import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import nextEnv from "@next/env";
import { DRAFT_INSTRUCTION, draftCandidates, modelSource, prepareQueue, settleDraft, validateSources } from "./engine.mjs";
import { discoverXML, fetchSource } from "./sources.mjs";
import { draftSchema, generateJSON, liveModels, modelConfig } from "./model.mjs";
import { checkDraft, checkReview, excerptFound, recentConcepts, summarisePreferences } from "./editorial.mjs";

nextEnv.loadEnvConfig(process.cwd());
const COMMANDS = ["check", "probe", "draft", "review", "publish", "publish-checked", "prepare", "cycle", "status", "providers", "models"];
const [command = "help", id, note] = process.argv.slice(2);
if (command === "help" || !COMMANDS.includes(command)) {
  console.log(`Content engine. See docs/content-engine.md.

  check              pre-flight: database, providers, models and feeds, spending no AI quota
  probe              send one tiny synthetic draft to each model; prints full provider errors
  cycle              draft, auto-publish if enabled, then top up the reading queue
  draft              draft new candidates from the configured sources
  publish-checked    publish every candidate that passed its checks
  publish <id> <note>  publish one checked candidate with a review note
  review [id]        read a draft, with each quote marked found or not (default: latest held)
  prepare            append published posts to the reading queue
  status             candidate counts, queue depth, today's per-provider usage
  providers          show the configured provider chain (never prints keys)
  models             ask each provider which models it serves now, and flag retired ones`);
  process.exit(command === "help" ? 0 : 1);
}

function setting(name, fallback, { min, max }) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}
const autoPublish = () => /^(1|true|yes)$/i.test(process.env.CONTENT_AUTO_PUBLISH ?? "");

async function result(query) {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data;
}
let db;
async function all(table, columns = "*") {
  const rows = [];
  for (let from = 0; ; from += 500) {
    const page = await result(db.from(table).select(columns).order(table === "feed_queue" ? "position" : table === "user_post_state" ? "post_id" : "id").range(from, from + 499));
    rows.push(...page);
    if (page.length < 500) return rows;
    if (rows.length >= 20000) throw new Error("Content catalogue exceeded runner limit");
  }
}

/**
 * Sources, first match wins: CONTENT_SOURCES_JSON (handy as a CI secret), CONTENT_SOURCES_FILE,
 * your git-ignored content-sources.local.json, then the committed starter list.
 */
async function loadSources() {
  if (process.env.CONTENT_SOURCES_JSON) return JSON.parse(process.env.CONTENT_SOURCES_JSON);
  for (const file of [process.env.CONTENT_SOURCES_FILE, "content-sources.local.json", "content-sources.example.json"].filter(Boolean)) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      // Only a missing file falls through; a malformed one should stop the run, not be silently skipped.
      if (error.code !== "ENOENT") throw new Error(`Could not read ${file}: ${error.message}`);
    }
  }
  throw new Error("No content sources configured. Copy content-sources.example.json to content-sources.local.json.");
}

async function draft(config) {
  const [groups, posts, states, drafted] = await Promise.all([
    loadSources(), all("post"), all("user_post_state"),
    // Only the source URL, not the stored evidence text, which can run to tens of kilobytes each.
    all("content_candidate", "id,status,created_at,url:evidence->0->>url"),
  ]);
  // A held draft's article is retried once it is older than this, since the checks or models may have
  // improved since; otherwise one bad draft would lock that article out for good. 0 retries every run.
  const retryAfter = setting("CONTENT_RETRY_HELD_HOURS", 24, { min: 0, max: 720 }) * 3_600_000;
  const cutoff = Date.now() - retryAfter;
  const done = drafted.filter((row) => row.status !== "held" || Date.parse(row.created_at) > cutoff);
  // Both are bounded: the raw catalogue and rating history grow with every post you read.
  const concepts = recentConcepts(posts);
  const preferences = summarisePreferences(states, posts);
  // Attempts since the last save belong to that candidate: the engine drafts, reviews, then saves, in order.
  const trace = [];
  return draftCandidates({
    groups, concepts, preferences,
    limit: setting("CONTENT_DRAFT_LIMIT", 8, { min: 1, max: 50 }),
    sourceChars: setting("CONTENT_SOURCE_CHARS", 10000, { min: 2000, max: 24000 }),
    known: new Set(done.map((row) => row.url).filter(Boolean)),
    // stderr, so the JSON summary on stdout stays clean for anything that parses it.
    onProgress: ({ n, limit, publisher, outcome }) => console.error(`[${n}/${limit}] ${publisher}: ${outcome}`),
    generate: (args) => generateJSON({
      ...args, config, trace,
      reserve: ({ provider, cost, dailyUsd, calls }) => result(db.rpc("reserve_content_call", {
        p_provider: provider, p_cost: cost, p_daily_limit: dailyUsd, p_call_limit: calls,
      })),
    }),
    save: (candidate) => result(db.from("content_candidate").upsert(
      { ...candidate, checks: { ...candidate.checks, models: trace.splice(0) } },
      { onConflict: "id", ignoreDuplicates: true },
    )),
  });
}

