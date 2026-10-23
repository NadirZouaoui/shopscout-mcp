// Scrape mode: reads public AliExpress pages directly from the Worker.
// Used when no API keys are set (or forced with MODE=scrape).
// Pages embed their data as JSON in <script> tags; we pull that out instead of parsing HTML.
// Expect occasional blocks: AliExpress challenges many cloud IPs. Errors say when that happens.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function headers(env) {
  const country = env.SHIP_TO || "DZ";
  const currency = env.CURRENCY || "USD";
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    // Locale cookie: ship-to country, language, currency
    "Cookie": `aep_usuc_f=site=glo&c_tp=${currency}&region=${country}&b_locale=en_US`,
  };
}

async function getText(url, env) {
  const res = await fetch(url, { headers: headers(env), redirect: "follow" });
  const text = await res.text();
  if (looksBlocked(res, text)) {
    throw new Error(`Blocked by AliExpress anti-bot (HTTP ${res.status}) for ${url}. Retry later, or use API mode.`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return { text, finalUrl: res.url };
}

function looksBlocked(res, text) {
  return (
    res.status === 403 || res.status === 429 ||
    /punish|_____tmd_____|x5secdata|baxia|captcha/i.test(text.slice(0, 20000)) && !/"productId"/.test(text)
  );
}

// Extract the JSON object/array that starts at the first "{" or "[" after `marker`.
// Pages often wrap the JSON in a JS literal like `{ data: {...} }`, which isn't valid JSON,
// so if the first brace fails to parse we try the next few opening braces.
export function jsonAfter(text, marker) {
  let i = text.indexOf(marker);
  if (i < 0) return null;
  i += marker.length;
  for (let attempt = 0; attempt < 4; attempt++) {
    while (i < text.length && text[i] !== "{" && text[i] !== "[") i++;
    if (i >= text.length) return null;
    const parsed = parseBalanced(text, i);
    if (parsed !== null) return parsed;
    i++;
  }
  return null;
}

function parseBalanced(text, i) {
  const open = text[i], close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) {
      try { return JSON.parse(text.slice(i, j + 1)); } catch { return null; }
    }
  }
  return null;
}

// Depth-first walk yielding every object in a JSON tree.
function* walk(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 40) return;
  yield node;
  for (const v of Array.isArray(node) ? node : Object.values(node)) yield* walk(v, depth + 1);
}

const first = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== "");
const meta = (html, prop) =>
  html.match(new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]+content="([^"]*)"`, "i"))?.[1];

// Find every assignment like `window._dida_config_._init_data_= { data: {...} }` and parse it.
// Matching the assignment (not just the name) matters: the name also appears earlier in unrelated scripts.
function embeddedData(html) {
  const out = [];
  const re = /(?:_init_data_|window\.runParams|_d_c_\.DCData|window\.__INITIAL_STATE__)\s*=\s*/g;
  let m;
  while ((m = re.exec(html)) && out.length < 6) {
    const parsed = jsonAfter(html.slice(m.index), m[0]);
    if (parsed) out.push(parsed);
  }
  return out;
}

// ---------- search ----------

function priceOf(o) {
  const p = o.prices || o.price || {};
  return first(
    p.salePrice?.formattedPrice, p.salePrice?.minPrice && `${p.salePrice.minPrice} ${p.salePrice.currencyCode || ""}`.trim(),
    o.salePrice?.formattedPrice, o.formattedPrice, typeof o.price === "string" ? o.price : undefined
  );
}

function compactSearchItem(o) {
  const id = String(o.productId || o.itemId);
  return {
    id,
    title: first(o.title?.displayTitle, o.title?.seoTitle, typeof o.title === "string" ? o.title : undefined, o.productTitle),
    price: priceOf(o),
    rating: first(o.evaluation?.starRating, o.starRating),
    sold: first(o.trade?.tradeDesc, o.trade?.realTradeCount, o.tradeDesc),
    shop: first(o.store?.storeName, o.storeName),
    ...tagsOf(o),
    link: `https://www.aliexpress.com/item/${id}.html`,
  };
}

// Selling-point badges shown on search cards: deal programs (SuperDeals, Choice, Bundle deals),
// coupons and shipping ("Free shipping", "+€1.99 shipping"). Shipping text is pulled out separately.
function tagsOf(o) {
  const texts = [];
  for (const sp of o.sellingPoints || []) {
    const t = sp?.tagContent?.tagText || sp?.tagContent?.displayTagText;
    if (t && !texts.includes(t)) texts.push(String(t).trim());
  }
  const shipping = texts.find((t) => /shipping|delivery|livraison/i.test(t));
  const tags = texts.filter((t) => t !== shipping);
  const original = o.prices?.originalPrice?.formattedPrice;
  return {
    original_price: original,
    shipping,
    tags: tags.length ? tags.slice(0, 6) : undefined,
  };
}

