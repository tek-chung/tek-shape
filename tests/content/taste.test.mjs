import { test } from "node:test";
import assert from "node:assert/strict";
import { REWARDS, buildTaste, judgeTopic, planSources, promptSummary, rankQueue, rewardOf, seededRandom, snapshotOf, subtopicKey } from "../../scripts/content/taste.mjs";

const now = Date.parse("2026-09-27T12:00:00Z");
const ago = (days) => new Date(now - days * 86_400_000).toISOString();
let serial = 0;
const post = (field, subtopic, extra = {}) => ({
  id: `p-${++serial}`, field, subtopic, status: "published", verification_status: "source_checked", content_type: "evergreen",
  difficulty: 2, concept_ids: [`c-${serial}`], sources: [{ publisher: "Quanta Magazine" }], reviewed_at: ago(1), ...extra,
});
const state = (p, fields) => ({ post_id: p.id, rating: null, bookmarked: false, first_seen_at: ago(3), updated_at: ago(2), ...fields });
const liked = (p) => state(p, { read_at: ago(2), rating: "more" });
const disliked = (p) => state(p, { read_at: ago(2), rating: "uninteresting" });

test("every signal becomes one enjoyment score, and Not interesting always wins", () => {
  assert.equal(rewardOf(state({ id: "x" }, { bookmarked: true, rating: "uninteresting" }), now), REWARDS.uninteresting);
  assert.equal(rewardOf(state({ id: "x" }, { bookmarked: true, read_at: ago(1) }), now), REWARDS.saved);
  assert.equal(rewardOf(state({ id: "x" }, { opened_at: ago(1), read_at: ago(1) }), now), REWARDS.opened);
  assert.equal(rewardOf(state({ id: "x" }, { rating: "harder" }), now), REWARDS.harder);
  assert.equal(rewardOf(state({ id: "x" }, { deeper_opened_at: ago(1) }), now), REWARDS.deeper);
  assert.equal(rewardOf(state({ id: "x" }, { read_at: ago(1) }), now), REWARDS.read);
  assert.equal(rewardOf(state({ id: "x" }, { first_seen_at: ago(2) }), now), REWARDS.skipped, "seen a day ago, never read: scrolled past");
  assert.equal(rewardOf(state({ id: "x" }, { first_seen_at: new Date(now - 3_600_000).toISOString() }), now), null, "seen an hour ago: no verdict yet");
  assert.equal(rewardOf(undefined, now), null);
});

test("a new subtopic borrows from its field: hopeful in a loved field, cautious but not written off in a disliked one", () => {
  const loved = [1, 2, 3, 4].map((i) => post("algebra-number-theory", `Primes ${i}`));
  const hated = [1, 2, 3, 4].map((i) => post("probability-statistics", `Surveys ${i}`));
  const model = buildTaste({ posts: [...loved, ...hated], states: [...loved.map(liked), ...hated.map(disliked)], now });
  const fresh = model.estimate("algebra-number-theory", "Modular forms").mean;
  const risky = model.estimate("probability-statistics", "Bayesian medicine").mean;
  assert.ok(fresh > model.prior + 0.15, `loved field starts hopeful (${fresh} vs ${model.prior})`);
  assert.ok(risky < fresh - 0.3 && risky > 0.1, `disliked field starts cautious, not zero (${risky})`);
});

test("old evidence fades: a dislike from a year ago weighs far less than one from last week", () => {
  const a = post("ethics", "Old dislike"), b = post("ethics", "New dislike");
  const oldModel = buildTaste({ posts: [a], states: [state(a, { rating: "uninteresting", updated_at: ago(365) })], now });
  const newModel = buildTaste({ posts: [b], states: [state(b, { rating: "uninteresting", updated_at: ago(7) })], now });
  assert.ok(oldModel.weightOf("f:ethics") < 0.05 && newModel.weightOf("f:ethics") > 0.9);
});

