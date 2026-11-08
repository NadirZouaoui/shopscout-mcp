// Deep search: finds listings a single keyword search misses.
//
// Why it exists: AliExpress search returns a capped, ranked set padded with loosely related items,
// and it can leave out listings whose titles do match (a "Rapoo MT760/MT720L ..." listing, the cheapest,
// never appeared for "rapoo mt760" or even "mt760"; a narrower "MT720L" query surfaced it). One query of
// one page therefore under-reports. Varying the query changes which listings make the cut. Deep search
//   1. runs several query variants (given aliases, the bare model token, sibling models found in titles),
//   2. reads a few result pages per query,
//   3. keeps only titles that mention the product (drops grips, skates, cases, spare PCBs),
//   4. flags new-shopper prices (not what a returning customer pays) and sorts by real price first.

const MODEL_TOKEN = /\b[A-Za-z]{1,5}-?\d{1,5}[A-Za-z]{0,5}\b/g;
const ACCESSORY = new RegExp(
  "\\b(grip|tape|stickers?|skates?|glides?|mouse feet|pcb|hot[- ]?swap|micro ?switch|charging (base|dock|station)|" +
  "case|pouch|bag|cover|lizard|screen protector|mouse ?pad|mousepad|replacement|repair|spare|jiggler|adapter cable)\\b", "i");
const NEW_SHOPPER = /new (shoppers?|users?|customers?|buyers?)/i;

