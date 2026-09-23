import type { Context, Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import bcrypt from "bcryptjs";
import { eq, isNull } from "drizzle-orm";
import { apiTokens, getDb } from "@job-scout/db";
import { env } from "./env.js";
import { fail } from "./envelope.js";

export type AuthUser = { kind: "session" | "agent" | "cf_access"; name: string; tokenId?: string; scopes: string[] };

declare module "hono" {
  interface ContextVariableMap {
    user?: AuthUser;
    requestId: string;
  }
}

const PUBLIC = new Set(["/api/v1/health", "/api/v1/ready", "/api/v1/auth/login", "/api/v1/auth/status", "/api/v1/webhooks/waha"]);

export async function resolveBearer(token: string): Promise<AuthUser | null> {
  if (!token) return null;
  if (token === env.apiTokenSeed) return { kind: "agent", name: "seed-token", scopes: ["agent", "mcp", "admin"] };
  const db = await getDb();
  const rows = await db.select().from(apiTokens).where(isNull(apiTokens.revokedAt));
  for (const row of rows) {
    if (!token.startsWith(row.tokenPrefix)) continue;
    if (await bcrypt.compare(token, row.tokenHash)) {
      await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id));
      return { kind: "agent", name: row.name, tokenId: row.id, scopes: (row.scopes as string[]) || ["agent"] };
    }
  }
  return null;
}

export async function authMiddleware(c: Context, next: Next) {
  const path = c.req.path;
  const gated = path.startsWith("/api/") || path === "/clip";
  if (PUBLIC.has(path) || !gated) return next();

  const header = c.req.header("authorization");
  if (header?.startsWith("Bearer ")) {
    const user = await resolveBearer(header.slice(7).trim());
    if (!user) return fail(c, "UNAUTHORIZED", "Invalid bearer token");
    c.set("user", user);
    return next();
  }
  if (env.authMode === "cf_access") {
    const email = c.req.header("cf-access-authenticated-user-email");
    if (email) {
      c.set("user", { kind: "cf_access", name: email, scopes: ["admin"] });
      return next();
    }
  }
  const session = getCookie(c, "js_session");
  if (session === "ok" || env.authMode === "dev") {
    c.set("user", { kind: "session", name: "operator", scopes: ["admin"] });
    return next();
  }
  return fail(c, "UNAUTHORIZED", "Authentication required");
}

export async function loginHandler(c: Context) {
  const b = (await c.req.json().catch(() => ({}))) as { password?: string };
  if (b.password !== env.authPassword && b.password !== env.apiTokenSeed) return fail(c, "UNAUTHORIZED", "Invalid password");
  setCookie(c, "js_session", "ok", {
    httpOnly: true,
    path: "/",
    sameSite: env.isProd ? "None" : "Lax",
    maxAge: 60 * 60 * 24 * 30,
    secure: env.isProd,
  });
  return c.json({ ok: true, data: { authenticated: true }, meta: {} });
}

export function authStatus(c: Context) {
  const session = getCookie(c, "js_session");
  return c.json({ ok: true, data: { authenticated: session === "ok" || env.authMode === "dev", mode: env.authMode }, meta: {} });
}
