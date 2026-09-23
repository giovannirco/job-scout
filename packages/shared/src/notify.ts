export const NOTIFY_CHANNELS = ["desk", "new", "process", "research", "chat"] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

export const NOTIFY_EVENTS = [
  "triage_pass",
  "approval_pending",
  "interview_scheduled",
  "stale_applied",
  "status_hot",
  "jd_change_hot",
  "listing_closed_hot",
  "company_research",
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export const PROCESS_NOTIFY_STATUSES = ["applied", "screen", "interview", "offer"] as const;

export function channelForEvent(event: NotifyEvent): Exclude<NotifyChannel, "chat"> {
  if (event === "triage_pass") return "new";
  if (event === "company_research") return "research";
  if (event === "status_hot" || event === "jd_change_hot" || event === "listing_closed_hot") return "process";
  return "desk";
}

export type NotifyChannelCfg = { enabled: boolean; chatId: string };
export type NotifyEventsCfg = Record<NotifyEvent, boolean>;

export type NotificationsConfig = {
  enabled: boolean;
  session: string;
  minTriageScore: number;
  channels: Record<NotifyChannel, NotifyChannelCfg>;
  events: NotifyEventsCfg;
  quietHours: { enabled: boolean; timezone: string; start: string; end: string };
  chat: { model: string; allowFrom: string[]; cursorTs: number; cursorId: string };
};

export const DEFAULT_NOTIFY_CHAT_IDS: Record<NotifyChannel, string> = {
  desk: "",
  new: "",
  process: "",
  research: "",
  chat: "",
};

export const DEFAULT_NOTIFY_ALLOW_FROM: string[] = [];

export const DEFAULT_NOTIFICATIONS: NotificationsConfig = {
  enabled: false,
  session: "default",
  minTriageScore: 3.5,
  channels: {
    desk: { enabled: true, chatId: DEFAULT_NOTIFY_CHAT_IDS.desk },
    new: { enabled: true, chatId: DEFAULT_NOTIFY_CHAT_IDS.new },
    process: { enabled: true, chatId: DEFAULT_NOTIFY_CHAT_IDS.process },
    research: { enabled: true, chatId: DEFAULT_NOTIFY_CHAT_IDS.research },
    chat: { enabled: true, chatId: DEFAULT_NOTIFY_CHAT_IDS.chat },
  },
  events: {
    triage_pass: true,
    approval_pending: true,
    interview_scheduled: true,
    stale_applied: true,
    status_hot: true,
    jd_change_hot: true,
    listing_closed_hot: true,
    company_research: true,
  },
  quietHours: { enabled: true, timezone: "UTC", start: "23:00", end: "08:00" },
  chat: { model: "grok-4.6", allowFrom: [...DEFAULT_NOTIFY_ALLOW_FROM], cursorTs: 0, cursorId: "" },
};

export type NotifyDecision =
  | { send: false; reason: string }
  | { send: true; channel: Exclude<NotifyChannel, "chat">; chatId: string; delayUntil: Date | null };

export function decideNotify(
  cfg: NotificationsConfig,
  event: NotifyEvent,
  opts: { score?: number | null; now?: Date } = {},
): NotifyDecision {
  if (!cfg.enabled) return { send: false, reason: "disabled" };
  if (!cfg.events[event]) return { send: false, reason: "event_off" };
  if (event === "triage_pass" && opts.score != null && opts.score < cfg.minTriageScore) {
    return { send: false, reason: "below_min_score" };
  }
  const channel = channelForEvent(event);
  const ch = cfg.channels[channel];
  if (!ch.enabled) return { send: false, reason: "channel_off" };
  if (!ch.chatId.endsWith("@g.us")) return { send: false, reason: "no_chat_id" };
  const now = opts.now ?? new Date();
  const qh = cfg.quietHours;
  const delayUntil =
    qh.enabled && inQuietHours(now, qh.timezone, qh.start, qh.end) ? nextQuietEnd(now, qh.timezone, qh.end) : null;
  return { send: true, channel, chatId: ch.chatId, delayUntil };
}

export function phoneDigits(raw: string): string {
  const beforeAt = raw.split("@")[0] || raw;
  const beforeDevice = beforeAt.split(":")[0] || beforeAt;
  let d = beforeDevice.replace(/\D/g, "");
  if (d.startsWith("0")) d = d.slice(1);
  return d;
}

export function senderAllowed(participant: string, allowFrom: string[]): boolean {
  const d = phoneDigits(participant);
  if (d.length < 10) return false;
  const tail = d.slice(-11);
  return allowFrom.some((a) => {
    const x = phoneDigits(a);
    if (!x) return false;
    return d === x || tail === x.slice(-11) || x.endsWith(tail) || d.endsWith(x);
  });
}

export type InboundMsg = {
  id: string;
  chatId: string;
  fromMe: boolean;
  participant: string;
  timestamp: number;
  body: string;
};

export function decideInbound(
  cfg: NotificationsConfig,
  msg: InboundMsg,
): { accept: false; reason: string } | { accept: true } {
  if (!cfg.enabled) return { accept: false, reason: "disabled" };
  const chat = cfg.channels.chat;
  if (!chat.enabled) return { accept: false, reason: "channel_off" };
  if (normalizeChatId(msg.chatId) !== normalizeChatId(chat.chatId)) return { accept: false, reason: "wrong_chat" };
  if (msg.fromMe) return { accept: false, reason: "from_me" };
  if (!msg.body.trim()) return { accept: false, reason: "empty" };
  if (!senderAllowed(msg.participant, cfg.chat.allowFrom)) return { accept: false, reason: "not_allowlisted" };
  if (msg.id && cfg.chat.cursorId && msg.id === cfg.chat.cursorId) return { accept: false, reason: "duplicate" };
  if (msg.timestamp < cfg.chat.cursorTs) return { accept: false, reason: "stale" };
  if (msg.timestamp === cfg.chat.cursorTs && msg.id && msg.id <= cfg.chat.cursorId) return { accept: false, reason: "stale" };
  return { accept: true };
}

export function normalizeChatId(id: string): string {
  return id.trim().toLowerCase();
}

export function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}

