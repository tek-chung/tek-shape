import { cleanSubtopic, placeOf, taxonomy } from "./taxonomy.mjs";

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

export const SETTINGS = {
  prior: 0.55,              // expected enjoyment of an unknown post
  strength: 3,              // pseudo-posts each rung borrows from the rung above
  publisherStrength: 5,
  halfLifeDays: 60,         // evidence weight halves every two months
  skipAfterHours: 24,       // seen but unread for this long counts as scrolled past
  batch: 10,
  explore: { min: 0.15, max: 0.3, start: 0.25, minSamples: 5 },
  snooze: { dislikes: 2, days: 30, subtopicsForField: 3 },
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
export function rewardOf(state, now = Date.now()) {
  if (!state) return null;
  if (state.rating === "uninteresting") return REWARDS.uninteresting;
  const positives = [
    state.bookmarked === true && REWARDS.saved,
    state.opened_at && REWARDS.opened,
    state.rating === "harder" && REWARDS.harder,
    state.rating === "more" && REWARDS.more,
    state.deeper_opened_at && REWARDS.deeper,
    state.read_at && REWARDS.read,
  ].filter((value) => typeof value === "number");
  if (positives.length) return Math.max(...positives);
  if (state.first_seen_at && now - Date.parse(state.first_seen_at) > SETTINGS.skipAfterHours * 3_600_000) return REWARDS.skipped;
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
 */
export function buildTaste({ posts, states, prefs = [], queue = [], now = Date.now() }) {
  const stateById = new Map(states.map((s) => [s.post_id, s]));
  const postById = new Map(posts.map((p) => [p.id, p]));
  const nodes = new Map();
  const node = (key) => { let n = nodes.get(key); if (!n) nodes.set(key, n = { w: 0, wr: 0, count: 0, dislikes: 0, positives: 0, lastDislike: 0 }); return n; };
  const names = new Map();       // subtopic key → display name
  const liked = new Map(), disliked = new Map();
  const difficulty = new Map();  // field → { w, wd, shift }
  let totalW = 0, totalWR = 0;

  for (const post of posts) {
    const state = stateById.get(post.id);
    const reward = rewardOf(state, now);
    if (reward === null) continue;
    const at = Date.parse(state.updated_at ?? state.read_at ?? state.first_seen_at ?? "") || now;
    const w = 0.5 ** (Math.max(0, now - at) / (SETTINGS.halfLifeDays * DAY));
    const place = placeOf(post.field);
    const sKey = subtopicKey(place.field, post.subtopic);
    if (!names.has(sKey)) names.set(sKey, cleanSubtopic(post.subtopic) || place.fieldLabel);
    for (const key of [`u:${place.umbrella}`, `f:${place.field}`, `s:${sKey}`, `p:${publisherOfPost(post)}`]) {
      const n = node(key);
      n.w += w; n.wr += w * reward; n.count++;
      if (reward === REWARDS.uninteresting) { n.dislikes++; n.lastDislike = Math.max(n.lastDislike, at); }
      if (reward >= REWARDS.deeper) n.positives++;
    }
    totalW += w; totalWR += w * reward;
    for (const concept of post.concept_ids ?? []) {
      if (reward >= REWARDS.deeper) liked.set(concept, (liked.get(concept) ?? 0) + w);
      if (reward <= REWARDS.skipped) disliked.set(concept, (disliked.get(concept) ?? 0) + w);
    }
    const d = difficulty.get(place.field) ?? { w: 0, wd: 0, shift: 0 };
    if (reward >= REWARDS.read) { d.w += w; d.wd += w * (post.difficulty ?? 2); }
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
  const multiplier = (choice) => (choice === "more" ? 1.25 : choice === "less" ? 0.7 : 1);

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

  const estimate = (field, subtopic) => {
    const place = placeOf(field);
    const sKey = subtopicKey(place.field, subtopic);
    const umbrellaMean = meanOf(`u:${place.umbrella}`, prior);
    const fieldMean = meanOf(`f:${place.field}`, umbrellaMean);
    const mean = meanOf(`s:${sKey}`, fieldMean);
    const n = weightOf(`s:${sKey}`) + SETTINGS.strength;
    return { place, sKey, umbrellaMean, fieldMean, mean, alpha: mean * n, beta: (1 - mean) * n, uncertainty: 1 / Math.sqrt(n) };
  };

  /** Why, if at all, a whole field is resting now. */
  const fieldPause = (field) => {
    const p = pref.get(`field:${field}`);
    if (p?.choice === "more") return null;
    if (p?.choice === "snooze") return { by: "you", until: p.until ? Date.parse(p.until) : null };
    const f = pausedByField.get(field);
    if (f && f.count >= SETTINGS.snooze.subtopicsForField && meanOf(`f:${field}`, prior) < prior) return { by: "feed", until: f.until };
    return null;
  };
  /** Why, if at all, this subtopic is resting now, on its own account or its field's. */
  const pauseOf = (field, sKey) => {
    const p = pref.get(`subtopic:${sKey}`);
    if (p?.choice === "more") return null;
    if (p?.choice === "snooze") return { by: "you", until: p.until ? Date.parse(p.until) : null };
    if (p?.choice !== "less") {
      const sub = learnedSubtopic(sKey);
      if (sub && pref.get(`field:${field}`)?.choice !== "more") return { by: "feed", until: sub };
    }
    return fieldPause(field);
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

  const conceptScore = (concepts, table) => clamp(0, 1, (concepts ?? []).reduce((sum, c) => sum + (table.get(c) ?? 0), 0) / 2);

  // The feed's report card, over the most recent posts it placed that now have an outcome.
  const resolved = queue
    .map((q) => ({ q, reward: rewardOf(stateById.get(q.post_id), now) }))
    .filter((r) => r.reward !== null && postById.has(r.q.post_id))
    .sort((a, b) => (b.q.position ?? 0) - (a.q.position ?? 0))
    .slice(0, SETTINGS.metricsWindow);
  const share = (rows, test) => (rows.length ? rows.filter(test).length / rows.length : null);
  const explorations = resolved.filter((r) => r.q.slot === "explore" || r.q.slot === "stretch");
  const metrics = {
    placed: resolved.length,
    hitRate: share(resolved, (r) => r.reward >= REWARDS.read),
    delightRate: share(resolved, (r) => r.reward >= REWARDS.more),
    explorations: explorations.length,
    explorationHitRate: share(explorations, (r) => r.reward >= REWARDS.read),
  };
  // Exploration earns its share: as good as favourites → 30%; never landing → 15%. Never zero.
  const exploreShare = metrics.explorations < SETTINGS.explore.minSamples || metrics.hitRate === null
    ? SETTINGS.explore.start
    : clamp(SETTINGS.explore.min, SETTINGS.explore.max,
      SETTINGS.explore.min + (SETTINGS.explore.max - SETTINGS.explore.min) * clamp(0, 1, metrics.explorationHitRate / Math.max(metrics.hitRate, 0.1)));

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
    estimate, pauseOf, fieldPause, prefFor, multiplier, targetDifficulty, gap, comfort, weightOf, meanOf, names, nodes,
    bridge: (concepts) => conceptScore(concepts, liked),
    avoid: (concepts) => conceptScore(concepts, disliked),
    publisherMean: (publisher) => meanOf(`p:${sourceOf(publisher)}`, prior, SETTINGS.publisherStrength),
    publisherWeight: (publisher) => weightOf(`p:${sourceOf(publisher)}`),
  };
}

/** Expected enjoyment of one post, before any exploring: the number favourites are chosen by. */
function expected(model, post, known) {
  const e = model.estimate(post.field, post.subtopic);
  const choice = model.prefFor(e.place.field, e.sKey)?.choice;
  let value = e.mean + 0.3 * (model.publisherMean(publisherOfPost(post)) - model.prior);
  const fit = Math.exp(-(((post.difficulty ?? 2) - model.targetDifficulty(e.place.field)) ** 2) / 2);
  value *= (0.85 + 0.15 * fit) * model.multiplier(choice);
  const concepts = post.concept_ids ?? [];
  const novelty = concepts.length ? concepts.filter((c) => !known.has(c)).length / concepts.length : 1;
  value *= 0.8 + 0.2 * novelty;
  if (post.content_type === "news") {
    const age = (model.now - Date.parse(post.article_date ?? post.reviewed_at ?? model.now)) / DAY;
    value *= 1 - clamp(0, 0.3, age * 0.04);
  }
  return { value, e, choice, novelty };
}

/** Where to put the batch's specials (explorations and the stretch), spread out, never at the very top. */
function layout(batch, explores) {
  const specials = explores + 1;
  const positions = Array.from({ length: specials }, (_, k) => Math.min(batch - 1, Math.max(1, Math.round((k + 0.5) * batch / specials))));
  const stretchAt = positions[Math.floor(specials / 2)];
  const slots = Array.from({ length: batch }, () => "favourite");
  for (const p of positions) slots[p] = "explore";
  slots[stretchAt] = "stretch";
  return slots;
}

/**
 * Choose and order the next `need` posts. Returns [{ id, slot }] where slot is favourite, explore or stretch.
 * `assigned` is the feed so far (posts in queue order); `candidates` are published posts not yet in it.
 */
export function rankQueue({ model, candidates, assigned, need, now = Date.now(), random = Math.random }) {
  if (need <= 0) return [];
  const assignedIds = new Set(assigned.map((p) => p.id));
  const known = new Set(assigned.flatMap((p) => p.concept_ids ?? []));
  const seenSubtopics = new Set(assigned.map((p) => subtopicKey(placeOf(p.field).field, p.subtopic)));
  const describe = (p) => {
    const place = placeOf(p.field);
    return { post: p, id: p.id, field: place.field, umbrella: place.umbrella, subKey: subtopicKey(place.field, p.subtopic), publisher: publisherOfPost(p) };
  };

  const pool = [];
  for (const post of candidates) {
    if (assignedIds.has(post.id) || post.status !== "published" || post.verification_status !== "source_checked") continue;
    if (post.content_type === "news" && !(now - Date.parse(post.reviewed_at) < 7 * DAY
      && now - Date.parse(post.article_date) < 14 * DAY && Date.parse(post.article_date) <= now)) continue;
    const d = describe(post);
    if (model.pauseOf(d.field, d.subKey)) continue;
    const concepts = post.concept_ids ?? [];
    // A true repeat: every idea already in the feed, in a subtopic already covered.
    if (concepts.length && concepts.every((c) => known.has(c)) && seenSubtopics.has(d.subKey)) continue;
    const x = expected(model, post, known);
    const theta = sampleBeta(x.e.alpha, x.e.beta, random);
    const weakArea = x.e.umbrellaMean < model.prior;
    // Exploration looks outside the comfort zone: areas that already fill your reading are discounted (their
    // depth comes from favourites and stretch posts); weak, thin or unread areas are not.
    const comfort = model.comfort(d.umbrella);
    const weakness = clamp(0, 1, (model.prior - x.e.umbrellaMean) / 0.25);
    d.fav = x.value;
    d.mean = x.e.mean;
    d.explore = (theta + 0.35 * model.gap(d.umbrella) + 0.2 * weakness + (weakArea ? 0.3 : 0.15) * model.bridge(concepts)
      - 0.3 * model.avoid(concepts) + 0.1 * x.e.uncertainty) * (1 - 0.5 * comfort) * model.multiplier(x.choice);
    const target = model.targetDifficulty(d.field);
    d.harderStretch = (post.difficulty ?? 2) >= target + 0.5 && target > 2.5;
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
  const best = (score, filter = () => true) => {
    for (let level = 0; level <= 4; level++) {
      let top = null;
      for (const c of pool) if (filter(c) && allowed(c, level) && (!top || score(c) > score(top))) top = c;
      if (top) return top;
    }
    return null;
  };

  while (picks.length < need && pool.length) {
    const size = Math.min(SETTINGS.batch, need - picks.length);
    const raw = SETTINGS.batch * model.exploreShare - 1;
    const explores = Math.max(0, Math.floor(raw) + (random() < raw - Math.floor(raw) ? 1 : 0));
    const slots = layout(SETTINGS.batch, explores).slice(0, size);
    for (const slot of slots) {
      if (!pool.length) break;
      let pick = null;
      if (slot === "stretch") {
        // Breadth floor first: an area with posts waiting that has not appeared recently.
        const due = new Set(pool.map((c) => c.umbrella).filter((u) => u !== "other" && !recentUmbrellas.has(u)));
        pick = (due.size && best((c) => c.explore, (c) => due.has(c.umbrella)))
          || best((c) => c.fav, (c) => c.harderStretch)
          || best((c) => c.explore);
      } else if (slot === "explore") pick = best((c) => c.explore);
      else pick = best((c) => c.fav);
      if (!pick) break;
      pool.splice(pool.indexOf(pick), 1);
      history.push(pick); recentUmbrellas.add(pick.umbrella);
      for (const c of pick.post.concept_ids ?? []) known.add(c);
      picks.push({ id: pick.id, slot });
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
    + 0.2 * (model.publisherMean(publisher) - model.prior)) * model.multiplier(choice);
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
    fields, subtopics: subtopics.slice(0, 400),
  };
}
const round = (v) => Math.round(v * 100) / 100;
const pauseInfo = (pause) => (pause ? { by: pause.by, until: pause.until ? new Date(pause.until).toISOString() : null } : null);
