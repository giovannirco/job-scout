import { appVersion } from "@job-scout/core";

function httpOrigin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Browser origins must be HTTP(S) URLs without credentials");
  return url.origin;
}

export function readApiEnv(source: NodeJS.ProcessEnv = process.env) {
  const isProd = source.NODE_ENV === "production";
  const authMode = source.AUTH_MODE || (isProd ? "token" : "dev");
  if (!["dev", "token", "cf_access"].includes(authMode)) throw new Error("Invalid AUTH_MODE");
  if (isProd && authMode === "dev" && source.ALLOW_INSECURE_DEV_AUTH !== "1") {
    throw new Error("Production dev authentication requires explicit ALLOW_INSECURE_DEV_AUTH=1 (local use only)");
  }
  const authPassword = source.AUTH_PASSWORD || "";
  const apiTokenSeed = source.API_TOKEN_SEED || "";
  if (authMode !== "dev") {
    if (authPassword === "job-scout" || apiTokenSeed === "dev-agent-token") throw new Error("Replace example authentication credentials");
    if (authMode === "token" && !authPassword && !apiTokenSeed) throw new Error("Token mode requires AUTH_PASSWORD or API_TOKEN_SEED");
    if ((authPassword && authPassword.length < 16) || (apiTokenSeed && apiTokenSeed.length < 32)) {
      throw new Error("AUTH_PASSWORD must have at least 16 characters and API_TOKEN_SEED at least 32 when configured");
    }
  }
  const publicBaseUrl = source.PUBLIC_BASE_URL || "http://localhost:8080";
  const cfAccessIssuer = source.CF_ACCESS_ISSUER || "";
  const cfAccessAudience = source.CF_ACCESS_AUDIENCE || "";
  if (authMode === "cf_access") {
    const issuer = new URL(cfAccessIssuer);
    if (issuer.protocol !== "https:" || !issuer.hostname.endsWith(".cloudflareaccess.com") || issuer.pathname !== "/" || issuer.search || issuer.hash || issuer.username || issuer.password || issuer.port) {
      throw new Error("CF_ACCESS_ISSUER must be your HTTPS Cloudflare Access team origin");
    }
    if (!cfAccessAudience) throw new Error("CF_ACCESS_AUDIENCE is required");
  }
  return {
    port: Number(source.PORT || 8080),
    host: source.HOST || "127.0.0.1",
    authMode: authMode as "dev" | "token" | "cf_access",
    authPassword,
    apiTokenSeed,
    publicBaseUrl,
    allowedOrigins: [httpOrigin(publicBaseUrl), ...(source.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean).map(httpOrigin)],
    cfAccessIssuer: cfAccessIssuer.replace(/\/$/, ""),
    cfAccessAudience,
    embedWorker: source.EMBED_WORKER === "1",
    isProd,
    version: appVersion,
  };
}

export const env = readApiEnv();
