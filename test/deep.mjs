// Offline test of deep search, modelled on the Rapoo MT760 case: the cheapest listing (titled
// "MT760/MT720L") was only returned by a search that narrowed the pool with "MT720L".
// Usage: node test/deep.mjs
import assert from "node:assert/strict";
import { deepSearch, parsePrice, modelTokens, buildQueries, isAccessory } from "../src/deep.js";

assert.equal(parsePrice("€ 37,84"), 37.84);
assert.equal(parsePrice("€ 1.171,21"), 1171.21);
assert.equal(parsePrice("US $9.80"), 9.8);
assert.equal(parsePrice("1,234"), 1234);
assert.ok(Number.isNaN(parsePrice(undefined)));

assert.deepEqual(modelTokens("Rapoo MT760/MT720L 4000 DPI"), ["MT760", "MT720L"]);
const q = buildQueries("rapoo mt760", ["MT720L"]);
assert.deepEqual(q.queries, ["rapoo mt760", "mt760", "rapoo MT720L"]);
assert.ok(isAccessory("For Rapoo MT760 Mouse Grip Tape + Skates"));
assert.ok(!isAccessory("Rapoo MT760NL Three Mode Hall Effect Magnetic Side Scroll Wheel Wireless Mouse"));

const item = (id, title, price, tags) => ({ id, title, price, tags, link: `https://www.aliexpress.com/item/${id}.html` });
const popular = [
  item("1", "Rapoo MT760L/MT760M Multi-mode Wireless Mouse", "€ 37,84", ["New shoppers save €53.35"]),
  item("2", "Rapoo MT760L/MT760M Multi-mode Wireless Mouse", "€ 41,35"),
  item("3", "For Rapoo MT760 Mouse Grip Tape", "€ 1,62"),
  item("4", "Logitech MX Master 3S", "€ 96,09"),
];
const hidden = [item("9", "Rapoo MT760/MT720L Multi-mode Rechargeable Wireless Mouse", "€ 23,44")];
const calls = [];
const search = async (a) => {
  calls.push(`${a.keywords}#${a.page}`);
  if (a.page > 1) return { products: [] };
  return { products: /mt720l/i.test(a.keywords) ? hidden : popular };
};

// Without the alias the hidden listing is NOT found (coverage is not guaranteed)...
let r = await deepSearch({ keywords: "rapoo mt760" }, { search });
assert.ok(!r.products.some((p) => p.id === "9"));
// ...with the alias it is, accessories and unrelated items are dropped, new-shopper price is flagged and sorted last.
calls.length = 0;
r = await deepSearch({ keywords: "rapoo mt760", aliases: ["MT720L"] }, { search });
assert.deepEqual(r.products.map((p) => p.id), ["9", "2", "1"]);
assert.equal(r.products[2].new_shopper_price, true);
assert.match(r.products[2].price_note, /new-shopper/);
assert.equal(r.dropped.accessories, 1);
assert.equal(r.dropped.not_matching, 1);
assert.ok(calls.some((c) => c.startsWith("rapoo MT720L")));

// Sibling model names in matching titles trigger a second round (MT760L -> "rapoo MT760L").
assert.ok(r.queries_run.some((x) => x.startsWith("rapoo MT760L")) || r.sibling_models_tried?.includes("MT760L"));

// include_accessories keeps them.
r = await deepSearch({ keywords: "rapoo mt760", aliases: ["MT720L"], include_accessories: true }, { search });
assert.ok(r.products.some((p) => p.id === "3"));

// verify_top attaches personalised totals and re-sorts by them.
r = await deepSearch({ keywords: "rapoo mt760", aliases: ["MT720L"], verify_top: 2 }, {
  search,
  verify: async (ids) => ids.map((id) => id === "9"
    ? { id, variant: "Light Gray", price_eur: 23.44, shipping: { fee_eur: 7.56, delivery_days: "9-33" }, total_eur: 31, total_dzd: 8680 }
    : { id, error: "blocked" }),
});
assert.equal(r.products[0].id, "9");
assert.equal(r.products[0].verified.total_eur, 31);
assert.equal(r.products.find((p) => p.id === "1").verified.error, "blocked");

// A failing query is reported, not fatal.
r = await deepSearch({ keywords: "rapoo mt760" }, { search: async (a) => { if (a.keywords === "mt760") throw new Error("boom"); return { products: popular }; } });
assert.ok(r.errors.some((e) => e.includes("boom")));
assert.ok(r.products.length >= 2);

// Fetch budget is respected.
calls.length = 0;
await deepSearch({ keywords: "rapoo mt760", aliases: ["a1", "a2", "a3", "a4", "a5"], pages: 4 }, { search }, { maxFetches: 6 });
assert.ok(calls.length <= 6);

console.log("deep ok");
