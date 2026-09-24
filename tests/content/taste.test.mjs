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

test("the feed is built in batches: mostly favourites, some explorations, one stretch; varied and without repeats", () => {
  const history = [];
  const fields = ["algebra-number-theory", "quantum-physics", "ethics", "artificial-intelligence", "modern-history", "neuroscience"];
  for (const f of fields) for (let i = 0; i < 3; i++) history.push(post(f, `${f} ${i}`));
  const states = history.map((p, i) => (i % 3 === 0 ? disliked(p) : liked(p)));
  const model = buildTaste({ posts: history, states, now });
  const candidates = fields.flatMap((f) => [1, 2, 3, 4, 5].map((i) => post(f, `${f} new ${i}`)));
  const picks = rankQueue({ model, candidates, assigned: history, need: 10, now, random: seededRandom(7) });
  assert.equal(picks.length, 10);
  const slots = picks.map((p) => p.slot);
  assert.equal(slots.filter((s) => s === "stretch").length, 1);
  assert.ok(slots.filter((s) => s === "explore").length >= 1);
  assert.ok(slots.filter((s) => s === "favourite").length >= 7);
  assert.equal(slots[0], "favourite", "the batch opens with a favourite");
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const chosen = picks.map((p) => byId.get(p.id).field);
  for (let i = 1; i < chosen.length; i++) assert.notEqual(chosen[i], chosen[i - 1], "never two in a row from the same field");
  assert.equal(new Set(picks.map((p) => p.id)).size, 10);
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
    const first = rankQueue({ model, candidates: [plain, bridge, ...others], assigned: [], need: 10, now, random: seededRandom(seed) }).find((p) => p.slot === "explore")?.id;
    if (first === bridge.id) bridgeWins++;
    if (first === plain.id) plainWins++;
  }
  assert.ok(bridgeWins > 20 && bridgeWins > 2.5 * plainWins, `the bridging post is explored first most of the time (${bridgeWins} vs ${plainWins} of 40)`);
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
