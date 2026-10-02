import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMAND, planDemand, withDemand } from "../../scripts/content/demand.mjs";
import { buildTaste } from "../../scripts/content/taste.mjs";

const now = Date.parse("2026-10-05T12:00:00Z");
const ago = (days) => new Date(now - days * 86_400_000).toISOString();
let serial = 0;
const post = (field, extra = {}) => ({ id: `d-${++serial}`, field, subtopic: `${field} ${serial}`, status: "published", verification_status: "source_checked",
  content_type: "evergreen", difficulty: 2, concept_ids: [`c-${serial}`], publisher: "Aeon", reviewed_at: ago(1), ...extra });
const read = (p, days = 1) => ({ post_id: p.id, rating: "more", bookmarked: false, read_at: ago(days), first_seen_at: ago(days), updated_at: ago(days) });

/** A reader who has read `daily` posts a day for a week, all in the fields given. */
function reader(daily, fields) {
  const history = Array.from({ length: daily * 7 }, (_, i) => post(fields[i % fields.length]));
  const states = history.map((p, i) => read(p, (i % 7) + 0.5));
  return { history, states, queued: new Set(history.map((p) => p.id)), model: buildTaste({ posts: history, states, now }) };
}

test("with plenty waiting, a run drafts only the floor, plus fresh news when there is too little", () => {
  const { history, states, queued, model } = reader(10, ["ethics", "neuroscience"]);
  const stock = Array.from({ length: 200 }, (_, i) => post(["ethics", "neuroscience", "geology", "law-rights", "modern-history"][i % 5]));
  const fresh = Array.from({ length: 6 }, () => post("geopolitics-diplomacy", { content_type: "news", article_date: ago(1) }));
  const plan = planDemand({ posts: [...history, ...stock, ...fresh], states, queued, model, now, limit: 26 });
  assert.equal(plan.drafts, DEMAND.minDrafts, JSON.stringify(plan.report));
  assert.equal(plan.report.readsPerDay, 10);
  const noNews = planDemand({ posts: [...history, ...stock], states, queued, model, now, limit: 26 });
  assert.ok(noNews.drafts > DEMAND.minDrafts, "short of fresh news, it drafts more");
  assert.ok(noNews.newsNeed > 0);
});

test("an empty shelf drafts up to the limit; the yield of past drafts scales the plan", () => {
  const { history, states, queued, model } = reader(10, ["ethics", "neuroscience"]);
  assert.equal(planDemand({ posts: history, states, queued, model, now, limit: 26 }).drafts, 26);
  const few = Array.from({ length: 50 }, () => post("ethics"));
  const good = planDemand({ posts: [...history, ...few], states, queued, model, now, limit: 26, yieldRate: 1 });
  const poor = planDemand({ posts: [...history, ...few], states, queued, model, now, limit: 26, yieldRate: 0.25 });
  assert.ok(poor.drafts > good.drafts, `drafts that rarely pass need more attempts (${poor.drafts} vs ${good.drafts})`);
  assert.equal(planDemand({ posts: [], states: [], queued: new Set(), model, now, limit: 1 }).drafts, 1, "never above the limit");
});

test("disliked, resting and stale posts are not counted as stock", () => {
  const { history, states, queued, model: base } = reader(5, ["ethics"]);
  const dull = Array.from({ length: 4 }, () => post("macroeconomics"));
  const model = buildTaste({ posts: [...history, ...dull], states: [...states, ...dull.map((p) => ({ ...read(p), rating: "uninteresting" }))], now });
  const stale = Array.from({ length: 30 }, () => post("ethics", { content_type: "news", article_date: ago(20) }));
  const unwanted = Array.from({ length: 30 }, () => post("macroeconomics"));
  const plan = planDemand({ posts: [...history, ...dull, ...stale, ...unwanted], states, queued: new Set([...queued, ...dull.map((p) => p.id)]), model, now });
  assert.equal(plan.report.useful, 0, JSON.stringify(plan.report));
  assert.ok(base.prior > 0);
});

test("gaps lift matching headlines: a stem field short of its share, an area with nothing waiting, news when short", () => {
  const { history, states, queued } = reader(10, ["ethics", "neuroscience"]);
  const prefs = ["ethics", "neuroscience"].map((key) => ({ scope: "field", key, choice: "stem" }));
  const model = buildTaste({ posts: history, states, prefs, now });
  assert.deepEqual([...model.stemFields].sort(), ["ethics", "neuroscience"]);
  const geology = post("geology", { reviewed_at: ago(40) });
  const stock = Array.from({ length: 120 }, () => post("ethics"));
  const law = post("law-rights", { reviewed_at: ago(2) });
  const plan = planDemand({ posts: [...history, ...stock, geology, law], states, queued, model, now, limit: 26 });
  assert.equal(plan.needOf("ethics"), 0, "plenty of ethics waiting");
  assert.ok(plan.needOf("neuroscience") > 0.9, "none of the other stem field");
  assert.ok(plan.needOf("law-rights") > 0.4, "an area the sources cover, with little waiting");
  assert.equal(plan.needOf("astronomy-cosmology"), 0, "an area no source has written about this month cannot be drafted into");
  const verdict = { skip: false, score: 0.5, field: "neuroscience" };
  assert.ok(withDemand(verdict, plan).score > 0.75);
  assert.equal(withDemand({ skip: false, score: 0.5, field: "ethics" }, plan).score, 0.5);
  assert.ok(withDemand({ skip: false, score: 0.5, field: "ethics" }, plan, { news: true }).score > 0.5, "news when short of it");
  assert.deepEqual(withDemand({ skip: true, score: 0 }, plan), { skip: true, score: 0 }, "a resting subtopic stays skipped");
  assert.equal(withDemand(verdict, null), verdict, "demand off changes nothing");
  assert.deepEqual(Object.keys(plan.report).sort(), ["areasShort", "deficit", "drafts", "freshNews", "freshWanted", "readsPerDay", "stemShort", "target", "useful", "yield"],
    "the report is numbers only, fit for public logs");
});
