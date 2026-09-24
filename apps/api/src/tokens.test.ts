import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { apiTokens, closeDb, getDb } from "@job-scout/db";
import { bootstrap } from "@job-scout/core";
import { createApp } from "./app.js";
import { env } from "./env.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-auth-"));
const original = { ...env };
const token = (name: string) => `js_test_${name}_credential_value_for_security_tests`;

describe("persisted bearer token authorization", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL; process.env.PGLITE_DATA_DIR = dir;
    env.authMode = "token"; env.apiTokenSeed = "";
    await bootstrap({ seedBoards: false });
    const db = await getDb();
    for (const [name, scopes] of [["agent", ["agent"]], ["mcp", ["mcp"]], ["admin", ["admin"]], ["empty", []], ["revoked", ["admin"]]] as const) {
      await db.insert(apiTokens).values({ id: `token_${name}`, name, scopes: [...scopes], tokenPrefix: token(name).slice(0, 8), tokenHash: await bcrypt.hash(token(name), 4), revokedAt: name === "revoked" ? new Date() : null });
    }
  });
  afterAll(async () => { Object.assign(env, original); await closeDb(); rmSync(dir, { recursive: true, force: true }); });
  it("requires API scope and blocks non-admin token management", async () => {
    const a = createApp();
    for (const [name, status] of [["agent", 200], ["mcp", 403], ["admin", 200], ["empty", 403], ["revoked", 401]] as const) {
      expect((await a.request("/api/v1/settings/profile", { headers: { authorization: `Bearer ${token(name)}` } })).status).toBe(status);
    }
    for (const name of ["agent", "mcp"]) {
      expect((await a.request("/api/v1/settings/tokens", { method: "POST", headers: { authorization: `Bearer ${token(name)}`, "content-type": "application/json" }, body: JSON.stringify({ name: "escalated", scopes: ["admin"] }) })).status).toBe(403);
    }
    expect((await a.request("/api/v1/settings/tokens", { headers: { authorization: `Bearer ${token("admin")}` } })).status).toBe(200);
  });
  it("MCP rejects missing/revoked/unscoped credentials and untrusted origins", async () => {
    const a = createApp();
    for (const name of ["empty", "revoked", ""]) {
      expect((await a.request("/mcp", { method: "POST", headers: { authorization: name ? `Bearer ${token(name)}` : "" } })).status).toBe(401);
    }
    const blocked = await a.request("/mcp", { method: "OPTIONS", headers: { origin: "https://attacker.example" } });
    expect(blocked.status).toBe(403); expect(blocked.headers.get("access-control-allow-origin")).not.toBe("*");
  });
});
