import { cleanSubtopic, placeOf, taxonomy } from "./taxonomy.mjs";
import { UNDERSTANDING, cosine } from "./understand.mjs";
import { apportion, mixShares, spread, stemFieldsOf, trustedOf } from "./mixer.mjs";

/**
 * The reader's taste, learned from every signal, and the feed built from it.
 *
 * 1. Each post the reader has dealt with gets one enjoyment score (REWARDS).
 * 2. Scores roll up an umbrella → field → subtopic ladder, and per source. Each rung borrows from the one
 *    above until it has evidence of its own (Bayesian shrinkage), so a new subtopic in a loved field starts
 *    hopeful and one in a disliked field starts cautious, never written off. Old evidence fades.
 * 3. The feed is built in batches: mostly favourites, a self-tuning share of explorations chosen by Thompson
 *    sampling (weighted to uncertain and under-read areas, approached through ideas the reader already
 *    likes), and one stretch post. Variety rules and a breadth floor keep the T-shape from collapsing.
 *
 * Pure functions throughout: time and randomness are passed in, so tests are exact.
 */

export const REWARDS = { uninteresting: 0, skipped: 0.25, read: 0.55, deeper: 0.75, more: 0.8, harder: 0.85, opened: 0.9, saved: 1 };

/**
 * Reading time refines the two weakest signals (needs `dwell_ms`, migration 202610020001; without it, or for
 * posts read before it was measured, the plain values above apply). A read earns 0.5 for a quick look up to
 * 0.65 for the time a careful read takes; scrolled past after less than 1.5 s in view is 0.15, a longer look
 * that never became a read 0.3. Anything at or above READ_MIN counts as read for the report card.
 */
export const DWELL = { readMin: 0.5, readFull: 0.65, passedOver: 0.15, glanced: 0.3, glanceMs: 1500, postMs: 45_000, excerptMs: 20_000 };
export const READ_MIN = DWELL.readMin;

export const SETTINGS = {
  prior: 0.55,              // expected enjoyment of an unknown post
  strength: 3,              // pseudo-posts each rung borrows from the rung above
  publisherStrength: 5,
  halfLifeDays: 60,         // evidence weight halves every two months
  skipAfterHours: 24,       // seen but unread for this long counts as scrolled past
  batch: 10,
  explore: { min: 0.15, max: 0.3, start: 0.25, minSamples: 5 },
  snooze: { dislikes: 2, days: 30, subtopicsForField: 3 },
  // After a Not interesting, the subtopic's posts score at 0.2× and recover linearly over six weeks, unless
  // something there is enjoyed again (X's feedback fatigue: 0.2× recovering over 140 days for an author).
  fatigue: { floor: 0.2, days: 42 },
  // Each earlier post from the same publisher among the last ten placed multiplies a candidate's score by a
  // decaying factor, down to a floor (X's author diversity: 0.25 + 0.75 × 0.5^k).
  publisherDecay: { decay: 0.5, floor: 0.25, window: 10 },
  // Depth ladders: reteaching a familiar idea (familiarity ≥ 0.8) scores ×0.7; a post whose prerequisites are at least half
  // familiar and that teaches something new scores up to ×1.25, and may fill the stretch slot.
  ladder: { reteach: 0.7, ready: 0.5, boost: 0.25, familiar: 0.8 },
  breadthWindow: 20,        // every area with posts available appears at least once in this many
  niche: { minMean: 0.7, lift: 0.12, minWeight: 0.8 },
  metricsWindow: 60,
};

const DAY = 86_400_000;
const clamp = (low, high, value) => Math.min(high, Math.max(low, value));

export const subtopicKey = (field, subtopic) => `${field}::${cleanSubtopic(subtopic).toLowerCase()}`;
/** Credit a post to the source in the config: "blog.example (via Hacker News)" belongs to Hacker News. */
export const sourceOf = (publisher) => {
  const via = /\(via (.+)\)\s*$/.exec(publisher ?? "");
  return ((via ? via[1] : publisher) ?? "").trim() || "unknown";
};
const publisherOfPost = (post) => sourceOf(post.sources?.[0]?.publisher ?? post.publisher);

/** One enjoyment score in [0, 1], or null when there is no evidence yet. "Not interesting" always wins. */
export function rewardOf(state, now = Date.now(), post = null) {
  if (!state) return null;
  if (state.rating === "uninteresting") return REWARDS.uninteresting;
  const dwell = Number(state.dwell_ms) > 0 ? Number(state.dwell_ms) : 0;
  // How long a careful read of this post takes: a full post's explanation and insight, or an excerpt's paragraph.
  const fullRead = post?.kind === "excerpt" ? DWELL.excerptMs : DWELL.postMs;
  const read = dwell ? DWELL.readMin + (DWELL.readFull - DWELL.readMin) * Math.min(1, dwell / fullRead) : REWARDS.read;
  const positives = [
    state.bookmarked === true && REWARDS.saved,
    state.opened_at && REWARDS.opened,
    state.rating === "harder" && REWARDS.harder,
    state.rating === "more" && REWARDS.more,
    state.deeper_opened_at && REWARDS.deeper,
    state.read_at && read,
  ].filter((value) => typeof value === "number");
  if (positives.length) return Math.max(...positives);
  if (state.first_seen_at && now - Date.parse(state.first_seen_at) > SETTINGS.skipAfterHours * 3_600_000)
    return !dwell ? REWARDS.skipped : dwell < DWELL.glanceMs ? DWELL.passedOver : DWELL.glanced;
  return null;
}

