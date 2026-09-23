import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATIONS,
  channelForEvent,
  decideInbound,
  decideNotify,
  formatNotifyBody,
  inQuietHours,
  nextQuietEnd,
  notifyDedupeKey,
  senderAllowed,
} from "./notify.js";

const cfg = structuredClone(DEFAULT_NOTIFICATIONS);
cfg.enabled = true;
cfg.channels.desk.chatId = "111111000000000001@g.us";
cfg.channels.new.chatId = "111111000000000002@g.us";
cfg.channels.process.chatId = "111111000000000003@g.us";
cfg.channels.research.chatId = "111111000000000004@g.us";
cfg.channels.chat.chatId = "111111000000000005@g.us";
cfg.chat.allowFrom = ["15555550100", "15555550101", "15555550102", "15555501901613", "155555115052123", "15555594827139"];

describe("channelForEvent", () => {
  it("maps product events onto the four alert rooms", () => {
    expect(channelForEvent("triage_pass")).toBe("new");
    expect(channelForEvent("approval_pending")).toBe("desk");
    expect(channelForEvent("interview_scheduled")).toBe("desk");
    expect(channelForEvent("stale_applied")).toBe("desk");
    expect(channelForEvent("status_hot")).toBe("process");
    expect(channelForEvent("jd_change_hot")).toBe("process");
    expect(channelForEvent("listing_closed_hot")).toBe("process");
    expect(channelForEvent("company_research")).toBe("research");
  });
});

describe("decideNotify", () => {
  it("sends triage PASS to new when score clears the floor", () => {
    const d = decideNotify(cfg, "triage_pass", { score: 4.2, now: new Date("2026-09-21T15:00:00.000Z") });
    expect(d).toMatchObject({ send: true, channel: "new", chatId: cfg.channels.new.chatId });
  });

  it("drops triage PASS below minTriageScore", () => {
    expect(decideNotify(cfg, "triage_pass", { score: 3.2 }).send).toBe(false);
  });

  it("drops when master or event or channel is off", () => {
    expect(decideNotify({ ...cfg, enabled: false }, "company_research").send).toBe(false);
    expect(decideNotify({ ...cfg, events: { ...cfg.events, company_research: false } }, "company_research").send).toBe(false);
    const off = { ...cfg, channels: { ...cfg.channels, research: { ...cfg.channels.research, enabled: false } } };
    expect(decideNotify(off, "company_research").send).toBe(false);
  });

  it("delays alert sends during Sao Paulo quiet hours", () => {
    const evening = new Date("2026-09-22T02:30:00.000Z");
    const d = decideNotify(cfg, "approval_pending", { now: evening });
    expect(d.send).toBe(true);
    if (d.send) expect(d.delayUntil).toBeInstanceOf(Date);
  });
});

describe("quiet hours", () => {
  it("treats 23:00–08:00 America/Sao_Paulo as overnight", () => {
    expect(inQuietHours(new Date("2026-09-22T02:10:00.000Z"), "America/Sao_Paulo", "23:00", "08:00")).toBe(true);
    expect(inQuietHours(new Date("2026-09-21T15:00:00.000Z"), "America/Sao_Paulo", "23:00", "08:00")).toBe(false);
  });

  it("schedules the next local 08:00", () => {
    const end = nextQuietEnd(new Date("2026-09-22T02:10:00.000Z"), "America/Sao_Paulo", "08:00");
    expect(end.getTime()).toBeGreaterThan(Date.parse("2026-09-22T02:10:00.000Z"));
  });
});

describe("inbound allowlist", () => {
  const base = {
    id: "wamid.1",
    chatId: cfg.channels.chat.chatId,
    fromMe: false,
    participant: "15555550100@c.us",
    timestamp: 1_800_000_000,
    body: "what is moving?",
  };

  it("accepts an allowlisted sender", () => {
    expect(decideInbound(cfg, base)).toEqual({ accept: true });
  });

  it("accepts a second allowlisted sender", () => {
    expect(decideInbound(cfg, { ...base, participant: "15555550101" }).accept).toBe(true);
  });

  it("rejects fromMe, other groups, empty body, strangers", () => {
    expect(decideInbound(cfg, { ...base, fromMe: true }).accept).toBe(false);
    expect(decideInbound(cfg, { ...base, chatId: cfg.channels.desk.chatId }).accept).toBe(false);
    expect(decideInbound(cfg, { ...base, body: "  " }).accept).toBe(false);
    expect(decideInbound(cfg, { ...base, participant: "15555550999@c.us" }).accept).toBe(false);
  });

  it("matches 11-digit tails", () => {
    expect(senderAllowed("15555550100@s.whatsapp.net", cfg.chat.allowFrom)).toBe(true);
    expect(senderAllowed("15555550100:56@s.whatsapp.net", cfg.chat.allowFrom)).toBe(true);
    expect(senderAllowed("5555550100", cfg.chat.allowFrom)).toBe(true);
  });

  it("matches LID participants on the allowlist", () => {
    expect(senderAllowed("15555501901613@lid", cfg.chat.allowFrom)).toBe(true);
    expect(senderAllowed("155555115052123@lid", cfg.chat.allowFrom)).toBe(true);
    expect(senderAllowed("15555594827139@lid", cfg.chat.allowFrom)).toBe(true);
  });

  it("rejects a already-seen message id even when the timestamp is later", () => {
    const seen = { ...cfg, chat: { ...cfg.chat, cursorTs: base.timestamp, cursorId: base.id } };
    expect(decideInbound(seen, { ...base, timestamp: base.timestamp + 5 }).accept).toBe(false);
  });
});

describe("formatNotifyBody", () => {
  it("is short and includes a desk link", () => {
    const body = formatNotifyBody({
      event: "triage_pass",
      title: "Senior SRE",
      company: "Kraken",
      slug: "kraken-sre",
      score: 4.6,
      deskUrl: "http://localhost:8080",
    });
    expect(body).toContain("NEW PASS");
    expect(body).toContain("Kraken");
    expect(body).toContain("4.6");
    expect(body).toContain("/positions/kraken-sre");
  });
});

describe("notifyDedupeKey", () => {
  it("includes revision when present", () => {
    expect(notifyDedupeKey("jd_change_hot", "pos_1", 3)).toBe("jd_change_hot:pos_1:3");
    expect(notifyDedupeKey("triage_pass", "pos_1")).toBe("triage_pass:pos_1");
  });
});
