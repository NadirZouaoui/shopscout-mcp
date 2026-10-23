// Experimental: personalised data using the owner's AliExpress session cookies (secret AE_COOKIES).
// Used only for a few shortlisted items. Never stores a password.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const MTOP_APP_KEY = "12574478"; // public app key used by the AliExpress web pages

function cookieValue(cookies, name) {
  return cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))?.[1];
}

async function md5(text) {
  const buf = await crypto.subtle.digest("MD5", new TextEncoder().encode(text)); // supported in Workers
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Return ~300 chars around each key found, so we can see what the response contains.
function snippets(text, keys) {
  const out = {};
  for (const k of keys) {
    const i = text.indexOf(k);
    if (i >= 0) out[k] = text.slice(Math.max(0, i - 40), i + 260);
  }
  return out;
}

// Outline of an object: keys with value types, down to `depth` levels.
function describe(v, depth) {
  if (v === null || typeof v !== "object") return typeof v === "string" ? `str(${v.length})` : typeof v;
  if (Array.isArray(v)) return depth ? [`len ${v.length}`, v.length ? describe(v[0], depth - 1) : null] : `array(${v.length})`;
  if (!depth) return `{${Object.keys(v).length} keys}`;
  return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, describe(x, depth - 1)]));
}

// Where do the expected numbers (e.g. "81.83", "5.95") appear? Also tries comma decimals.
function findValues(text, values) {
  const out = {};
  for (const v of values) {
    for (const form of new Set([v, v.replace(".", ",")])) {
      const hits = [];
      let i = text.indexOf(form);
      while (i >= 0 && hits.length < 3) {
        hits.push(text.slice(Math.max(0, i - 200), i + 60));
        i = text.indexOf(form, i + 1);
      }
      if (hits.length) out[form] = hits;
    }
  }
  return out;
}

// Up to 2 snippets per keyword (case-insensitive, matched inside quoted JSON keys).
function keywordSnippets(text, words) {
  const out = {};
  for (const w of words) {
    const re = new RegExp(`"[A-Za-z_]*${w}[A-Za-z_]*"\\s*:`, "gi");
    const found = [];
    let m;
    while ((m = re.exec(text)) && found.length < 2) found.push(text.slice(m.index, m.index + 160));
    if (found.length) out[w] = found;
  }
  return out;
}

const PRICE_KEYS = ['"formatedActivityPrice"', '"formatedPrice"', '"salePriceString"', '"targetSkuPriceInfo"',
  '"priceComponent"', '"PRICE"', '"discountPrice"', '"actPrice"'];
const SHIP_KEYS = ['"freightAmount"', '"deliveryOptionPanelDisplayList"', '"shippingFee"', '"freight"',
  '"SHIPPING"', '"deliveryDate"', '"displayAmount"', '"freeShipping"'];
const LOGIN_KEYS = ['"isLogin"', '"loginId"', '"memberSeq"', '"buyerAdminSeq"', '"userId"', '"newUser"', '"coins"'];

export async function sessionProbe(id, env, expect = []) {
  const cookies = (env.AE_COOKIES || "").trim();
  if (!cookies) throw new Error("No AE_COOKIES secret set.");
  const headers = { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Cookie: cookies };
  const report = { product: id, cookie_names: cookies.split(/;\s*/).map((c) => c.split("=")[0]).slice(0, 40) };

  // 1) Item page with the session — fetched straight from the DZ host with full browser navigation headers
  const navHeaders = {
    ...headers,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none", "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Ch-Ua": '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?0", "Sec-Ch-Ua-Platform": '"Windows"',
  };
  const page = await fetch(`https://ar.aliexpress.com/item/${id}.html`, { headers: navHeaders, redirect: "follow" });
  const html = await page.text();
  if (!expect.length && id === "1005009412750740") expect = ["81.83", "5.95"]; // default for the reference item until the tool schema refreshes
  report.page = {
    status: page.status, final_url: page.url, length: html.length,
    title: html.match(/<title>([^<]*)/)?.[1]?.slice(0, 120),
    euro_amounts: [...new Set(html.match(/€\s?\d+[.,]\d{2}/g) || [])].slice(0, 15),
    scripts: [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1].split("?")[0]).slice(0, 12),
    init_vars: [...new Set(html.match(/window\.[A-Za-z_]+\s*=/g) || [])].slice(0, 20),
    blocked: /punish|x5secdata|baxia/i.test(html.slice(0, 20000)),
    login: snippets(html, LOGIN_KEYS),
    price: snippets(html, PRICE_KEYS),
    shipping: snippets(html, SHIP_KEYS),
    hits: findValues(html, expect),
    keyword_hits: keywordSnippets(html, ["price", "freight", "login"]),
  };

  // 2) The background price/shipping request the product page makes (mtop, signed with the _m_h5_tk token)
  const tk = cookieValue(cookies, "_m_h5_tk");
  if (!tk) {
    report.mtop = "skipped: no _m_h5_tk cookie in AE_COOKIES";
  } else {
    const token = tk.split("_")[0];
    const t = String(Date.now());
    const data = JSON.stringify({
      productId: id, _lang: "en_US", _currency: env.CURRENCY || "EUR", country: env.SHIP_TO || "DZ",
      province: "", city: "", channel: "", pdp_ext_f: "", pdpNPI: "", sourceType: "", clientType: "pc",
      ext: JSON.stringify({ foreverRandomToken: "", site: "glo", crawler: false, "x-m-biz-bx-region": "", signedIn: true, host: "www.aliexpress.com" }),
    });
    const sign = await md5(`${token}&${t}&${MTOP_APP_KEY}&${data}`);
    const url = new URL("https://acs.aliexpress.com/h5/mtop.aliexpress.pdp.pc.query/1.0/");
    url.search = new URLSearchParams({
      jsv: "2.5.1", appKey: MTOP_APP_KEY, t, sign, api: "mtop.aliexpress.pdp.pc.query", type: "originaljsonp",
      v: "1.0", timeout: "15000", dataType: "originaljsonp", callback: "mtopjsonp1", data,
    }).toString();
    const r = await fetch(url, { headers: { ...headers, Referer: `https://www.aliexpress.com/item/${id}.html` } });
    const body = await r.text();
    let parsed;
    try {
      parsed = JSON.parse(body.replace(/^[^(]*\(/, "").replace(/\)\s*;?\s*$/, ""));
    } catch {}
    report.mtop = {
      status: r.status, length: body.length,
      ret: body.match(/"ret":\[[^\]]*\]/)?.[0],
      structure: parsed ? describe(parsed.data, 3) : "unparsed",
      hits: findValues(body, expect),
      keyword_hits: keywordSnippets(body, ["price", "freight", "shipping", "delivery", "login", "amount"]),
      price: snippets(body, PRICE_KEYS),
      shipping: snippets(body, SHIP_KEYS),
      login: snippets(body, LOGIN_KEYS),
      refreshed_cookies: (r.headers.get("set-cookie") || "").split(/,(?=\s*\w+=)/).map((c) => c.split("=")[0].trim()).filter(Boolean),
    };
  }
  return report;
}