/** Deterministic random numbers for tests and reproducible runs. */
export function seededRandom(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function gamma(shape, random) {
  // Marsaglia and Tsang; boosted for shape < 1.
  if (shape < 1) return gamma(shape + 1, random) * random() ** (1 / shape);
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do {
      // Box–Muller normal.
      const u1 = Math.max(random(), 1e-12), u2 = random();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v ** 3;
    const u = Math.max(random(), 1e-12);
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}
export function sampleBeta(alpha, beta, random) {
  const a = gamma(Math.max(alpha, 0.05), random), b = gamma(Math.max(beta, 0.05), random);
  return a / (a + b);
}

const AREAS = taxonomy.umbrellas.filter((u) => u.id !== "other").map((u) => u.id);

/**
 * Learn the reader's taste from their posts, reading states and explicit steering (More / Less / Snooze).
 * `queue` is the feed in order ({ post_id, position, slot }), used for the feed's own report card.
 * `clusters` (post id → idea cluster, from understand.mjs) adds a rung beside the subtopic: taste learnt on
 * one idea carries to the same idea under another subtopic name.
 */
export function buildTaste({ posts, states, prefs = [], queue = [], now = Date.now(), clusters = new Map(), aliases = new Map() }) {
  // Concept tags folded to canonical concepts (understand.mjs), so familiarity is per idea, not per spelling.
  const canon = (c) => aliases.get(c) ?? c;
  const conceptsOf = (post) => [...new Set((post.concept_ids ?? []).map(canon))];
  const familiar = new Map();     // canonical concept → evidence the reader already knows it
  const stateById = new Map(states.map((s) => [s.post_id, s]));
  const postById = new Map(posts.map((p) => [p.id, p]));
  const nodes = new Map();
  const node = (key) => { let n = nodes.get(key); if (!n) nodes.set(key, n = { w: 0, wr: 0, count: 0, dislikes: 0, positives: 0, lastDislike: 0, lastPositive: 0 }); return n; };
  const names = new Map();       // subtopic key → display name
  const liked = new Map(), disliked = new Map();
  const difficulty = new Map();  // field → { w, wd, shift }
  let totalW = 0, totalWR = 0;

  for (const post of posts) {
    const state = stateById.get(post.id);
    const reward = rewardOf(state, now, post);
    if (reward === null) continue;
    const at = Date.parse(state.updated_at ?? state.read_at ?? state.first_seen_at ?? "") || now;
    const w = 0.5 ** (Math.max(0, now - at) / (SETTINGS.halfLifeDays * DAY));
    const place = placeOf(post.field);
    const sKey = subtopicKey(place.field, post.subtopic);
    if (!names.has(sKey)) names.set(sKey, cleanSubtopic(post.subtopic) || place.fieldLabel);
    const cluster = clusters.get(post.id);
    const keys = [`u:${place.umbrella}`, `f:${place.field}`, `s:${sKey}`, `p:${publisherOfPost(post)}`];
    if (cluster !== undefined && cluster !== null) keys.push(`k:${cluster}`);
    for (const key of keys) {
      const n = node(key);
      n.w += w; n.wr += w * reward; n.count++;
      if (reward === REWARDS.uninteresting) { n.dislikes++; n.lastDislike = Math.max(n.lastDislike, at); }
      if (reward >= REWARDS.deeper) { n.positives++; n.lastPositive = Math.max(n.lastPositive, at); }
    }
    totalW += w; totalWR += w * reward;
    // Familiarity: Harder says "I know this" outright; enjoying a post (deeper or better) counts half; a read
    // a third, so three reads make an idea familiar. Not interesting says nothing about knowing.
    const learnt = state.rating === "harder" ? 1 : reward >= REWARDS.deeper ? 0.5 : reward >= READ_MIN ? 0.34 : 0;
    for (const concept of conceptsOf(post)) {
      if (reward >= REWARDS.deeper) liked.set(concept, (liked.get(concept) ?? 0) + w);
      if (reward <= REWARDS.skipped) disliked.set(concept, (disliked.get(concept) ?? 0) + w);
      if (learnt) familiar.set(concept, (familiar.get(concept) ?? 0) + learnt * w);
    }
    const d = difficulty.get(place.field) ?? { w: 0, wd: 0, shift: 0 };
    // Excerpts are the publisher's words, not graded on the scale: they say nothing about the level you read at.
    if (reward >= READ_MIN && post.kind !== "excerpt") { d.w += w; d.wd += w * (post.difficulty ?? 2); }
    if (state.rating === "harder") d.shift += 0.4 * w;
    if (reward <= REWARDS.skipped && (post.difficulty ?? 2) >= 4) d.shift -= 0.3 * w;
    difficulty.set(place.field, d);
  }

  const prior = (totalWR + 2 * SETTINGS.prior) / (totalW + 2);
  const meanOf = (key, parent, strength = SETTINGS.strength) => {
    const n = nodes.get(key);
    return ((n?.wr ?? 0) + strength * parent) / ((n?.w ?? 0) + strength);
  };
  const weightOf = (key) => nodes.get(key)?.w ?? 0;

  // Explicit steering from the Map. A current "more" overrides any learned pause beneath it.
  const pref = new Map();
  for (const p of prefs) {
    if (p.choice === "snooze" && p.until && Date.parse(p.until) <= now) continue;
    pref.set(`${p.scope}:${p.key}`, p);
  }
  const prefFor = (field, sKey) => pref.get(`subtopic:${sKey}`) ?? pref.get(`field:${field}`) ?? null;
  // "stem" (a field chosen as one of the reader's deep fields on the Map) counts as More, and more.
  const keen = (choice) => choice === "more" || choice === "stem";
  const multiplier = (choice) => (keen(choice) ? 1.25 : choice === "less" ? 0.7 : 1);

  // Learned pauses: a subtopic with repeated "Not interesting" and nothing positive rests for 30 days after the
  // latest dislike, then gets one more try. A field rests only when several of its subtopics do.
  const learnedSubtopic = (sKey) => {
    const n = nodes.get(`s:${sKey}`);
    if (!n || n.dislikes < SETTINGS.snooze.dislikes || n.positives > 0) return null;
    const until = n.lastDislike + SETTINGS.snooze.days * DAY;
    return until > now ? until : null;
  };
  const pausedByField = new Map();
  for (const key of nodes.keys()) {
    if (!key.startsWith("s:")) continue;
    const sKey = key.slice(2), until = learnedSubtopic(sKey);
    if (!until) continue;
    const field = sKey.split("::")[0];
    const entry = pausedByField.get(field) ?? { count: 0, until: 0 };
    entry.count++; entry.until = Math.max(entry.until, until);
    pausedByField.set(field, entry);
  }

  /**
   * Expected enjoyment of a subtopic, borrowing from its field and area. With an idea cluster, the cluster's
   * own record (itself shrunk towards the field) is blended in, the more so the less the subtopic has: a new
   * subtopic name inside a well-read idea starts where that idea stands.
   */
  const estimate = (field, subtopic, cluster = null) => {
    const place = placeOf(field);
    const sKey = subtopicKey(place.field, subtopic);
    const umbrellaMean = meanOf(`u:${place.umbrella}`, prior);
    const fieldMean = meanOf(`f:${place.field}`, umbrellaMean);
    const subtopicMean = meanOf(`s:${sKey}`, fieldMean);
    const ws = weightOf(`s:${sKey}`) + SETTINGS.strength;
    const wc = cluster === null || cluster === undefined ? 0 : weightOf(`k:${cluster}`);
    const lambda = wc / (wc + ws);
    const mean = lambda ? (1 - lambda) * subtopicMean + lambda * meanOf(`k:${cluster}`, fieldMean) : subtopicMean;
    const n = ws + lambda * wc;
    return { place, sKey, umbrellaMean, fieldMean, mean, alpha: mean * n, beta: (1 - mean) * n, uncertainty: 1 / Math.sqrt(n) };
  };

  /** Why, if at all, a whole field is resting now. */
  const fieldPause = (field) => {
    const p = pref.get(`field:${field}`);
    if (keen(p?.choice)) return null;
    if (p?.choice === "snooze") return { by: "you", until: p.until ? Date.parse(p.until) : null };
    const f = pausedByField.get(field);
    if (f && f.count >= SETTINGS.snooze.subtopicsForField && meanOf(`f:${field}`, prior) < prior) return { by: "feed", until: f.until };
    return null;
  };
  /** Why, if at all, this subtopic is resting now, on its own account or its field's. */
  const pauseOf = (field, sKey) => {
    const p = pref.get(`subtopic:${sKey}`);
    if (keen(p?.choice)) return null;
    if (p?.choice === "snooze") return { by: "you", until: p.until ? Date.parse(p.until) : null };
    if (p?.choice !== "less") {
      const sub = learnedSubtopic(sKey);
      if (sub && !keen(pref.get(`field:${field}`)?.choice)) return { by: "feed", until: sub };
    }
    return fieldPause(field);
  };

  /** 1 normally; after a recent Not interesting in this subtopic, less, recovering to 1 over the fatigue window. */
  const fatigue = (field, sKey) => {
    const n = nodes.get(`s:${sKey}`);
    if (!n?.lastDislike || n.lastPositive > n.lastDislike) return 1;
    if (keen(pref.get(`subtopic:${sKey}`)?.choice) || keen(pref.get(`field:${field}`)?.choice)) return 1;
    const age = Math.max(0, now - n.lastDislike) / (SETTINGS.fatigue.days * DAY);
    return age >= 1 ? 1 : SETTINGS.fatigue.floor + (1 - SETTINGS.fatigue.floor) * age;
  };

  const targetDifficulty = (field) => {
    const d = difficulty.get(field);
    const base = d?.w ? d.wd / d.w : 2.5;
    return clamp(1, 5, base + clamp(-1.5, 1.5, d?.shift ?? 0));
  };

  const readShare = new Map(AREAS.map((a) => [a, weightOf(`u:${a}`)]));
  const readTotal = [...readShare.values()].reduce((sum, v) => sum + v, 0);
  /** 1 for an area you have barely read, 0 once it has its fair share (one tenth). */
  const gap = (umbrella) => (umbrella === "other" ? 0 : clamp(0, 1, 1 - (readTotal ? (readShare.get(umbrella) ?? 0) / readTotal : 0) * AREAS.length));
  /**
   * Your comfort zone: an area that already has a large share of your reading (twice its fair share counts in
   * full) and that you enjoy more than average. An area read a lot but disliked is not a comfort zone.
   */
  const comfort = (umbrella) => {
    const heavy = clamp(0, 1, (readTotal ? (readShare.get(umbrella) ?? 0) / readTotal : 0) * AREAS.length / 2);
    const enjoyed = clamp(0, 1, (meanOf(`u:${umbrella}`, prior) - (prior - 0.05)) / 0.2);
    return heavy * enjoyed;
  };

  const conceptScore = (concepts, table) => clamp(0, 1, [...new Set((concepts ?? []).map(canon))].reduce((sum, c) => sum + (table.get(c) ?? 0), 0) / 2);
  const familiarity = (concept) => clamp(0, 1, familiar.get(canon(concept)) ?? 0);
  /** How ready the reader is for a post: the mean familiarity of what it assumes; null if it assumes nothing. */
  const readiness = (post) => {
    const needs = [...new Set((post.assumes ?? []).map(canon))].filter((c) => !conceptsOf(post).includes(c));
    return needs.length ? needs.reduce((sum, c) => sum + familiarity(c), 0) / needs.length : null;
  };

  // The feed's report card, over the most recent posts it placed that now have an outcome.
  const resolved = queue
    .map((q) => ({ q, reward: rewardOf(stateById.get(q.post_id), now, postById.get(q.post_id)) }))
    .filter((r) => r.reward !== null && postById.has(r.q.post_id))
    .sort((a, b) => (b.q.position ?? 0) - (a.q.position ?? 0))
    .slice(0, SETTINGS.metricsWindow);
  const share = (rows, test) => (rows.length ? rows.filter(test).length / rows.length : null);
  const explorations = resolved.filter((r) => r.q.slot === "explore" || r.q.slot === "stretch");
  const metrics = {
    placed: resolved.length,
    hitRate: share(resolved, (r) => r.reward >= READ_MIN),
    delightRate: share(resolved, (r) => r.reward >= REWARDS.more),
    explorations: explorations.length,
    explorationHitRate: share(explorations, (r) => r.reward >= READ_MIN),
  };
  // Exploration earns its share: as good as favourites → 30%; never landing → 15%. Never zero.
  const exploreShare = metrics.explorations < SETTINGS.explore.minSamples || metrics.hitRate === null
    ? SETTINGS.explore.start
    : clamp(SETTINGS.explore.min, SETTINGS.explore.max,
      SETTINGS.explore.min + (SETTINGS.explore.max - SETTINGS.explore.min) * clamp(0, 1, metrics.explorationHitRate / Math.max(metrics.hitRate, 0.1)));

  // The mixer's inputs: how each source's placements have landed, the stem fields and the trusted sources.
  const bySource = {};
  for (const r of queue.map((q) => ({ q, reward: rewardOf(stateById.get(q.post_id), now, postById.get(q.post_id)) }))
    .filter((r) => r.reward !== null && r.q.reasons?.source).sort((a, b) => (b.q.position ?? 0) - (a.q.position ?? 0)).slice(0, 4 * SETTINGS.metricsWindow)) {
    const s = (bySource[r.q.reasons.source] ??= { n: 0, hits: 0 });
    s.n++; if (r.reward >= READ_MIN) s.hits++;
  }
  const shares = mixShares(bySource, metrics.hitRate);
  const fieldRows = [];
  const publisherRows = [];
  for (const [key, n] of nodes) {
    if (key.startsWith("f:")) {
      const field = key.slice(2);
      fieldRows.push({ field, weight: n.w, mean: meanOf(key, meanOf(`u:${placeOf(field).umbrella}`, prior)) });
    } else if (key.startsWith("p:")) publisherRows.push({ publisher: key.slice(2), weight: n.w, mean: meanOf(key, prior, SETTINGS.publisherStrength) });
  }
  const chosenStem = prefs.filter((p) => p.scope === "field" && p.choice === "stem").map((p) => p.key);
  const stemFields = stemFieldsOf({ chosen: chosenStem, fields: fieldRows, prior });
  const trusted = trustedOf({ publishers: publisherRows, prior });

  // Discovered niches: subtopics you clearly enjoy inside an area you otherwise read less or like less.
  const niches = [];
  for (const [key, n] of nodes) {
    if (!key.startsWith("s:") || n.w < SETTINGS.niche.minWeight || n.positives === 0) continue;
    const sKey = key.slice(2), field = sKey.split("::")[0];
    const e = estimate(field, names.get(sKey) ?? "");
    if (e.mean >= SETTINGS.niche.minMean && e.mean - e.umbrellaMean >= SETTINGS.niche.lift && e.umbrellaMean <= prior + 0.02)
      niches.push({ key: sKey, field, umbrella: e.place.umbrella, name: names.get(sKey), mean: e.mean, lift: e.mean - e.umbrellaMean });
  }
  niches.sort((a, b) => b.lift - a.lift);

  return {
    now, prior, exploreShare, metrics, niches: niches.slice(0, 8),
    shares, bySource, stemFields, stemChosen: chosenStem.length > 0, trusted,
    estimate, pauseOf, fieldPause, prefFor, fatigue, clusterOf: (id) => clusters.get(id) ?? null, multiplier, targetDifficulty, gap, comfort, weightOf, meanOf, names, nodes,
    canonical: canon, conceptsOf, familiarity, readiness,
    bridge: (concepts) => conceptScore(concepts, liked),
    avoid: (concepts) => conceptScore(concepts, disliked),
    publisherMean: (publisher) => meanOf(`p:${sourceOf(publisher)}`, prior, SETTINGS.publisherStrength),
    publisherWeight: (publisher) => weightOf(`p:${sourceOf(publisher)}`),
  };
}

/** Expected enjoyment of one post, before any exploring: the number favourites are chosen by. */
function expected(model, post, known) {
  const e = model.estimate(post.field, post.subtopic, model.clusterOf?.(post.id) ?? null);
  const choice = model.prefFor(e.place.field, e.sKey)?.choice;
  let value = e.mean + 0.3 * (model.publisherMean(publisherOfPost(post)) - model.prior);
  // An excerpt is the publisher's own summary, with no difficulty of its own to fit: neutral.
  const fit = post.kind === "excerpt" ? 1 : Math.exp(-(((post.difficulty ?? 2) - model.targetDifficulty(e.place.field)) ** 2) / 2);
  value *= (0.85 + 0.15 * fit) * model.multiplier(choice) * model.fatigue(e.place.field, e.sKey);
  const concepts = model.conceptsOf ? model.conceptsOf(post) : post.concept_ids ?? [];
  const novelty = concepts.length ? concepts.filter((c) => !known.has(c)).length / concepts.length : 1;
  value *= 0.8 + 0.2 * novelty;
  // Depth ladders. Reteaching what the reader already knows, at no greater difficulty, is scored down; a post
  // that builds on what they know (its prerequisites familiar) and teaches something new is the next step.
  const target = model.targetDifficulty(e.place.field);
  const familiarity = model.familiarity ?? (() => 0);
  const mastered = concepts.length ? Math.min(...concepts.map(familiarity)) : 0;
  const reteach = mastered >= SETTINGS.ladder.familiar && (post.difficulty ?? 2) <= target;
  if (reteach) value *= SETTINGS.ladder.reteach;
  const ready = model.readiness ? model.readiness(post) : null;
  const ladder = ready !== null && ready >= SETTINGS.ladder.ready && concepts.some((c) => familiarity(c) < 0.5) ? ready : 0;
  if (ladder) value *= 1 + SETTINGS.ladder.boost * ladder;
  if (post.content_type === "news") {
    const age = (model.now - Date.parse(post.article_date ?? post.reviewed_at ?? model.now)) / DAY;
    value *= 1 - clamp(0, 0.3, age * 0.04);
  }
  return { value, e, choice, novelty, fit, ladder, reteach };
}

/**
 * The Briefing ring: today's news, at most `limit` posts, one per story. Fresh (article within 36 hours),
 * unread, not resting, not already in the feed; best expected enjoyment first; a post too close to one already
 * chosen (the same story from another outlet, by the understanding model) is left out, and no publisher has
 * more than two. Returns post ids in ring order.
 */
export function chooseBriefing({ model, candidates, excluded = new Set(), vectors = new Map(), now = Date.now(), limit = 5 }) {
  const fresh = [];
  for (const post of candidates) {
    if (excluded.has(post.id) || post.status !== "published" || post.verification_status !== "source_checked" || post.content_type !== "news") continue;
    const age = now - Date.parse(post.article_date ?? "");
    if (!(age >= 0 && age < 36 * 3_600_000)) continue;
    const e = model.estimate(post.field, post.subtopic, model.clusterOf?.(post.id) ?? null);
    if (model.pauseOf(e.place.field, e.sKey)) continue;
    fresh.push({ post, value: expected(model, post, new Set()).value, publisher: publisherOfPost(post), vec: vectors.get(post.id) ?? null });
  }
  fresh.sort((a, b) => b.value - a.value || a.post.id.localeCompare(b.post.id));
  const chosen = [];
  for (const item of fresh) {
    if (chosen.length >= limit) break;
    if (chosen.filter((c) => c.publisher === item.publisher).length >= 2) continue;
    if (item.vec && chosen.some((c) => c.vec && cosine(c.vec, item.vec) >= UNDERSTANDING.near)) continue;
    chosen.push(item);
  }
  return chosen.map((c) => c.post.id);
}

/** Names the ranker that placed a post, stored with each placement so rankers can be compared later. */
export const RANKER = "mixer-1";
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/**
 * Why a post was placed, in a few numbers and one plain reason code, stored with the placement (never
 * logged: it describes the reader's taste). Codes: favourite, excerpt, thin-area, bar, bridge, uncertain, next-step, stem,
 * trusted, fresh,
 * breadth, harder.
 */
function reasonsFor(pick, slot, why) {
  return {
    v: 1, slot, why, field: pick.field, umbrella: pick.umbrella,
    value: r2(pick.fav), explore: r2(pick.explore), mean: r2(pick.mean), novelty: r2(pick.novelty), fit: r2(pick.fit),
    difficulty: pick.post.difficulty ?? null, target: r2(pick.target), gap: r2(pick.gap), bridge: r2(pick.bridge),
    ...(pick.choice ? { steer: pick.choice } : {}),
    ...(pick.fatigue < 1 ? { fatigue: r2(pick.fatigue) } : {}),
    ...(pick.ladder ? { ladder: r2(pick.ladder) } : {}),
    ...(pick.reteach ? { reteach: true } : {}),
  };
}
const exploreReason = (pick) => (pick.gap >= 0.5 ? "thin-area" : pick.bridge >= 0.25 ? "bridge" : "uncertain");

/**
 * Choose and order the next `need` posts. Returns [{ id, slot }] where slot is favourite, explore or stretch.
 * `assigned` is the feed so far (posts in queue order); `candidates` are published posts not yet in it.
 */
export function rankQueue({ model, candidates, assigned, need, now = Date.now(), random = Math.random, vectors = new Map() }) {
  if (need <= 0) return [];
  // Idea-level repeats (needs post vectors, from understand.mjs): a candidate that says what a post already in
  // the feed said is dropped, unless it is harder, which makes it the next step rather than a repeat.
  const recentVectors = assigned.slice(-500).flatMap((p) => (vectors.has(p.id) ? [{ post: p, vec: vectors.get(p.id) }] : []));
  const twinOf = (post, vec, among) => among.find((other) => other.post.id !== post.id && cosine(vec, other.vec) >= UNDERSTANDING.duplicate
    && (post.difficulty ?? 2) <= (other.post.difficulty ?? 2));
  const assignedIds = new Set(assigned.map((p) => p.id));
  const conceptsOf = model.conceptsOf ?? ((p) => p.concept_ids ?? []);
  const known = new Set(assigned.flatMap(conceptsOf));
  const seenSubtopics = new Set(assigned.map((p) => subtopicKey(placeOf(p.field).field, p.subtopic)));
  const describe = (p) => {
    const place = placeOf(p.field);
    return { post: p, id: p.id, field: place.field, umbrella: place.umbrella, subKey: subtopicKey(place.field, p.subtopic), publisher: publisherOfPost(p), excerpt: p.kind === "excerpt", vec: vectors.get(p.id) ?? null };
  };

  const pool = [];
  for (const post of candidates) {
    if (assignedIds.has(post.id) || post.status !== "published" || post.verification_status !== "source_checked") continue;
    if (post.content_type === "news" && !(now - Date.parse(post.reviewed_at) < 7 * DAY
      && now - Date.parse(post.article_date) < 14 * DAY && Date.parse(post.article_date) <= now)) continue;
    const d = describe(post);
    if (model.pauseOf(d.field, d.subKey)) continue;
    const concepts = conceptsOf(post);
    // A true repeat: every idea already in the feed, in a subtopic already covered.
    if (concepts.length && concepts.every((c) => known.has(c)) && seenSubtopics.has(d.subKey)) continue;
    if (d.vec && twinOf(post, d.vec, recentVectors)) continue;
    const x = expected(model, post, known);
    const theta = sampleBeta(x.e.alpha, x.e.beta, random);
    const weakArea = x.e.umbrellaMean < model.prior;
    // Exploration looks outside the comfort zone: areas that already fill your reading are discounted (their
    // depth comes from favourites and stretch posts); weak, thin or unread areas are not.
    const comfort = model.comfort(d.umbrella);
    const weakness = clamp(0, 1, (model.prior - x.e.umbrellaMean) / 0.25);
    d.fav = x.value;
    d.mean = x.e.mean;
    d.novelty = x.novelty;
    d.fit = x.fit;
    d.choice = x.choice;
    d.gap = model.gap(d.umbrella);
    d.bridge = model.bridge(concepts);
    d.fatigue = model.fatigue(d.field, d.subKey);
    d.ladder = x.ladder;
    d.reteach = x.reteach;
    d.explore = (theta + 0.35 * model.gap(d.umbrella) + 0.2 * weakness + (weakArea ? 0.3 : 0.15) * model.bridge(concepts)
      - 0.3 * model.avoid(concepts) + 0.1 * x.e.uncertainty) * (1 - 0.5 * comfort) * model.multiplier(x.choice) * model.fatigue(d.field, d.subKey);
    const target = model.targetDifficulty(d.field);
    d.target = target;
    d.harderStretch = (post.difficulty ?? 2) >= target + 0.5 && target > 2.5;
    d.inStem = model.stemFields?.has(d.field) ?? false;
    d.trusted = model.trusted?.has(d.publisher) ?? false;
    d.news = post.content_type === "news";
    d.accessible = post.kind === "excerpt" || (post.difficulty ?? 2) <= target + 0.5;
    pool.push(d);
  }

  const history = assigned.map(describe);
  const recentUmbrellas = new Set(history.slice(-(SETTINGS.breadthWindow - 1)).map((h) => h.umbrella));
  const picks = [];
  const allowed = (c, level) => {
    const prev = history.at(-1);
    if (level < 4 && prev && prev.field === c.field) return false;
    if (level < 3 && history.slice(-4).filter((h) => h.umbrella === c.umbrella).length >= 2) return false;
    if (level < 2 && c.mean < 0.8 && history.slice(-9).some((h) => h.subKey === c.subKey)) return false;
    if (level < 1 && prev && prev.publisher === c.publisher) return false;
    return true;
  };
  const best = (rawScore, filter = () => true) => {
    const recent = history.slice(-SETTINGS.publisherDecay.window).map((h) => h.publisher);
    const nearby = history.slice(-5).flatMap((h) => (h.vec ? [h.vec] : []));
    const { decay, floor } = SETTINGS.publisherDecay;
    const score = (c) => {
      const s = rawScore(c), k = recent.filter((p) => p === c.publisher).length;
      // Close to something just placed, but not the same idea: scored down, so the batch keeps its variety.
      const closest = c.vec ? Math.max(0, ...nearby.map((v) => cosine(c.vec, v))) : 0;
      const nearness = Math.min(1, Math.max(0, (closest - UNDERSTANDING.near) / (UNDERSTANDING.duplicate - UNDERSTANDING.near)));
      const factor = (floor + (1 - floor) * decay ** k) * (1 - 0.5 * nearness);
      return s >= 0 ? s * factor : s / factor;
    };
    for (let level = 0; level <= 4; level++) {
      let top = null, topScore = -Infinity;
      for (const c of pool) {
        if (!filter(c) || !allowed(c, level)) continue;
        const value = score(c);
        if (!top || value > topScore) { top = c; topScore = value; }
      }
      if (top) return top;
    }
    return null;
  };

  // Each source's choice, and what to fall back on when it has nothing to offer. `first` marks the batch's
  // first bar slot, which serves the breadth floor: an area with posts waiting that has not appeared recently.
  const pickers = {
    stem: () => [best((c) => c.fav * (c.harderStretch ? 1.15 : 1), (c) => c.inStem), (c) => (c.ladder ? "next-step" : "stem")],
    trusted: () => [best((c) => c.fav, (c) => c.trusted), () => "trusted"],
    fresh: () => [best((c) => c.fav, (c) => c.news), () => "fresh"],
    bar: (first) => {
      const due = first ? new Set(pool.map((c) => c.umbrella).filter((u) => u !== "other" && !recentUmbrellas.has(u))) : new Set();
      const floor = due.size ? best((c) => c.explore, (c) => due.has(c.umbrella)) : null;
      if (floor) return [floor, () => "breadth"];
      return [best((c) => c.fav * (0.6 + 0.8 * c.gap), (c) => !c.inStem && c.accessible), (c) => (c.gap >= 0.5 ? "thin-area" : "bar")];
    },
    bridges: () => [best((c) => c.explore, (c) => !c.inStem && c.bridge >= 0.15), () => "bridge"],
    wild: () => [best((c) => c.explore), exploreReason],
    any: () => [best((c) => c.fav), () => "favourite"],
  };
  const FALLBACK = ["stem", "trusted", "bar", "wild", "any"];
  const slotOf = (source, why) => (why === "breadth" ? "stretch" : ["bar", "bridges", "wild"].includes(source) ? "explore" : "favourite");

  while (picks.length < need && pool.length) {
    const size = Math.min(SETTINGS.batch, need - picks.length);
    const order = spread(apportion(model.shares ?? { any: 1 }, SETTINGS.batch, random)).slice(0, size);
    // Excerpt sources (no AI) were asked for by name, but a one-paragraph excerpt rarely outscores a full post,
    // so one place per batch goes to the best waiting excerpt — unless the reader has come to dislike what is on
    // offer, which the taste model then says.
    const excerptAt = order.length >= 2 ? Math.min(3, order.length - 1) : -1;
    let barSeen = false;
    for (const [index, wanted] of order.entries()) {
      if (!pool.length) break;
      let pick = null, why = null, source = wanted;
      if (index === excerptAt) {
        const offer = best((c) => c.fav, (c) => c.excerpt);
        if (offer && offer.fav >= 0.6 * model.prior) { pick = offer; why = "excerpt"; source = "trusted"; }
      }
      for (const candidate of [wanted, ...FALLBACK.filter((f) => f !== wanted)]) {
        if (pick) break;
        const [found, reason] = pickers[candidate](candidate === "bar" && !barSeen);
        if (found) { pick = found; why = reason(found); source = candidate; }
      }
      if (!pick) break;
      if (source === "bar") barSeen = true;
      const slot = slotOf(source, why);
      pool.splice(pool.indexOf(pick), 1);
      // The same idea in other words, waiting in the pool, is not placed after it.
      if (pick.vec) for (let i = pool.length - 1; i >= 0; i--) {
        if (pool[i].vec && twinOf(pool[i].post, pool[i].vec, [{ post: pick.post, vec: pick.vec }])) pool.splice(i, 1);
      }
      history.push(pick); recentUmbrellas.add(pick.umbrella);
      for (const c of conceptsOf(pick.post)) known.add(c);
      picks.push({ id: pick.id, slot, reasons: { ...reasonsFor(pick, slot, why), source } });
    }
  }
  return picks;
}

/**
 * Order sources for drafting: overdue sources first (none may miss two runs in a row), then by a sampled
 * enjoyment score plus how much each fills gaps in the map. The top third get two turns in the first round.
 */
export function planSources({ model, groups, lastDrafted = new Map(), postsByPublisher = new Map(), now = Date.now(), random = Math.random }) {
  const scored = groups.map((group) => {
    const mean = model.publisherMean(group.publisher);
    const n = model.publisherWeight(group.publisher) + SETTINGS.publisherStrength;
    const umbrellas = postsByPublisher.get(group.publisher) ?? [];
    const coverage = umbrellas.length ? umbrellas.reduce((sum, u) => sum + model.gap(u), 0) / umbrellas.length : 0.5;
    const last = lastDrafted.get(group.publisher) ?? 0;
    return { group, overdue: now - last > 6.5 * 3_600_000, score: sampleBeta(mean * n, (1 - mean) * n, random) + 0.15 * coverage };
  });
  scored.sort((a, b) => Number(b.overdue) - Number(a.overdue) || b.score - a.score);
  const extra = new Set([...scored].sort((a, b) => b.score - a.score).slice(0, Math.ceil(scored.length / 3)).map((s) => s.group.publisher));
  return scored.map((s) => ({ group: s.group, turns: extra.has(s.group.publisher) ? 2 : 1 }));
}

/** Judge a headline the triage call has filed: skip it if resting, otherwise how worth drafting it is. */
export function judgeTopic(model, { field, subtopic, publisher }, random = Math.random) {
  const e = model.estimate(field, subtopic);
  if (model.pauseOf(e.place.field, e.sKey)) return { skip: true, score: 0 };
  const choice = model.prefFor(e.place.field, e.sKey)?.choice;
  const theta = sampleBeta(e.alpha, e.beta, random);
  const score = (0.6 * e.mean + 0.4 * theta + 0.2 * model.gap(e.place.umbrella)
    + 0.2 * (model.publisherMean(publisher) - model.prior)) * model.multiplier(choice) * model.fatigue(e.place.field, e.sKey);
  return { skip: false, score, field: e.place.field };
}

/** What the drafting model hears about the reader: a few liked and disliked subtopics, compactly. */
export function promptSummary(model, limit = 8) {
  const rows = [];
  for (const [key, n] of model.nodes) {
    if (!key.startsWith("s:") || n.w < 0.5) continue;
    const sKey = key.slice(2), field = sKey.split("::")[0];
    rows.push({ label: `${placeOf(field).fieldLabel}: ${model.names.get(sKey)}`, mean: model.estimate(field, model.names.get(sKey)).mean });
  }
  rows.sort((a, b) => b.mean - a.mean);
  return {
    enjoys: rows.filter((r) => r.mean >= 0.7).slice(0, limit).map((r) => r.label),
    avoids: rows.filter((r) => r.mean <= 0.35).slice(-limit).map((r) => r.label),
  };
}

/** What the app shows: per-field and per-subtopic enjoyment, pauses, niches and the report card. */
export function snapshotOf(model) {
  const fields = [];
  for (const umbrella of taxonomy.umbrellas) {
    for (const field of umbrella.fields) {
      const weight = model.weightOf(`f:${field.id}`);
      const pause = model.fieldPause(field.id);
      if (!weight && !pause) continue;
      const umbrellaMean = model.meanOf(`u:${umbrella.id}`, model.prior);
      fields.push({ field: field.id, mean: round(model.meanOf(`f:${field.id}`, umbrellaMean)), weight: round(weight),
        targetDifficulty: round(model.targetDifficulty(field.id)), paused: pauseInfo(pause) });
    }
  }
  const subtopics = [];
  for (const [key, n] of model.nodes) {
    if (!key.startsWith("s:")) continue;
    const sKey = key.slice(2), field = sKey.split("::")[0];
    const e = model.estimate(field, model.names.get(sKey) ?? "");
    subtopics.push({ key: sKey, field, name: model.names.get(sKey), mean: round(e.mean), weight: round(n.w), paused: pauseInfo(model.pauseOf(field, sKey)) });
  }
  subtopics.sort((a, b) => b.weight - a.weight);
  return {
    version: 1, computedAt: new Date(model.now).toISOString(), prior: round(model.prior), exploreShare: round(model.exploreShare),
    metrics: Object.fromEntries(Object.entries(model.metrics).map(([k, v]) => [k, v === null ? null : round(v)])),
    niches: model.niches.map((n) => ({ key: n.key, field: n.field, umbrella: n.umbrella, name: n.name, mean: round(n.mean) })),
    stem: [...(model.stemFields ?? [])], stemChosen: model.stemChosen ?? false,
    shares: Object.fromEntries(Object.entries(model.shares ?? {}).map(([k, v]) => [k, round(v)])),
    fields, subtopics: subtopics.slice(0, 400),
  };
}
const round = (v) => Math.round(v * 100) / 100;
const pauseInfo = (pause) => (pause ? { by: pause.by, until: pause.until ? new Date(pause.until).toISOString() : null } : null);
