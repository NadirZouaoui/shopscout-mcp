import { callApi, compactProduct, withAffiliateLink, asArray } from "./aliexpress.js";
import { scrapeSearch, scrapeProduct, scrapeReviews } from "./scrape.js";

// "api" when keys are configured, otherwise "scrape". MODE env var overrides.
export function mode(env) {
  if (env.MODE === "api" || env.MODE === "scrape") return env.MODE;
  return env.AE_APP_KEY && env.AE_APP_SECRET ? "api" : "scrape";
}

function defaults(env) {
  return {
    target_currency: env.CURRENCY || "USD",
    target_language: env.LANGUAGE || "EN",
    country: env.SHIP_TO || "DZ",
  };
}

const SHORT_LINK = /^(https?:\/\/)?(a|s\.click|star)\.aliexpress\.com\//i;

// Strict id extraction: only from /item/<id> paths or productId-style params,
// never from arbitrary long numbers (tracking params contain those too).
export function extractId(input) {
  let s = String(input).trim();
  if (/^\d{10,20}$/.test(s)) return s;
  for (let i = 0; i < 3; i++) {
    const m =
      s.match(/\/item\/(?:[^/?#]*\/)?(\d{10,20})(?:\.html)?/) ||
      s.match(/[?&](?:productIds?|itemId|objectId|product_id)=(\d{10,20})/i);
    if (m) return m[1];
    try { const d = decodeURIComponent(s); if (d === s) break; s = d; } catch { break; } // ids may sit inside encoded redirect params
  }
  return null;
}

// Follow redirects by hand so every hop's Location can be inspected; the item id
// usually appears in an intermediate URL even when the final page is a login/landing page.
export async function resolveShortLink(url) {
  let current = /^https?:/i.test(url) ? url : "https://" + url;
  const hops = [];
  for (let i = 0; i < 8; i++) {
    const res = await fetch(current, {
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36" },
    });
    hops.push(`${res.status} ${current.slice(0, 120)}`);
    const loc = res.headers.get("location");
    if (loc) {
      current = new URL(loc, current).toString();
      const id = extractId(current);
      if (id) return { id, hops };
      continue;
    }
    // No redirect: the page may use a JS/meta redirect with the item URL inside.
    const body = await res.text();
    const id = extractId(body.match(/https?:[^"'\s<>]*aliexpress\.com\/item\/[^"'\s<>]+/)?.[0] || "")
      || extractId(body.match(/[?&](?:productIds?|itemId)=\d{10,20}/)?.[0] || "");
    return { id, hops };
  }
  return { id: null, hops };
}

async function toIds(input) {
  const parts = String(input).split(/[,\s]+/).filter(Boolean).slice(0, 20);
  const ids = [], failed = [];
  for (const p of parts) {
    let id = extractId(p);
    if (!id && SHORT_LINK.test(p)) {
      try {
        const r = await resolveShortLink(p);
        id = r.id;
        if (!id) failed.push(`${p} (redirects: ${r.hops.join(" -> ")})`);
      } catch (e) { failed.push(`${p} (${e.message})`); }
    } else if (!id) failed.push(p);
    if (id) ids.push(id);
  }
  if (!ids.length) throw new Error("No product id found. Unresolved: " + failed.join("; "));
  return { ids, failed };
}

async function apiSearch(args, env) {
      const d = defaults(env);
      const result = await callApi(env, "aliexpress.affiliate.product.query", {
        keywords: args.keywords,
        sort: args.sort,
        min_sale_price: args.min_price,
        max_sale_price: args.max_price,
        page_no: args.page || 1,
        page_size: Math.min(args.page_size || 10, 50),
        target_currency: d.target_currency,
        target_language: d.target_language,
        ship_to_country: d.country,
        tracking_id: env.AE_TRACKING_ID,
      });
      const products = asArray(result?.products?.product).map(compactProduct);
      // The API's volume sort uses its own sales counter, not the 30-day figure we show,
      // so re-sort the page by orders_30d to match what the user sees.
      if (args.sort === "LAST_VOLUME_DESC") products.sort((a, b) => (b.orders_30d || 0) - (a.orders_30d || 0));
      if (args.sort === "LAST_VOLUME_ASC") products.sort((a, b) => (a.orders_30d || 0) - (b.orders_30d || 0));
      return { source: "api", total: result?.total_record_count, page: result?.current_page_no, products };
}

export const TOOLS = [
  {
    name: "search_products",
    description:
      "Search products by keyword. Default source 'site' reads the real AliExpress search results (same items and prices " +
      "the site shows, including SuperDeals/Choice items, deal badges and shipping text when shown). Source 'api' uses the " +
      "affiliate catalog (only items in the affiliate program; returns 30-day orders). 'both' merges them. " +
      "Use get_product with ids for details.",
    inputSchema: {
      type: "object",
      properties: {
        keywords: { type: "string", description: "Search terms, e.g. 'wifi 6 usb 3.0 adapter'" },
        sort: {
          type: "string",
          enum: ["SALE_PRICE_ASC", "SALE_PRICE_DESC", "LAST_VOLUME_ASC", "LAST_VOLUME_DESC"],
          description: "Optional sort order",
        },
        min_price: { type: "number" },
        max_price: { type: "number" },
        page: { type: "integer", minimum: 1, default: 1 },
        page_size: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        source: { type: "string", enum: ["site", "api", "both"], default: "site" },
      },
      required: ["keywords"],
    },
    async run(args, env) {
      const source = mode(env) === "scrape" ? "site" : (args.source || "site");
      if (source === "site") {
        try { return await scrapeSearch(args, env); }
        catch (e) {
          if (mode(env) === "scrape") throw e;
          const api = await apiSearch(args, env);
          return { ...api, note: "Site search failed (" + e.message + "); showing affiliate catalog results instead." };
        }
      }
      if (source === "both") {
        const [site, api] = await Promise.allSettled([scrapeSearch(args, env), apiSearch(args, env)]);
        const items = new Map();
        for (const p of site.value?.products || []) items.set(p.id, { ...p, in: "site" });
        for (const p of api.value?.products || []) {
          items.set(p.id, items.has(p.id) ? { ...items.get(p.id), orders_30d: p.orders_30d, in: "both" } : { ...p, in: "api" });
        }
        return {
          source: "both",
          products: [...items.values()],
          errors: [site, api].filter((r) => r.status === "rejected").map((r) => String(r.reason?.message || r.reason)),
        };
      }
      return apiSearch(args, env);
    },
  },
  {
    name: "get_product",
    description:
      "Get details for products by id, full URL or short share link (comma-separated, up to 20; up to 5 in scrape mode). " +
      "In scrape mode includes the spec table and variant options, which often name the chipset.",
    inputSchema: {
      type: "object",
      properties: {
        products: { type: "string", description: "Product ids or URLs, comma-separated" },
      },
      required: ["products"],
    },
    async run(args, env) {
      const { ids, failed } = await toIds(args.products);
      const unresolved = failed.length ? failed : undefined;
      if (mode(env) === "scrape") {
        const results = await Promise.all(
          ids.slice(0, 5).map((id) => scrapeProduct(id, env).catch((e) => ({ id, error: String(e.message || e) })))
        );
        return { source: "scrape", products: results, unresolved };
      }
      const d = defaults(env);
      const result = await callApi(env, "aliexpress.affiliate.productdetail.get", {
        product_ids: ids.join(","),
        target_currency: d.target_currency,
        target_language: d.target_language,
        country: d.country,
        tracking_id: env.AE_TRACKING_ID,
      });
      const products = asArray(result?.products?.product).map((p) => withAffiliateLink(compactProduct(p), p));
      // Never fail silently: report ids the API didn't return (not in the affiliate program, or delisted).
      const missing = ids.filter((id) => !products.some((p) => p.id === id));
      // Items outside the affiliate program (common for SuperDeals/Choice listings): read the item page instead.
      const fromSite = await Promise.all(missing.slice(0, 5).map((id) =>
        scrapeProduct(id, env).then((p) => ({ ...p, source: "site" })).catch(() => null)));
      for (const p of fromSite) if (p) { products.push(p); missing.splice(missing.indexOf(p.id), 1); }
      return {
        source: "api",
        products,
        not_found: missing.length
          ? missing.map((id) => `${id}: not in the affiliate catalog and the item page couldn't be read`)
          : undefined,
        unresolved,
      };
    },
  },
  {
    name: "debug_api",
    description:
      "Diagnostics: call any affiliate API method with raw parameters and return the raw JSON (trimmed to 6000 chars). " +
      "app_key, signing, currency, language and tracking_id are filled in automatically. Use only to explore API fields.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", description: "e.g. aliexpress.affiliate.productdetail.get" },
        params: { type: "object", description: "Method parameters as key/value pairs" },
      },
      required: ["method"],
    },
    async run(args, env) {
      const d = defaults(env);
      const params = {
        target_currency: d.target_currency, target_language: d.target_language,
        tracking_id: env.AE_TRACKING_ID, ...(args.params || {}),
      };
      try {
        const result = await callApi(env, args.method, params);
        const raw = JSON.stringify(result);
        return raw.length > 6000 ? { truncated: true, raw: raw.slice(0, 6000) } : result;
      } catch (e) {
        return { error: e.message };
      }
    },
  },
  {
    name: "debug_fetch",
    description:
      "Diagnostics: fetch a URL from the server the way the scraper does and report status, redirects, page title, " +
      "which embedded-data markers exist, and short snippets. Use only when other tools fail.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        find: { type: "string", description: "Optional text to locate; returns 300 chars around the first match" },
      },
      required: ["url"],
    },
    async run(args, env) {
      const res = await fetch(args.url, {
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
          "Cookie": `aep_usuc_f=site=glo&c_tp=${env.CURRENCY || "USD"}&region=${env.SHIP_TO || "DZ"}&b_locale=en_US`,
        },
      });
      const t = await res.text();
      const markers = ["_init_data_", "runParams", "DCData", "__INITIAL_STATE__", "productId", "itemList",
        "attrName", "punish", "captcha", "x5sec", "baxia", "og:title", "item/"];
      const at = (s) => { const i = t.indexOf(s); return i < 0 ? undefined : t.slice(Math.max(0, i - 100), i + 200); };
      return {
        status: res.status, final_url: res.url, redirected: res.redirected, length: t.length,
        title: t.match(/<title>([^<]*)<\/title>/i)?.[1],
        markers: Object.fromEntries(markers.map((m) => [m, t.split(m).length - 1])),
        scripts: [...t.matchAll(/(window\.[\w.$]+|_d_c_\.\w+)\s*=/g)].map((m) => m[1]).slice(0, 25),
        find: args.find ? at(args.find) : undefined,
        head: t.slice(0, 600),
      };
    },
  },
  {
    name: "get_reviews",
    description:
      "Get buyer reviews for one product (text trimmed, in the site's relevance order). Useful to confirm chipsets, real speeds or defects. " +
      "Reads the public reviews feed, works without API keys.",
    inputSchema: {
      type: "object",
      properties: {
        product: { type: "string", description: "Product id or URL" },
        page: { type: "integer", minimum: 1, default: 1 },
        page_size: { type: "integer", minimum: 1, maximum: 20, default: 10 },
        with_photos: { type: "boolean", description: "Only reviews with photos" },
      },
      required: ["product"],
    },
    async run(args, env) {
      const { ids: [id] } = await toIds(args.product);
      return scrapeReviews({ ...args, id }, env);
    },
  },
];
