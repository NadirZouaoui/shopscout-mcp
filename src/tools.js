import { callApi, compactProduct, asArray } from "./aliexpress.js";

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

export const TOOLS = [
  {
    name: "search_products",
    description:
      "Search products by keyword. Returns a compact list (id, title, price, rating, 30-day orders, shop, link). " +
      "Use get_product with an id for full details.",
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
      return { total: result?.total_record_count, page: result?.current_page_no, products };
    },
  },
  {
    name: "get_product",
    description:
      "Get details for one or more products by id or product URL (up to 20, comma-separated). " +
      "Includes price, rating, orders, category, shop and an affiliate link.",
    inputSchema: {
      type: "object",
      properties: {
        products: {
          type: "string",
          description: "Product ids or URLs, comma-separated",
        },
      },
      required: ["products"],
    },
    async run(args, env) {
      const parts = String(args.products).split(/[,\s]+/).filter(Boolean).slice(0, 20);
      const ids = [];
      for (const p of parts) {
        let id = extractId(p);
        if (!id && /^https?:\/\/(a|s\.click)\.aliexpress\.com\//.test(p)) {
          try { id = extractId(await resolveShortLink(p)); } catch { /* ignore */ }
        }
        if (id) ids.push(id);
      }
      if (!ids.length) throw new Error("No product id found in the input.");
      const d = defaults(env);
      const result = await callApi(env, "aliexpress.affiliate.productdetail.get", {
        product_ids: ids.join(","),
        target_currency: d.target_currency,
        target_language: d.target_language,
        country: d.country,
        tracking_id: env.AE_TRACKING_ID,
      });
      return { products: asArray(result?.products?.product).map(compactProduct) };
    },
  },
];

export async function resolveShortLink(url) {
  // a.aliexpress.com short links redirect to the item page; follow without downloading the body.
  const res = await fetch(url, { method: "HEAD", redirect: "follow" });
  return res.url;
}
