/**
 * Demand-led drafting: write what the feed will need, not whatever the feeds offer. X and Instagram rank what
 * already exists; T decides what to create, and drafting is its expensive step (AI quota), so it plans first.
 *
 * Each run works out:
 *   - the useful inventory: published, checked, unqueued posts the reader would plausibly enjoy (not resting,
 *     expected enjoyment ≥ 0.45, news still fresh)
 *   - how much the reader gets through (reads a day over the last week)
 *   - the gap to a few days' reading (at least the reserve), divided by how often a draft gets published
 * and from that, how many drafts this run should make (between a floor that keeps news flowing and the
 * configured limit), plus where the gaps are: stem fields short of their share, areas short of theirs, and
 * fresh news. Those gaps lift the triage scores of matching headlines, so the next drafts fill them.
 *
 * Pure functions; the runner supplies the data.
 */
import { SOURCES } from "./mixer.mjs";
import { placeOf, taxonomy } from "./taxonomy.mjs";

export const DEMAND = {
  inventoryDays: 4,    // keep this many days of reading waiting
  minInventory: 60,    // and never less than the reserve
  minDrafts: 2,        // per run, whatever the inventory: news goes stale in a fortnight
  yieldDefault: 0.6,   // share of drafts that get published, until there is a record
  usefulMean: 0.45,
  freshDays: 3,        // news counts as fresh inventory for this long
  needBoost: 0.3,      // added to a headline's triage score at full need
};

const DAY = 86_400_000;
const AREAS = taxonomy.umbrellas.filter((u) => u.id !== "other").map((u) => u.id);
const clamp = (low, high, value) => Math.min(high, Math.max(low, value));

/**
 * `posts` as the ranker reads them, `states` the reader's, `queued` the ids already in the feed, `model` from
 * buildTaste, `yieldRate` the published share of recent drafts (or null), `limit` the configured maximum.
 */
export function planDemand({ posts, states, queued, model, now = Date.now(), yieldRate = null, limit = 26,
  inventoryDays = DEMAND.inventoryDays, minDrafts = DEMAND.minDrafts }) {
  const reads = states.filter((s) => s.read_at && now - Date.parse(s.read_at) <= 7 * DAY).length;
  const readsPerDay = Math.max(5, reads / 7);
  const target = Math.max(DEMAND.minInventory, Math.round(readsPerDay * inventoryDays));

  const useful = [];
  const read = new Set(states.filter((s) => s.read_at).map((s) => s.post_id));
  for (const post of posts) {
    if (queued.has(post.id) || read.has(post.id) || post.status !== "published" || post.verification_status !== "source_checked") continue;
    if (post.content_type === "news" && !(now - Date.parse(post.article_date) < 14 * DAY)) continue;
    const e = model.estimate(post.field, post.subtopic, model.clusterOf?.(post.id) ?? null);
    if (model.pauseOf(e.place.field, e.sKey) || e.mean < DEMAND.usefulMean) continue;
    useful.push({ post, field: e.place.field, umbrella: e.place.umbrella });
  }

  // Where the mixer will look, and how much each part has waiting.
  const stem = [...(model.stemFields ?? [])];
  const shares = model.shares ?? SOURCES;
  const stemNeed = new Map(), areaNeed = new Map();
  let shortfall = 0;   // posts missing where the mixer will look, even if the inventory as a whole is ample
  for (const field of stem) {
    const want = (target * (shares.stem ?? SOURCES.stem)) / stem.length;
    const have = useful.filter((u) => u.field === field).length;
    stemNeed.set(field, clamp(0, 1, (want - have) / want));
    shortfall += Math.max(0, want - have);
  }
  const barWant = (target * (shares.bar ?? SOURCES.bar)) / AREAS.length;
  // Only areas the sources actually write about (a post in the last month) can be filled by drafting; an area
  // none of them covers would otherwise keep every run at its limit for nothing.
  const produced = new Set(posts.filter((p) => now - Date.parse(p.published_at ?? p.reviewed_at ?? "") < 30 * DAY).map((p) => placeOf(p.field).umbrella));
  for (const area of AREAS) {
    if (!produced.has(area)) continue;
    const have = useful.filter((u) => u.umbrella === area && !stem.includes(u.field)).length;
    areaNeed.set(area, clamp(0, 1, (barWant - have) / barWant));
    shortfall += Math.max(0, barWant - have);
  }
  const freshWant = Math.max(3, Math.round(readsPerDay * (shares.fresh ?? SOURCES.fresh) * DEMAND.freshDays));
  const freshHave = useful.filter((u) => u.post.content_type === "news" && now - Date.parse(u.post.article_date) < DEMAND.freshDays * DAY).length;
  const newsNeed = clamp(0, 1, (freshWant - freshHave) / freshWant);

  const rate = yieldRate === null ? DEMAND.yieldDefault : clamp(0.1, 1, yieldRate);
  const deficit = Math.max(0, target - useful.length, Math.ceil(shortfall));
  const drafts = clamp(Math.min(minDrafts, limit), limit,
    Math.ceil(deficit / rate) + Math.ceil(Math.max(0, freshWant - freshHave) / rate));

  return {
    drafts,
    /** How much a headline in this field fills a gap, 0 to 1: its stem field's need, else its area's. */
    needOf: (field) => {
      const place = placeOf(field);
      return stemNeed.has(place.field) ? stemNeed.get(place.field) : areaNeed.get(place.umbrella) ?? 0;
    },
    newsNeed,
    // Numbers only, safe for public logs.
    report: {
      readsPerDay: Math.round(readsPerDay * 10) / 10, target, useful: useful.length, deficit, yield: Math.round(rate * 100) / 100,
      drafts, freshNews: freshHave, freshWanted: freshWant,
      stemShort: [...stemNeed.values()].filter((n) => n > 0).length, areasShort: [...areaNeed.values()].filter((n) => n > 0.5).length,
    },
  };
}

/** A triage verdict with the demand added: headlines that fill a gap rise; nothing is skipped for it. */
export function withDemand(verdict, demand, { news = false } = {}) {
  if (!verdict || verdict.skip || !demand) return verdict;
  const need = Math.max(demand.needOf(verdict.field), news ? demand.newsNeed : 0);
  return { ...verdict, score: verdict.score + DEMAND.needBoost * need, need };
}
