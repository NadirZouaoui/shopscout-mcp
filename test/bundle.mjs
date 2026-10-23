// Offline test for bundle_deals: page parsing, keyword filter, pagination via signed POST, stop conditions.
import { createHash } from "node:crypto";
import { bundleDeals, parseBundlePage, extractAssigned } from "../src/bundle.js";

const digest = crypto.subtle.digest.bind(crypto.subtle);
crypto.subtle.digest = async (alg, data) =>
  alg === "MD5" ? new Uint8Array(createHash("md5").update(data).digest()).buffer : digest(alg, data);

const checks = [];
const ok = (name, cond) => { checks.push(cond); console.log((cond ? "PASS " : "FAIL ") + name); };

const item = (id, title, price, ori = price * 2) => ({ id, title, localizedAssignToolMinPriceInfo: `€${price}|0|0`, localizedOriMinPriceInfo: `€${ori}|0|0`, discount: 50, stock: 10, reviewStar: "4.9" });
const init = {
  data: {
    a: { compName: "gmod-aem-nn-goods-slider", fields: { data: [item(1, "GRWIBEOU WiFi 6 BT5.4 Adapter", 7.48)] } },
    b: { compName: "gmod-aem-nn-waterfall", fields: { data: [{
      itemResourceId: "101001407293", reqExt: JSON.stringify({ datasetId: 1, page: 1 }),
      extraInfo: JSON.stringify({ streamId: "s1", finished: false }),
      products: [item(2, "1300Mbps WiFi Bluetooth 5.4 Adapter", 7.66), item(3, "Rechargeable Wireless Mouse", 6.93), { ...item(9, "Scene card", 1), itemCardType: "SCENE", localizedAssignToolMinPriceInfo: "" }],
    }] } },
    c: { compName: "gmod-aem-nn-item-threshold-discount", fields: { locale: { locale: { step1ContentText: "{US $3} OFF", step1text: "on 6 items", step2ContentText: "{US $4} OFF", step2text: "on 8 items" } } } },
  },
  global: { bizContext: { pvuuid: "pv-1" } },
};
const html = `<html><script>window.__INIT_DATA__=${JSON.stringify(init)}</script><script>x={\\"memberSeq\\":\\"555\\"}</script></html>`;

ok("extract init data", extractAssigned(html, "window.__INIT_DATA__=")?.global?.bizContext?.pvuuid === "pv-1");
const pg = parseBundlePage(html);
ok("parse page: items, tiers, waterfall, member", pg.items.length === 3 && pg.tiers[0] === "US $3 OFF on 6 items" && pg.waterfall.streamId === "s1" && pg.memberSeq === "555");

const posts = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.pathname.startsWith("/ssr/")) return new Response(html, { headers: { "set-cookie": "cna=abc; Path=/" } });
  posts.push({ appKey: u.searchParams.get("appKey"), method: init.method, body: decodeURIComponent(String(init.body).replace(/^data=/, "")) });
  const params = JSON.parse(JSON.parse(posts.at(-1).body).params);
  const n = params.page;
  const products = n === 2 ? [item(4, "FENVI WiFi 6 USB Adapter", 12.59), item(5, "USB Hub", 3)]
    : n === 3 ? [item(6, "AX900 WiFi6 BT5.4 Adapter", 5.84)] : [];
  return new Response(JSON.stringify({ ret: ["SUCCESS::ok"], data: { resultValue: { "101001407293": { data: products, finished: n >= 3 } } } }));
};
const env = { AE_COOKIES: "_m_h5_tk=tok_1; cna=abc", SHIP_TO: "DZ", CURRENCY: "EUR" };

const r = await bundleDeals(env, { keywords: "wifi adapter", want: 3 });
ok("keyword filter + pagination until want", r.matches.map((m) => m.id).join() === "1,2,4" && r.pages_loaded === 2 && /found 3/.test(r.stop_reason));
const p0 = JSON.parse(JSON.parse(posts[0].body).params);
const ext = JSON.parse(JSON.parse(p0.resources)[0].reqExt);
ok("signed POST payload", posts[0].appKey === "24815441" && posts[0].method === "POST" && p0.page === 2 && p0.streamId === "s1" && p0.buyerAliId === "555" && p0.cna === "abc" && ext.pageType === 3);
ok("bundle item fields", r.matches[1].bundle_price_eur === 7.66 && r.matches[1].bundle_price_dzd === 2145 && r.matches[1].url === "https://www.aliexpress.com/item/2.html");

posts.length = 0;
const all = await bundleDeals(env, { keywords: "wifi|bluetooth", want: 30, max_pages: 15 });
ok("end of list + alternatives", all.matches.length === 4 && /end of the list/.test(all.stop_reason) && all.pages_loaded === 3);
const capped = await bundleDeals(env, { want: 30, max_pages: 2 });
ok("page limit", capped.pages_loaded === 2 && /page limit/.test(capped.stop_reason));
const cheap = await bundleDeals(env, { keywords: "adapter", max_price: 7.5, max_pages: 1 });
ok("max price", cheap.matches.every((m) => m.bundle_price_eur <= 7.5) && cheap.matches.length === 1);

if (checks.includes(false)) process.exit(1);
