import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOutbox, applyPatch, coerceBlocks, coercePost, emptyPost, initialState, marksRead, readBefore } from "../../src/lib/storage.ts";

const at = (time) => `2026-09-24T${time}:00.000Z`;
const stateWith = (posts) => ({ ...initialState, posts });

test("any control counts as reading a post; being seen does not", () => {
  for (const patch of [{ rating: "harder" }, { rating: null }, { bookmarked: true }, { bookmarked: false }, { expanded: true }, { opened: true }, { read: true }])
    assert.equal(applyPatch(emptyPost, patch, at("10:00")).readAt, at("10:00"), JSON.stringify(patch));
  assert.equal(applyPatch(emptyPost, { seen: true }, at("10:00")).readAt, undefined);
  assert.equal(marksRead({ seen: true }), false);
  assert.equal(applyPatch({ ...emptyPost, readAt: at("09:00") }, { rating: "more" }, at("10:00")).readAt, at("09:00"), "the first read time stands");
});

test("a read not yet synced keeps the time it happened on this device, so it still counts before a later sitting", () => {
  const local = stateWith({ a: { ...emptyPost, rating: "more", readAt: at("10:00") } });
  const outbox = { posts: { a: { rating: "more", read: true } }, progress: null };
  const merged = applyOutbox(initialState, outbox, at("12:05"), local);
  assert.equal(merged.posts.a.readAt, at("10:00"));
  assert.equal(readBefore(merged, "a", at("12:00")), true, "Refresh at 12:00 moves it to Read");
  // Without this device's copy the merge can only stamp it now, after the sitting began: the old bug.
  assert.equal(readBefore(applyOutbox(initialState, outbox, at("12:05")), "a", at("12:00")), false);
  // Once the server has it, the server's time wins.
  const server = stateWith({ a: { ...emptyPost, rating: "more", readAt: "2026-09-24T10:00:02.123456+00:00" } });
  assert.equal(applyOutbox(server, outbox, at("12:05"), local).posts.a.readAt, "2026-09-24T10:00:02.123456+00:00");
});

test("read before the sitting leaves the feed; read during it stays put; formats compare as times", () => {
  const state = stateWith({
    before: { ...emptyPost, readAt: "2026-09-24T11:59:59.999999+00:00" },
    during: { ...emptyPost, readAt: at("12:01") },
    seen: { ...emptyPost, firstSeenAt: at("09:00") },
  });
  assert.equal(readBefore(state, "before", at("12:00")), true);
  assert.equal(readBefore(state, "during", at("12:00")), false);
  assert.equal(readBefore(state, "seen", at("12:00")), false);
  assert.equal(readBefore(state, "unknown", at("12:00")), false);
  assert.equal(readBefore(null, "before", at("12:00")), false);
});

test("a post rated, saved or opened on an older app, with no read time, counts as read in an earlier sitting", () => {
  const state = stateWith({
    rated: { ...emptyPost, rating: "harder" },
    saved: { ...emptyPost, bookmarked: true },
    deeper: { ...emptyPost, deeperOpenedAt: at("08:00") },
    opened: { ...emptyPost, openedAt: at("08:00") },
    untouched: { ...emptyPost },
  });
  for (const id of ["rated", "saved", "deeper", "opened"]) assert.equal(readBefore(state, id, at("12:00")), true, id);
  assert.equal(readBefore(state, "untouched", at("12:00")), false);
});

const published = { id: "idea-1", topic: "Technology", title: "Towers", explanation: ["The opening paragraph."], publishedAt: "2026-09-24T10:00:00Z",
  status: "published", contentType: "news",
  sources: [{ url: "https://www.technologyreview.com/a", title: "Towers", publisher: "MIT Technology Review", accessedAt: "2026-09-24T10:00:00Z", articleDate: null, author: "Ada Writer", licence: "CC BY-NC-SA 4.0" }] };

test("an excerpt needs no insight or deeper explanation; an ordinary post still does", () => {
  const excerpt = coercePost({ ...published, kind: "excerpt", insight: null, deeper: null, hasBody: true });
  assert.equal(excerpt.kind, "excerpt");
  assert.equal(excerpt.insight, "");
  assert.equal(excerpt.hasBody, true);
  assert.equal(excerpt.sources[0].author, "Ada Writer");
  assert.equal(excerpt.sources[0].licence, "CC BY-NC-SA 4.0");
  assert.equal(coercePost({ ...published, insight: null, deeper: null }), null);
  const post = coercePost({ ...published, insight: "I", deeper: "D" });
  assert.equal(post.kind, undefined);
  assert.equal(post.hasBody, undefined);
});

