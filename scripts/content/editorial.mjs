import { digest, normalise } from "./sources.mjs";

const slug = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * For excerpt matching only: fold typography a model cannot reliably reproduce. Publishers use curly
 * quotes, en/em dashes, ellipses and non-breaking spaces; models often type the plain equivalents. The
 * words must still match exactly — this only stops a correct quote failing on a ’ versus a '.
 */
export const comparable = (value) => normalise(String(value)
  .replace(/[‘’‚‛′`´]/g, "'")
  .replace(/[“”„‟″]/g, '"')
  .replace(/[‐-―−]/g, "-")
  .replace(/…/g, "...")
  .replace(/[   ]/g, " ")).toLowerCase();
const text = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const iso = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

/**
 * Is the excerpt genuinely in the source? Matched verbatim after folding typography. A quote joined with
 * an ellipsis ("A … B") passes only if every fragment appears verbatim, in order, and each is at least four
 * words — so it can bridge a cut, never stitch together words the source did not say.
 */
export function excerptFound(sourceText, excerpt) {
  const haystack = comparable(sourceText);
  const quote = comparable(excerpt).replace(/^["'\s]+|["'\s]+$/g, "");
  if (!quote) return false;
  if (haystack.includes(quote)) return true;
  const fragments = quote.split(/\s*(?:\.\.\.|\[\.\.\.\])\s*/).map((part) => part.trim()).filter(Boolean);
  if (fragments.length < 2 || fragments.some((part) => part.split(" ").length < 4)) return false;
  let from = 0;
  for (const fragment of fragments) {
    const at = haystack.indexOf(fragment, from);
    if (at < 0) return false;
    from = at + fragment.length;
  }
  return true;
}

/** Longest common subsequence of two word arrays: how many words appear in both, in the same order. */
function inOrder(a, b) {
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = above;
    }
  }
  return row[b.length];
}

/**
 * If a quote is a near-miss of a real passage — the model changed a word or two — return that passage
 * exactly as the source has it; otherwise null. The evidence stays genuine source text, and the reviewer
 * still judges whether the claim is supported. Requires ≥85% of words in order and at least 6 words, so
 * a loose paraphrase is never "found".
 */
export function snapExcerpt(sourceText, excerpt, threshold = 0.85) {
  if (typeof excerpt !== "string" || excerptFound(sourceText, excerpt)) return null;
  const words = String(sourceText).split(" ");
  const folded = words.map((word) => comparable(word));
  const quote = comparable(excerpt).replace(/^["'\s]+|["'\s]+$/g, "").split(" ").filter(Boolean);
  if (quote.length < 6 || quote.length > 60) return null;
  let best = { score: 0, start: 0, length: 0 };
  for (let length = Math.max(6, quote.length - 3); length <= quote.length + 3; length++) {
    for (let start = 0; start + length <= words.length; start++) {
      const window = folded.slice(start, start + length);
      // Cheap filter before the full comparison: must share the quote's first or last word.
      if (!window.includes(quote[0]) && !window.includes(quote.at(-1))) continue;
      const score = inOrder(quote, window) / Math.max(quote.length, length);
      if (score > best.score) best = { score, start, length };
    }
  }
  return best.score >= threshold ? words.slice(best.start, best.start + best.length).join(" ") : null;
}

export function checkDraft(draft, sources, now = Date.now()) {
  const errors = [];
  if (!draft || typeof draft !== "object") return ["Draft is not an object"];
  for (const [key,max] of Object.entries({ topic:60, subtopic:100, title:200, insight:400, deeper:4000 }))
    if (!text(draft[key],max)) errors.push(`Invalid ${key}`);
  if (!Array.isArray(draft.explanation) || !draft.explanation.length || draft.explanation.length > 20 || draft.explanation.some((p) => !text(p,4000))) errors.push("Invalid explanation");
  if (!["news","evergreen"].includes(draft.contentType)) errors.push("Invalid content type");
  if (!Number.isInteger(draft.difficulty) || draft.difficulty < 1 || draft.difficulty > 5) errors.push("Invalid difficulty");
  if (!Array.isArray(draft.conceptIds) || draft.conceptIds.length < 1 || draft.conceptIds.length > 8 || draft.conceptIds.some((c) => !slug.test(c)) || new Set(draft.conceptIds).size !== draft.conceptIds.length) errors.push("Invalid canonical concepts");
  if (draft.eventDate !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(draft.eventDate) || !iso(draft.eventDate) || Date.parse(draft.eventDate) > now)) errors.push("Invalid event date");
  if (draft.contentType === "news" && (!iso(draft.articleDate) || Date.parse(draft.articleDate) > now || now - Date.parse(draft.articleDate) > 14 * 86400000
    || !sources.some((source) => source.articleDate === draft.articleDate))) errors.push("News needs a supported recent article date");
  if (!Array.isArray(draft.claims) || !draft.claims.length || draft.claims.length > 30) errors.push("Claim evidence is required");
  else for (const claim of draft.claims) {
    if (!claim || typeof claim !== "object") { errors.push("Invalid claim"); continue; }
    const source = sources.find((s) => s.url === claim.url);
    // Up to three cited sentences can make a long excerpt, hence the generous length.
    if (!text(claim.claim,1000) || !text(claim.excerpt,2400) || !source || !excerptFound(source.text, claim.excerpt)) errors.push("Claim has no exact supporting source excerpt");
  }
  // Generated links are never accepted merely because the model produced them.
  if (!Array.isArray(draft.sources) || !draft.sources.length || draft.sources.some((s) => !s || !sources.some((known) => known.url === s.url && known.publisher === s.publisher && known.title === s.title && known.articleDate === s.articleDate && known.accessedAt === s.accessedAt))) errors.push("Citations must match retrieved sources");
  return errors;
}

const RATINGS = ["more", "harder", "uninteresting"];

/**
 * Concept IDs from the most recently published posts. The full catalogue grows
 * with every post; sending it all would soon overflow a small token allowance.
 */
export function recentConcepts(posts, limit = 80) {
  const ordered = [...posts].sort((a, b) => (Date.parse(b.published_at) || 0) - (Date.parse(a.published_at) || 0));
  const seen = new Set();
  for (const post of ordered) {
    for (const id of post.concept_ids ?? []) {
      if (seen.size >= limit) return [...seen];
      seen.add(id);
    }
  }
  return [...seen];
}

/**
 * Ratings summarised per subtopic, most recently rated first: the same signal
 * the model needs, in a fraction of the tokens of one entry per rating.
 */
export function summarisePreferences(states, posts, limit = 20) {
  const byId = new Map(posts.map((post) => [post.id, post]));
  const groups = new Map();
  for (const state of states) {
    const post = byId.get(state.post_id);
    if (!post || !RATINGS.includes(state.rating)) continue;
    const key = `${post.topic}\u0000${post.subtopic ?? ""}`;
    const group = groups.get(key) ?? { topic: post.topic, subtopic: post.subtopic ?? "", more: 0, harder: 0, uninteresting: 0, difficulty: 0, count: 0, latest: 0 };
    group[state.rating]++;
    group.difficulty += post.difficulty ?? 1;
    group.count++;
    group.latest = Math.max(group.latest, Date.parse(state.updated_at) || 0);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.latest - a.latest || b.count - a.count)
    .slice(0, limit)
    .map(({ topic, subtopic, more, harder, uninteresting, difficulty, count }) =>
      ({ topic, subtopic, more, harder, uninteresting, averageDifficulty: Math.round((difficulty / count) * 10) / 10 }));
}

export function candidateId(draft) {
  return `idea-${digest(JSON.stringify(draft)).slice(0,32)}`;
}
export function checkReview(review, draft) {
  return review?.supported === true && review?.complete === true && review?.misleading === false
    && Array.isArray(review.claims) && review.claims.length === draft.claims.length
    && review.claims.every((value, index) => value?.index === index && value.supported === true && text(value.reason,1000));
}

export function selectQueue({ candidates, assigned, states, target = 24, now = Date.now() }) {
  const stateById = new Map(states.map((s) => [s.post_id,s]));
  const unread = assigned.filter((p) => !stateById.get(p.id)?.read_at).length;
  const selected = []; const history = [...assigned];
  const remaining = candidates.filter((p) => p.status === "published" && p.verification_status === "source_checked" && !assigned.some((a) => a.id === p.id));
  const known = new Set(assigned.flatMap((p) => p.concept_ids ?? []));
  while (selected.length < Math.max(0,target - unread)) {
    const ranked = remaining.filter((p) => p.concept_ids?.length && p.concept_ids.filter((c) => !known.has(c)).length / p.concept_ids.length >= 0.5)
      .filter((p) => p.content_type !== "news" || (now - Date.parse(p.reviewed_at) < 7 * 86400000
        && now - Date.parse(p.article_date) < 14 * 86400000 && Date.parse(p.article_date) <= now))
      .map((p) => {
        let score = p.concept_ids.filter((c) => !known.has(c)).length / p.concept_ids.length * 5;
        score -= history.slice(-4).filter((h) => h.topic === p.topic).length * 4;
        score -= history.slice(-2).filter((h) => h.content_type === p.content_type).length;
        for (const h of assigned) {
          if (h.topic !== p.topic) continue;
          const rating = stateById.get(h.id)?.rating;
          if (rating === "more") score += p.difficulty === h.difficulty ? 2 : -1;
          if (rating === "harder") score += p.difficulty > h.difficulty ? 3 : -5;
          if (rating === "uninteresting" && h.subtopic === p.subtopic) score -= 3;
        }
        return { post:p, score };
      }).sort((a,b) => b.score-a.score || a.post.id.localeCompare(b.post.id));
    if (!ranked.length) break;
    const next = ranked[0].post;
    selected.push(next); history.push(next); next.concept_ids.forEach((id) => known.add(id));
    remaining.splice(remaining.indexOf(next),1);
  }
  return selected;
}
