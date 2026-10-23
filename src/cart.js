// Read-only view of the owner's AliExpress cart (mtop.aliexpress.trade.cart.render), via the logged-in session.
// Never adds, removes or changes anything.

import { mtopRequest } from "./pdp.js";

const DZD_PER_EUR = 280;
const round2 = (n) => Math.round(n * 100) / 100;
const euro = (s) => {
  const m = String(s ?? "").match(/(\d+(?:[.,]\d{3})*[.,]\d{2}|\d+)/);
  return m ? Number(m[1].replace(/[.,](?=\d{3}\b)/g, "").replace(",", ".")) : null;
};

export async function fetchCart(env) {
  return mtopRequest(env, "mtop.aliexpress.trade.cart.render", {
    _currency: env.CURRENCY || "EUR", shipToCountry: env.SHIP_TO || "DZ", _state: "null", _city: "null",
    locale: "en_US", _saasRegion: "aeg", bizParams: JSON.stringify({ platformType: "DESKTOP", pcChoiceNewCart: 1 }),
  }, "https://www.aliexpress.com/p/shoppingcart/index.html");
}

export function parseCart(data) {
  const comps = data?.data || {};
  // store name per cart line, from the shop headers
  const storeOf = new Map();
  for (const [k, v] of Object.entries(comps)) {
    if (!k.includes("shop_header")) continue;
    for (const id of v.fields?.cartLineIds || []) storeOf.set(String(id), v.fields.title);
  }
  const items = [];
  for (const [k, v] of Object.entries(comps)) {
    if (!k.startsWith("app_cart_product_component")) continue;
    const f = v.fields || {};
    const iv = f.itemView || {};
    const lv = f.logisticsView || {};
    const show = (f.priceViews || []).find((p) => p.priceType === "showPrice") || (f.priceViews || [])[0] || {};
    const crossed = (f.priceViews || []).find((p) => p.priceType === "crossedPrice");
    const qty = f.quantityView?.current ?? 1;
    const price = typeof show.value === "number" ? show.value : euro(show.formattedAmount);
    const shipping = lv.freeShipping ? 0 : euro(lv.freightCost);
    items.push({
      id: String(iv.itemId),
      url: `https://www.aliexpress.com/item/${iv.itemId}.html`,
      title: iv.title,
      variant: iv.sku?.skuInfo || iv.skuInfo,
      sku_id: String(iv.skuId ?? ""),
      store: storeOf.get(String(iv.cartId)),
      quantity: qty,
      price_eur: price,
      original_eur: crossed?.value,
      shipping_eur: shipping,
      line_total_eur: price != null && shipping != null ? round2(price * qty + shipping) : null,
      delivery_days: lv.deliveryDays,
      selected: f.checkbox?.selected ?? true,
      available: iv.valid !== false && iv.status !== "INVALID",
      max_quantity: f.quantityView?.max,
    });
  }
  // AliExpress's own summary for the selected items
  const s = comps.app_cart_summary_component_summary?.fields || {};
  const lines = [...(s.summaryTabVO?.priceBlockList?.[0]?.summaryLines || []), ...(s.totalSummaryLines || [])]
    .map((l) => ({ label: l.title?.title, value: l.content?.content }))
    .filter((l) => l.value);
  const estimated = euro((s.totalSummaryLines || []).find((l) => l.type === "CART_TOTAL")?.content?.content);
  return {
    items,
    selected_items: s.selectItemNum ?? items.filter((i) => i.selected).length,
    summary: lines.length ? lines : undefined,
    estimated_total_eur: estimated,
    estimated_total_dzd: estimated != null ? Math.round(estimated * DZD_PER_EUR) : null,
  };
}

export async function getCart(env) {
  return parseCart(await fetchCart(env));
}
