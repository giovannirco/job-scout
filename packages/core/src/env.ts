import { readFileSync } from "node:fs";

function readRootVersion(): string {
  try {
    return String(JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version);
  } catch {
    return "0.0.0";
  }
}

/** Version of the running build: APP_VERSION env, else the workspace root package.json. */
export const appVersion: string = process.env.APP_VERSION || readRootVersion();

export const coreEnv = {
  openaiBaseUrl: (process.env.OPENAI_BASE_URL || "http://127.0.0.1:8317/v1").replace(/\/+$/, ""),
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS || 180_000),
  /** Job-scout Steel REST base (in-cluster: http://steel.example:3000). Empty = off. Not the shared human browser. */
  steelBaseUrl: (process.env.STEEL_BASE_URL || "").replace(/\/+$/, ""),
  /** Playwright MCP sidecar on the job-scout Steel pod (in-cluster: http://playwright.example:8931/mcp) */
  browserMcpUrl: process.env.BROWSER_MCP_URL || "",
  isProd: process.env.NODE_ENV === "production",
};
