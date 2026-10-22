# ShopScout MCP

An MCP server that connects AliExpress product search, details and reviews to an AI chat assistant, so products can be compared by specs, price and ratings right in the chat.

It runs as a small remote MCP server on Cloudflare Workers (free tier). Once deployed, it can be added as a custom connector in Claude and used from web, desktop or mobile.

## Modes

- **API mode** (when `AE_APP_KEY` and `AE_APP_SECRET` are set): uses the official AliExpress Open Platform affiliate API. Reliable, returns affiliate links.
- **Scrape mode** (no keys): reads the public product, search and review pages and extracts their embedded data. Gives spec tables and reviews, but may be blocked at times. Errors say when that happens.

Set `MODE = "api"` or `"scrape"` in `wrangler.toml` to force one.

## Tools

| Tool | What it does |
|---|---|
| `search_products` | Keyword search with optional price range and sort. Returns a compact list: id, title, price, rating, orders, shop, link. |
| `get_product` | Details by id, full URL or short share link. In scrape mode includes the spec table and variants. |
| `get_reviews` | Buyer reviews for one product, text trimmed, optional photos-only filter. |

Results are trimmed to the fields that matter for comparison, so they stay small in chat.

## Setup

Requirements: Node.js 18+ and a free Cloudflare account. API mode also needs an approved app on the AliExpress Open Platform.

```bash
git clone https://github.com/NadirZouaoui/shopscout-mcp
cd shopscout-mcp
npm install
npx wrangler login

npx wrangler secret put ACCESS_TOKEN     # any long random string

# API mode only, once approved:
npx wrangler secret put AE_APP_KEY
npx wrangler secret put AE_APP_SECRET
npx wrangler secret put AE_TRACKING_ID

npm run deploy
```

Currency, language and ship-to country are set in `wrangler.toml` (default EUR / EN / DZ).

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
