import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOutbox, applyPatch, emptyPost, initialState, marksRead, readBefore } from "../../src/lib/storage.ts";

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
