import { callApi, compactProduct, asArray } from "./aliexpress.js";
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

function extractId(input) {
  const s = String(input).trim();
  const m = s.match(/item\/(\d+)/) || s.match(/(\d{10,})/);
  return m ? m[1] : null;
}

async function resolveShortLink(url) {
  // Short share links redirect to the item page.
  const res = await fetch(url, { method: "GET", redirect: "follow", headers: { "User-Agent": "Mozilla/5.0" } });
  const id = extractId(res.url);
  if (id) return id;
  // Some short links land on an interstitial that contains the item URL in the body.
  const body = await res.text();
  return extractId(body.match(/aliexpress\.com\/item\/\d+/)?.[0] || "");
}

async function toIds(input) {
  const parts = String(input).split(/[,\s]+/).filter(Boolean).slice(0, 20);
  const ids = [];
  for (const p of parts) {
    let id = extractId(p);
    if (!id && /^https?:\/\/(a|s\.click)\.aliexpress\.com\//.test(p)) {
      try { id = await resolveShortLink(p); } catch { /* ignore */ }
    }
    if (id) ids.push(id);
  }
  if (!ids.length) throw new Error("No product id found in the input.");
  return ids;
}

export const TOOLS = [
  {
    name: "search_products",
    description:
      "Search products by keyword. Returns a compact list (id, title, price, rating, orders, shop, link). " +
      "Use get_product with ids for specs and details.",
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
      },
      required: ["keywords"],
    },
    async run(args, env) {
      if (mode(env) === "scrape") return scrapeSearch(args, env);
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
      return { source: "api", total: result?.total_record_count, page: result?.current_page_no, products };
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
      const ids = await toIds(args.products);
      if (mode(env) === "scrape") {
        const results = await Promise.all(
          ids.slice(0, 5).map((id) => scrapeProduct(id, env).catch((e) => ({ id, error: String(e.message || e) })))
        );
        return { source: "scrape", products: results };
      }
      const d = defaults(env);
      const result = await callApi(env, "aliexpress.affiliate.productdetail.get", {
        product_ids: ids.join(","),
        target_currency: d.target_currency,
        target_language: d.target_language,
        country: d.country,
        tracking_id: env.AE_TRACKING_ID,
      });
      return { source: "api", products: asArray(result?.products?.product).map(compactProduct) };
    },
  },
  {
    name: "get_reviews",
    description:
      "Get buyer reviews for one product (text trimmed, newest-relevant first). Useful to confirm chipsets, real speeds or defects. " +
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
      const [id] = await toIds(args.product);
      return scrapeReviews({ ...args, id }, env);
    },
  },
];
