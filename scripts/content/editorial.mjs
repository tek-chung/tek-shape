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
// Chinese, Japanese and Korean script, which has no spaces between words.
const CJK = /[぀-ヿ㐀-鿿가-힯豈-﫿]/g;
/** Long enough to count as evidence: four words, or eight characters of unspaced script. */
const substantial = (part) => (part.match(CJK)?.length ?? 0) >= 8 || part.split(" ").length >= 4;

export function excerptFound(sourceText, excerpt) {
  const haystack = comparable(sourceText);
  const quote = comparable(excerpt).replace(/^["'\s]+|["'\s]+$/g, "");
  if (!quote) return false;
  if (haystack.includes(quote)) return true;
  const fragments = quote.split(/\s*(?:\.\.\.|\[\.\.\.\])\s*/).map((part) => part.trim()).filter(Boolean);
  if (fragments.length < 2 || !fragments.every(substantial)) return false;
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

/**
 * `evidence: false` (CONTENT_CHECKS=off) keeps only the format checks the database needs, and skips the
 * check that every claim quotes the source. Posts are then unverified summaries with a source link.
 */
export function checkDraft(draft, sources, now = Date.now(), { evidence = true } = {}) {
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
  if (!evidence) { /* Claims are not checked against the source. */ }
  else if (!Array.isArray(draft.claims) || !draft.claims.length || draft.claims.length > 30) errors.push("Claim evidence is required");
  else for (const claim of draft.claims) {
    if (!claim || typeof claim !== "object") { errors.push("Invalid claim"); continue; }
    const source = sources.find((s) => s.url === claim.url);
    // Up to three cited sentences can make a long excerpt, hence the generous length.
    if (!text(claim.claim,1000) || !text(claim.excerpt,2400) || !source || !excerptFound(source.text, claim.excerpt)) errors.push("Claim has no exact supporting source excerpt");
  }
  // Generated links are never accepted merely because the model produced them.
  if (!Array.isArray(draft.sources) || !draft.sources.length || draft.sources.some((s) => !s || !sources.some((known) => known.url === s.url && known.publisher === s.publisher && known.title === s.title && known.articleDate === s.articleDate && known.accessedAt === s.accessedAt))) errors.push("Citations must match retrieved sources");
  if (draft.body !== undefined && !validBlocks(draft.body)) errors.push("Invalid saved article");
  return errors;
}

/** A saved article body (see feedBlocks): plain text blocks only, within the database's size limits. */
export function validBlocks(body) {
  if (!Array.isArray(body) || !body.length || body.length > 300 || JSON.stringify(body).length > 150_000) return false;
  const strings = (list, count, max) => Array.isArray(list) && list.length >= 1 && list.length <= count && list.every((s) => typeof s === "string" && s.length <= max);
  return body.every((block) => block && typeof block === "object" && (
    (["h", "p", "q"].includes(block.t) && text(block.text, 4000) && Object.keys(block).length === 2)
    || (["ul", "ol"].includes(block.t) && strings(block.items, 50, 4000) && Object.keys(block).length === 2)
    || (block.t === "table" && Array.isArray(block.rows) && block.rows.length >= 1 && block.rows.length <= 40 && block.rows.every((row) => strings(row, 12, 300)) && Object.keys(block).length === 2)));
}

/**
 * An excerpt: made without AI, from the publisher's own words — its feed summary or the first paragraph of
 * the page — with the link. No claims to check, so only the format the database needs, a real source, and
 * (for news) a recent date.
 */
export function checkExcerpt(post, now = Date.now()) {
  if (!post || typeof post !== "object" || post.kind !== "excerpt") return ["Not an excerpt"];
  const errors = [];
  for (const [key, max] of Object.entries({ topic: 60, subtopic: 100, title: 200 })) if (!text(post[key], max)) errors.push(`Invalid ${key}`);
  if (!Array.isArray(post.explanation) || post.explanation.length !== 1 || !text(post.explanation[0], 1200)) errors.push("Invalid excerpt");
  if (post.insight !== null || post.deeper !== null) errors.push("An excerpt has no insight or deeper explanation");
  if (!["news", "evergreen"].includes(post.contentType)) errors.push("Invalid content type");
  if (!Number.isInteger(post.difficulty) || post.difficulty < 1 || post.difficulty > 5) errors.push("Invalid difficulty");
  if (!Array.isArray(post.conceptIds) || post.conceptIds.length < 1 || post.conceptIds.length > 8 || post.conceptIds.some((c) => !slug.test(c))) errors.push("Invalid canonical concepts");
  if (post.contentType === "news" && (!iso(post.articleDate) || Date.parse(post.articleDate) > now || now - Date.parse(post.articleDate) > 14 * 86400000)) errors.push("News needs a recent article date");
  const source = Array.isArray(post.sources) && post.sources.length === 1 ? post.sources[0] : null;
  if (!source || !text(source.url, 2000) || !source.url.startsWith("https://") || !text(source.publisher, 200) || !text(source.title, 200) || !iso(source.accessedAt)) errors.push("An excerpt needs its one source");
  if (post.body !== undefined && !validBlocks(post.body)) errors.push("Invalid saved article");
  return errors;
}

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

export function candidateId(draft) {
  return `idea-${digest(JSON.stringify(draft)).slice(0,32)}`;
}
export function checkReview(review, draft) {
  return review?.supported === true && review?.complete === true && review?.misleading === false
    && Array.isArray(review.claims) && review.claims.length === draft.claims.length
    && review.claims.every((value, index) => value?.index === index && value.supported === true && text(value.reason,1000));
}