/** Re-run every check before publishing, so nothing is published on a stale verdict. */
function passesChecks(candidate) {
  return !checkDraft(candidate.payload, candidate.evidence).length && checkReview(candidate.checks?.review, candidate.payload);
}

async function publishChecked() {
  const candidates = await result(db.from("content_candidate").select("id,payload,evidence,checks").eq("status", "checked").limit(200));
  const metrics = { published: 0, needsRecheck: 0, rejected: 0 };
  for (const candidate of candidates) {
    if (!passesChecks(candidate)) { metrics.needsRecheck++; continue; }
    const models = [...new Set((candidate.checks?.models ?? []).filter((m) => m.ok).map((m) => `${m.provider}/${m.model}`))];
    try {
      await result(db.rpc("publish_candidate", {
        p_id: candidate.id,
        p_note: `Auto-published: passed source-excerpt checks and model review (${models.join(", ") || "model unrecorded"}).`,
      }));
      metrics.published++;
    } catch {
      // Typically stale news or a candidate past its review window; it stays unpublished.
      metrics.rejected++;
    }
  }
  return metrics;
}

async function prepare() {
  const [posts, states, queue, reader] = await Promise.all([
    all("post"), all("user_post_state"), all("feed_queue"),
    result(db.from("allowed_reader").select("user_id").single()),
  ]);
  const assigned = queue.map((q) => posts.find((p) => p.id === q.post_id)).filter(Boolean);
  const target = setting("CONTENT_QUEUE_TARGET", 24, { min: 1, max: 500 });
  const ids = prepareQueue({ candidates: posts, assigned, states, target });
  const added = await result(db.rpc("append_feed", { p_user_id: reader.user_id, p_ids: ids }));
  return { added, targetUnread: target };
}

async function withRun(stage, work) {
  const run = await result(db.from("content_run").insert({}).select("id").single());
  try {
    const metrics = await work();
    await result(db.from("content_run").update({ status: "completed", finished_at: new Date().toISOString(), metrics }).eq("id", run.id));
    return metrics;
  } catch (error) {
    // Keep error details local; provider responses may contain private content.
    await result(db.from("content_run").update({ status: "failed", finished_at: new Date().toISOString(), metrics: { stage } }).eq("id", run.id));
    throw error;
  }
}

/**
 * Pre-flight for a first run. Every check is read-only and spends no generation quota;
 * each failure says what to do about it. Returns true only if everything passes.
 */
async function check() {
  const results = [];
  // A warning is worth knowing but does not block a run, e.g. a fallback that is not set up yet.
  const record = (ok, label, detail = "", warning = false) => results.push({ ok, label, detail, warning });
  const attempt = async (label, work, hint) => {
    try { record(true, label, (await work()) ?? ""); }
    catch (error) { record(false, label, `${error.message}${hint ? ` — ${hint}` : ""}`); }
  };

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) record(false, "Supabase configuration", "set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
  else if (key === process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) record(false, "Supabase configuration", "SUPABASE_SERVICE_ROLE_KEY is the publishable key; use the secret key");
  else {
    record(true, "Supabase configuration");
    db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    await attempt("Migration 202609230001 (content engine)",
      async () => { await result(db.from("content_candidate").select("id").limit(1)); await result(db.from("feed_queue").select("post_id").limit(1)); },
      "apply supabase/migrations/202609230001_content_engine.sql in the SQL Editor");
    await attempt("Migration 202609240001 (provider budget)",
      async () => { await result(db.from("content_budget").select("provider").limit(1)); },
      "apply supabase/migrations/202609240001_model_providers.sql, after 202609230001");
    await attempt("Enrolled reader", async () => {
      const rows = await result(db.from("allowed_reader").select("user_id"));
      if (rows.length !== 1) throw new Error(`${rows.length} enrolled`);
      return "one";
    }, "enrol your auth user in public.allowed_reader");
    await attempt("Content readable", async () => `${(await all("post", "id")).length} posts`);
  }

  let config = null;
  await attempt("Provider chain", async () => {
    config = modelConfig(process.env);
    return [config.chain.map((e) => `${e.name}/${e.model}`).join(" → "), config.skipped.length ? `(skipped: ${config.skipped.join("; ")})` : ""].join(" ").trim();
  });
  if (config) {
    const inChain = new Set(config.chain.map((e) => e.name));
    for (const report of await liveModels(process.env)) {
      // Only a provider the chain actually uses can block a run; an unconfigured fallback is a warning.
      if (report.error) { record(!inChain.has(report.provider), `Models: ${report.provider}`, report.error, !inChain.has(report.provider)); continue; }
      if (!report.preferred?.length) { record(true, `Models: ${report.provider}`, report.note ?? "none chosen", true); continue; }
      const retired = report.preferred.filter((p) => p.live === false).map((p) => p.model);
      const live = report.preferred.filter((p) => p.live !== false);
      if (!live.length) record(false, `Models: ${report.provider}`, `none of your preferred models are served: ${retired.join(", ")}. Run \`models\` and update CONTENT_${report.provider.toUpperCase()}_MODEL`);
      else record(true, `Models: ${report.provider}`, `${live.map((p) => p.model).join(", ")} live${retired.length ? `; retired, will be skipped: ${retired.join(", ")}` : ""}`);
    }
  }

  let groups = null;
  await attempt("Sources", async () => { groups = validateSources(await loadSources()); return `${groups.length} publishers`; });
  for (const group of groups ?? []) {
    for (const feed of group.feeds) {
      await attempt(`Feed: ${group.publisher}`, async () => {
        const found = discoverXML((await fetchSource(feed, group.hosts)).text, group.hosts);
        if (!found.length) throw new Error("reachable, but listed no articles on the allowed hosts");
        return `${found.length} articles`;
      }, "check the feed URL and its hosts list");
    }
  }

  for (const { ok, label, detail, warning } of results) console.log(`${!ok ? "✗" : warning ? "!" : "✓"} ${label}${detail ? `: ${detail}` : ""}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} check${failed === 1 ? "" : "s"} failed. Fix these before running \`cycle\`.` : "\nAll checks passed. Next: npm run content -- cycle");
  return failed === 0;
}

