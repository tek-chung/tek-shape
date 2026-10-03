import { test } from "node:test";
import assert from "node:assert/strict";
import { DEAR_INSTRUCTION, dearPreferences, dearSchema, settleSteers } from "../../scripts/content/dear.mjs";
import { buildTaste } from "../../scripts/content/taste.mjs";

const names = new Map([["ancient-medieval-history::byzantine empire", "Byzantine Empire"], ["artificial-intelligence::ai regulation", "AI Regulation"]]);

test("the model's answer becomes at most five steers, matched to subtopics the feed already uses", () => {
  const steers = settleSteers({ steers: [
    { field: "artificial-intelligence", subtopic: "", choice: "less" },
    { field: "ancient-medieval-history", subtopic: "Byzantium Empire", choice: "more" },
    { field: "ancient-medieval-history", subtopic: "Viking Raids", choice: "more" },
    { field: "not-a-field", subtopic: "", choice: "more" },
    { field: "ethics", subtopic: "", choice: "shout" },
    { field: "artificial-intelligence", subtopic: "", choice: "snooze" },
  ] }, names);
  assert.deepEqual(steers.map((s) => [s.scope, s.key, s.choice, s.label]), [
    ["field", "artificial-intelligence", "less", "Artificial intelligence"],
    ["subtopic", "ancient-medieval-history::byzantine empire", "more", "Byzantine Empire"],
    ["subtopic", "ancient-medieval-history::viking raids", "more", "Viking Raids"],
  ], "unknown fields and choices dropped; a repeat of the same steer dropped; an unmatched subtopic kept as written");
  assert.deepEqual(settleSteers(null), []);
  assert.deepEqual(settleSteers({ steers: "nope" }), []);
});

test("running requests become preferences that steer the taste model, and stop when they expire", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  const at = (h) => new Date(now + h * 3_600_000).toISOString();
  const prefs = dearPreferences([
    { status: "applied", created_at: at(-5), until: at(20), steers: [{ scope: "field", key: "artificial-intelligence", choice: "less" }] },
    { status: "applied", created_at: at(-50), until: at(-1), steers: [{ scope: "field", key: "ethics", choice: "more" }] },
    { status: "pending", created_at: at(-1), until: at(70), steers: [] },
  ], now);
  assert.deepEqual(prefs.map((p) => [p.key, p.choice, p.source]), [["artificial-intelligence", "less", "dear-t"]]);
  const model = buildTaste({ posts: [], states: [], prefs, now });
  assert.equal(model.multiplier(model.prefFor("artificial-intelligence", "artificial-intelligence::x")?.choice), 0.7);
});

test("the request is filed with a small schema whose fields are the subject map's", () => {
  const item = dearSchema.properties.steers.items.properties;
  assert.ok(item.field.enum.includes("ancient-medieval-history"));
  assert.deepEqual(item.choice.enum, ["more", "less", "snooze"]);
  assert.match(DEAR_INSTRUCTION, /untrusted data/);
});