test("two dislikes and nothing positive pause a subtopic for 30 days; More overrides; a field needs three paused subtopics", () => {
  const a = post("probability-statistics", "Survey Methods"), b = post("probability-statistics", "Survey methods");
  const base = { posts: [a, b], states: [disliked(a), disliked(b)], now };
  const key = subtopicKey("probability-statistics", "Survey Methods");
  assert.equal(buildTaste(base).pauseOf("probability-statistics", key).by, "feed");
  assert.equal(buildTaste({ ...base, now: now + 31 * 86_400_000 }).pauseOf("probability-statistics", key), null, "then gets another try");
  assert.equal(buildTaste({ ...base, prefs: [{ scope: "subtopic", key, choice: "more" }] }).pauseOf("probability-statistics", key), null);
  assert.equal(buildTaste(base).fieldPause("probability-statistics"), null, "one paused subtopic does not pause the field");
  const more = ["Polling", "Sampling"].flatMap((name) => [post("probability-statistics", name), post("probability-statistics", name)]);
  const field = buildTaste({ posts: [a, b, ...more], states: [a, b, ...more].map(disliked), now });
  assert.equal(field.fieldPause("probability-statistics").by, "feed");
  const snoozed = buildTaste({ posts: [], states: [], prefs: [{ scope: "field", key: "ethics", choice: "snooze", until: ago(-10) }], now });
  assert.equal(snoozed.fieldPause("ethics").by, "you");
});

test("Harder raises a field's target difficulty", () => {
  const ps = [1, 2, 3].map((i) => post("quantum-physics", `Q${i}`, { difficulty: 3 }));
  const model = buildTaste({ posts: ps, states: ps.map((p) => state(p, { read_at: ago(1), rating: "harder" })), now });
  assert.ok(model.targetDifficulty("quantum-physics") > 4, `${model.targetDifficulty("quantum-physics")}`);
  assert.equal(buildTaste({ posts: [], states: [], now }).targetDifficulty("quantum-physics"), 2.5);
});

test("a subtopic loved inside an area you otherwise dislike is reported as a discovered niche", () => {
  const dull = [1, 2, 3, 4, 5].map((i) => post("macroeconomics", `Rates ${i}`));
  const gem = [post("markets-investing", "Behavioural Finance"), post("markets-investing", "Behavioural finance")];
  const model = buildTaste({ posts: [...dull, ...gem], states: [...dull.map(disliked), ...gem.map((p) => state(p, { read_at: ago(1), bookmarked: true }))], now });
  assert.deepEqual(model.niches.map((n) => n.name), ["Behavioural Finance"]);
  assert.equal(snapshotOf(model).niches[0].umbrella, "economics-business");
});

test("each batch is shared between sources: the stem opens it, breadth and exploration have their places; varied, no repeats", () => {
  const history = [];
  const fields = ["algebra-number-theory", "quantum-physics", "ethics", "artificial-intelligence", "modern-history", "neuroscience"];
  for (const f of fields) for (let i = 0; i < 3; i++) history.push(post(f, `${f} ${i}`));
  // Quantum physics and ethics are clear favourites; the rest are liked one time in three.
  const states = history.map((p) => (["quantum-physics", "ethics"].includes(p.field) || p.subtopic.endsWith(" 0") ? liked(p) : disliked(p)));
  const model = buildTaste({ posts: history, states, now });
  assert.deepEqual([...model.stemFields].sort(), ["ethics", "quantum-physics"], "with none chosen, the stem is learnt");
  const candidates = fields.flatMap((f) => [1, 2, 3, 4, 5].map((i) => post(f, `${f} new ${i}`)));
  const picks = rankQueue({ model, candidates, assigned: history, need: 10, now, random: seededRandom(7) });
  assert.equal(picks.length, 10);
  const sources = picks.map((p) => p.reasons.source);
  assert.equal(sources[0], "stem", "the batch opens in the stem");
  assert.ok(sources.filter((s) => s === "stem").length >= 3, sources.join());
  assert.ok(sources.filter((s) => s === "bar").length >= 2, sources.join());
  assert.ok(picks.some((p) => p.slot === "explore"), "exploration has a place");
  const byId = new Map(candidates.map((c) => [c.id, c]));
  for (const p of picks.filter((p) => p.reasons.source === "stem")) assert.ok(model.stemFields.has(byId.get(p.id).field));
  for (const p of picks.filter((p) => p.reasons.source === "bar")) assert.ok(!model.stemFields.has(byId.get(p.id).field), "the bar is breadth beyond the stem");
  const chosen = picks.map((p) => byId.get(p.id).field);
  for (let i = 1; i < chosen.length; i++) assert.notEqual(chosen[i], chosen[i - 1], "never two in a row from the same field");
  assert.equal(new Set(picks.map((p) => p.id)).size, 10);
});

