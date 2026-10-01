/**
 * The understanding layer: what a post is about, as a point in meaning-space, so the feed can tell a new idea
 * from the same idea in other words, and group posts into idea clusters (T's SimClusters) whatever their
 * subtopic happens to be called.
 *
 * Embeddings come from a small multilingual model run locally with transformers.js (in GitHub Actions or on
 * the laptop): no API quota, no text sent anywhere, and Chinese sources work. Excerpt-mode sources are never
 * embedded: their publishers' terms rule out AI use of their text, and that includes this.
 *
 * Everything but `embedder()` is pure, so tests need no model.
 */

/** Small (384 dimensions), multilingual (50+ languages), and its similarities spread well for duplicate checks. */
export const EMBED_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const DIMS = 384;

export const UNDERSTANDING = {
  // Cosine similarity at or above which two posts teach the same idea. To be calibrated on real posts:
  // `understand` reports the spread of nearest-neighbour similarities.
  duplicate: 0.9,
  // Above this, two posts are close enough that placing them near each other wastes the reader's variety.
  near: 0.75,
  // Posts per idea cluster, roughly; clusters are refreshed weekly or when the catalogue grows by a fifth.
  perCluster: 25,
  refreshDays: 7,
  growth: 0.2,
  // Two concept tags at or above this similarity name the same idea and are folded into one concept.
  // Deliberately strict: "machine-learning" and "deep-learning" must stay apart.
  sameConcept: 0.85,
};

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;
/** What the model reads of a concept tag: its words. */
export const conceptText = (slug) => slug.replace(/-/g, " ");

/**
 * Fold new concept tags into canonical concepts. Commonest tags go first, so the usual spelling becomes the
 * canonical one; each later tag joins the closest concept if similar enough, or becomes a concept itself.
 * `existing`: canonical concepts already stored, [{ id, vec }]; `tags`: new tags, [{ slug, vec, count }].
 * Returns the new concepts and an alias row for every new tag (a new concept is its own alias).
 */
export function foldConcepts(existing, tags, threshold = UNDERSTANDING.sameConcept) {
  const canonical = [...existing];
  const concepts = [], aliases = [];
  const ordered = tags.filter((t) => SLUG.test(t.slug) && t.vec).sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.slug.localeCompare(b.slug));
  for (const tag of ordered) {
    let best = null, bestSim = -Infinity;
    for (const c of canonical) { const sim = cosine(tag.vec, c.vec); if (sim > bestSim) { bestSim = sim; best = c; } }
    if (best && bestSim >= threshold) aliases.push({ alias: tag.slug, concept_id: best.id, similarity: Math.round(bestSim * 1000) / 1000 });
    else {
      const concept = { id: tag.slug, vec: tag.vec };
      canonical.push(concept); concepts.push(concept);
      aliases.push({ alias: tag.slug, concept_id: tag.slug, similarity: 1 });
    }
  }
  return { concepts, aliases };
}

/**
 * What the model reads of a post: title, key insight and the first paragraph. The model sees 128 word pieces at
 * most, so the idea's statement matters more than its detail.
 */
export function postText(post) {
  const parts = [post.title, post.insight, Array.isArray(post.explanation) ? post.explanation[0] : ""];
  return parts.filter((part) => typeof part === "string" && part.trim()).join(". ").replace(/\s+/g, " ").slice(0, 1200);
}

/** Load the model once; returns texts → unit-length Float32Array vectors. Downloads ~120 MB on first use. */
export async function embedder({ model = EMBED_MODEL, cacheDir = process.env.CONTENT_MODEL_CACHE || ".cache/transformers" } = {}) {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = cacheDir;
  const extract = await pipeline("feature-extraction", model, { dtype: "q8" });
  return async (texts) => {
    const out = [];
    for (let i = 0; i < texts.length; i += 16) {
      const tensor = await extract(texts.slice(i, i + 16), { pooling: "mean", normalize: true });
      const [rows, dims] = tensor.dims;
      for (let r = 0; r < rows; r++) out.push(Float32Array.from(tensor.data.subarray(r * dims, (r + 1) * dims)));
    }
    return out;
  };
}

/** A unit vector stored as one signed byte per dimension, base64: 512 characters for 384 dimensions. */
export function pack(vector) {
  const bytes = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i++) bytes[i] = Math.max(-127, Math.min(127, Math.round(vector[i] * 127)));
  return Buffer.from(bytes.buffer).toString("base64");
}

