// Minimal client for the AliExpress Open Platform affiliate API (sync gateway).
// Signing: HMAC-SHA256 over the alphabetically sorted "keyvalue" pairs, uppercase hex.

const GATEWAY = "https://api-sg.aliexpress.com/sync";

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export async function signParams(params, appSecret) {
  const base = Object.keys(params).sort().map((k) => k + params[k]).join("");
  return hmacSha256Hex(appSecret, base);
}

export async function callApi(env, method, apiParams) {
  const params = {
    method,
    app_key: env.AE_APP_KEY,
    timestamp: String(Date.now()),
    sign_method: "sha256",
    format: "json",
    v: "2.0",
  };
  for (const [k, v] of Object.entries(apiParams)) {
    if (v !== undefined && v !== null && v !== "") params[k] = String(v);
  }
  params.sign = await signParams(params, env.AE_APP_SECRET);

  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`AliExpress API gateway returned HTTP ${res.status} (${text.slice(0, 60).trim()}); temporary, retry.`);
  }
  if (data.error_response) {
    const e = data.error_response;
    throw new Error(`AliExpress API error ${e.code}: ${e.msg || e.sub_msg || "unknown"}`);
  }
  // Responses look like { "<method_with_underscores>_response": { resp_result: { resp_code, resp_msg, result } } }
  const key = Object.keys(data).find((k) => k.endsWith("_response"));
  const rr = key ? data[key].resp_result : undefined;
  if (!rr) throw new Error("Unexpected API response: " + JSON.stringify(data).slice(0, 300));
  // 405 "The result is empty" just means no matches; return an empty result instead of an error.
  if (String(rr.resp_code) === "405") return { total_record_count: 0, products: { product: [] } };
  if (rr.resp_code !== 200 && rr.resp_code !== "200") {
    throw new Error(`AliExpress API ${rr.resp_code}: ${rr.resp_msg}`);
  }
  return rr.result;
}

// Keep only fields useful for comparison, so results stay small in chat.
export function compactProduct(p) {
  return {
    id: String(p.product_id),
    title: p.product_title,
    price: p.target_sale_price ? `${p.target_sale_price} ${p.target_sale_price_currency || ""}`.trim() : undefined,
    original_price: p.target_original_price
      ? `${p.target_original_price} ${p.target_original_price_currency || ""}`.trim() : undefined,
    discount: p.discount,
    rating: p.evaluate_rate,
    orders_30d: p.lastest_volume,
    category: [p.first_level_category_name, p.second_level_category_name].filter(Boolean).join(" > ") || undefined,
    shop: p.shop_name,
    link: `https://www.aliexpress.com/item/${p.product_id}.html`,
    sku_id: p.sku_id ? String(p.sku_id) : undefined,
    price_eur: p.target_sale_price && (p.target_sale_price_currency || "EUR") === "EUR" ? Number(p.target_sale_price) : undefined,
  };
}

// Affiliate links are ~800 chars each, so they're only included where asked for (get_product).
export function withAffiliateLink(compact, p) {
  return p.promotion_link ? { ...compact, affiliate_link: p.promotion_link } : compact;
}

export function asArray(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

// Advanced API: shipping fee for one product + SKU at a given price, to the configured country.
// Works for any item (not only the affiliate catalog); sku_id is mandatory.
// Response: { shipping_fee, min_delivery_days, max_delivery_days, delivery_days, ship_from_country }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function apiShipping(env, { product_id, sku_id, price }) {
  if (!sku_id) return { fee_eur: null, error: "no sku_id" };
  const params = {
    product_id, sku_id, target_sale_price: price, target_currency: env.CURRENCY || "EUR",
    target_language: env.LANGUAGE || "EN", ship_to_country: env.SHIP_TO || "DZ", tax_rate: 0,
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return parseShipping(await callApi(env, "aliexpress.affiliate.product.shipping.get", params));
    } catch (e) {
      // The app gets a short ban when calls come too close together: wait and retry.
      if (/ApiCallLimit/.test(e.message) && attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
      return { fee_eur: null, error: e.message };
    }
  }
}

export function parseShipping(r) {
  if (!r || r.shipping_fee === undefined || r.shipping_fee === "") return { fee_eur: null, error: "no shipping offered to this country" };
  const min = r.min_delivery_days, max = r.max_delivery_days ?? r.delivery_days;
  return {
    fee_eur: Number(r.shipping_fee),
    delivery_days: min && max ? (min === max ? `${min}` : `${min}-${max}`) : max || undefined,
    ships_from: r.ship_from_country || undefined,
  };
}

// Add shipping + totals to compact products that carry sku_id and a numeric price (sequential, spaced calls).
export async function addShipping(env, products, limit = 5) {
  const DZD = 280;
  let n = 0;
  for (const p of products) {
    if (n >= limit) break;
    if (!p.sku_id || p.price_eur == null || p.shipping) continue;
    if (n++) await sleep(1100);
    const sh = await apiShipping(env, { product_id: p.id, sku_id: p.sku_id, price: p.price_eur });
    p.shipping = sh.fee_eur == null ? { error: sh.error } : sh;
    if (sh.fee_eur != null) {
      p.total_eur = Math.round((p.price_eur + sh.fee_eur) * 100) / 100;
      p.total_dzd = Math.round(p.total_eur * DZD);
    }
  }
  return products;
}