test("every placement says why, in a small record fit to store and never to log", () => {
  const history = [];
  const fields = ["algebra-number-theory", "quantum-physics", "ethics", "artificial-intelligence", "modern-history", "neuroscience"];
  for (const f of fields) for (let i = 0; i < 3; i++) history.push(post(f, `${f} ${i}`));
  const model = buildTaste({ posts: history, states: history.map((p) => liked(p)), now });
  const candidates = [...fields, "earth-sciences", "law-rights"].flatMap((f) => [1, 2, 3].map((i) => post(f, `${f} new ${i}`)));
  const picks = rankQueue({ model, candidates, assigned: history, need: 10, now, random: seededRandom(5) });
  const codes = new Set(["favourite", "excerpt", "thin-area", "bar", "bridge", "uncertain", "breadth", "harder", "next-step", "stem", "trusted", "fresh"]);
  for (const pick of picks) {
    assert.equal(pick.reasons.v, 1);
    assert.equal(pick.reasons.slot, pick.slot);
    assert.ok(codes.has(pick.reasons.why), pick.reasons.why);
    assert.ok(JSON.stringify(pick.reasons).length < 2000, "fits the database's limit");
    assert.ok(["stem", "bar", "bridges", "trusted", "wild", "fresh", "any"].includes(pick.reasons.source), pick.reasons.source);
  }
  // Politics & society is missing from the reading so far: it is placed, and placed as breadth or a thin area.
  const unread = picks.find((p) => p.reasons.field === "law-rights");
  assert.ok(unread, "the unread area appears in the batch");
  assert.ok(["breadth", "thin-area"].includes(unread.reasons.why), unread.reasons.why);
  assert.equal(unread.reasons.gap, 1);
});

test("paused subtopics, stale news and true repeats never reach the feed", () => {
  const a = post("probability-statistics", "Survey Methods"), b = post("probability-statistics", "Survey Methods");
  const model = buildTaste({ posts: [a, b], states: [disliked(a), disliked(b)], now });
  const paused = post("probability-statistics", "Survey methods");
  const stale = post("ethics", "Trolley Problems", { content_type: "news", article_date: ago(40), reviewed_at: ago(1) });
  const repeat = post("ethics", "Virtue", { concept_ids: ["virtue"] });
  const known = post("ethics", "Virtue", { concept_ids: ["virtue"] });
  const fine = post("ethics", "Moral Luck");
  const picks = rankQueue({ model, candidates: [paused, stale, repeat, fine], assigned: [known], need: 5, now, random: seededRandom(1) });
  assert.deepEqual(picks.map((p) => p.id), [fine.id]);
});

test("the breadth floor brings back an area missing from the last twenty posts", () => {
  const history = Array.from({ length: 20 }, (_, i) => post(i % 2 ? "algebra-number-theory" : "quantum-physics", `S${i}`));
  const model = buildTaste({ posts: history, states: history.map(liked), now });
  const candidates = [
    ...Array.from({ length: 12 }, (_, i) => post(i % 2 ? "algebra-number-theory" : "quantum-physics", `N${i}`)),
    post("ancient-medieval-history", "Roman Roads"),
  ];
  const picks = rankQueue({ model, candidates, assigned: history, need: 10, now, random: seededRandom(3) });
  assert.ok(picks.some((p) => p.id === candidates.at(-1).id), "history returns within one batch");
});

