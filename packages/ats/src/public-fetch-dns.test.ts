import { describe, expect, it, vi } from "vitest";
const dns = vi.hoisted(() => ({ records: [{ address: "127.0.0.1", family: 4 }] }));
vi.mock("node:dns", () => ({ lookup: (_host: string, _options: unknown, callback: (error: null, records: typeof dns.records) => void) => callback(null, dns.records) }));
import { publicFetch } from "./public-fetch.js";

describe("socket DNS validation", () => {
  it("blocks a public hostname whose actual connection resolves to loopback", async () => {
    await expect(publicFetch("http://rebinding.example/", { signal: AbortSignal.timeout(2000) })).rejects.toMatchObject({ cause: { message: "ATS hostname resolves to a non-public address" } });
  });
  it("rejects mixed public/private DNS records instead of selecting a private fallback", async () => {
    dns.records = [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }];
    await expect(publicFetch("http://mixed-answer.example/", { signal: AbortSignal.timeout(2000) })).rejects.toMatchObject({ cause: { message: "ATS hostname resolves to a non-public address" } });
  });
});
