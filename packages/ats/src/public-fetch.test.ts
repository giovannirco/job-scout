import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPublicUrl, isPublicAddress, publicFetch } from "./public-fetch.js";

afterEach(() => vi.unstubAllGlobals());

describe("public network fetch boundary", () => {
  it.each(["http://127.0.0.1/", "http://2130706433/", "http://0x7f000001/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://localhost./", "http://db.svc.cluster.local/", "file:///etc/passwd", "https://user:pass@example.com/", "https://example.com:8080/"])("blocks %s before network access", (url) => {
    expect(() => assertPublicUrl(url)).toThrow();
  });
  it("rejects non-global addresses including translation and transition IPv6 ranges", () => {
    for (const address of ["192.168.1.1", "100.64.1.1", "fc00::1", "fe80::1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1"]) expect(isPublicAddress(address)).toBe(false);
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });
  it("blocks a public redirect into cloud metadata before the second fetch", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(publicFetch("https://jobs.example.com/role")).rejects.toThrow(/public/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: "manual", dispatcher: expect.anything() });
  });
  it("allows public relative redirects and caps redirect loops", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/next" } })).mockResolvedValueOnce(new Response("job"));
    vi.stubGlobal("fetch", fetch);
    expect(await (await publicFetch("https://jobs.example.com/role")).text()).toBe("job");
    expect(fetch.mock.calls[1][0]).toBe("https://jobs.example.com/next");
    fetch.mockImplementation(async () => new Response(null, { status: 302, headers: { location: "/loop" } }));
    await expect(publicFetch("https://jobs.example.com/role")).rejects.toThrow(/Too many/);
  });
});

describe("manual redirect Fetch semantics", () => {
  it.each([301, 302, 303])("turns a POST %s redirect into a GET without replaying its body", async (status) => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status, headers: { location: "/result" } })).mockResolvedValueOnce(new Response("result"));
    vi.stubGlobal("fetch", fetch);
    await publicFetch("https://jobs.ashbyhq.com/api/non-user-graphql", { method: "POST", headers: { "content-type": "application/json", "content-length": "2" }, body: "{}" });
    expect(fetch.mock.calls[1][1].method).toBe("GET");
    expect(fetch.mock.calls[1][1].body).toBeUndefined();
    const headers = new Headers(fetch.mock.calls[1][1].headers);
    expect(headers.has("content-type")).toBe(false); expect(headers.has("content-length")).toBe(false);
  });
  it("preserves 307 request bodies but removes credentials when the origin changes", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "https://other.example/endpoint" } })).mockResolvedValueOnce(new Response("result"));
    vi.stubGlobal("fetch", fetch);
    await publicFetch("https://jobs.example/endpoint", { method: "POST", headers: { authorization: "Bearer test-only", cookie: "session=test-only", host: "jobs.example", "content-type": "application/json" }, body: "{}" });
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: "POST", body: "{}" });
    const headers = new Headers(fetch.mock.calls[1][1].headers);
    expect(headers.has("authorization")).toBe(false); expect(headers.has("cookie")).toBe(false); expect(headers.has("host")).toBe(false);
    expect(headers.get("content-type")).toBe("application/json");
  });
});