test("in an area you like less, exploration approaches through ideas you already enjoy", () => {
  const lovedFields = ["cognition-perception", "ethics", "quantum-physics", "modern-history"];
  const loves = lovedFields.flatMap((f) => [1, 2, 3].map((i) => post(f, `${f} ${i}`, { concept_ids: ["cognitive-bias", `${f}-${i}`] })));
  const dull = [1, 2, 3].map((i) => post("macroeconomics", `Rates ${i}`, { concept_ids: [`rates-${i}`] }));
  const model = buildTaste({ posts: [...loves, ...dull], states: [...loves.map(liked), ...dull.map(disliked)], now });
  const bridge = post("markets-investing", "Behavioural Finance", { concept_ids: ["cognitive-bias", "markets"] });
  const plain = post("markets-investing", "Bond Ladders", { concept_ids: ["bonds"] });
  const others = lovedFields.flatMap((f) => [1, 2, 3].map((i) => post(f, `${f} fresh ${i}`, { concept_ids: [`${f}-fresh-${i}`] })));
  let bridgeWins = 0, plainWins = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const order = rankQueue({ model, candidates: [plain, bridge, ...others], assigned: [], need: 10, now, random: seededRandom(seed) }).map((p) => p.id);
    const at = (id) => (order.includes(id) ? order.indexOf(id) : Infinity);
    if (at(bridge.id) < at(plain.id)) bridgeWins++;
    if (at(plain.id) < at(bridge.id)) plainWins++;
  }
  assert.ok(bridgeWins > 30, `the post that shares a liked idea is placed first into the unread area (${bridgeWins} vs ${plainWins} of 40)`);
});

test("exploration earns its share: it shrinks when explorations miss, but never below 15%", () => {
  const favs = Array.from({ length: 10 }, (_, i) => post("ethics", `F${i}`));
  const exps = Array.from({ length: 10 }, (_, i) => post("macroeconomics", `E${i}`));
  const queue = [...favs.map((p, i) => ({ post_id: p.id, position: i + 1, slot: "favourite" })), ...exps.map((p, i) => ({ post_id: p.id, position: 20 + i, slot: "explore" }))];
  const missing = buildTaste({ posts: [...favs, ...exps], states: [...favs.map(liked), ...exps.map(disliked)], queue, now });
  const landing = buildTaste({ posts: [...favs, ...exps], states: [...favs, ...exps].map(liked), queue, now });
  assert.equal(missing.exploreShare, 0.15);
  assert.equal(landing.exploreShare, 0.3);
  assert.equal(buildTaste({ posts: [], states: [], now }).exploreShare, 0.25, "a new reader starts at a quarter");
  assert.equal(missing.metrics.hitRate, 0.5);
});

test("sources: overdue ones go first, the most enjoyed third get two turns, and resting headlines are skipped", () => {
  const ps = [1, 2, 3].map((i) => post("ethics", `A${i}`, { sources: [{ publisher: "Aeon" }] }));
  const model = buildTaste({ posts: ps, states: ps.map((p) => state(p, { read_at: ago(1), bookmarked: true })), now });
  const groups = ["Aeon", "TechCrunch", "Nature"].map((publisher) => ({ publisher }));
  const plan = planSources({ model, groups, lastDrafted: new Map([["Aeon", now - 3_600_000], ["TechCrunch", now - 3_600_000]]), now, random: seededRandom(2) });
  assert.equal(plan[0].group.publisher, "Nature", "never drafted: overdue, so first");
  assert.equal(plan.find((p) => p.group.publisher === "Aeon").turns, 2);
  const a = post("probability-statistics", "Polls"), b = post("probability-statistics", "Polls");
  const paused = buildTaste({ posts: [a, b], states: [disliked(a), disliked(b)], now });
  assert.equal(judgeTopic(paused, { field: "probability-statistics", subtopic: "polls", publisher: "Nature" }, seededRandom(1)).skip, true);
  assert.equal(judgeTopic(paused, { field: "ethics", subtopic: "Moral Luck", publisher: "Nature" }, seededRandom(1)).skip, false);
});

test("the drafting model hears only a short list of liked and disliked subtopics", () => {
  const good = [post("ethics", "Moral Luck"), post("ethics", "Moral Luck")], bad = [post("macroeconomics", "Rates"), post("macroeconomics", "Rates")];
  const summary = promptSummary(buildTaste({ posts: [...good, ...bad], states: [...good.map((p) => state(p, { bookmarked: true, read_at: ago(1) })), ...bad.map(disliked)], now }));
  assert.deepEqual(summary, { enjoys: ["Ethics: Moral Luck"], avoids: ["Macroeconomics & policy: Rates"] });
});

// --- Wiring into the drafting run -------------------------------------------------------------

