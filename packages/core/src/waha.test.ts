import { describe, expect, it } from "vitest";
import { NoopWahaSender, WahaHttpSender, normalizeWahaMessage } from "./waha.js";

describe("normalizeWahaMessage", () => {
  it("reads a GOWS group payload", () => {
    const m = normalizeWahaMessage(
      {
        id: "false_120@g.us_AAA",
        timestamp: 1789991111,
        from: "111111000000000005@g.us",
        fromMe: false,
        participant: "15555550100@c.us",
        body: "intake https://jobs.ashbyhq.com/x",
      },
      "111111000000000005@g.us",
    );
    expect(m?.fromMe).toBe(false);
    expect(m?.participant).toContain("15555550100");
    expect(m?.body).toContain("intake");
  });

  it("drops empty objects", () => {
    expect(normalizeWahaMessage({}, "x@g.us")).toBeNull();
  });

  it("pulls text and sender from GOWS _data when top-level body is missing", () => {
    const m = normalizeWahaMessage(
      {
        fromMe: false,
        from: "111111000000000005@g.us",
        _data: {
          Info: {
            Chat: "111111000000000005@g.us",
            Sender: "15555550100:56@s.whatsapp.net",
            IsFromMe: false,
            ID: "3EB0ABC",
            Timestamp: "2026-09-21T13:54:27Z",
          },
          Message: { extendedTextMessage: { text: "intake https://example.com/job" } },
        },
      },
      "111111000000000005@g.us",
    );
    expect(m?.body).toBe("intake https://example.com/job");
    expect(m?.participant).toContain("15555550100");
    expect(m?.fromMe).toBe(false);
  });
});

describe("WahaHttpSender", () => {
  it("POSTs sendText with session and chatId", async () => {
    const calls: { url: string; body: string }[] = [];
    const s = new WahaHttpSender("http://waha.example:3000", "key", "default", async (url, init) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ id: "wamid.9" }), { status: 200 });
    });
    const r = await s.sendText("120@g.us", "hello");
    expect(r.ok).toBe(true);
    expect(r.providerRef).toBe("wamid.9");
    expect(calls[0]?.url).toContain("/api/sendText");
    expect(JSON.parse(calls[0]!.body)).toEqual({ session: "default", chatId: "120@g.us", text: "hello" });
  });
});

describe("NoopWahaSender", () => {
  it("records sends without calling a network", async () => {
    const s = new NoopWahaSender();
    const r = await s.sendText("120@g.us", "x");
    expect(r.noop).toBe(true);
    expect(s.last[0]).toEqual({ chatId: "120@g.us", body: "x" });
  });
});