test("a saved article is plain text blocks; anything else is dropped", () => {
  const blocks = coerceBlocks([
    { t: "p", text: "A paragraph." }, { t: "h", text: "A heading" }, { t: "ul", items: ["One", 2, "Two"] },
    { t: "table", rows: [["A", "B"], []] }, { t: "script", text: "alert(1)" }, { t: "p", html: "<b>bold</b>" }, "text", null,
  ]);
  assert.deepEqual(blocks, [{ t: "p", text: "A paragraph." }, { t: "h", text: "A heading" }, { t: "ul", items: ["One", "Two"] }, { t: "table", rows: [["A", "B"]] }]);
  assert.equal(coerceBlocks([]), null);
  assert.equal(coerceBlocks({ t: "p", text: "x" }), null);
});

test("reading time adds up in the outbox, is capped per report, and can be stripped for an older server", async () => {
  const { MAX_DWELL_MS, coerceOutbox, mergePatch, withoutDwell } = await import("../../src/lib/storage.ts");
  assert.deepEqual(mergePatch({ seen: true, dwell: 1200 }, { dwell: 800 }), { seen: true, dwell: 2000 });
  assert.deepEqual(mergePatch({ rating: "more" }, { dwell: 500 }), { rating: "more", dwell: 500 });
  assert.deepEqual(mergePatch({ dwell: 400 }, { rating: "harder" }), { dwell: 400, rating: "harder" }, "a later tap keeps the time");
  assert.equal(mergePatch({ dwell: MAX_DWELL_MS - 10 }, { dwell: 5000 }).dwell, MAX_DWELL_MS);
  assert.deepEqual(withoutDwell({ seen: true, dwell: 300 }), { seen: true });
  assert.equal(withoutDwell({ dwell: 300 }), null);
  assert.equal(applyPatch(emptyPost, { dwell: 3000 }, at("10:00")).readAt, undefined, "time in view is not a read");
  const outbox = coerceOutbox({ posts: { a: { dwell: 1500.4 }, b: { dwell: -3 }, c: { dwell: "9" }, d: { dwell: 9e9, seen: true } }, progress: null });
  assert.deepEqual(outbox.posts, { a: { dwell: 1500 }, d: { seen: true, dwell: MAX_DWELL_MS } });
});

test("why a post was placed, in plain words, from whatever the engine stored", async () => {
  const { explainPlacement } = await import("../../src/lib/why.ts");
  const names = (id) => (id === "neuroscience" ? { field: "Neuroscience & the brain", area: "Life sciences" } : undefined);
  assert.deepEqual(explainPlacement(null), ["Placed before the feed recorded its reasons."]);
  assert.deepEqual(explainPlacement("junk"), ["Placed before the feed recorded its reasons."]);
  assert.match(explainPlacement({ why: "next-step", field: "neuroscience" }, names)[0], /next step in Neuroscience & the brain/);
  assert.match(explainPlacement({ why: "breadth", field: "neuroscience" }, names)[0], /Life sciences has not appeared/);
  assert.match(explainPlacement({ why: "bridge", field: "x" }, names)[0], /shares an idea you enjoyed/);
  const many = explainPlacement({ why: "stem", field: "neuroscience", steer: "stem", reteach: true, fatigue: 0.4, difficulty: 4, target: 2.5 }, names);
  assert.equal(many.length, 5, many.join(" | "));
  assert.match(many.at(-1), /above your usual level/);
  assert.match(explainPlacement({ why: "something-new", field: "nope" }, names)[0], /Close to what you enjoy in this field/);
});

test("the Atlas offers fields with posts waiting that you have barely read, unexplored first, niches included", async () => {
  const { atlasTiles } = await import("../../src/lib/atlas.ts");
  const field = (id, posts, read) => ({ field: { id, label: id }, posts, read });
  const map = { umbrellas: [
    { umbrella: { id: "life-sciences", short: "Life" }, fields: [field("neuroscience", 30, 12), field("ecology", 5, 0), field("genetics", 4, 2)] },
    { umbrella: { id: "other", short: "Other" }, fields: [field("general", 9, 0)] },
    { umbrella: { id: "mathematics", short: "Maths" }, fields: [field("topology", 0, 0), field("statistics", 8, 6)] },
  ] };
  const tiles = atlasTiles(map, [{ field: "statistics" }]);
  assert.deepEqual(tiles.map((t) => t.field), ["ecology", "statistics", "genetics"]);
  assert.deepEqual(tiles[0], { field: "ecology", label: "ecology", area: "Life", waiting: 5, read: 0, niche: false });
  assert.equal(atlasTiles(map, [], 1).length, 1);
});