/** Back to a unit-length Float32Array; null for anything malformed. */
export function unpack(text, dims = DIMS) {
  if (typeof text !== "string") return null;
  const buffer = Buffer.from(text, "base64");
  if (buffer.length !== dims) return null;
  const bytes = new Int8Array(buffer.buffer, buffer.byteOffset, buffer.length);
  return normalise(Float32Array.from(bytes, (b) => b / 127));
}

export function normalise(vector) {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const length = Math.sqrt(sum) || 1;
  return vector.map((v) => v / length);
}

/** Cosine similarity of two unit vectors. */
export function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/** How many idea clusters suit a catalogue of n embedded posts. */
export const clusterCount = (n) => Math.max(2, Math.min(200, Math.round(n / UNDERSTANDING.perCluster)));

/**
 * Spherical k-means with k-means++ seeding: unit vectors in, k unit centroids and each vector's cluster out.
 * `random` makes runs reproducible (tests pass a seeded one).
 */
export function kmeans(vectors, k, random = Math.random, iterations = 20) {
  const n = vectors.length;
  if (!n) return { centroids: [], assign: [] };
  k = Math.max(1, Math.min(k, n));
  const centroids = [vectors[Math.floor(random() * n)]];
  const nearest = new Float64Array(n).fill(Infinity);
  while (centroids.length < k) {
    const last = centroids.at(-1);
    let total = 0;
    for (let i = 0; i < n; i++) { nearest[i] = Math.min(nearest[i], 1 - cosine(vectors[i], last)); total += Math.max(0, nearest[i]); }
    let pick = random() * total, chosen = n - 1;
    for (let i = 0; i < n; i++) { pick -= Math.max(0, nearest[i]); if (pick <= 0) { chosen = i; break; } }
    centroids.push(vectors[chosen]);
  }
  const assign = new Int32Array(n);
  for (let round = 0; round < iterations; round++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      const best = nearestCentroid(vectors[i], centroids);
      if (round === 0 || best !== assign[i]) moved++;
      assign[i] = best;
    }
    const sums = centroids.map(() => new Float32Array(vectors[0].length));
    const sizes = new Int32Array(k);
    for (let i = 0; i < n; i++) { sizes[assign[i]]++; const s = sums[assign[i]]; for (let d = 0; d < s.length; d++) s[d] += vectors[i][d]; }
    for (let c = 0; c < k; c++) if (sizes[c]) centroids[c] = normalise(sums[c]);
    if (!moved) break;
  }
  return { centroids, assign: [...assign] };
}

export function nearestCentroid(vector, centroids) {
  let best = 0, bestSim = -Infinity;
  for (let c = 0; c < centroids.length; c++) {
    const sim = cosine(vector, centroids[c]);
    if (sim > bestSim) { bestSim = sim; best = c; }
  }
  return best;
}

/** A cluster's name, without AI: its two commonest subtopics. */
export function labelCluster(posts) {
  const counts = new Map();
  for (const post of posts) {
    const name = String(post.subtopic ?? "").trim();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2).map(([name]) => name).join(" · ").slice(0, 120) || null;
}

/** Whether the clusters are due a rebuild: none yet, a week old, or the catalogue has grown by a fifth. */
export function clustersDue({ clusters, vectors, now = Date.now() }) {
  if (!clusters.length) return vectors > 0;
  const built = Math.min(...clusters.map((c) => Date.parse(c.updated_at) || 0));
  const covered = clusters.reduce((sum, c) => sum + (c.size ?? 0), 0);
  return now - built > UNDERSTANDING.refreshDays * 86_400_000 || vectors > covered * (1 + UNDERSTANDING.growth);
}

/**
 * The spread of each post's similarity to its nearest neighbour (numbers only, safe for public logs), so the
 * duplicate threshold can be set from real posts rather than guessed. Samples at most `limit` posts.
 */
export function neighbourSpread(vectors, limit = 400) {
  const sample = vectors.slice(-limit);
  if (sample.length < 2) return null;
  const best = sample.map((v, i) => Math.max(...sample.map((w, j) => (i === j ? -1 : cosine(v, w)))));
  best.sort((a, b) => a - b);
  const at = (q) => Math.round(best[Math.min(best.length - 1, Math.floor(q * best.length))] * 100) / 100;
  return { posts: sample.length, p50: at(0.5), p90: at(0.9), p99: at(0.99), aboveDuplicate: best.filter((s) => s >= UNDERSTANDING.duplicate).length };
}
