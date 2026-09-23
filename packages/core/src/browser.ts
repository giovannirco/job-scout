import { coreEnv } from "./env.js";
import { browserRenderDuration, browserRenders } from "./metrics.js";
import { log as rootLog } from "@job-scout/shared";
const log = rootLog.child({ scope: "browser" });

/**
 * Steel Browser client for the *job-scout* instance (not the shared human Chrome).
 *  - `renderUrl`: stateless JS-rendered fetch via POST {STEEL_BASE_URL}/v1/scrape — never /v1/sessions
 *  - `browserStatus`: health for Settings > System and the chat agent
 * The chat agent drives interactive tabs through Playwright MCP on the same dedicated pod (see chat.ts).
 */

const SESSIONS_PATH = /\/v1\/sessions(?:\/|$|\?)/i;

export type RenderedPage = {
  url: string;
  title: string | null;
  html: string | null;
  markdown: string | null;
  statusCode: number | null;
  fetchedAt: string;
};

export type BrowserStatus = {
  configured: boolean;
  baseUrl: string | null;
  healthUrl: string | null;
  ok: boolean;
  error: string | null;
  mcpUrl: string | null;
  /** Dedicated job-scout Steel; never the shared human UI at the shared browser. */
  owner: "job-scout";
};

export function steelScrapeUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (!base) throw new Error("STEEL_BASE_URL is empty");
  if (SESSIONS_PATH.test(base)) {
    throw new Error(`STEEL_BASE_URL must be the Steel REST origin, not a session path: ${base}`);
  }
  const url = `${base}/v1/scrape`;
  if (SESSIONS_PATH.test(url) || !url.endsWith("/v1/scrape")) {
    throw new Error(`steel scrape URL must be POST {base}/v1/scrape, not a session path (got ${url})`);
  }
  return url;
}

export function steelHealthUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/health`;
}

export function browserConfigured(): boolean {
  return Boolean(coreEnv.steelBaseUrl);
}

export async function browserStatus(): Promise<BrowserStatus> {
  const mcpUrl = coreEnv.browserMcpUrl || null;
  if (!coreEnv.steelBaseUrl) {
    return { configured: false, baseUrl: null, healthUrl: null, ok: false, error: "STEEL_BASE_URL not set", mcpUrl, owner: "job-scout" };
  }
  const healthUrl = steelHealthUrl(coreEnv.steelBaseUrl);
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    return { configured: true, baseUrl: coreEnv.steelBaseUrl, healthUrl, ok: res.ok, error: res.ok ? null : `health ${res.status}`, mcpUrl, owner: "job-scout" };
  } catch (e) {
    return { configured: true, baseUrl: coreEnv.steelBaseUrl, healthUrl, ok: false, error: e instanceof Error ? e.message : String(e), mcpUrl, owner: "job-scout" };
  }
}

/** Render a URL in the job-scout Chromium and return html + markdown. Null when the browser plane is not configured. */
export async function renderUrl(url: string, opts: { delayMs?: number; timeoutMs?: number } = {}): Promise<RenderedPage | null> {
  if (!coreEnv.steelBaseUrl) return null;
  const scrapeUrl = steelScrapeUrl(coreEnv.steelBaseUrl);
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(scrapeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, format: ["html", "markdown"], delay: opts.delayMs ?? 4000 }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
  } catch (e) {
    browserRenders.labels({ via: "steel", ok: "false" }).inc();
    browserRenderDuration.observe((Date.now() - t0) / 1000);
    log.warn("browser.render.failed", { url, ms: Date.now() - t0, err: e });
    throw e;
  }
  browserRenderDuration.observe((Date.now() - t0) / 1000);
  if (!res.ok) {
    browserRenders.labels({ via: "steel", ok: "false" }).inc();
    const body = (await res.text()).slice(0, 300);
    log.warn("browser.render.failed", { url, ms: Date.now() - t0, status: res.status, body });
    throw new Error(`steel scrape ${res.status}: ${body}`);
  }
  browserRenders.labels({ via: "steel", ok: "true" }).inc();
  const json = (await res.json()) as {
    content?: { html?: string; markdown?: string };
    metadata?: { title?: string; statusCode?: number };
  };
  log.info("browser.render", { url, ms: Date.now() - t0, status: json.metadata?.statusCode ?? null, htmlChars: json.content?.html?.length ?? 0 });
  return {
    url,
    title: json.metadata?.title ?? null,
    html: json.content?.html ?? null,
    markdown: json.content?.markdown ?? null,
    statusCode: json.metadata?.statusCode ?? null,
    fetchedAt: new Date().toISOString(),
  };
}

/** `HtmlRenderer` for @job-scout/ats: null when the browser plane is off so fetchers keep plain-HTTP behaviour. */
export const steelRenderer = browserConfigured()
  ? async (url: string) => {
      const r = await renderUrl(url);
      return r ? { html: r.html, title: r.title } : null;
    }
  : undefined;

/** Markdown of a page for the chat agent's `web_fetch` tool. Falls back to plain fetch + tag strip. */
export async function fetchPageMarkdown(url: string, maxChars = 20_000): Promise<{ title: string | null; markdown: string; via: "steel" | "http" }> {
  if (coreEnv.steelBaseUrl) {
    try {
      const r = await renderUrl(url, { delayMs: 1500 });
      if (r && (r.markdown || r.html)) {
        const md = r.markdown || stripTags(r.html || "");
        return { title: r.title, markdown: md.slice(0, maxChars), via: "steel" };
      }
    } catch {
      /* fall through to plain fetch */
    }
  }
  const res = await fetch(url, { headers: { accept: "text/html,*/*" }, signal: AbortSignal.timeout(20_000) });
  browserRenders.labels({ via: "http", ok: String(res.ok) }).inc();
  const text = await res.text();
  const title = text.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() ?? null;
  return { title, markdown: stripTags(text).slice(0, maxChars), via: "http" };
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}
