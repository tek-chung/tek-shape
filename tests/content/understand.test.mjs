import { test } from "node:test";
import assert from "node:assert/strict";
import { DIMS, UNDERSTANDING, clusterCount, clustersDue, cosine, kmeans, labelCluster, nearestCentroid, neighbourSpread, normalise, pack, postText, unpack } from "../../scripts/content/understand.mjs";
import { seededRandom } from "../../scripts/content/taste.mjs";

/** A unit vector near one of a few "ideas", with a little noise, for tests that need no model. */
function near(idea, noise, random) {
  const v = new Float32Array(DIMS);
  v[idea] = 1;
  for (let i = 0; i < DIMS; i++) v[i] += (random() - 0.5) * noise;
  return normalise(v);
}

test("a vector survives storage as 512 characters, close enough to compare", () => {
  const random = seededRandom(3);
  const v = near(5, 0.4, random);
  const text = pack(v);
  assert.equal(text.length, 512);
  const back = unpack(text);
  assert.equal(back.length, DIMS);
  assert.ok(cosine(v, back) > 0.999, `${cosine(v, back)}`);
  assert.equal(unpack("not base64 of the right size"), null);
  assert.equal(unpack(null), null);
});

test("the model reads a post's statement, not its whole detail", () => {
  const text = postText({ title: "Why ice floats", insight: "Hydrogen bonds hold water open as it freezes.", explanation: ["First paragraph.", "Second paragraph."] });
  assert.equal(text, "Why ice floats. Hydrogen bonds hold water open as it freezes.. First paragraph.");
  assert.equal(postText({ title: "Only a title" }), "Only a title");
});

test("k-means finds the ideas, reproducibly, and new posts file into the nearest", () => {
  const random = seededRandom(9);
  const ideas = [3, 40, 200];
  const vectors = ideas.flatMap((idea) => Array.from({ length: 20 }, () => near(idea, 0.3, random)));
  const run = () => kmeans(vectors, 3, seededRandom(1));
  const { centroids, assign } = run();
  assert.equal(centroids.length, 3);
  for (let i = 0; i < 3; i++) assert.equal(new Set(assign.slice(i * 20, i * 20 + 20)).size, 1, `idea ${i} is one cluster`);
  assert.equal(new Set(assign).size, 3);
  assert.deepEqual(run().assign, assign, "same posts, same clusters");
  assert.equal(nearestCentroid(near(40, 0.3, random), centroids), assign[20]);
  assert.deepEqual(kmeans([], 4), { centroids: [], assign: [] });
  assert.equal(kmeans(vectors.slice(0, 2), 10).centroids.length, 2, "never more clusters than posts");
});

test("clusters are named from their commonest subtopics, without AI", () => {
  assert.equal(labelCluster([{ subtopic: "Prime Gaps" }, { subtopic: "Twin Primes" }, { subtopic: "Prime Gaps" }, { subtopic: "" }]), "Prime Gaps · Twin Primes");
  assert.equal(labelCluster([]), null);
});

test("clusters rebuild when missing, a week old or outgrown; the catalogue sets their number", () => {
  const now = Date.parse("2026-10-03T12:00:00Z");
  const built = (days, size) => [{ updated_at: new Date(now - days * 86_400_000).toISOString(), size }];
  assert.equal(clustersDue({ clusters: [], vectors: 10, now }), true);
  assert.equal(clustersDue({ clusters: [], vectors: 0, now }), false);
  assert.equal(clustersDue({ clusters: built(2, 100), vectors: 110, now }), false);
  assert.equal(clustersDue({ clusters: built(8, 100), vectors: 110, now }), true);
  assert.equal(clustersDue({ clusters: built(2, 100), vectors: 125, now }), true);
  assert.equal(clusterCount(10), 2);
  assert.equal(clusterCount(2500), 100);
  assert.equal(clusterCount(100_000), 200);
});

test("the similarity report is numbers only, for calibrating the duplicate threshold", () => {
  const random = seededRandom(4);
  const vectors = [near(1, 0.05, random), near(1, 0.05, random), near(90, 0.3, random)];
  const spread = neighbourSpread(vectors);
  assert.deepEqual(Object.keys(spread), ["posts", "p50", "p90", "p99", "aboveDuplicate"]);
  assert.equal(spread.aboveDuplicate, 2, "the two near-identical posts");
  assert.ok(UNDERSTANDING.near < UNDERSTANDING.duplicate);
  assert.equal(neighbourSpread([vectors[0]]), null);
});
