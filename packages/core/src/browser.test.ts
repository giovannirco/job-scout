import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const STEEL_BASE = "http://steel.example:3000";
process.env.STEEL_BASE_URL = STEEL_BASE;
process.env.BROWSER_MCP_URL = "http://playwright.example:8931/mcp";

const { renderUrl, browserStatus, steelScrapeUrl, steelHealthUrl } = await import("./browser.js");

type FetchCall = { url: string; method: string; body: unknown };

function mockFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const call = { url, method, body };
      calls.push(call);
      if (/\/v1\/sessions(?:\/|$|\?)/.test(url)) {
        throw new Error(`must not call Steel session API: ${method} ${url}`);
      }
      return handler(call);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("steelScrapeUrl", () => {
  it("is STEEL_BASE_URL + /v1/scrape", () => {
    expect(steelScrapeUrl(STEEL_BASE)).toBe(`${STEEL_BASE}/v1/scrape`);
    expect(steelScrapeUrl(`${STEEL_BASE}/`)).toBe(`${STEEL_BASE}/v1/scrape`);
  });

  it("rejects a session-create path as the scrape target", () => {
    expect(() => steelScrapeUrl(`${STEEL_BASE}/v1/sessions`)).toThrow(/session/i);
    expect(() => steelScrapeUrl(`${STEEL_BASE}/v1/sessions/`)).toThrow(/session/i);
    expect(() => steelScrapeUrl("http://steel.browser.svc.cluster.local:3000/v1/sessions")).toThrow(/session/i);
  });

  it("never returns a URL whose path is /v1/sessions", () => {
    const url = steelScrapeUrl(STEEL_BASE);
    expect(url.endsWith("/v1/scrape")).toBe(true);
    expect(url).not.toMatch(/\/v1\/sessions(?:\/|$|\?)/);
  });
});

describe("renderUrl", () => {
  it("POSTs only to STEEL_BASE_URL/v1/scrape and never to /v1/sessions", async () => {
    const calls = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            content: { html: "<p>hi</p>", markdown: "hi" },
            metadata: { title: "T", statusCode: 200 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const page = await renderUrl("https://jobs.example.com/role");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${STEEL_BASE}/v1/scrape`);
    expect(calls[0]?.url).not.toContain("/v1/sessions");
    expect(calls[0]?.body).toMatchObject({ url: "https://jobs.example.com/role", format: ["html", "markdown"] });
    expect(page?.title).toBe("T");
    expect(page?.html).toBe("<p>hi</p>");
  });
});

describe("browserStatus", () => {
  it("GETs the job-scout Steel /v1/health URL, not the human UI", async () => {
    const calls = mockFetch(() => new Response("{}", { status: 200 }));
    const status = await browserStatus();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(`${STEEL_BASE}/v1/health`);
    expect(calls[0]?.url).toBe(steelHealthUrl(STEEL_BASE));
    expect(status.ok).toBe(true);
    expect(status.healthUrl).toBe(`${STEEL_BASE}/v1/health`);
    expect(status.owner).toBe("job-scout");
    expect(status.baseUrl).not.toContain("the shared browser");
  });
});

describe("helm isolation", () => {
  it("points job-scout at steel-job-scout, not the shared Steel", () => {
    const values = fs.readFileSync(path.resolve("deploy/helm/job-scout/values.yaml"), "utf8");
    const steelLine = values.match(/^  STEEL_BASE_URL:.*$/m)?.[0] ?? "";
    const mcpLine = values.match(/^  BROWSER_MCP_URL:.*$/m)?.[0] ?? "";
    expect(steelLine).toBe("  STEEL_BASE_URL: \"\"");
    expect(mcpLine).toBe("  BROWSER_MCP_URL: \"\"");
    expect(steelLine).not.toMatch(/steel\.browser\.svc/);
    expect(steelLine).not.toMatch(/\/v1\/sessions/);
    expect(mcpLine).not.toMatch(/playwright-mcp\.browser\.svc/);
  });
});
