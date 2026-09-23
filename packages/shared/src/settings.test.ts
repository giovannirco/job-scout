import { describe, expect, it } from "vitest";
import { DEFAULT_NOTIFICATIONS } from "./notify.js";
import { DEFAULT_LLM_FALLBACK_MODEL, DEFAULT_SETTINGS, resolveSettings } from "./settings.js";

describe("llm fallback model", () => {
  it("defaults to grok-4.6", () => {
    expect(DEFAULT_LLM_FALLBACK_MODEL).toBe("grok-4.6");
    expect(DEFAULT_SETTINGS.llm.fallbackModel).toBe("grok-4.6");
    expect(resolveSettings({}).llm.fallbackModel).toBe("grok-4.6");
  });

  it("keeps a stored fallback and allows empty to disable", () => {
    expect(resolveSettings({ llm: { fallbackModel: "gpt-5.6-sol" } }).llm.fallbackModel).toBe("gpt-5.6-sol");
    expect(resolveSettings({ llm: { fallbackModel: "" } }).llm.fallbackModel).toBe("");
  });
});

describe("notifications settings", () => {
  it("starts with notifications off and no chat ids", () => {
    const n = resolveSettings({}).notifications;
    expect(n.enabled).toBe(false);
    expect(n.channels.chat.chatId).toBe("");
    expect(n.chat.model).toBe("grok-4.6");
    expect(n.chat.allowFrom).toEqual([]);
  });

  it("keeps a stored chatId override", () => {
    const n = resolveSettings({
      notifications: { channels: { new: { chatId: "999@g.us", enabled: false } } },
    }).notifications;
    expect(n.channels.new.chatId).toBe("999@g.us");
    expect(n.channels.new.enabled).toBe(false);
    expect(n.channels.desk.chatId).toBe(DEFAULT_NOTIFICATIONS.channels.desk.chatId);
  });
});
