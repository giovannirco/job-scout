import { coreEnv } from "./env.js";
import { log as rootLog } from "@job-scout/shared";

const log = rootLog.child({ scope: "waha" });
const TIMEOUT = 12_000;

export type WahaSendResult = { ok: boolean; providerRef?: string; error?: string; noop?: boolean };

export type WahaMessage = {
  id: string;
  timestamp: number;
  fromMe: boolean;
  from: string;
  to?: string;
  participant: string;
  body: string;
  chatId: string;
};

export type WahaSender = {
  configured: boolean;
  session: string;
  sendText: (chatId: string, body: string, session?: string) => Promise<WahaSendResult>;
  listMessages: (chatId: string, opts?: { limit?: number; session?: string }) => Promise<WahaMessage[]>;
};

export class NoopWahaSender implements WahaSender {
  configured = false;
  session = "default";
  last: { chatId: string; body: string }[] = [];
  async sendText(chatId: string, body: string): Promise<WahaSendResult> {
    this.last.push({ chatId, body });
    return { ok: true, noop: true, providerRef: `noop-${Date.now()}` };
  }
  async listMessages(): Promise<WahaMessage[]> {
    return [];
  }
}

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class WahaHttpSender implements WahaSender {
  configured = true;
  constructor(
    private baseUrl: string,
    private apiKey: string,
    public session = "default",
    private fetchFn: FetchFn = fetch,
  ) {}

  async sendText(chatId: string, body: string, session = this.session): Promise<WahaSendResult> {
    const base = this.baseUrl.replace(/\/$/, "");
    try {
      const res = await this.fetchFn(`${base}/api/sendText`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": this.apiKey },
        body: JSON.stringify({ session, chatId, text: body }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, error: `WAHA ${res.status}: ${text.slice(0, 200)}` };
      }
      const data = (await res.json().catch(() => ({}))) as { id?: string; key?: { id?: string } };
      return { ok: true, providerRef: data.id || data.key?.id || `waha-${Date.now()}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async listMessages(chatId: string, opts: { limit?: number; session?: string } = {}): Promise<WahaMessage[]> {
    const base = this.baseUrl.replace(/\/$/, "");
    const session = opts.session || this.session;
    const limit = Math.min(50, opts.limit ?? 20);
    const url = `${base}/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}&downloadMedia=false`;
    const res = await this.fetchFn(url, {
      headers: { "X-Api-Key": this.apiKey },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`WAHA ${res.status}: ${text.slice(0, 200)}`);
    }
    const raw = (await res.json()) as unknown;
    const rows = Array.isArray(raw) ? raw : (raw as { messages?: unknown[] }).messages ?? [];
    return rows.map((r) => normalizeWahaMessage(r, chatId)).filter((m): m is WahaMessage => Boolean(m));
  }
}

function gowsText(data: Record<string, unknown>): string {
  const msg = (data.Message && typeof data.Message === "object" ? data.Message : data.RawMessage) as Record<string, unknown> | undefined;
  if (!msg) return "";
  if (typeof msg.conversation === "string") return msg.conversation;
  const ext = msg.extendedTextMessage as { text?: string } | undefined;
  if (ext && typeof ext.text === "string") return ext.text;
  return "";
}

function gowsSender(data: Record<string, unknown>): string {
  const info = (data.Info && typeof data.Info === "object" ? data.Info : {}) as Record<string, unknown>;
  return String(info.Sender || info.Chat || "");
}

export function normalizeWahaMessage(raw: unknown, fallbackChatId: string): WahaMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const data = (o._data && typeof o._data === "object" ? o._data : {}) as Record<string, unknown>;
  const info = (data.Info && typeof data.Info === "object" ? data.Info : {}) as Record<string, unknown>;
  const fromMe = Boolean(o.fromMe ?? info.IsFromMe ?? (data.id as { fromMe?: boolean } | undefined)?.fromMe);
  const nestedId = (data.id as { id?: string } | undefined)?.id;
  const keyId = o.key && typeof o.key === "object" ? (o.key as { id?: string }).id : undefined;
  const id = String(o.id || nestedId || keyId || info.ID || "");
  const tsRaw = o.timestamp ?? o.ts ?? data.t ?? info.Timestamp ?? 0;
  let timestamp = 0;
  if (typeof tsRaw === "string" && tsRaw.includes("T")) timestamp = Math.floor(Date.parse(tsRaw) / 1000) || 0;
  else timestamp = Number(tsRaw) > 1e12 ? Math.floor(Number(tsRaw) / 1000) : Number(tsRaw) || 0;
  const from = String(o.from || o.chatId || info.Chat || "");
  const participant = String(o.participant || o.author || gowsSender(data) || (fromMe ? "" : from) || "");
  const body = String(o.body || o.text || (o.message as { conversation?: string } | undefined)?.conversation || gowsText(data) || "").trim();
  const chatId = String(o.chatId || (from.includes("@g.us") ? from : "") || info.Chat || fallbackChatId);
  if (!id && !body) return null;
  return { id: id || `${timestamp}:${participant}:${body.slice(0, 24)}`, timestamp, fromMe, from, participant, body, chatId };
}

let singleton: WahaSender | null = null;

export function getWahaSender(): WahaSender {
  if (singleton) return singleton;
  if (coreEnv.wahaBaseUrl && coreEnv.wahaApiKey) {
    singleton = new WahaHttpSender(coreEnv.wahaBaseUrl, coreEnv.wahaApiKey, coreEnv.wahaSession);
  } else {
    singleton = new NoopWahaSender();
    log.info("waha.noop", { reason: "WAHA_BASE_URL or WAHA_API_KEY unset" });
  }
  return singleton;
}

export function setWahaSender(s: WahaSender): void {
  singleton = s;
}

export function resetWahaSender(): void {
  singleton = null;
}

export function wahaConfigured(): boolean {
  return Boolean(coreEnv.wahaBaseUrl && coreEnv.wahaApiKey);
}
