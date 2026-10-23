// Offline test for check_price parsing, token refresh and KV caching (mocked mtop responses).
import { createHash } from "node:crypto";
import { parsePdp, mergeCookies, checkPrice } from "../src/pdp.js";

// Workers' crypto.subtle supports MD5; Node's doesn't, so shim it for the test.
const digest = crypto.subtle.digest.bind(crypto.subtle);
crypto.subtle.digest = async (alg, data) =>
  alg === "MD5" ? new Uint8Array(createHash("md5").update(data).digest()).buffer : digest(alg, data);

const checks = [];
const ok = (name, cond) => { checks.push(cond); console.log((cond ? "PASS " : "FAIL ") + name); };

// Shape observed from mtop.aliexpress.pdp.pc.query for the DZ site
const result = {
  PRODUCT_TITLE: { text: "Xiaomi TV Box S 3rd Gen" },
  PRICE: {
    selectedSkuId: 12000060419298710,
    targetSkuPriceInfo: { originalPrice: { currency: "EUR", formatedAmount: "€143.55", value: 143.55 }, salePriceString: "€81.83" },
    skuPriceInfoMap: {
      "12000060419298710": { salePriceString: "€81.83" },
      "12000060419298711": { salePriceString: "€82.76" },
    },
  },
  SHIPPING: {
    deliveryLayoutInfo: [{ bizData: {
      displayAmount: 5.95, shippingFee: "charge", formattedAmount: "€5.95", deliveryProviderName: "AliExpress Standard Shipping",
      shipFromCode: "CN", deliveryDayMin: 12, deliveryDayMax: 27, displayEtaMaxDate: "Nov. 19",
    } }],
  },
  SKU: {
    selectedSkuIdStr: "12000060419298710",
    skuProperties: [{ skuPropertyValues: [
      { propertyValueId: 201, propertyValueDisplayName: "Mi Box S 3rd Gen" },
      { propertyValueId: 202, propertyValueDisplayName: "Add EU plug" },
    ] }],
    skuPaths: [
      { skuIdStr: "12000060419298710", path: "14:201", skuStock: 67 },
      { skuIdStr: "12000060419298711", path: "14:202", skuStock: 3 },
    ],
  },
  QUANTITY_PC: { totalAvailableInventory: 67 },
  PRICE_EXTEND: { priceExtendViews: [{ text: "2+ pieces, extra 2% off" }], buildText: "<span>Tax excluded</span>" },
  INTEREST_POINTS: { content: "€0.91 off over €90.41", couponIcon: "https://ae-pic.example/x.png", couponStartColor: "#FF0000" },
};

const p = parsePdp(result, "1005009412750740");
ok("price", p.price_eur === 81.83 && p.original_eur === 143.55);
ok("shipping", p.shipping.fee_eur === 5.95 && p.shipping.carrier === "AliExpress Standard Shipping" && p.shipping.delivery_days === "12-27");
ok("total eur/dzd", p.total_eur === 87.78 && p.total_dzd === 24578);
ok("variants + selected", p.variants.length === 2 && p.variants[1].price_eur === 82.76 && p.variant === "Mi Box S 3rd Gen");
ok("deals (bundle + coupon, no urls/colors)", p.deals.includes("2+ pieces, extra 2% off") && p.deals.includes("€0.91 off over €90.41") && p.deals.length === 2);
ok("plain url", p.url === "https://www.aliexpress.com/item/1005009412750740.html");

const free = parsePdp({ ...result, SHIPPING: { x: { displayAmount: 0, shippingFee: "free" } } }, "1");
ok("free shipping", free.shipping.fee_eur === 0 && free.total_eur === 81.83);

const m = mergeCookies("a=1; _m_h5_tk=old_1", ["_m_h5_tk=new_2; Path=/; Domain=.aliexpress.com", "b=3; Path=/"]);
ok("cookie merge", m.changed && m.cookies === "a=1; _m_h5_tk=new_2; b=3");

// Token expired on the first call -> Set-Cookie with a new token -> retry succeeds; result cached in KV
const store = new Map();
const kv = { get: async (k, t) => (store.has(k) ? (t === "json" ? JSON.parse(store.get(k)) : store.get(k)) : null), put: async (k, v) => store.set(k, v) };
let calls = 0;
globalThis.fetch = async () => {
  calls++;
  if (calls === 1)
    return new Response('mtopjsonp1({"ret":["FAIL_SYS_TOKEN_EXOIRED::令牌过期"]})', { headers: { "set-cookie": "_m_h5_tk=fresh_9; Path=/" } });
  return new Response(`mtopjsonp1(${JSON.stringify({ ret: ["SUCCESS::调用成功"], data: { result } })})`);
};
const env = { AE_COOKIES: "_m_h5_tk=stale_1; x=y", SHOPSCOUT_KV: kv, CURRENCY: "EUR", SHIP_TO: "DZ" };
const first = await checkPrice("1005009412750740", env);
ok("token refresh retry", calls === 2 && first.total_eur === 87.78 && store.get("cookies").includes("_m_h5_tk=fresh_9"));
const second = await checkPrice("1005009412750740", env);
ok("kv cache", second.cached === true && calls === 2);

if (checks.includes(false)) process.exit(1);
