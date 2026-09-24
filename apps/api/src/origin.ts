import type { Context, Next } from "hono";
import { env } from "./env.js";
import { fail } from "./envelope.js";

export function allowedOrigin(origin: string | undefined): boolean {
  return !origin || env.allowedOrigins.includes(origin);
}

/** A browser can omit Origin for same-origin GETs after rebinding an attacker hostname. */
function allowedDevHost(url: string): boolean {
  const hostname = new URL(url).hostname.toLowerCase();
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname) || env.allowedOrigins.some((origin) => new URL(origin).hostname.toLowerCase() === hostname);
}

/** Browser callers must use an operator-configured origin, including in dev mode. */
export async function originMiddleware(c: Context, next: Next) {
  if (env.authMode === "dev" && !["/api/v1/health", "/api/v1/ready"].includes(c.req.path) && !allowedDevHost(c.req.url)) {
    return fail(c, "FORBIDDEN", "Host is not allowed");
  }
  if (!allowedOrigin(c.req.header("origin"))) return fail(c, "FORBIDDEN", "Origin is not allowed");
  if (["cross-site", "same-site"].includes(c.req.header("sec-fetch-site") || "") && !c.req.header("origin")) return fail(c, "FORBIDDEN", "Cross-site request is not allowed");
  return next();
}