const article = (url) => ({ url, accessedAt: new Date(now).toISOString(),
  text: `<html><title>Headline</title><article>${"<p>Enough readable sentences about the subject sit here for a draft.</p>".repeat(20)}</article></html>` });
const feed = (items) => ({ text: `<rss><channel>${items.map(([url, title]) => `<item><link>${url}</link><title>${title}</title><description><![CDATA[<b>${title}</b> summary]]></description></item>`).join("")}</channel></rss>` });

test("feeds keep their headlines and summaries for triage; listing pages keep link text", async () => {
  const { discoverXMLItems, discoverHTMLItems } = await import("../../scripts/content/sources.mjs");
  const [item] = discoverXMLItems(feed([["https://a.example/x", "Primes &amp; gaps"]]).text, ["a.example"]);
  assert.deepEqual([item.url, item.summary.startsWith("Primes")], ["https://a.example/x", true]);
  const links = discoverHTMLItems('<a href="/doc/1"><img></a><a href="/doc/1">The real headline</a>', "https://a.example/", ["a.example"], "/doc/");
  assert.deepEqual(links, [{ url: "https://a.example/doc/1", title: "The real headline", summary: "" }]);
});

test("triage skips resting headlines before any drafting call, drafts the best first, and passes the difficulty target", async () => {
  const { draftCandidates, interleave } = await import("../../scripts/content/engine.mjs");
  assert.deepEqual(interleave([{ group: { publisher: "A" }, urls: ["a1", "a2", "a3"], turns: 2, linkHosts: [] }, { group: { publisher: "B" }, urls: ["b1", "b2"], linkHosts: [] }]).map((o) => o.url),
    ["a1", "a2", "b1", "a3", "b2"], "a favoured source gets two turns in the first round");
  const urls = ["https://a.example/1", "https://a.example/2", "https://a.example/3"];
  const prompts = [];
  let triaged;
  const metrics = await draftCandidates({
    groups: [{ publisher: "A", hosts: ["a.example"], feeds: ["https://a.example/rss"] }], limit: 1, checks: "off",
    retrieve: async (url) => (url.endsWith("rss") ? feed(urls.map((u, i) => [u, `Headline ${i}`])) : article(url)),
    triage: async (entries) => { triaged = entries; return new Map([[urls[0], { skip: true, score: 0 }], [urls[1], { skip: false, score: 0.2, field: "ethics" }], [urls[2], { skip: false, score: 0.9, field: "quantum-physics" }]]); },
    guidance: (field) => (field ? { field, targetDifficulty: 4 } : undefined),
    generate: async (args) => { prompts.push(args); return { field: "quantum-physics", subtopic: "Entanglement", title: "T", explanation: ["E"], insight: "I", deeper: "D",
      contentType: "evergreen", difficulty: 4, conceptIds: ["entanglement"], eventDate: null, articleDate: null, sources: [], claims: [{ claim: "c", sentences: [1] }] }; },
    save: async () => {},
  });
  assert.deepEqual(triaged.map((e) => [e.url, e.title]), urls.map((u, i) => [u, `Headline ${i}`]));
  assert.equal(metrics.skippedByTaste, 1);
  assert.equal(prompts.length, 1, "one draft, no review with checks off");
  assert.equal(prompts[0].input.source.url, urls[2], "the most promising headline is drafted first");
  assert.deepEqual(prompts[0].input.guidance, { field: "quantum-physics", targetDifficulty: 4 });
});

