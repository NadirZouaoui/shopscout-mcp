// ShopScout MCP — a remote MCP server (Streamable HTTP, stateless JSON responses) on Cloudflare Workers.
// Endpoint: POST https://<worker>/mcp/<ACCESS_TOKEN>

import { TOOLS } from "./tools.js";

const SERVER_INFO = { name: "shopscout-mcp", version: "0.3.0" };
const DEFAULT_PROTOCOL = "2025-06-18";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleMessage(msg, env) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "AliExpress product search, details and reviews. search_products reads the real site results by default (same items, prices, deal badges and shipping text the site shows); source 'api' uses the affiliate catalog, which misses many deal items. " +
          "Results are compact text; call get_product for one item's details. Prices are in the configured currency and ship-to country. " +
          "Use the shipping field when present. Otherwise prices exclude shipping: before recommending, check the shipping fee for each shortlisted item " +
          "(at most ~5) with the browser extension if available: open the item page, read the page text (avoid screenshots), " +
          "and report item price + shipping = total. If no browser is available, say clearly that prices exclude shipping.",
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        const out = await tool.run(params.arguments || {}, env);
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out) }] });
      } catch (e) {
        return rpcResult(id, { content: [{ type: "text", text: String(e.message || e) }], isError: true });
      }
    }
    default:
      if (isNotification) return null; // e.g. notifications/initialized
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" ) {
      return new Response("ShopScout MCP server. See https://github.com/NadirZouaoui/shopscout-mcp", {
        headers: { "Content-Type": "text/plain" },
      });
    }

    const m = url.pathname.match(/^\/mcp(?:\/([^/]+))?\/?$/);
    if (!m) return new Response("Not found", { status: 404 });
    if (!env.ACCESS_TOKEN || m[1] !== env.ACCESS_TOKEN) return new Response("Unauthorized", { status: 401 });

    if (request.method === "GET") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (request.method !== "POST") return new Response(null, { status: 405 });

    let body;
    try { body = await request.json(); } catch { return json(rpcError(null, -32700, "Parse error"), 400); }

    if (Array.isArray(body)) {
      const results = (await Promise.all(body.map((m) => handleMessage(m, env)))).filter(Boolean);
      return results.length ? json(results) : new Response(null, { status: 202 });
    }
    const result = await handleMessage(body, env);
    return result ? json(result) : new Response(null, { status: 202 });
  },
};
