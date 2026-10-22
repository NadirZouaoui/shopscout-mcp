// Local smoke test: runs the worker's fetch handler with a mocked API gateway.
// Usage: node test/smoke.mjs
import worker from "../src/index.js";
import { signParams } from "../src/aliexpress.js";

const env = { ACCESS_TOKEN: "t0k", AE_APP_KEY: "k", AE_APP_SECRET: "s", SHIP_TO: "DZ" };

globalThis.fetch = async (url, init) => {
  const p = Object.fromEntries(new URLSearchParams(init.body));
  const { sign, ...rest } = p;
  if (sign !== (await signParams(rest, "s"))) throw new Error("bad signature");
  const product = {
    product_id: 1005001234567890, product_title: "Test WiFi adapter", target_sale_price: "12.5",
    target_sale_price_currency: "USD", evaluate_rate: "96.1%", lastest_volume: 321, shop_name: "Shop",
    promotion_link: "https://s.click.example/x",
  };
  const name = p.method.replace(/\./g, "_") + "_response";
  return new Response(JSON.stringify({
    [name]: { resp_result: { resp_code: 200, resp_msg: "ok", result: { total_record_count: 1, current_page_no: 1, products: { product: [product] } } } },
  }));
};

const call = async (body, path = "/mcp/t0k") => {
  const res = await worker.fetch(new Request("https://x" + path, { method: "POST", body: JSON.stringify(body) }), env);
  return [res.status, res.status === 200 ? await res.json() : null];
};

const checks = [];
const ok = (name, cond) => { checks.push(cond); console.log((cond ? "PASS " : "FAIL ") + name); };

let [s, r] = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
ok("initialize", s === 200 && r.result.serverInfo.name === "shopscout-mcp");
[s] = await call({ jsonrpc: "2.0", method: "notifications/initialized" });
ok("notification -> 202", s === 202);
[s, r] = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
ok("tools/list", r.result.tools.length === 4);
[s, r] = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_products", arguments: { keywords: "wifi" } } });
ok("search_products", JSON.parse(r.result.content[0].text).products[0].price === "12.5 USD");
[s, r] = await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_product", arguments: { products: "https://www.aliexpress.com/item/1005001234567890.html" } } });
ok("get_product", JSON.parse(r.result.content[0].text).products[0].id === "1005001234567890");
[s] = await call({ jsonrpc: "2.0", id: 5, method: "tools/list" }, "/mcp/wrong");
ok("bad token -> 401", s === 401);

process.exit(checks.every(Boolean) ? 0 : 1);
