// Personalised price + shipping for a few shortlisted items, using the owner's logged-in session.
// Calls the same background request the DZ item page makes (mtop.aliexpress.pdp.pc.query).
// Cookies: KV copy (refreshed tokens) first, falling back to the AE_COOKIES secret.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const MTOP_APP_KEY = "12574478"; // public app key used by the AliExpress web pages
const HOST = "ar.aliexpress.com"; // regional site the DZ account is served from
const DZD_PER_EUR = 280;
const CACHE_TTL = 900; // seconds
export const KEEPALIVE_ITEM = "1005009412750740";

async function md5(text) {
  const buf = await crypto.subtle.digest("MD5", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const cookieValue = (cookies, name) => cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))?.[1];

// Merge Set-Cookie values into a Cookie header string (replace same-name cookies, append new ones).
export function mergeCookies(cookies, setCookies) {
  const jar = new Map(cookies.split(/;\s*/).filter(Boolean).map((c) => {
    const i = c.indexOf("=");
    return [c.slice(0, i), c.slice(i + 1)];
  }));
  let changed = false;
  for (const sc of setCookies) {
    const pair = sc.split(";")[0];
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim();
    if (!value || /max-age=0|expires=thu, 01 jan 1970/i.test(sc)) continue;
    if (jar.get(name) !== value) { jar.set(name, value); changed = true; }
  }
  return { cookies: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), changed };
}

function setCookieList(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const raw = headers.get("set-cookie");
  return raw ? raw.split(/,(?=\s*[\w-]+=)/) : [];
}

async function loadCookies(env) {
  const kv = env.SHOPSCOUT_KV ? await env.SHOPSCOUT_KV.get("cookies") : null;
  return (kv || env.AE_COOKIES || "").trim();
}

async function saveCookies(env, cookies) {
  if (env.SHOPSCOUT_KV) await env.SHOPSCOUT_KV.put("cookies", cookies);
}

export class SessionError extends Error {}