test("a batch always makes room for the best waiting excerpt, which would otherwise never win a place", () => {
  const fields = ["algebra-number-theory", "quantum-physics", "ethics", "artificial-intelligence", "modern-history", "neuroscience", "corporate-finance", "public-policy"];
  const from = (n) => [{ publisher: `Publisher ${n % 12}` }];
  const history = fields.flatMap((f) => [0, 1, 2, 3].map((i) => post(f, `${f} ${i}`, { sources: from(i * 3 + f.length) })));
  const model = buildTaste({ posts: history, states: history.map((p) => state(p, { read_at: ago(2), bookmarked: true })), now });
  const drafted = fields.flatMap((f) => Array.from({ length: 12 }, (_, i) => post(f, `${f} fresh ${i}`, { difficulty: 2 + (i % 2), sources: from(i * 7 + f.length) })));
  const excerpt = { ...post("corporate-finance", "CFO playbooks", { difficulty: 1, sources: [{ publisher: "CFO Secrets" }] }), kind: "excerpt" };
  const placed = (candidate, need, seed) => rankQueue({ model, candidates: [...drafted, candidate], assigned: history, need, now, random: seededRandom(seed) })
    .some((p) => p.id === candidate.id);
  for (const seed of [1, 2, 3, 4, 5]) {
    assert.equal(placed(excerpt, 10, seed), true, `seed ${seed}: the excerpt has its place`);
    assert.equal(placed({ ...excerpt, kind: undefined }, 10, seed), false, `seed ${seed}: the same post, not an excerpt, loses to full posts`);
  }
});

test("reading time refines a read and a scroll-past; without it the plain values stand", async () => {
  const { DWELL, READ_MIN } = await import("../../scripts/content/taste.mjs");
  const read = (dwell_ms, extra = {}) => rewardOf(state({ id: "x" }, { read_at: ago(1), dwell_ms, ...extra }), now);
  assert.equal(read(0), REWARDS.read, "measured before dwell existed");
  assert.equal(read(2000).toFixed(3), (DWELL.readMin + 0.15 * 2000 / DWELL.postMs).toFixed(3));
  assert.equal(read(DWELL.postMs * 3), DWELL.readFull, "a long read is capped");
  assert.ok(read(1000) >= READ_MIN && read(1000) < REWARDS.deeper, "still a read, still below the deeper explanation");
  assert.equal(rewardOf(state({ id: "x" }, { read_at: ago(1), dwell_ms: DWELL.excerptMs }), now, { kind: "excerpt" }), DWELL.readFull, "an excerpt is shorter to read");
  assert.equal(read(500, { rating: "harder" }), REWARDS.harder, "an explicit rating still wins");
  const past = (dwell_ms) => rewardOf(state({ id: "x" }, { first_seen_at: ago(2), dwell_ms }), now);
  assert.equal(past(0), REWARDS.skipped);
  assert.equal(past(600), DWELL.passedOver);
  assert.equal(past(4000), DWELL.glanced);
});

test("one Not interesting dims a subtopic, which recovers over six weeks unless enjoyed again", () => {
  const p = post("ethics", "Trolley Problems");
  const key = subtopicKey("ethics", "Trolley Problems");
  const at = (days) => buildTaste({ posts: [p], states: [state(p, { read_at: ago(days), rating: "uninteresting", updated_at: ago(days) })], now });
  assert.ok(Math.abs(at(0).fatigue("ethics", key) - 0.2) < 0.01, "just disliked");
  assert.ok(Math.abs(at(21).fatigue("ethics", key) - 0.6) < 0.01, "half recovered after three weeks");
  assert.equal(at(50).fatigue("ethics", key), 1);
  assert.equal(at(0).fatigue("ethics", subtopicKey("ethics", "Virtue")), 1, "other subtopics are untouched");
  assert.equal(at(0).pauseOf("ethics", key), null, "one dislike dims; it does not pause");
  const q = post("ethics", "Trolley problems");
  const forgiven = buildTaste({ posts: [p, q], states: [state(p, { rating: "uninteresting", updated_at: ago(5) }), state(q, { read_at: ago(1), rating: "more", updated_at: ago(1) })], now });
  assert.equal(forgiven.fatigue("ethics", key), 1, "a later More lifts it");
  const steered = buildTaste({ posts: [p], states: [state(p, { rating: "uninteresting", updated_at: ago(1) })], prefs: [{ scope: "field", key: "ethics", choice: "more" }], now });
  assert.equal(steered.fatigue("ethics", key), 1, "your own More overrides it");
});