// "€ 1.171,21" -> 1171.21, "US $9.80" -> 9.8, "€ 37,84" -> 37.84
export function parsePrice(s) {
  if (typeof s === "number") return s;
  const t = String(s ?? "").replace(/[^\d.,]/g, "");
  if (!t) return NaN;
  const lastDot = t.lastIndexOf("."), lastComma = t.lastIndexOf(",");
  let decimalSep = null;
  if (lastDot >= 0 && lastComma >= 0) decimalSep = lastDot > lastComma ? "." : ",";
  else if (lastComma >= 0) decimalSep = /,\d{1,2}$/.test(t) ? "," : null;
  else if (lastDot >= 0) decimalSep = /\.\d{1,2}$/.test(t) ? "." : null;
  const norm = decimalSep
    ? t.replace(decimalSep === "." ? /,/g : /\./g, "").replace(decimalSep, ".")
    : t.replace(/[.,]/g, "");
  return Number(norm);
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// Model-like tokens (letters+digits, e.g. MT760, MT720L, VT3) in a string.
export function modelTokens(text) {
  const out = [];
  for (const m of String(text || "").matchAll(MODEL_TOKEN)) {
    const t = m[0];
    if (/\d/.test(t) && /[A-Za-z]/.test(t) && !out.some((o) => norm(o) === norm(t))) out.push(t);
  }
  return out;
}

export const isAccessory = (title) => ACCESSORY.test(String(title || ""));
export const isNewShopperPrice = (item) => (item.tags || []).some((t) => NEW_SHOPPER.test(t));

// Queries to run, in order. `aliases` are alternate model names supplied by the caller.
export function buildQueries(keywords, aliases = []) {
  const kw = String(keywords).trim();
  const tokens = modelTokens(kw);
  const words = kw.split(/\s+/);
  // Brand = leading plain word before the first model token ("rapoo" in "rapoo mt760").
  const brand = tokens.length && !/^[A-Za-z]{1,5}-?\d{1,5}[A-Za-z]{0,5}$/.test(words[0]) ? words[0] : "";
  const q = [kw];
  for (const t of tokens) q.push(brand ? `${brand} ${t}` : t, t);
  for (const a of aliases) {
    const alias = String(a).trim();
    if (!alias) continue;
    q.push(brand && !norm(alias).includes(norm(brand)) ? `${brand} ${alias}` : alias);
  }
  const unique = new Map();
  for (const x of q) if (!unique.has(x.toLowerCase())) unique.set(x.toLowerCase(), x);
  return { queries: [...unique.values()], tokens, brand };
}

// Sibling model names found in matching titles (same letter prefix, e.g. MT760L / MT760M / MT720L
// when searching MT760). Used to run a second round of searches.
export function siblingTokens(items, baseTokens, known) {
  const prefixes = baseTokens.map((t) => t.match(/^[A-Za-z]+/)?.[0].toLowerCase()).filter(Boolean);
  const out = [];
  for (const it of items) {
    // titles list alternates as "MT760L/MT760M/MT760Mini" or "MT760/MT720L"
    for (const t of modelTokens(it.title)) {
      const p = t.match(/^[A-Za-z]+/)?.[0].toLowerCase();
      if (!prefixes.includes(p)) continue;
      if (known.some((k) => norm(k) === norm(t)) || out.some((k) => norm(k) === norm(t))) continue;
      out.push(t);
    }
  }
  return out;
}

// Does the title mention the product? Model tokens decide; with no model token, every keyword must appear.
export function isRelevant(title, matchTokens, keywords) {
  const nt = norm(title);
  if (matchTokens.length) return matchTokens.some((t) => nt.includes(norm(t)));
  return String(keywords).toLowerCase().split(/\s+/).filter(Boolean).every((w) => nt.includes(norm(w)));
}

/**
 * @param args   { keywords, aliases?, pages?, include_accessories?, verify_top?, min_price?, max_price? }
 * @param deps   { search(args)->{products}, verify?(ids)->[{id,...}] }  (injected so it can be tested offline)
 */
export async function deepSearch(args, deps, limits = {}) {
  const maxFetches = limits.maxFetches || 20; // stays well under the Worker subrequest limit
  const pages = Math.min(Math.max(args.pages || 2, 1), 4);
  const { queries, tokens } = buildQueries(args.keywords, args.aliases || []);
  const matchTokens = [...tokens, ...(args.aliases || []).flatMap((a) => modelTokens(a))];
  const errors = [];
  const found = new Map(); // id -> item
  const ran = [];
  let fetches = 0;

  async function runRound(qs) {
    const jobs = [];
    for (const query of qs) {
      for (let page = 1; page <= pages && fetches < maxFetches; page++) {
        fetches++;
        jobs.push(
          deps.search({ keywords: query, page, page_size: 40, min_price: args.min_price, max_price: args.max_price })
            .then((r) => ({ query, page, products: r.products || [] }))
            .catch((e) => { errors.push(`${query} p${page}: ${e.message}`); return null; })
        );
      }
    }
    for (const r of await Promise.all(jobs)) {
      if (!r) continue;
      ran.push(`${r.query} p${r.page}`);
      for (const p of r.products) {
        if (!found.has(p.id)) found.set(p.id, { ...p, found_by: r.query });
      }
    }
  }

  await runRound(queries);

  // Second round: sibling model names that appeared in matching titles.
  const relevantNow = [...found.values()].filter((p) => isRelevant(p.title, matchTokens, args.keywords));
  const siblings = siblingTokens(relevantNow, tokens, [...matchTokens]).slice(0, 3);
  if (siblings.length && fetches < maxFetches) {
    const { brand } = buildQueries(args.keywords);
    const qs = siblings.map((s) => (brand ? `${brand} ${s}` : s));
    matchTokens.push(...siblings);
    await runRound(qs);
  }

  const all = [...found.values()];
  const relevant = all.filter((p) => isRelevant(p.title, matchTokens, args.keywords));
  const accessories = relevant.filter((p) => isAccessory(p.title));
  let products = (args.include_accessories ? relevant : relevant.filter((p) => !isAccessory(p.title))).map((p) => {
    const newShopper = isNewShopperPrice(p);
    return {
      ...p,
      price_value: parsePrice(p.price),
      new_shopper_price: newShopper || undefined,
      price_note: newShopper ? "new-shopper price, not what a returning customer pays; verify with check_price" : undefined,
    };
  });
  // Returning-customer prices first (cheapest first), then new-shopper-priced items (cheapest first).
  products.sort((a, b) =>
    (a.new_shopper_price ? 1 : 0) - (b.new_shopper_price ? 1 : 0) ||
    (a.price_value || Infinity) - (b.price_value || Infinity));

  // Optional: personalised price + shipping for the N cheapest candidates (needs the owner's session).
  const verifyN = Math.min(Math.max(args.verify_top || 0, 0), 5);
  if (verifyN && deps.verify) {
    const cheapest = [...products].sort((a, b) => (a.price_value || Infinity) - (b.price_value || Infinity)).slice(0, verifyN);
    const results = await deps.verify(cheapest.map((p) => p.id));
    for (const r of results) {
      const p = products.find((x) => x.id === r.id);
      if (!p) continue;
      p.verified = r.error
        ? { error: r.error }
        : { variant: r.variant, price_eur: r.price_eur, shipping_eur: r.shipping?.fee_eur, total_eur: r.total_eur,
            total_dzd: r.total_dzd, delivery_days: r.shipping?.delivery_days, deals: r.deals, source: r.source };
    }
    products.sort((a, b) => (a.verified?.total_eur ?? Infinity) - (b.verified?.total_eur ?? Infinity) ||
      (a.new_shopper_price ? 1 : 0) - (b.new_shopper_price ? 1 : 0) || (a.price_value || Infinity) - (b.price_value || Infinity));
  }

  return {
    source: "site (deep)",
    queries_run: ran,
    sibling_models_tried: siblings.length ? siblings : undefined,
    products,
    dropped: { not_matching: all.length - relevant.length, accessories: args.include_accessories ? 0 : accessories.length },
    note: "AliExpress returns a capped, ranked set per query and can omit listings that do match. If this looks thin, call again " +
      "with 'aliases' (other model names, sibling numbers, size suffixes) or distinctive title words to change which listings make the cut.",
    errors: errors.length ? errors : undefined,
  };
}
