import type { Context, Next } from "hono";
import { env } from "./env.js";
import { fail } from "./envelope.js";

export function allowedOrigin(origin: string | undefined): boolean {
  return !origin || env.allowedOrigins.includes(origin);
}

/** Browser callers must use an operator-configured origin, including in dev mode. */
export async function originMiddleware(c: Context, next: Next) {
  if (!allowedOrigin(c.req.header("origin"))) return fail(c, "FORBIDDEN", "Origin is not allowed");
  if (c.req.header("sec-fetch-site") === "cross-site" && !c.req.header("origin")) return fail(c, "FORBIDDEN", "Cross-site request is not allowed");
  return next();
}
