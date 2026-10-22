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
  const data = await res.json();
  if (data.error_response) {
    const e = data.error_response;
    throw new Error(`AliExpress API error ${e.code}: ${e.msg || e.sub_msg || "unknown"}`);
  }
  // Responses look like { "<method_with_underscores>_response": { resp_result: { resp_code, resp_msg, result } } }
  const key = Object.keys(data).find((k) => k.endsWith("_response"));
  const rr = key ? data[key].resp_result : undefined;
  if (!rr) throw new Error("Unexpected API response: " + JSON.stringify(data).slice(0, 300));
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
