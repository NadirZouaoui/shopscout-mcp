// Offline test for get_cart parsing (shape observed from mtop.aliexpress.trade.cart.render).
import { parseCart } from "../src/cart.js";

const checks = [];
const ok = (name, cond) => { checks.push(cond); console.log((cond ? "PASS " : "FAIL ") + name); };

const product = (cartId, itemId, price, crossed, ship, free, sku) => ({
  fields: {
    itemView: { cartId, itemId, skuId: "1", title: "T" + itemId, sku: { skuInfo: sku }, status: "VALID", valid: true },
    logisticsView: { freeShipping: free, freightCost: free ? "Free shipping" : `Shipping: €${ship}`, deliveryDays: 17 },
    priceViews: [{ priceType: "showPrice", value: price, formattedAmount: `€${price}` }, ...(crossed ? [{ priceType: "crossedPrice", value: crossed }] : [])],
    quantityView: { current: 1, max: 68 }, checkbox: { selected: true },
  },
});
const data = {
  data: {
    app_cart_product_component_group_ahe_product_1: product(1, 1005009412750740, 81.83, 143.55, "5.95", false, "Mi Box S 3rd Gen"),
    app_cart_product_component_group_ahe_product_2: product(2, 1005006439886497, 11.33, 23.61, null, true, "WIFI6 FU-AX1800"),
    cart_group_shop_header_ahe_global_shop_9_shop_header: { fields: { title: "Goldway Store", cartLineIds: [1] } },
    app_cart_summary_component_summary: { fields: {
      selectItemNum: 2,
      summaryTabVO: { priceBlockList: [{ summaryLines: [{ title: { title: "Items total" }, content: { content: "€167.16" } }] }] },
      totalSummaryLines: [{ type: "CART_TOTAL", title: { title: "Estimated total" }, content: { content: "€99.11" } }],
    } },
  },
};
const c = parseCart(data);
ok("cart items", c.items.length === 2 && c.items[0].url === "https://www.aliexpress.com/item/1005009412750740.html");
ok("cart shipping + line total", c.items[0].shipping_eur === 5.95 && c.items[0].line_total_eur === 87.78 && c.items[1].shipping_eur === 0);
ok("cart store + variant", c.items[0].store === "Goldway Store" && c.items[1].variant === "WIFI6 FU-AX1800");
ok("cart summary + dzd", c.estimated_total_eur === 99.11 && c.estimated_total_dzd === 27751 && c.summary[0].label === "Items total");

if (checks.includes(false)) process.exit(1);
