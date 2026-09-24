import { createPublicKey, verify } from "node:crypto";
import { env } from "./env.js";

type SigningKey = import("node:crypto").webcrypto.JsonWebKey & { kid?: string; alg?: string; use?: string };
let cache: { issuer: string; until: number; keys: SigningKey[] } | undefined;

/** Validate the assertion itself; the email header is never an authentication credential. */
export async function verifyAccessAssertion(assertion: string | undefined): Promise<string | null> {
  if (!assertion || assertion.length > 16_384 || !env.cfAccessIssuer || !env.cfAccessAudience) return null;
  try {
    const parts = assertion.split(".");
    if (parts.length !== 3) return null;
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== env.cfAccessIssuer || typeof claims.exp !== "number" || claims.exp <= now ||
      (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now)) ||
      !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(env.cfAccessAudience) ||
      typeof claims.email !== "string" || !claims.email) return null;
    if (!cache || cache.issuer !== env.cfAccessIssuer || cache.until <= Date.now()) {
      const response = await fetch(`${env.cfAccessIssuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000), redirect: "error" });
      if (!response.ok) return null;
      const body = await response.json() as { keys?: SigningKey[] };
      if (!Array.isArray(body.keys)) return null;
      cache = { issuer: env.cfAccessIssuer, until: Date.now() + 300_000, keys: body.keys };
    }
    const key = cache.keys.find((k) => k.kid === header.kid && k.kty === "RSA" && (!k.alg || k.alg === "RS256") && (!k.use || k.use === "sig"));
    if (!key) return null;
    return verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2], "base64url")) ? claims.email : null;
  } catch {
    return null;
  }
}
