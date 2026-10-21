import { afterEach, describe, expect, it, vi } from "vitest";
import { AtsFetchError, classifyFetchError } from "./fetch-error.js";
import { fetchJobFromUrl } from "./fetch.js";

afterEach(() => vi.unstubAllGlobals());

const undiciFailure = (code: string, message = "getaddrinfo failed") =>
  Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(message), { code }) });

describe("classifyFetchError", () => {
  it("reads the undici cause instead of a bare 'fetch failed'", () => {
    const e = classifyFetchError(undiciFailure("ENOTFOUND"), { url: "https://careers.acme-example.com/jobs/1" });
    expect(e).toBeInstanceOf(AtsFetchError);
    expect(e.toJSON()).toMatchObject({ reason: "network", causeCode: "ENOTFOUND", url: "https://careers.acme-example.com/jobs/1" });
    expect(e.message).toMatch(/fetch failed: getaddrinfo failed/);
  });

  it("maps aborts and connect timeouts to timeout", () => {
    expect(classifyFetchError(Object.assign(new Error("aborted"), { name: "AbortError" })).reason).toBe("timeout");
    expect(classifyFetchError(undiciFailure("UND_ERR_CONNECT_TIMEOUT", "connect timeout")).reason).toBe("timeout");
  });

  it("maps the SSRF guard to blocked and JSON errors to parse_failed", () => {
    expect(classifyFetchError(Object.assign(new TypeError("fetch failed"), { cause: new Error("ATS hostname resolves to a non-public address") })).reason).toBe("blocked");
    expect(classifyFetchError(new SyntaxError("Unexpected token < in JSON")).reason).toBe("parse_failed");
  });
});

describe("fetchJobFromUrl failure reasons", () => {
  it("HTTP 403 is a blocked fetch carrying its status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 403 })));
    const err = await fetchJobFromUrl("https://careers.acme-example.com/jobs/platform-engineer").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AtsFetchError);
    expect((err as AtsFetchError).toJSON()).toMatchObject({ reason: "blocked", httpStatus: 403 });
  });

  it("HTTP 500 on an ATS API is http_status with the code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("oops", { status: 500 })));
    const err = await fetchJobFromUrl("https://jobs.lever.co/acme-example/0d6c2b8e-1111-4222-8333-944455556666").catch((e: unknown) => e);
    expect((err as AtsFetchError).toJSON()).toMatchObject({ reason: "http_status", httpStatus: 500, provider: "lever" });
  });

  it("a network error keeps the undici cause code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw undiciFailure("ECONNRESET", "socket hang up"); }));
    const err = await fetchJobFromUrl("https://careers.acme-example.com/jobs/platform-engineer").catch((e: unknown) => e);
    expect((err as AtsFetchError).toJSON()).toMatchObject({ reason: "network", causeCode: "ECONNRESET" });
  });

  it("a 200 page with no title or body says parse_failed instead of returning silence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html><head><title>Careers</title></head><body><div id=app></div></body></html>", { status: 200 })));
    const job = await fetchJobFromUrl("https://careers.acme-example.com/jobs/platform-engineer");
    expect((job.rawPayload as { fetchFailure?: unknown }).fetchFailure).toMatchObject({ reason: "parse_failed", httpStatus: 200 });
  });
});
