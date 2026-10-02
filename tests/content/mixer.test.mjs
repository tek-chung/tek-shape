import { test } from "node:test";
import assert from "node:assert/strict";
import { MIX, SOURCES, apportion, mixShares, spread, stemFieldsOf, trustedOf } from "../../scripts/content/mixer.mjs";
import { seededRandom } from "../../scripts/content/taste.mjs";

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

test("shares start from the plan, move with how each source lands, and keep breadth and exploration above a floor", () => {
  assert.deepEqual(Object.keys(mixShares()), Object.keys(SOURCES));
  assert.ok(Math.abs(sum(mixShares()) - 1) < 1e-9);
  const landing = mixShares({ stem: { n: 20, hits: 18 }, wild: { n: 20, hits: 4 } }, 0.6);
  assert.ok(landing.stem > SOURCES.stem && landing.wild < SOURCES.wild, "a source landing well grows; one missing shrinks");
  assert.ok(landing.stem <= SOURCES.stem * (1 + MIX.tune) / 0.95, "by a bounded amount");
  const early = mixShares({ stem: { n: 3, hits: 3 } }, 0.5);
  assert.ok(Math.abs(early.stem - SOURCES.stem) < 1e-9, "too few outcomes move nothing");
  const starved = mixShares({ bar: { n: 50, hits: 0 }, wild: { n: 50, hits: 0 }, stem: { n: 50, hits: 50 } }, 0.5);
  assert.ok(starved.bar >= MIX.floors.bar - 1e-9 && starved.wild >= MIX.floors.wild - 1e-9, JSON.stringify(starved));
  assert.ok(Math.abs(sum(starved) - 1) < 1e-9);
});

test("a batch's slots add up, follow the shares, and are spread out with the stem first", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const counts = apportion(SOURCES, 10, seededRandom(seed));
    assert.equal(sum(counts), 10);
    assert.ok(counts.stem >= 3 && counts.bar >= 3 && counts.bridges >= 1 && counts.trusted >= 1 && counts.wild >= 1, JSON.stringify(counts));
  }
  const order = spread({ stem: 4, bar: 3, wild: 2, fresh: 1 });
  assert.equal(order.length, 10);
  assert.equal(order[0], "stem");
  for (let i = 1; i < order.length; i++) assert.ok(!(order[i] === "bar" && order[i - 1] === "bar"), `no clumping: ${order.join()}`);
  assert.equal(spread({ bar: 2 })[0], "bar", "with no stem or trusted posts, the largest source opens");
  assert.deepEqual(spread({}), []);
});

test("the stem is what you chose (three at most), else your clearest favourites; trusted sources are learnt", () => {
  const fields = [
    { field: "ethics", weight: 6, mean: 0.8 }, { field: "neuroscience", weight: 4, mean: 0.85 },
    { field: "macroeconomics", weight: 9, mean: 0.5 }, { field: "geology", weight: 1, mean: 0.95 },
  ];
  assert.deepEqual([...stemFieldsOf({ fields, prior: 0.55 })], ["ethics", "neuroscience"]);
  assert.deepEqual([...stemFieldsOf({ chosen: ["a", "b", "c", "d"], fields, prior: 0.55 })], ["a", "b", "c"]);
  assert.deepEqual([...stemFieldsOf({ fields: [], prior: 0.55 })], []);
  const trusted = trustedOf({ publishers: [{ publisher: "Aeon", weight: 5, mean: 0.8 }, { publisher: "Loud", weight: 9, mean: 0.5 }, { publisher: "New", weight: 1, mean: 0.9 }], prior: 0.55 });
  assert.deepEqual([...trusted], ["Aeon"]);
});
