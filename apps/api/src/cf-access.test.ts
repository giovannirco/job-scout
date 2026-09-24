import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyAccessAssertion } from "./cf-access.js";
import { env } from "./env.js";

const original = { ...env };
afterEach(() => { Object.assign(env, original); vi.unstubAllGlobals(); });
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
function token(claims: Record<string, unknown>, key = privateKey, alg = "RS256") {
  const content = [JSON.stringify({ alg, kid: "test-key" }), JSON.stringify(claims)].map((v) => Buffer.from(v).toString("base64url")).join(".");
  return `${content}.${sign("RSA-SHA256", Buffer.from(content), key).toString("base64url")}`;
}

describe("Cloudflare Access assertion validation", () => {
  it("checks signature, issuer, audience, expiry, activation time, and algorithm", async () => {
    env.cfAccessIssuer = "https://test-team.cloudflareaccess.com";
    env.cfAccessAudience = "job-scout-audience";
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" }] })));
    vi.stubGlobal("fetch", fetch);
    const claims = { iss: env.cfAccessIssuer, aud: [env.cfAccessAudience], email: "operator@example.com", exp: Math.floor(Date.now() / 1000) + 300 };
    expect(await verifyAccessAssertion(token(claims))).toBe("operator@example.com");
    for (const patch of [{ iss: "https://attacker.example" }, { aud: ["another-app"] }, { exp: 0 }, { nbf: claims.exp + 1000 }, { email: undefined }]) {
      expect(await verifyAccessAssertion(token({ ...claims, ...patch }))).toBeNull();
    }
    expect(await verifyAccessAssertion(token(claims, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey))).toBeNull();
    expect(await verifyAccessAssertion(token(claims, privateKey, "none"))).toBeNull();
    expect(await verifyAccessAssertion("malformed")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(`${env.cfAccessIssuer}/cdn-cgi/access/certs`, expect.objectContaining({ redirect: "error" }));
  });
  it("fails closed if signing keys cannot be retrieved", async () => {
    env.cfAccessIssuer = "https://offline-team.cloudflareaccess.com"; env.cfAccessAudience = "aud";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await verifyAccessAssertion(token({ iss: env.cfAccessIssuer, aud: "aud", exp: Math.floor(Date.now() / 1000) + 300, email: "operator@example.com" }))).toBeNull();
  });
});
