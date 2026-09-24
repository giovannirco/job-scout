import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware, authStatus, createSession, loginHandler, validSession } from "./auth.js";
import { env, readApiEnv } from "./env.js";
import { originMiddleware } from "./origin.js";

const original = { ...env };
beforeEach(() => { env.authMode = "token"; env.authPassword = "test-password-long-enough"; env.apiTokenSeed = "test-seed-token-32-characters-long"; });
afterEach(() => { Object.assign(env, original); vi.restoreAllMocks(); });
function app() {
  const a = new Hono();
  a.use("*", originMiddleware);
  a.use("*", authMiddleware);
  a.post("/api/v1/auth/login", loginHandler);
  a.get("/api/v1/auth/status", authStatus);
  a.get("/api/v1/settings/profile", (c) => c.json({ private: "profile" }));
  return a;
}

describe("authentication boundary", () => {
  it("rejects the legacy forged cookie on private API and auth status", async () => {
    const headers = { cookie: "js_session=ok" };
    expect((await app().request("/api/v1/settings/profile", { headers })).status).toBe(401);
    expect(await (await app().request("/api/v1/auth/status", { headers })).json()).toMatchObject({ data: { authenticated: false } });
  });
  it("creates a signed session only with the password, not the seed", async () => {
    const a = app();
    for (const password of [env.apiTokenSeed, "job-scout", undefined]) {
      expect((await a.request("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ password }) })).status).toBe(401);
    }
    const login = await a.request("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ password: env.authPassword }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("SameSite=Lax");
    expect((await a.request("/api/v1/settings/profile", { headers: { cookie } })).status).toBe(200);
  });
  it("rejects expired, modified, and credential-rotated sessions", () => {
    const now = Date.now(); const session = createSession(now);
    expect(validSession(session, now)).toBe(true);
    expect(validSession(session, now + 31 * 86400000)).toBe(false);
    expect(validSession(session.replace(/.$/, (char) => char === "a" ? "b" : "a"), now)).toBe(false);
    env.authPassword += "rotated"; expect(validSession(session, now)).toBe(false);
  });
  it("does not accept a Cloudflare email header or local password in cf_access mode", async () => {
    env.authMode = "cf_access";
    expect((await app().request("/api/v1/settings/profile", { headers: { "cf-access-authenticated-user-email": "attacker@example.com", cookie: `js_session=${createSession()}` } })).status).toBe(401);
    expect((await app().request("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ password: env.authPassword }) })).status).toBe(401);
  });
  it("rejects untrusted browser origins even in dev mode, and permits configured origins", async () => {
    env.authMode = "dev";
    expect((await app().request("/api/v1/settings/profile", { headers: { origin: "https://attacker.example" } })).status).toBe(403);
    expect((await app().request("/api/v1/settings/profile", { headers: { origin: env.allowedOrigins[0] } })).status).toBe(200);
  });
});

describe("authentication configuration", () => {
  it("defaults production to protected mode and refuses empty/example/weak credentials", () => {
    expect(() => readApiEnv({ NODE_ENV: "production" })).toThrow(/requires/);
    expect(() => readApiEnv({ AUTH_MODE: "token", AUTH_PASSWORD: "job-scout" })).toThrow(/example/);
    expect(() => readApiEnv({ AUTH_MODE: "token", API_TOKEN_SEED: "short" })).toThrow(/32/);
    expect(() => readApiEnv({ AUTH_MODE: "wrong" })).toThrow(/Invalid/);
    expect(() => readApiEnv({ NODE_ENV: "production", AUTH_MODE: "dev" })).toThrow(/explicit/);
    expect(readApiEnv({ NODE_ENV: "production", AUTH_MODE: "dev", ALLOW_INSECURE_DEV_AUTH: "1" }).authMode).toBe("dev");
  });
  it("requires Cloudflare issuer and audience and rejects custom key servers", () => {
    expect(() => readApiEnv({ AUTH_MODE: "cf_access", CF_ACCESS_ISSUER: "https://attacker.example", CF_ACCESS_AUDIENCE: "aud" })).toThrow();
    expect(() => readApiEnv({ AUTH_MODE: "cf_access", CF_ACCESS_ISSUER: "https://team.cloudflareaccess.com" })).toThrow(/AUDIENCE/);
  });
});

describe("browser requests without Origin", () => {
  it("rejects an attacker-controlled host after DNS rebinding in dev mode", async () => {
    env.authMode = "dev";
    for (const headers of [new Headers(), new Headers({ "sec-fetch-site": "same-origin" })]) {
      const response = await app().request("http://rebinding.attacker.example/api/v1/settings/profile", { headers });
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('"private"');
    }
    expect((await app().request("http://127.0.0.1/api/v1/settings/profile")).status).toBe(200);
    env.allowedOrigins = ["https://desk.example.com"];
    expect((await app().request("https://desk.example.com/api/v1/settings/profile")).status).toBe(200);
  });
  it("does not confuse a sibling site's no-Origin request with same-origin permission", async () => {
    env.authMode = "token";
    const cookie = `js_session=${createSession()}`;
    expect((await app().request("/api/v1/settings/profile", { headers: { cookie, "sec-fetch-site": "same-site" } })).status).toBe(403);
    expect((await app().request("/api/v1/settings/profile", { headers: { cookie, "sec-fetch-site": "same-origin" } })).status).toBe(200);
  });
});