export function parseHm(hm: string): number {
  const [h, m] = hm.split(":").map((x) => Number(x));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

export function inQuietHours(now: Date, timeZone: string, start: string, end: string): boolean {
  const mins = localMinutes(now, timeZone);
  const a = parseHm(start);
  const b = parseHm(end);
  if (a === b) return false;
  if (a < b) return mins >= a && mins < b;
  return mins >= a || mins < b;
}

export function nextQuietEnd(now: Date, timeZone: string, end: string): Date {
  const mins = localMinutes(now, timeZone);
  const b = parseHm(end);
  let delta = b - mins;
  if (delta <= 0) delta += 24 * 60;
  return new Date(now.getTime() + delta * 60_000);
}

export type NotifyBodyInput = {
  event: NotifyEvent;
  title: string;
  company: string;
  slug?: string | null;
  score?: number | null;
  url?: string | null;
  deskUrl?: string | null;
  extra?: string | null;
};

export function formatNotifyBody(input: NotifyBodyInput): string {
  const label: Record<NotifyEvent, string> = {
    triage_pass: "NEW PASS",
    approval_pending: "INBOX",
    interview_scheduled: "INTERVIEW",
    stale_applied: "STALE APPLY",
    status_hot: "PROCESS",
    jd_change_hot: "JD CHANGE",
    listing_closed_hot: "LISTING CLOSED",
    company_research: "RESEARCH",
  };
  const lines = [`${label[input.event]}  ${input.company} — ${input.title}`];
  if (input.score != null) lines.push(`score ${input.score.toFixed(1)}`);
  if (input.extra) lines.push(input.extra);
  if (input.slug && input.deskUrl) lines.push(`${input.deskUrl.replace(/\/$/, "")}/positions/${input.slug}`);
  else if (input.url) lines.push(input.url);
  return lines.filter(Boolean).join("\n");
}

export function notifyDedupeKey(event: NotifyEvent, subjectId: string, revision?: string | number | null): string {
  return revision != null && revision !== "" ? `${event}:${subjectId}:${revision}` : `${event}:${subjectId}`;
}
