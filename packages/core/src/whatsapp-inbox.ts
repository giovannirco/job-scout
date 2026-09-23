import { and, eq, isNull } from "drizzle-orm";
import { chatThreads, getDb, id } from "@job-scout/db";
import { decideInbound, type InboundMsg } from "@job-scout/shared";
import { runChatTurn } from "./chat.js";
import { getSettings, updateSettings } from "./settings.js";
import { getWahaSender, normalizeWahaMessage, type WahaMessage } from "./waha.js";
import { coreEnv } from "./env.js";
import { notifyInbox } from "./metrics.js";
import { log as rootLog } from "@job-scout/shared";

const log = rootLog.child({ scope: "whatsapp-inbox" });
const THREAD_TITLE = "WhatsApp · job-scout chat";
const REPLY_CAP = 3500;
const inflightIds = new Set<string>();

export function inboundFromWahaEvent(raw: unknown, fallbackChatId: string): InboundMsg | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const event = String(o.event || "");
  if (event && event !== "message") return null;
  const payload = (o.payload && typeof o.payload === "object" ? o.payload : o) as Record<string, unknown>;
  const msg = normalizeWahaMessage(payload, fallbackChatId);
  if (!msg) return null;
  const chatId = msg.chatId.includes("@g.us") ? msg.chatId : String(payload.from || fallbackChatId);
  return {
    id: msg.id,
    chatId,
    fromMe: msg.fromMe,
    participant: msg.participant || String(payload.participant || ""),
    timestamp: msg.timestamp,
    body: msg.body,
  };
}

export async function handleWahaWebhookEvent(raw: unknown): Promise<{ accepted: boolean; replied: boolean; reason?: string }> {
  const settings = await getSettings();
  const cfg = settings.notifications;
  const chatId = cfg.channels.chat.chatId;
  const inbound = inboundFromWahaEvent(raw, chatId);
  if (!inbound) return { accepted: false, replied: false, reason: "ignored_event" };
  const decision = decideInbound(cfg, inbound);
  if (!decision.accept) return { accepted: false, replied: false, reason: decision.reason };
  if (inbound.id && inflightIds.has(inbound.id)) return { accepted: false, replied: false, reason: "duplicate" };
  if (inbound.id) inflightIds.add(inbound.id);
  try {
    await updateSettings({ notifications: { chat: { cursorTs: inbound.timestamp, cursorId: inbound.id } } });
    await handleInbound(inbound.body, cfg.chat.model, chatId, cfg.session);
    notifyInbox.labels({ outcome: "ok" }).inc();
    return { accepted: true, replied: true };
  } catch (e) {
    notifyInbox.labels({ outcome: "turn_error" }).inc();
    log.warn("whatsapp.inbox.webhook_failed", { err: e, msgId: inbound.id });
    return { accepted: true, replied: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    if (inbound.id) inflightIds.delete(inbound.id);
  }
}

export function wahaWebhookAuthorized(headerKey: string | undefined): boolean {
  const expected = coreEnv.wahaWebhookKey;
  if (!expected) return false;
  return Boolean(headerKey) && headerKey === expected;
}

export async function pollWhatsAppInbox(): Promise<{ seen: number; accepted: number; replied: number }> {
  const settings = await getSettings();
  const cfg = settings.notifications;
  const chatId = cfg.channels.chat.chatId;
  if (!cfg.enabled || !cfg.channels.chat.enabled || !chatId) return { seen: 0, accepted: 0, replied: 0 };
  const sender = getWahaSender();
  let rows: WahaMessage[] = [];
  try {
    rows = await sender.listMessages(chatId, { limit: 30, session: cfg.session });
  } catch (e) {
    log.warn("whatsapp.inbox.fetch_failed", { err: e });
    notifyInbox.labels({ outcome: "fetch_error" }).inc();
    return { seen: 0, accepted: 0, replied: 0 };
  }
  const ordered = [...rows].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  let accepted = 0;
  let replied = 0;
  let cursorTs = cfg.chat.cursorTs;
  let cursorId = cfg.chat.cursorId;
  for (const msg of ordered) {
    const decision = decideInbound({ ...cfg, chat: { ...cfg.chat, cursorTs, cursorId } }, {
      id: msg.id,
      chatId: msg.chatId || chatId,
      fromMe: msg.fromMe,
      participant: msg.participant || msg.from,
      timestamp: msg.timestamp,
      body: msg.body,
    });
    if (!decision.accept) continue;
    accepted++;
    try {
      await handleInbound(msg.body, cfg.chat.model, chatId, cfg.session);
      replied++;
      notifyInbox.labels({ outcome: "ok" }).inc();
    } catch (e) {
      notifyInbox.labels({ outcome: "turn_error" }).inc();
      log.warn("whatsapp.inbox.turn_failed", { err: e, msgId: msg.id });
    }
    cursorTs = msg.timestamp;
    cursorId = msg.id;
  }
  if (cursorTs !== cfg.chat.cursorTs || cursorId !== cfg.chat.cursorId) {
    await updateSettings({ notifications: { chat: { cursorTs, cursorId } } });
  }
  return { seen: rows.length, accepted, replied };
}

async function handleInbound(text: string, model: string, chatId: string, session: string): Promise<void> {
  const threadId = await ensureWhatsAppThread();
  const chunks: string[] = [];
  await runChatTurn(threadId, text, (e) => {
    if (e.type === "message" && e.message.role === "assistant" && e.message.content && !e.message.toolCalls?.length) {
      chunks.push(e.message.content);
    }
  }, { model });
  const reply = chunks.join("\n\n").trim().slice(0, REPLY_CAP);
  if (!reply) return;
  const sender = getWahaSender();
  const sent = await sender.sendText(chatId, reply, session);
  if (!sent.ok) throw new Error(sent.error || "reply failed");
}

async function ensureWhatsAppThread(): Promise<string> {
  const db = await getDb();
  const existing = (
    await db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(and(eq(chatThreads.scope, "global"), eq(chatThreads.title, THREAD_TITLE), isNull(chatThreads.positionId)))
      .limit(1)
  )[0];
  if (existing?.id) return existing.id;
  const rowId = id("cht");
  await db.insert(chatThreads).values({ id: rowId, scope: "global", title: THREAD_TITLE, messages: [] });
  return rowId;
}
