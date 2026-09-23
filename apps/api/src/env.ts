import { appVersion } from "@job-scout/core";

export const env = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || "0.0.0.0",
  authMode: (process.env.AUTH_MODE || "dev") as "dev" | "token" | "cf_access",
  authPassword: process.env.AUTH_PASSWORD || "job-scout",
  apiTokenSeed: process.env.API_TOKEN_SEED || "dev-agent-token",
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "http://localhost:8080",
  embedWorker: process.env.EMBED_WORKER === "1",
  isProd: process.env.NODE_ENV === "production",
  version: appVersion,
};
