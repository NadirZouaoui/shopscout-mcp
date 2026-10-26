// Offline test for Advanced API shipping (response shape observed live: shipping_fee, min/max_delivery_days, ship_from_country).
import { parseShipping, addShipping } from "../src/aliexpress.js";

const checks = [];
const ok = (name, cond) => { checks.push(cond); console.log((cond ? "PASS " : "FAIL ") + name); };

const paid = parseShipping({ shipping_fee: "7.91", delivery_days: "18", max_delivery_days: "18", ship_from_country: "CN", min_delivery_days: "9" });
ok("paid shipping", paid.fee_eur === 7.91 && paid.delivery_days === "9-18" && paid.ships_from === "CN");
ok("free shipping", parseShipping({ shipping_fee: "0", min_delivery_days: "9", max_delivery_days: "17" }).fee_eur === 0);
ok("no shipping offered", parseShipping({ total_record_count: 0 }).fee_eur === null);

let calls = 0;
globalThis.fetch = async (_u, init) => {
  calls++;
  const p = Object.fromEntries(new URLSearchParams(init.body));
  if (calls === 1) return new Response(JSON.stringify({ error_response: { code: "ApiCallLimit", msg: "ban 1 second" } }));
  return new Response(JSON.stringify({ aliexpress_affiliate_product_shipping_get_response: { resp_result: { resp_code: 200, result: {
    shipping_fee: p.product_id === "2" ? "7.91" : "0", min_delivery_days: "9", max_delivery_days: "18", ship_from_country: "CN" } } } }));
};
const env = { AE_APP_KEY: "k", AE_APP_SECRET: "s", SHIP_TO: "DZ", CURRENCY: "EUR" };
const items = [{ id: "1", sku_id: "a", price_eur: 11.32 }, { id: "2", sku_id: "b", price_eur: 33.37 }, { id: "3", price_eur: 5 }];
await addShipping(env, items);
ok("retry after rate limit + totals", calls === 3 && items[0].total_eur === 11.32 && items[1].total_eur === 41.28 && items[1].total_dzd === 11558);
ok("skips items without sku", items[2].shipping === undefined);

if (checks.includes(false)) process.exit(1);