export async function scrapeSearch(args, env) {
  const kw = String(args.keywords).trim().replace(/\s+/g, "-");
  const url = new URL(`https://www.aliexpress.com/w/wholesale-${encodeURIComponent(kw)}.html`);
  url.searchParams.set("page", String(args.page || 1));
  if (args.min_price) url.searchParams.set("minPrice", String(args.min_price));
  if (args.max_price) url.searchParams.set("maxPrice", String(args.max_price));
  const sortMap = { SALE_PRICE_ASC: "price_asc", SALE_PRICE_DESC: "price_desc", LAST_VOLUME_DESC: "total_tranpro_desc" };
  if (sortMap[args.sort]) url.searchParams.set("SortType", sortMap[args.sort]);

  const { text } = await getText(url.toString(), env);
  const seen = new Map();
  for (const data of embeddedData(text)) {
    for (const o of walk(data)) {
      const id = o.productId || o.itemId;
      if (id && /^\d{8,}$/.test(String(id)) && (o.title || o.prices || o.productTitle) && !seen.has(String(id))) {
        seen.set(String(id), compactSearchItem(o));
      }
    }
  }
  const products = [...seen.values()].slice(0, Math.min(args.page_size || 10, 60));
  if (!products.length) throw new Error("Search page loaded but no products were found in it (page layout may have changed).");
  return { source: "scrape", page: args.page || 1, products };
}

// ---------- product details ----------

export async function scrapeProduct(id, env) {
  const { text } = await getText(`https://www.aliexpress.com/item/${id}.html`, env);
  const blobs = embeddedData(text);

  const specs = {};
  let price, rating, reviews, sold, shop, stockSkus = [];
  for (const data of blobs) {
    for (const o of walk(data)) {
      if (o.attrName && o.attrValue !== undefined && Object.keys(specs).length < 40) specs[o.attrName] = o.attrValue;
      price = first(price, o.formatedActivityPrice, o.formatedPrice, o.salePriceString, o.targetSkuPriceInfo?.salePriceString);
      rating = first(rating, o.averageStar, o.evarageStar);
      reviews = first(reviews, o.totalValidNum, o.totalCount);
      sold = first(sold, o.formatTradeCount, o.tradeCount);
      shop = first(shop, o.storeName);
      if (o.skuPropertyName && Array.isArray(o.skuPropertyValues) && stockSkus.length < 6) {
        stockSkus.push({
          option: o.skuPropertyName,
          values: o.skuPropertyValues.map((v) => v.propertyValueDisplayName || v.propertyValueName).filter(Boolean).slice(0, 15),
        });
      }
    }
  }

  const title = first(meta(text, "og:title"), text.match(/<title>([^<]*)<\/title>/i)?.[1]);
  if (!title && !Object.keys(specs).length) throw new Error(`Item ${id}: page loaded but no product data found.`);
  return {
    id,
    title: title?.replace(/\s*-\s*AliExpress.*$/i, "").trim(),
    price, rating, reviews, sold, shop,
    variants: stockSkus.length ? stockSkus : undefined,
    specs: Object.keys(specs).length ? specs : undefined,
    link: `https://www.aliexpress.com/item/${id}.html`,
  };
}

// ---------- reviews ----------

export async function scrapeReviews(args, env) {
  const url = new URL("https://feedback.aliexpress.com/pc/searchEvaluation.do");
  url.search = new URLSearchParams({
    productId: args.id, lang: "en_US", country: env.SHIP_TO || "DZ",
    page: String(args.page || 1), pageSize: String(Math.min(args.page_size || 10, 20)),
    filter: args.with_photos ? "image" : "all", sort: "complex_default",
  }).toString();
  const res = await fetch(url, { headers: { ...headers(env), Accept: "application/json", Referer: "https://www.aliexpress.com/" } });
  const body = await res.text();
  let data;
  try { data = JSON.parse(body); } catch {
    throw new Error(`Reviews request returned non-JSON (HTTP ${res.status}); likely blocked.`);
  }
  const list = (data?.data?.evaViewList || []).slice(0, Math.min(args.page_size || 10, 20)); // feed ignores pageSize
  return {
    total: data?.data?.totalNum,
    reviews: list.map((r) => ({
      stars: r.buyerEval ? Math.round(r.buyerEval / 20) : undefined,
      date: r.evalDate,
      country: r.buyerCountry,
      variant: r.skuInfo?.trim(),
      text: (r.buyerTranslationFeedback || r.buyerFeedback || "").slice(0, 600),
      photos: r.images?.length || 0,
    })),
  };
}
