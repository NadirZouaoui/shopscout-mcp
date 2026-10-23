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

const PRICE_KEYS = ['"formatedActivityPrice"', '"formatedPrice"', '"salePriceString"', '"targetSkuPriceInfo"',
  '"priceComponent"', '"PRICE"', '"discountPrice"', '"actPrice"'];
const SHIP_KEYS = ['"freightAmount"', '"deliveryOptionPanelDisplayList"', '"shippingFee"', '"freight"',
  '"SHIPPING"', '"deliveryDate"', '"displayAmount"', '"freeShipping"'];
const LOGIN_KEYS = ['"isLogin"', '"loginId"', '"memberSeq"', '"buyerAdminSeq"', '"userId"', '"newUser"', '"coins"'];

export async function sessionProbe(id, env) {
  const cookies = (env.AE_COOKIES || "").trim();
  if (!cookies) throw new Error("No AE_COOKIES secret set.");
  const headers = { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Cookie: cookies };
  const report = { product: id, cookie_names: cookies.split(/;\s*/).map((c) => c.split("=")[0]).slice(0, 40) };

  // 1) Item page with the session
  const page = await fetch(`https://www.aliexpress.com/item/${id}.html`, { headers, redirect: "follow" });
  const html = await page.text();
  report.page = {
    status: page.status, final_url: page.url, length: html.length,
    blocked: /punish|x5secdata|baxia/i.test(html.slice(0, 20000)),
    login: snippets(html, LOGIN_KEYS),
    price: snippets(html, PRICE_KEYS),
    shipping: snippets(html, SHIP_KEYS),
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
    report.mtop = {
      status: r.status, length: body.length,
      ret: body.match(/"ret":\[[^\]]*\]/)?.[0],
      price: snippets(body, PRICE_KEYS),
      shipping: snippets(body, SHIP_KEYS),
      login: snippets(body, LOGIN_KEYS),
      refreshed_cookies: (r.headers.get("set-cookie") || "").split(/,(?=\s*\w+=)/).map((c) => c.split("=")[0].trim()).filter(Boolean),
    };
  }
  return report;
}
