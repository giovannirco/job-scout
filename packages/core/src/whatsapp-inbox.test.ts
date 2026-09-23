import { describe, expect, it } from "vitest";
import { DEFAULT_NOTIFICATIONS, decideInbound } from "@job-scout/shared";
import { inboundFromWahaEvent } from "./whatsapp-inbox.js";

const chatId = "111111000000000005@g.us";
const inboundCfg = structuredClone(DEFAULT_NOTIFICATIONS);
inboundCfg.enabled = true;
inboundCfg.channels.chat.chatId = chatId;
inboundCfg.channels.chat.enabled = true;
inboundCfg.chat.allowFrom = ["15555550100"];

describe("inboundFromWahaEvent", () => {
  it("reads a group message payload from an allowlisted participant", () => {
    const inbound = inboundFromWahaEvent(
      {
        event: "message",
        session: "default",
        payload: {
          id: "false_111111000000000005@g.us_AAA",
          timestamp: 1789998186,
          from: chatId,
          fromMe: false,
          participant: "15555550100@c.us",
          body: "List process roles",
        },
      },
      chatId,
    );
    expect(inbound?.fromMe).toBe(false);
    expect(inbound?.chatId).toBe(chatId);
    expect(inbound?.body).toBe("List process roles");
    expect(decideInbound(inboundCfg, inbound!).accept).toBe(true);
  });

  it("drops message.any so the same GOWS delivery is not handled twice", () => {
    const inbound = inboundFromWahaEvent(
      {
        event: "message.any",
        session: "default",
        payload: {
          id: "false_111111000000000005@g.us_AAA",
          timestamp: 1789998186,
          from: chatId,
          fromMe: false,
          participant: "15555550100@c.us",
          body: "List process roles",
        },
      },
      chatId,
    );
    expect(inbound).toBeNull();
  });

  it("reads GOWS _data.extendedTextMessage when body is omitted", () => {
    const inbound = inboundFromWahaEvent(
      {
        event: "message",
        payload: {
          fromMe: false,
          from: chatId,
          _data: {
            Info: {
              Chat: chatId,
              Sender: "15555550100:56@s.whatsapp.net",
              IsFromMe: false,
              ID: "3EB078C7E875BBE086ADA9",
              Timestamp: "2026-09-21T13:54:27Z",
            },
            Message: { extendedTextMessage: { text: "WEBHOOK-PROBE-1: list live process" } },
          },
        },
      },
      chatId,
    );
    expect(inbound?.body).toContain("WEBHOOK-PROBE-1");
    expect(inbound?.fromMe).toBe(false);
    expect(decideInbound(inboundCfg, inbound!).accept).toBe(true);
  });

  it("drops fromMe bot pings and other events", () => {
    const ping = inboundFromWahaEvent(
      {
        event: "message",
        payload: { id: "true_x", timestamp: 1, from: chatId, fromMe: true, participant: "15555550999@c.us", body: "live" },
      },
      chatId,
    );
    expect(ping && decideInbound(inboundCfg, ping).accept).toBe(false);
    expect(inboundFromWahaEvent({ event: "session.status", payload: {} }, chatId)).toBeNull();
  });
});
