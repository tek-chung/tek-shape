/**
 * The mixer: how each batch of the feed is shared between candidate sources, as X's Home Mixer blends
 * followed accounts with retrieved posts and Instagram's Explore weights its retrieval sources. Each source
 * serves one part of the T:
 *
 *   stem     the next step in your 1–3 deep fields (chosen on the Map, or learnt)      the vertical bar
 *   bar      areas you have read least, at an accessible level                         the horizontal bar
 *   bridges  an idea you liked, met in a field you do not usually read
 *   trusted  your best sources
 *   wild     exploration by Thompson sampling, new sources included
 *   fresh    recent news, at most about one post in twenty
 *
 * Shares tune themselves by how well each source's posts land, within bounds, and never let breadth or
 * exploration fall below a floor, so the T cannot narrow into an I. Pure functions; randomness passed in.
 */

export const SOURCES = { stem: 0.35, bar: 0.3, bridges: 0.1, trusted: 0.1, wild: 0.1, fresh: 0.05 };
export const MIX = {
  floors: { bar: 0.2, wild: 0.05 },
  tune: 0.3,          // a source landing better or worse than the feed as a whole moves its share by up to ±30%
  minSamples: 8,      // placements with an outcome before a source's share moves at all
  stemFields: 3,      // at most this many fields form the stem
  learnedStem: 2,     // when none are chosen, the two clearest favourites are used
  trusted: 8,
};

const clamp = (low, high, value) => Math.min(high, Math.max(low, value));

/**
 * Today's shares. `bySource` is { source: { n, hits } } over recent placements with an outcome; `hitRate` the
 * feed's overall rate. Returns shares summing to 1, with the floors honoured.
 */
export function mixShares(bySource = {}, hitRate = null) {
  const raw = {};
  for (const [source, base] of Object.entries(SOURCES)) {
    const s = bySource[source];
    const factor = s && s.n >= MIX.minSamples && hitRate !== null ? clamp(1 - MIX.tune, 1 + MIX.tune, (s.hits / s.n) / Math.max(hitRate, 0.1)) : 1;
    raw[source] = base * factor;
  }
  const total = Object.values(raw).reduce((a, b) => a + b, 0);
  const shares = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v / total]));
  // Floors: lift any source below its floor, taking the difference from the others in proportion.
  const lifted = Object.entries(MIX.floors).filter(([k, floor]) => shares[k] < floor);
  if (lifted.length) {
    const need = lifted.reduce((sum, [k, floor]) => sum + floor - shares[k], 0);
    const free = Object.keys(shares).filter((k) => !lifted.some(([l]) => l === k));
    const pool = free.reduce((sum, k) => sum + shares[k], 0);
    for (const [k, floor] of lifted) shares[k] = floor;
    for (const k of free) shares[k] -= need * (shares[k] / pool);
  }
  return shares;
}

/** Whole slots per source for a batch of `size`: floors first, then the remainders by weighted chance. */
export function apportion(shares, size, random = Math.random) {
  const counts = {}, rest = {};
  let left = size;
  for (const [k, share] of Object.entries(shares)) {
    counts[k] = Math.floor(share * size);
    rest[k] = share * size - counts[k];
    left -= counts[k];
  }
  while (left > 0) {
    const total = Object.values(rest).reduce((a, b) => a + b, 0);
    if (total <= 0) { counts[Object.keys(shares)[0]]++; left--; continue; }
    let r = random() * total, chosen = null;
    for (const [k, v] of Object.entries(rest)) { r -= v; if (r <= 0 && v > 0) { chosen = k; break; } }
    chosen ??= Object.entries(rest).sort((a, b) => b[1] - a[1])[0][0];
    counts[chosen]++; rest[chosen] = 0; left--;
  }
  return counts;
}

/**
 * The order of a batch's slots: opens with a stem post (else trusted, else the largest source), then spreads
 * the rest evenly (smooth weighted round robin), so no source clumps.
 */
export function spread(counts) {
  const remaining = { ...counts };
  const total = Object.values(remaining).reduce((a, b) => a + b, 0);
  if (!total) return [];
  const opener = ["stem", "trusted"].find((k) => remaining[k] > 0) ?? Object.entries(remaining).sort((a, b) => b[1] - a[1])[0][0];
  const order = [opener];
  remaining[opener]--;
  const current = Object.fromEntries(Object.keys(remaining).map((k) => [k, 0]));
  for (let i = 1; i < total; i++) {
    const weight = Object.values(remaining).reduce((a, b) => a + b, 0);
    let chosen = null;
    for (const k of Object.keys(remaining)) {
      if (remaining[k] <= 0) continue;
      current[k] += remaining[k];
      if (!chosen || current[k] > current[chosen]) chosen = k;
    }
    current[chosen] -= weight;
    remaining[chosen]--;
    order.push(chosen);
  }
  return order;
}

/**
 * The stem: fields chosen on the Map (at most three), or else the clearest favourites so far — fields read
 * enough to know (weight ≥ 2.5, about three recent posts) and enjoyed above the reader's average, by how much and how often.
 */
export function stemFieldsOf({ chosen = [], fields = [], prior }) {
  if (chosen.length) return new Set(chosen.slice(0, MIX.stemFields));
  return new Set(fields.filter((f) => f.weight >= 2.5 && f.mean >= prior + 0.05)
    .sort((a, b) => b.weight * (b.mean - prior) - a.weight * (a.mean - prior))
    .slice(0, MIX.learnedStem).map((f) => f.field));
}

/** Trusted sources: publishers read enough to know and clearly enjoyed. */
export function trustedOf({ publishers = [], prior }) {
  return new Set(publishers.filter((p) => p.weight >= 2.5 && p.mean >= prior + 0.08)
    .sort((a, b) => b.mean - a.mean).slice(0, MIX.trusted).map((p) => p.publisher));
}