test("a publisher that already filled recent places gives way to others of similar merit", () => {
  const fields = ["algebra-number-theory", "quantum-physics", "ethics", "artificial-intelligence", "modern-history", "neuroscience"];
  const history = fields.flatMap((f) => [0, 1].map((i) => post(f, `${f} ${i}`, { sources: [{ publisher: "Aeon" }] })));
  const model = buildTaste({ posts: history, states: history.map(liked), now });
  const candidates = fields.flatMap((f) => [
    post(f, `${f} more`, { sources: [{ publisher: "Aeon" }] }),
    post(f, `${f} other`, { sources: [{ publisher: f.length % 2 ? "Quanta Magazine" : "Nature" }] }),
  ]);
  const picks = rankQueue({ model, candidates, assigned: history, need: 6, now, random: seededRandom(2) });
  const byId = new Map(candidates.map((c) => [c.id, c.sources[0].publisher]));
  const aeon = picks.filter((p) => byId.get(p.id) === "Aeon").length;
  assert.ok(aeon <= 2, `after ten Aeon posts in a row, Aeon takes at most two of six (${aeon})`);
});

test("an idea cluster carries taste across subtopic names", () => {
  // Within ethics the reader loves one idea (cluster 7) and dislikes another (cluster 3).
  const loved = [1, 2, 3, 4].map((i) => post("ethics", `Moral Luck ${i}`));
  const dull = [1, 2, 3, 4].map((i) => post("ethics", `Duty ${i}`));
  const clusters = new Map([...loved.map((p) => [p.id, 7]), ...dull.map((p) => [p.id, 3])]);
  const model = buildTaste({ posts: [...loved, ...dull], states: [...loved.map(liked), ...dull.map(disliked)], now, clusters });
  const plain = model.estimate("ethics", "Fortune and Blame").mean;
  const sameIdea = model.estimate("ethics", "Fortune and Blame", 7).mean;
  const otherIdea = model.estimate("ethics", "Fortune and Blame", 3).mean;
  assert.ok(sameIdea > plain + 0.05, `a new name for a loved idea starts higher (${sameIdea} vs ${plain})`);
  assert.ok(otherIdea < plain - 0.05, `a new name for a disliked idea starts lower (${otherIdea} vs ${plain})`);
  assert.equal(model.estimate("ethics", "Fortune and Blame", 99).mean, plain, "an unread cluster changes nothing");
  assert.equal(model.clusterOf(loved[0].id), 7);
});

test("the same idea in other words is not placed twice, unless it goes deeper", async () => {
  const { normalise } = await import("../../scripts/content/understand.mjs");
  const unit = (i, j = null) => { const v = new Float32Array(384); v[i] = 1; if (j !== null) v[j] = 0.25; return normalise(v); };
  const seen = post("ethics", "Moral Luck", { difficulty: 2 });
  const fields = ["algebra-number-theory", "quantum-physics", "artificial-intelligence", "modern-history", "neuroscience"];
  const history = [seen, ...fields.map((f) => post(f, `${f} 0`))];
  const model = buildTaste({ posts: history, states: history.map(liked), now });
  const echo = post("ethics", "Fortune and Blame", { difficulty: 2 });
  const deeper = post("ethics", "Constitutive Luck", { difficulty: 4 });
  const twinA = post("neuroscience", "Place Cells"), twinB = post("neuroscience", "Grid Cells");
  const others = fields.map((f) => post(f, `${f} new`));
  const vectors = new Map([[seen.id, unit(1)], [echo.id, unit(1, 2)], [deeper.id, unit(1, 3)], [twinA.id, unit(50)], [twinB.id, unit(50, 51)],
    ...[...history.slice(1), ...others].map((p, i) => [p.id, unit(100 + i)])]);
  const candidates = [echo, deeper, twinA, twinB, ...others];
  const picks = rankQueue({ model, candidates, assigned: history, need: 10, now, random: seededRandom(3), vectors }).map((p) => p.id);
  assert.ok(!picks.includes(echo.id), "a restatement of a post already in the feed is dropped");
  assert.ok(picks.includes(deeper.id), "a harder take on it is the next step, and stays");
  assert.equal([twinA.id, twinB.id].filter((id) => picks.includes(id)).length, 1, "of two waiting twins, one is placed");
  const without = rankQueue({ model, candidates, assigned: history, need: 10, now, random: seededRandom(3) }).map((p) => p.id);
  assert.ok(without.includes(echo.id), "without vectors the old rules apply");
});

