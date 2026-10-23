// Bundle deals channel: list items with their bundle prices, filtered by keywords, loading more pages until
// enough matches are found or a page limit is reached. Uses the owner's logged-in session (the page 404s without it).

import { mtopRequest, loadCookies, saveCookies, mergeCookies, setCookieList, cookieValue, SessionError } from "./pdp.js";

const PAGE_URL =
  "https://www.aliexpress.com/ssr/300000512/BundleDeals2?disableNav=YES&pha_manifest=ssr&_immersiveMode=true&businessCode=guide";
const WATERFALL_APP_KEY = "24815441"; // key the Bundle deals page uses for its "load more" requests
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const DZD_PER_EUR = 280;
const MAX_PAGES_CAP = 15;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pull the JSON object assigned to `marker` out of a page, by brace matching (strings and escapes respected).
export function extractAssigned(html, marker) {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf("{", at);
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

const priceOf = (info) => {
  const m = String(info || "").match(/(\d+(?:[.,]\d{3})*[.,]\d{2}|\d+)/);
  return m ? Number(m[1].replace(/[.,](?=\d{3}\b)/g, "").replace(",", ".")) : null;
};

export function compactBundleItem(p) {
  const price = priceOf(p.localizedAssignToolMinPriceInfo);
  if (!p.id || price == null) return null;
  return {
    id: String(p.id),
    url: `https://www.aliexpress.com/item/${p.id}.html`,
    title: p.title,
    bundle_price_eur: price,
    bundle_price_dzd: Math.round(price * DZD_PER_EUR),
    list_price_eur: priceOf(p.localizedOriMinPriceInfo) ?? undefined,
    discount_pct: p.discount ?? undefined,
    rating: p.reviewStar ? Number(p.reviewStar) : undefined,
    reviews: p.reviewCount ?? undefined,
    orders: p.orders ?? undefined,
    stock: p.stock ?? undefined,
  };
}

// Items + pagination context from the server-rendered page.
export function parseBundlePage(html) {
  const init = extractAssigned(html, "window.__INIT_DATA__=");
  if (!init?.data) return null;
  const comps = Object.values(init.data);
  const byName = (n) => comps.find((c) => c.compName === n)?.fields;
  const items = [];
  for (const p of byName("gmod-aem-nn-goods-slider")?.data || []) items.push(p);
  const wf = byName("gmod-aem-nn-waterfall")?.data?.[0] || {};
  for (const p of wf.products || []) if (p.itemCardType !== "SCENE" || p.localizedAssignToolMinPriceInfo) items.push(p);
  const locale = byName("gmod-aem-nn-item-threshold-discount")?.locale?.locale || {};
  const tiers = [1, 2, 3, 4]
    .map((n) => locale[`step${n}ContentText`] && `${locale[`step${n}ContentText`].replace(/[{}]/g, "")} ${locale[`step${n}text`] || ""}`.trim())
    .filter(Boolean);
  let streamId;
  try { streamId = JSON.parse(wf.extraInfo || "{}").streamId; } catch {}
  return {
    components: comps.map((c) => `${c.compName}:${Array.isArray(c.fields?.data) ? c.fields.data.length : "-"}`),
    items,
    tiers,
    waterfall: wf.reqExt && wf.itemResourceId
      ? {
          resourceId: Number(wf.itemResourceId),
          reqExt: wf.reqExt,
          streamId,
          finished: /"finished":\s*true/.test(wf.extraInfo || ""),
        }
      : null,
    pvuuid: init.global?.bizContext?.pvuuid,
    memberSeq: html.match(/memberSeq\\*"\s*:\s*\\*"(\d+)/)?.[1],
  };
}

async function fetchBundlePage(env) {
  let cookies = await loadCookies(env);
  if (!cookies) throw new SessionError("No session cookies set (AE_COOKIES).");
  const r = await fetch(PAGE_URL, {
    headers: {
      "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Cookie: cookies,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none", "Upgrade-Insecure-Requests": "1",
    },
  });
  const merged = mergeCookies(cookies, setCookieList(r.headers));
  if (merged.changed) await saveCookies(env, merged.cookies);
  const html = await r.text();
  const page = parseBundlePage(html);
  const init = page ? null : extractAssigned(html, "window.__INIT_DATA__=");
  const diag = {
    status: r.status, final_url: r.url, length: html.length,
    title: html.match(/<title>([^<]*)/)?.[1]?.slice(0, 80),
    has_init_data: html.includes("__INIT_DATA__"),
    components: page ? undefined : init?.data ? Object.values(init.data).map((c) => c.compName) : undefined,
  };
  if (page) page.diag = { ...diag, components: page.components };
  if (!page) {
    const why = /\/error\/404|404 page/i.test(r.url + html.slice(0, 3000)) ? "page returned 404 (session not accepted?)"
      : /punish|baxia|captcha/i.test(html.slice(0, 20000)) ? "blocked by bot check" : `no item data (status ${r.status})`;
    throw new Error(`Bundle deals page unreadable: ${why}. ${JSON.stringify(diag)}`);
  }
  return { page, cookies: merged.cookies };
}

async function fetchWaterfallPage(env, ctx, cookies, pageNo) {
  const wf = ctx.waterfall;
  const reqExt = JSON.stringify({ ...JSON.parse(wf.reqExt), isFellowPrefetch: false, pageType: 3 });
  const params = {
    aeLocale: "en_US", aeRegion: env.SHIP_TO || "DZ", aeCurrency: env.CURRENCY || "EUR",
    cna: cookieValue(cookies, "cna") || "", acs_rt: "", buyerAliId: ctx.memberSeq || "",
    backupParams: "aeLocale,aeCurrency,aeRegion,device,aeDevice", device: "pc", aeDevice: "pc", platform: "pc",
    resources: JSON.stringify([{ id: wf.resourceId, reqExt }]),
    page: pageNo, streamId: wf.streamId, url: PAGE_URL, realPageId: "1000015626", childSceneId: "300000512",
    childSceneType: "3", businessCode: "guide", pageSize: 12, pvuuid: ctx.pvuuid, _pvuuid: ctx.pvuuid,
  };
  const data = await mtopRequest(env, "mtop.aliexpress.fc.gateway.campaign.data",
    { fcGroup: "campaign-data", fcName: "index", params: JSON.stringify(params) },
    PAGE_URL, { method: "POST", appKey: WATERFALL_APP_KEY });
  const rv = data?.resultValue?.[String(wf.resourceId)] || {};
  return { products: rv.data || [], finished: rv.finished === true || rv.finished === "true" };
}

// Keyword match: every term must appear in the title (case-insensitive); "|" separates alternatives within a term.
function matcher(keywords) {
  const terms = String(keywords || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return () => true;
  return (title) => {
    const t = String(title || "").toLowerCase();
    return terms.every((term) => term.split("|").some((alt) => t.includes(alt)));
  };
}

export async function bundleDeals(env, { keywords = "", max_price, want = 10, max_pages = 6 } = {}) {
  const { page, cookies } = await fetchBundlePage(env);
  const match = matcher(keywords);
  const pagesLimit = Math.min(Math.max(1, Number(max_pages) || 6), MAX_PAGES_CAP);
  const wantN = Math.min(Math.max(1, Number(want) || 10), 30);
  const seen = new Set();
  const found = [];
  let scanned = 0;
  const take = (list) => {
    for (const p of list) {
      const it = compactBundleItem(p);
      if (!it || seen.has(it.id)) continue;
      seen.add(it.id);
      scanned++;
      if (match(it.title) && (max_price == null || it.bundle_price_eur <= max_price)) found.push(it);
    }
  };
  take(page.items);
  let pagesLoaded = 1, finished = page.waterfall?.finished ?? true, stopReason = "";
  let pageError;
  for (let n = 2; found.length < wantN && !finished && page.waterfall && pagesLoaded < pagesLimit; n++) {
    await sleep(350); // don't fire requests at the same instant
    try {
      const r = await fetchWaterfallPage(env, page, cookies, n);
      if (!r.products.length) { finished = true; break; }
      take(r.products);
      finished = r.finished;
      pagesLoaded++;
    } catch (e) {
      if (e instanceof SessionError) throw e;
      pageError = String(e.message || e);
      break;
    }
  }
  if (found.length >= wantN) stopReason = `found ${wantN} matches`;
  else if (finished) stopReason = "reached the end of the list";
  else if (pageError) stopReason = `stopped loading more: ${pageError}`;
  else stopReason = `page limit reached (${pagesLimit}); raise max_pages (up to ${MAX_PAGES_CAP}) to look further`;
  return {
    keywords: keywords || undefined,
    matches: found.slice(0, wantN),
    scanned_items: scanned,
    pages_loaded: pagesLoaded,
    stop_reason: stopReason,
    basket_rules: ["Free shipping on 3+ items", ...page.tiers],
    diagnostics: scanned === 0 ? page.diag : undefined,
    note: "Bundle prices apply when bought through Bundle deals. Use check_price with bundle=true on chosen ids for shipping and a basket total.",
  };
}