/**
 * Send one tiny, synthetic draft request — using the real draft schema — to every model in the chain,
 * and print exactly what each provider says. Because the input is made up, the provider's full error
 * text is safe to show, which it never is during a real run. Costs one call per model; no budget is reserved.
 */
async function probe() {
  const config = modelConfig(process.env);
  // Long enough to support a real post, evergreen, and made up — so errors are safe to print in full.
  const text = [
    "The Sun is a star at the centre of the Solar System.",
    "Light from the Sun takes about eight minutes to reach Earth, because the two are roughly 150 million kilometres apart.",
    "The Sun produces energy through nuclear fusion, in which hydrogen nuclei combine to form helium in its core.",
    "Temperatures in the core reach around 15 million degrees Celsius.",
    "Energy released in the core can take many thousands of years to travel outward through the Sun's interior before it escapes as light.",
    "Sunspots are cooler, darker regions on the surface, caused by concentrated magnetic fields.",
  ].join(" ");
  const source = { url: "https://example.org/probe", publisher: "Probe", title: "How the Sun shines", articleDate: null, accessedAt: new Date().toISOString(), text };
  // Exactly what a real run sends — the real instruction, schema and numbered-sentence input — and the
  // reply is settled by the same code, so ✓ means a real run would accept it.
  const { sentences, view } = modelSource(source);
  const input = { source: view, concepts: [], preferences: [] };
  let usable = 0;
  for (const entry of config.chain) {
    const label = `${entry.name}/${entry.model}`;
    try {
      const { json } = await entry.provider.request({
        model: entry.model, key: entry.key, instruction: DRAFT_INSTRUCTION, input, schema: draftSchema,
        maxOutputTokens: config.maxOutputTokens, options: entry.options,
      });
      // The same settling and deterministic checks a real draft faces before it may even be reviewed.
      const problems = checkDraft(settleDraft(json, source, sentences), [source]);
      if (problems.length) console.log(`~ ${label}: answered, but a real draft like this would be held: ${problems.join(", ")}`);
      else { console.log(`✓ ${label}: produced a draft that passes every check`); usable++; }
    } catch (error) {
      console.log(`✗ ${label}: ${error.message}${error.detail ? `\n    provider said: ${error.detail}` : ""}`);
    }
  }
  console.log(usable ? `\n${usable} of ${config.chain.length} models produce drafts that pass.` : "\nNo model produced a passing draft. Paste this output for a fix.");
  return usable > 0;
}

