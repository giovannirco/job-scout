import { createMcpHandler, type AuthInfo, type McpHttpHandler } from "@modelcontextprotocol/server";
import { allowedOrigin } from "../origin.js";
import { resolveBearer } from "../auth.js";
import { createJobScoutMcpServer } from "./server.js";
import { log as rootLog } from "@job-scout/shared";

const log = rootLog.child({ scope: "mcp" });

/** Stateless Streamable HTTP MCP entry. Auth: Bearer (seed token or api_tokens with mcp|agent|admin scope). */
const mcpCore: McpHttpHandler = createMcpHandler(() => createJobScoutMcpServer(), {
  legacy: "stateless",
  responseMode: "json",
  onerror: (err) => log.error("mcp.transport.error", { err }),
});

const CORS: Record<string, string> = {
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Mcp-Method, Mcp-Name, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version",
};

export async function handleMcpHttp(request: Request, parsedBody?: unknown): Promise<Response> {
  const origin = request.headers.get("origin") || undefined;
  if (!allowedOrigin(origin)) return new Response("Origin is not allowed", { status: 403 });
  const corsHeaders = { ...CORS, ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}) };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  const header = request.headers.get("authorization") || "";
  const user = header.startsWith("Bearer ") ? await resolveBearer(header.slice(7).trim()) : null;
  if (!user || !user.scopes.some((s) => ["mcp", "agent", "admin"].includes(s))) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }), {
      status: 401,
      headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="job-scout-mcp", error="invalid_token"', ...corsHeaders },
    });
  }
  const authInfo: AuthInfo = { token: header.slice(7).trim(), clientId: user.name, scopes: user.scopes };
  let body = parsedBody;
  if (body === undefined && request.method !== "GET" && request.method !== "HEAD") {
    try {
      body = await request.clone().json();
    } catch {
      body = undefined;
    }
  }
  const response = await mcpCore.fetch(request, { authInfo, parsedBody: body });
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
