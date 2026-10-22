# ShopScout MCP

AI shopping assistant tool built by an electrical engineer. It connects AliExpress product search and details to an AI chat assistant (via MCP), so users can compare electronics such as WiFi adapters, PC accessories and solar equipment by specs, price and ratings, and open the products they choose through affiliate links.

It runs as a small remote MCP server on Cloudflare Workers (free tier) and uses the official AliExpress Open Platform affiliate API, with no scraping. Once deployed, it can be added as a custom connector in Claude and used from web, desktop or mobile.

## Tools

| Tool | What it does |
|---|---|
| `search_products` | Keyword search with optional price range and sort. Returns a compact list: id, title, price, rating, 30-day orders, shop, link. |
| `get_product` | Details for up to 20 products by id, full URL or short share link. |

Results are trimmed to the fields that matter for comparison, so they stay small in chat.

## Setup

Requirements: Node.js 18+, a free Cloudflare account, and an approved app on the AliExpress Open Platform (App Key + App Secret, plus a tracking id for affiliate links).

```bash
git clone https://github.com/NadirZouaoui/shopscout-mcp
cd shopscout-mcp
npm install
npx wrangler login

npx wrangler secret put AE_APP_KEY
npx wrangler secret put AE_APP_SECRET
npx wrangler secret put AE_TRACKING_ID
npx wrangler secret put ACCESS_TOKEN     # any long random string

npm run deploy
```

Currency, language and ship-to country are set in `wrangler.toml` (default USD / EN / DZ).

## Connect to Claude

Settings → Connectors → Add custom connector, with this URL:

```
https://shopscout-mcp.<your-subdomain>.workers.dev/mcp/<ACCESS_TOKEN>
```

The access token in the path keeps the endpoint private. Treat the full URL like a password.

## Development

```bash
npm test      # offline smoke test with a mocked API
npm run dev   # local server at http://localhost:8787
```

For `npm run dev`, put the secrets in a `.dev.vars` file (already gitignored).

## Disclosure

Product links returned by this tool may be affiliate links.
