// Tests for strict id extraction and manual short-link redirect following.
import { extractId, resolveShortLink } from "../src/tools.js";
const checks = [];
const ok = (n, c) => { checks.push(c); console.log((c ? "PASS " : "FAIL ") + n); };

ok("plain id", extractId("1005006784646120") === "1005006784646120");
ok("item url", extractId("https://www.aliexpress.com/item/1005006784646120.html?spm=a2g0o&gatewayAdapt=1234567890123") === "1005006784646120");
ok("ignores tracking numbers", extractId("https://star.aliexpress.com/share/share.htm?aff_fcid=12345678901234567&platform=AE") === null);
ok("encoded redirect param", extractId("https://star.aliexpress.com/share/share.htm?redirectUrl=https%3A%2F%2Fvi.aliexpress.com%2Fitem%2F1005005560098155.html%3Fsk%3D1") === "1005005560098155");
ok("productIds param", extractId("https://m.aliexpress.com/p/x.html?productIds=1005001111111111") === "1005001111111111");

// Simulated chain: short link -> share page with encoded item url (no item page fetched)
const chain = {
  "https://a.aliexpress.com/_EzTbrRG": "https://s.click.aliexpress.com/e/_abc?bz=725*90&aff_fcid=99999999999999999",
  "https://s.click.aliexpress.com/e/_abc?bz=725*90&aff_fcid=99999999999999999": "https://star.aliexpress.com/share/share.htm?redirectUrl=https%3A%2F%2Fwww.aliexpress.com%2Fitem%2F1005003333333333.html",
};
globalThis.fetch = async (url) => {
  const loc = chain[url];
  return loc ? new Response(null, { status: 302, headers: { location: loc } }) : new Response("<html></html>");
};
const r = await resolveShortLink("https://a.aliexpress.com/_EzTbrRG");
ok("short link chain", r.id === "1005003333333333");

globalThis.fetch = async () => new Response('<script>location.href="https://www.aliexpress.com/item/1005004444444444.html"</script>');
ok("js redirect body", (await resolveShortLink("https://a.aliexpress.com/_X")).id === "1005004444444444");

process.exit(checks.every(Boolean) ? 0 : 1);
