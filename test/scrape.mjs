// Offline test of scrape mode with fake pages shaped like AliExpress's embedded JSON.
// Usage: node test/scrape.mjs
import worker from "../src/index.js";

const env = { ACCESS_TOKEN: "t0k", SHIP_TO: "DZ" };

const searchPage = `<html><script>if(window._dida_config_._init_data_){var x={a:1}}</script><script>window._dida_config_._init_data_= { data: {"root":{"fields":{"mods":{"itemList":{"content":[
 {"productId":"1005001111111111","title":{"displayTitle":"WiFi 6 USB adapter"},"prices":{"salePrice":{"formattedPrice":"US $9.80"}},"evaluation":{"starRating":4.7},"trade":{"tradeDesc":"1,000+ sold"},"store":{"storeName":"Net Store"},"sellingPoints":[{"tagContent":{"tagText":"SuperDeals"}},{"tagContent":{"tagText":"Free shipping"}}]},
 {"productId":"1005002222222222","title":{"displayTitle":"AC1300 dongle \\"BT\\" {x}"},"prices":{"salePrice":{"formattedPrice":"US $7.10"}}}
]}}}}} }</script></html>`;

const itemPage = `<html><head><meta property="og:title" content="FENVI 1300Mbps USB adapter - AliExpress 7"></head>
<script>window.runParams = { data: {"priceComponent":{"formatedActivityPrice":"US $11.20"},
"feedbackComponent":{"averageStar":"4.8","totalValidNum":512},"tradeComponent":{"formatTradeCount":"2000+"},
"productPropComponent":{"props":[{"attrName":"Chipset","attrValue":"RTL8822BU"},{"attrName":"Interface Type","attrValue":"USB 3.0"}]},
"skuComponent":{"productSKUPropertyList":[{"skuPropertyName":"Color","skuPropertyValues":[{"propertyValueDisplayName":"Black"}]}]},
"sellerComponent":{"storeName":"FENVI Store"}} };</script></html>`;

const reviewsJson = { data: { totalNum: 2, evaViewList: [{ buyerEval: 100, evalDate: "01 Oct 2026", buyerCountry: "DZ", buyerFeedback: "Works, chip 8822BU, hotspot 5GHz ok", images: [1] }] } };

globalThis.fetch = async (url) => {
  const u = String(url);
  const page = u.includes("/w/wholesale-") ? searchPage
    : u.includes("/item/") ? itemPage
    : u.includes("searchEvaluation") ? JSON.stringify(reviewsJson)
    : u.includes("a.aliexpress.com") ? null : "";
  if (page === null) return new Response(null, { status: 302, headers: { location: "https://www.aliexpress.com/item/1005003333333333.html" } });
  return new Response(page);
};

const call = async (name, args) => {
  const res = await worker.fetch(new Request("https://x/mcp/t0k", { method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), env);
  const r = await res.json();
  if (r.result.isError) throw new Error(r.result.content[0].text);
  return JSON.parse(r.result.content[0].text);
};

const checks = [];
const ok = (n, c) => { checks.push(c); console.log((c ? "PASS " : "FAIL ") + n); };

const s = await call("search_products", { keywords: "wifi 6 adapter" });
ok("search finds 2", s.products.length === 2 && s.source === "scrape");
ok("search tags/shipping", s.products[0].shipping === "Free shipping" && s.products[0].tags[0] === "SuperDeals");
ok("search price/title", s.products[0].price === "US $9.80" && s.products[1].title.includes('"BT"'));

const p = await call("get_product", { products: "https://a.aliexpress.com/_EzTbrRG" });
const d = p.products[0];
ok("short link resolved", d.id === "1005003333333333");
ok("title cleaned", d.title === "FENVI 1300Mbps USB adapter");
ok("specs chipset", d.specs?.Chipset === "RTL8822BU");
ok("price/rating/shop", d.price === "US $11.20" && d.rating === "4.8" && d.shop === "FENVI Store");
ok("variants", d.variants?.[0]?.values?.[0] === "Black");

const r = await call("get_reviews", { product: "1005003333333333" });
ok("reviews", r.reviews[0].stars === 5 && r.reviews[0].text.includes("8822BU"));

process.exit(checks.every(Boolean) ? 0 : 1);
