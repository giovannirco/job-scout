import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { verifyAccessAssertion } from "./cf-access.js";
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

const SESSION_SECONDS = 60 * 60 * 24 * 30;
const processSessionKey = randomBytes(32).toString("hex");
function sessionKey() {
  // Rotation of either configured credential invalidates all existing sessions.
  return createHmac("sha256", env.authPassword || processSessionKey).update(env.apiTokenSeed).digest();
}
export function createSession(now = Date.now()): string {
  const payload = `${Math.floor(now / 1000) + SESSION_SECONDS}.${randomBytes(24).toString("base64url")}`;
  return `${payload}.${createHmac("sha256", sessionKey()).update(payload).digest("base64url")}`;
}
export function validSession(value: string | undefined, now = Date.now()): boolean {
  if (!value || value.length > 256) return false;
  const parts = value.split(".");
  if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{32}$/.test(parts[1])) return false;
  const expiry = Number(parts[0]);
  if (expiry <= Math.floor(now / 1000) || expiry > Math.floor(now / 1000) + SESSION_SECONDS) return false;
  const expected = createHmac("sha256", sessionKey()).update(`${parts[0]}.${parts[1]}`).digest("base64url");
  return secureEqual(parts[2], expected);
}
function secureEqual(actual: string, expected: string) {
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const PUBLIC = new Set(["/api/v1/health", "/api/v1/ready", "/api/v1/auth/login", "/api/v1/auth/status", "/api/v1/webhooks/waha"]);

export async function resolveBearer(token: string): Promise<AuthUser | null> {
  if (!token || token.length > 512) return null;
  if (env.apiTokenSeed && secureEqual(token, env.apiTokenSeed)) return { kind: "agent", name: "seed-token", scopes: ["agent", "mcp", "admin"] };
  const db = await getDb();
  const rows = await db.select().from(apiTokens).where(isNull(apiTokens.revokedAt));
  for (const row of rows) {
    if (!token.startsWith(row.tokenPrefix)) continue;
    if (await bcrypt.compare(token, row.tokenHash)) {
      await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id));
      return { kind: "agent", name: row.name, tokenId: row.id, scopes: Array.isArray(row.scopes) ? row.scopes.filter((scope): scope is string => typeof scope === "string") : [] };
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
    if (!user.scopes.some((scope) => ["agent", "admin"].includes(scope))) return fail(c, "FORBIDDEN", "API scope required");
    if (path.startsWith("/api/v1/settings/tokens") && !user.scopes.includes("admin")) return fail(c, "FORBIDDEN", "Admin scope required");
    c.set("user", user);
    return next();
  }
  if (env.authMode === "cf_access") {
    const email = await verifyAccessAssertion(c.req.header("cf-access-jwt-assertion"));
    if (email) {
      c.set("user", { kind: "cf_access", name: email, scopes: ["admin"] });
      return next();
    }
  }
  const session = getCookie(c, "js_session");
  if ((env.authMode === "token" && validSession(session)) || env.authMode === "dev") {
    c.set("user", { kind: "session", name: "operator", scopes: ["admin"] });
    return next();
  }
  return fail(c, "UNAUTHORIZED", "Authentication required");
}

export async function loginHandler(c: Context) {
  const b = (await c.req.json().catch(() => ({}))) as { password?: string } | null;
  if (env.authMode !== "token" || !b || typeof b.password !== "string" || !env.authPassword || !secureEqual(b.password, env.authPassword)) return fail(c, "UNAUTHORIZED", "Invalid password");
  setCookie(c, "js_session", createSession(), {
    httpOnly: true,
    path: "/",
    sameSite: "Lax",
    maxAge: SESSION_SECONDS,
    secure: env.isProd,
  });
  return c.json({ ok: true, data: { authenticated: true }, meta: {} });
}

export async function authStatus(c: Context) {
  const session = getCookie(c, "js_session");
  return c.json({ ok: true, data: { authenticated: env.authMode === "dev" || (env.authMode === "token" && validSession(session)) || (env.authMode === "cf_access" && !!await verifyAccessAssertion(c.req.header("cf-access-jwt-assertion"))), mode: env.authMode }, meta: {} });
}
