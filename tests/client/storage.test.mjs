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