async function mtopCall(id, env, cookies) {
  const tk = cookieValue(cookies, "_m_h5_tk");
  const token = tk ? tk.split("_")[0] : "";
  const country = env.SHIP_TO || "DZ";
  const t = String(Date.now());
  const randomToken = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const data = JSON.stringify({
    _currency: env.CURRENCY || "EUR", _lang: `en_${country}`, channel: "", city: "null", clientType: "pc",
    country,
    ext: JSON.stringify({ foreverRandomToken: randomToken, site: "ara", crawler: false, "x-m-biz-bx-region": "", signedIn: true, host: HOST }),
    pdpNPI: "", pdp_ext_f: "", productId: id, province: "null", sourceType: "",
  });
  const url = new URL("https://acs.aliexpress.com/h5/mtop.aliexpress.pdp.pc.query/1.0/");
  url.search = new URLSearchParams({
    jsv: "2.5.1", appKey: MTOP_APP_KEY, t, sign: await md5(`${token}&${t}&${MTOP_APP_KEY}&${data}`),
    api: "mtop.aliexpress.pdp.pc.query", type: "originaljsonp", v: "1.0", timeout: "15000",
    dataType: "originaljsonp", callback: "mtopjsonp1", data,
  }).toString();
  const r = await fetch(url, {
    headers: {
      "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Accept: "*/*", Cookie: cookies,
      Referer: `https://${HOST}/`, "Sec-Fetch-Dest": "script", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Site": "same-site",
    },
  });
  const body = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(body.replace(/^[^(]*\(/, "").replace(/\)\s*;?\s*$/, "")); } catch {}
  return { status: r.status, parsed, ret: (parsed?.ret || []).join(" | ") || body.slice(0, 120), setCookies: setCookieList(r.headers) };
}

// Fetch the raw pdp result, refreshing the mtop token once if it has expired.
export async function fetchPdp(id, env) {
  let cookies = await loadCookies(env);
  if (!cookies) throw new SessionError("No session cookies set (AE_COOKIES).");
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await mtopCall(id, env, cookies);
    const merged = mergeCookies(cookies, res.setCookies);
    if (merged.changed) { cookies = merged.cookies; await saveCookies(env, cookies); }
    if (/FAIL_SYS_TOKEN/i.test(res.ret) && attempt === 0) continue; // token refreshed via Set-Cookie: retry
    if (/SESSION_EXPIRED|FAIL_SYS_SESSION|NOT_LOGIN|LOGIN/i.test(res.ret)) throw new SessionError(`Session expired (${res.ret}).`);
    if (!/^SUCCESS/.test(res.ret)) throw new Error(`Price request failed: ${res.ret}`);
    const result = res.parsed?.data?.result;
    if (!result?.PRICE) throw new SessionError("Price data missing from response (session may have expired).");
    return result;
  }
  throw new SessionError("Token refresh failed.");
}

// First object (depth-first) that has the given key.
function findWithKey(v, key, depth = 6) {
  if (!v || typeof v !== "object" || depth < 0) return null;
  if (!Array.isArray(v) && key in v) return v;
  for (const x of Object.values(v)) {
    const hit = findWithKey(x, key, depth - 1);
    if (hit) return hit;
  }
  return null;
}

const eur = (s) => {
  const m = String(s ?? "").replace(/\s/g, "").match(/(\d+(?:[.,]\d{3})*(?:[.,]\d{1,2})?)/);
  if (!m) return null;
  let n = m[1];
  n = /[.,]\d{1,2}$/.test(n) ? n.slice(0, -3).replace(/[.,]/g, "") + "." + n.slice(-2).replace(/[.,]/, "") : n.replace(/[.,]/g, "");
  return Number(n);
};
const round2 = (n) => Math.round(n * 100) / 100;

// Human-readable offer texts (bundle / multi-piece discounts, coupons, store promos) from the deal blocks.
const DEAL_BLOCKS = ["PRICE_EXTEND", "PRICE_BANNER", "INTEREST_POINTS", "COUPON_BLOCK_PC"];
function dealTexts(result) {
  const out = new Set();
  const walk = (v, depth) => {
    if (depth < 0 || v == null) return;
    if (typeof v === "string") {
      const s = v.replace(/<[^>]+>/g, "").trim();
      // keep short sentences that mention money, percent, pieces or bundles; skip urls, colors, codes, json
      if (s.length >= 6 && s.length <= 120 && !/^(https?:|\/\/|#|\{|\[)/.test(s) && /[€%]|\d+\+|piece|bundle|off|coupon|deal|save/i.test(s))
        out.add(s);
      return;
    }
    if (typeof v === "object") for (const x of Object.values(v)) walk(x, depth - 1);
  };
  for (const b of DEAL_BLOCKS) walk(result[b], 6);
  return out.size ? [...out].slice(0, 8) : undefined;
}

export function parsePdp(result, id) {
  const price = result.PRICE || {};
  const target = price.targetSkuPriceInfo || {};
  const priceEur = eur(target.salePriceString);
  const originalEur = target.originalPrice?.value ?? eur(target.originalPrice?.formatedAmount);

  // Shipping for the selected variant
  const ship = findWithKey(result.SHIPPING, "displayAmount") || findWithKey(result.SHIPPING, "formattedAmount") || {};
  const free = /free/i.test(String(ship.shippingFee || "")) || ship.displayAmount === 0;
  const shippingEur = free ? 0 : (typeof ship.displayAmount === "number" ? ship.displayAmount : eur(ship.formattedAmount));
  const shipping = ship.displayAmount !== undefined || ship.formattedAmount
    ? {
        fee_eur: shippingEur,
        carrier: ship.deliveryProviderName || ship.company,
        ships_from: ship.shipFromCode,
        delivery_days: ship.deliveryDayMin && ship.deliveryDayMax ? `${ship.deliveryDayMin}-${ship.deliveryDayMax}` : undefined,
        latest_delivery: ship.displayEtaMaxDate || ship.deliveryDate,
      }
    : null;

  // Variants: names from SKU properties, prices from skuPriceInfoMap
  const names = new Map();
  for (const prop of result.SKU?.skuProperties || [])
    for (const v of prop.skuPropertyValues || [])
      names.set(String(v.propertyValueId ?? v.propertyValueIdLong), v.propertyValueDisplayName || v.propertyValueName);
  const variants = (result.SKU?.skuPaths || []).map((p) => {
    const skuId = String(p.skuIdStr ?? p.skuId);
    const info = price.skuPriceInfoMap?.[skuId] || price.skuIdStrPriceInfoMap?.[skuId] || {};
    const label = String(p.path || "").split(/[;,]/).map((pair) => names.get(pair.split(":")[1])).filter(Boolean).join(" / ");
    return { sku_id: skuId, name: label || undefined, price_eur: eur(info.salePriceString), stock: p.skuStock ?? undefined };
  }).filter((v) => v.price_eur != null);

  const selectedSku = String(result.SKU?.selectedSkuIdStr || price.selectedSkuId || "");
  const total = priceEur != null && shippingEur != null ? round2(priceEur + shippingEur) : null;
  return {
    id,
    url: `https://www.aliexpress.com/item/${id}.html`,
    title: result.PRODUCT_TITLE?.text,
    variant: variants.find((v) => v.sku_id === selectedSku)?.name,
    price_eur: priceEur,
    original_eur: originalEur ?? undefined,
    shipping,
    total_eur: total,
    total_dzd: total != null ? Math.round(total * DZD_PER_EUR) : null,
    deals: dealTexts(result),
    stock: result.QUANTITY_PC?.totalAvailableInventory,
    variants: variants.length > 1 ? variants : undefined,
  };
}

// One item: cached in KV for CACHE_TTL seconds unless fresh is requested.
export async function checkPrice(id, env, { fresh = false } = {}) {
  const key = `pdp:${id}`;
  if (!fresh && env.SHOPSCOUT_KV) {
    const hit = await env.SHOPSCOUT_KV.get(key, "json");
    if (hit) return { ...hit, cached: true };
  }
  const out = { ...parsePdp(await fetchPdp(id, env), id), checked_at: new Date().toISOString() };
  if (env.SHOPSCOUT_KV) await env.SHOPSCOUT_KV.put(key, JSON.stringify(out), { expirationTtl: CACHE_TTL });
  return out;
}

// Daily cron: one real request keeps the session warm and records whether it still works.
export async function keepAlive(env) {
  let status;
  try {
    const r = parsePdp(await fetchPdp(KEEPALIVE_ITEM, env), KEEPALIVE_ITEM);
    status = { ok: r.price_eur != null, at: new Date().toISOString() };
  } catch (e) {
    status = { ok: false, expired: e instanceof SessionError, error: e.message, at: new Date().toISOString() };
  }
  if (env.SHOPSCOUT_KV) await env.SHOPSCOUT_KV.put("session_status", JSON.stringify(status));
  return status;
}