test("depth ladders: Harder makes an idea familiar, so it is not retaught, and posts built on it come next", () => {
  const basic = post("probability-statistics", "Bayes Theorem", { concept_ids: ["bayes-theorem"], difficulty: 2 });
  const aliases = new Map([["bayes-rule", "bayes-theorem"]]);
  const model = buildTaste({ posts: [basic], states: [state(basic, { read_at: ago(1), rating: "harder" })], now, aliases });
  assert.ok(model.familiarity("bayes-theorem") > 0.95, "Harder yesterday: familiar (evidence fades slowly)");
  assert.equal(model.familiarity("bayes-rule"), model.familiarity("bayes-theorem"), "the same idea under another tag");
  assert.equal(model.familiarity("priors"), 0);
  const read = buildTaste({ posts: [basic], states: [state(basic, { read_at: ago(1) })], now });
  assert.ok(read.familiarity("bayes-theorem") > 0.3 && read.familiarity("bayes-theorem") < 0.4, "one read is a third of the way");
  const nope = buildTaste({ posts: [basic], states: [state(basic, { rating: "uninteresting" })], now });
  assert.equal(nope.familiarity("bayes-theorem"), 0, "Not interesting never marks an idea as known");

  const again = post("probability-statistics", "Bayes Rule Basics", { concept_ids: ["bayes-rule"], difficulty: 2 });
  const next = post("probability-statistics", "Hierarchical Models", { concept_ids: ["hierarchical-models"], assumes: ["bayes-rule"], difficulty: 3 });
  const plain = post("probability-statistics", "Survey Weights", { concept_ids: ["survey-weights"], difficulty: 3 });
  assert.ok(model.readiness(next) > 0.95);
  assert.equal(model.readiness(plain), null, "assumes nothing");
  const picks = rankQueue({ model, candidates: [again, next, plain], assigned: [basic], need: 3, now, random: seededRandom(1) });
  const why = Object.fromEntries(picks.map((p) => [p.id, p.reasons]));
  assert.ok(why[next.id]?.ladder > 0.95, "the post built on Bayes is marked as the next step");
  const order = picks.map((p) => p.id);
  assert.ok(why[next.id].value > why[plain.id].value, "and is valued above an otherwise similar post");
  if (order.includes(again.id)) assert.ok(why[again.id].value < why[next.id].value, "the restatement is valued below it");
  if (order.includes(again.id)) assert.equal(why[again.id].reteach, true, "and is marked as reteaching");
  assert.equal(why[plain.id].reteach, undefined);
});

test("the briefing: today's unread news, best first, one post per story, two per publisher at most", async () => {
  const { chooseBriefing } = await import("../../scripts/content/taste.mjs");
  const { normalise } = await import("../../scripts/content/understand.mjs");
  const unit = (i, j = null) => { const v = new Float32Array(384); v[i] = 1; if (j !== null) v[j] = 0.2; return normalise(v); };
  const model = buildTaste({ posts: [], states: [], now });
  const news = (hoursAgo, publisher, extra = {}) => post("geopolitics-diplomacy", `Story ${serial}`, { content_type: "news", article_date: new Date(now - hoursAgo * 3_600_000).toISOString(), sources: [{ publisher }], ...extra });
  const a = news(2, "SCMP"), b = news(3, "Guardian"), sameStory = news(4, "Al Jazeera"), old = news(50, "CNN"), c = news(5, "SCMP"), d = news(6, "SCMP"), read = news(1, "CNN");
  const evergreen = post("ethics", "Virtue");
  const vectors = new Map([[a.id, unit(1)], [b.id, unit(2)], [sameStory.id, unit(1, 3)], [c.id, unit(4)], [d.id, unit(5)]]);
  const ids = chooseBriefing({ model, candidates: [a, b, sameStory, old, c, d, read, evergreen], excluded: new Set([read.id]), vectors, now });
  assert.ok(!ids.includes(sameStory.id), "the same story from another outlet is left out");
  assert.ok(!ids.includes(old.id) && !ids.includes(read.id) && !ids.includes(evergreen.id), "only fresh, unread news");
  assert.ok(ids.filter((id) => [a.id, c.id, d.id].includes(id)).length <= 2, "two per publisher at most");
  assert.ok(ids.length >= 3 && ids.length <= 5, ids.join());
});