// Every command returns normally rather than calling process.exit(): on Windows, exiting while fetch's
// sockets are still closing trips a libuv assertion ("UV_HANDLE_CLOSING") after the output is printed.
async function main() {
  if (command === "check") {
    if (!(await check())) process.exitCode = 1;
    return;
  }
  if (command === "probe") {
    if (!(await probe())) process.exitCode = 1;
    return;
  }
  if (command === "providers") {
    const config = modelConfig(process.env);
    console.log(JSON.stringify({
      chain: config.chain.map(({ name, model, calls, inputPrice, outputPrice }) => ({ name, model, dailyCalls: calls, inputPrice, outputPrice })),
      skipped: config.skipped, dailyUsd: config.dailyUsd, autoPublish: autoPublish(),
    }, null, 2));
    return;
  }
  if (command === "models") {
    // Model IDs only; the listing call carries no content and costs no generation quota.
    console.log(JSON.stringify(await liveModels(process.env), null, 2));
    return;
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || key === process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) throw new Error("Local service role configuration required");
  db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  if (command === "review") {
    // With no id, the most recent held draft: the one you most likely want to understand.
    const candidate = id
      ? await result(db.from("content_candidate").select("*").eq("id", id).single())
      : (await result(db.from("content_candidate").select("*").eq("status", "held").order("created_at", { ascending: false }).limit(1)))[0];
    if (!candidate) { console.log("No held drafts."); return; }
    const p = candidate.payload ?? {};
    const text = candidate.evidence?.[0]?.text ?? "";
    // Local terminal only: this prints the draft and quotes, which never go to CI logs.
    console.log(`${candidate.id} — ${candidate.status}\n${p.title ?? "(no title)"}  [${p.topic ?? "?"} / ${p.subtopic ?? "?"}]`);
    console.log(`source: ${candidate.evidence?.[0]?.publisher ?? "?"}: ${candidate.evidence?.[0]?.title ?? "?"}\n`);
    for (const [i, paragraph] of (p.explanation ?? []).entries()) console.log(`${i ? "" : "Explanation:\n"}  ${paragraph}`);
    if (p.insight) console.log(`\nInsight: ${p.insight}`);
    console.log(`Concepts: ${(p.conceptIds ?? []).join(", ") || "(none)"}\n\nClaims:`);
    for (const [i, claim] of (p.claims ?? []).entries()) {
      console.log(`  ${excerptFound(text, claim?.excerpt ?? "") ? "✓" : "✗"} ${i + 1}. ${claim?.claim}\n       quote: "${claim?.excerpt}"`);
    }
    console.log(`\nChecks: ${candidate.checks?.passed ? "passed" : (candidate.checks?.errors ?? []).join("; ") || "none recorded"}`);
    if (candidate.checks?.review) console.log(`Reviewer: supported=${candidate.checks.review.supported} complete=${candidate.checks.review.complete} misleading=${candidate.checks.review.misleading}`);
    console.log(`Models: ${(candidate.checks?.models ?? []).map((m) => `${m.provider}/${m.model}${m.ok ? "" : ` (${m.reason})`}`).join(", ") || "unrecorded"}`);
  } else if (command === "publish") {
    const candidate = await result(db.from("content_candidate").select("*").eq("id", id ?? "").single());
    if (!passesChecks(candidate)) throw new Error("Candidate needs renewed checks");
    await result(db.rpc("publish_candidate", { p_id: id, p_note: note ?? "" }));
    console.log("Published reviewed candidate. Run prepare to append it to the reading queue.");
  } else if (command === "status") {
    const [candidates, queue, states, budget, runs] = await Promise.all([
      all("content_candidate", "id,status"), all("feed_queue"), all("user_post_state", "post_id,read_at"),
      result(db.from("content_budget").select("*").order("day", { ascending: false }).order("provider").limit(21)),
      result(db.from("content_run").select("*").order("started_at", { ascending: false }).limit(5)),
    ]);
    const read = new Set(states.filter((s) => s.read_at).map((s) => s.post_id));
    console.log(JSON.stringify({
      candidates: candidates.reduce((counts, c) => ({ ...counts, [c.status]: (counts[c.status] ?? 0) + 1 }), {}),
      queued: queue.length, unread: queue.filter((q) => !read.has(q.post_id)).length, budget, runs,
    }, null, 2));
  } else {
    const config = ["draft", "cycle"].includes(command) ? modelConfig(process.env) : null;
    const metrics = await withRun(command, async () => {
      if (command === "draft") return draft(config);
      if (command === "publish-checked") return publishChecked();
      if (command === "prepare") return prepare();
      // cycle: the one command a scheduler needs.
      console.error("Drafting from your sources. Each post takes up to two AI calls; this can take a few minutes.");
      const drafted = await draft(config);
      const published = autoPublish() ? await publishChecked() : { skipped: "Set CONTENT_AUTO_PUBLISH=true to publish without review" };
      return { drafted, published, queued: await prepare() };
    });
    console.log(JSON.stringify(metrics, null, 2));
  }
}

try {
  await main();
} catch (error) {
  console.error(`Content engine stopped: ${error.message}`);
  process.exitCode = 1;
}
