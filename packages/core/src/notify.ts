import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { getDb, id, notificationOutbox, type NotifyOutboxStatus } from "@job-scout/db";
import {
  decideNotify,
  formatNotifyBody,
  notifyDedupeKey,
  type NotifyBodyInput,
} from "@job-scout/shared";
import { coreEnv } from "./env.js";
import { getSettings, updateSettings } from "./settings.js";
import { getWahaSender } from "./waha.js";
import { log as rootLog } from "@job-scout/shared";
import { notifyEnqueued, notifySent } from "./metrics.js";

const log = rootLog.child({ scope: "notify" });

export type EmitNotifyInput = NotifyBodyInput & {
  positionId?: string | null;
  companyId?: string | null;
  subjectId: string;
  revision?: string | number | null;
};

export async function emitNotify(input: EmitNotifyInput): Promise<{ id: string; status: string } | { skipped: string }> {
  try {
    const settings = await getSettings();
    const decision = decideNotify(settings.notifications, input.event, { score: input.score ?? null });
    if (!decision.send) return { skipped: decision.reason };
    const body = formatNotifyBody({
      ...input,
      deskUrl: input.deskUrl ?? (coreEnv.publicBaseUrl || undefined),
    });
    const dedupeKey = notifyDedupeKey(input.event, input.subjectId, input.revision);
    return await enqueueNotify({
      channel: decision.channel,
      event: input.event,
      chatId: decision.chatId,
      body,
      dedupeKey,
      positionId: input.positionId ?? null,
      companyId: input.companyId ?? null,
      scheduledFor: decision.delayUntil,
    });
  } catch (e) {
    log.warn("notify.emit.failed", { event: input.event, err: e });
    return { skipped: e instanceof Error ? e.message : String(e) };
  }
}

export async function enqueueNotify(input: {
  channel: string;
  event: string;
  chatId: string;
  body: string;
  dedupeKey?: string | null;
  positionId?: string | null;
  companyId?: string | null;
  scheduledFor?: Date | null;
}): Promise<{ id: string; status: string }> {
  const db = await getDb();
  const rowId = id("ntf");
  const dedupeKey = input.dedupeKey || null;
  if (dedupeKey) {
    const existing = (
      await db
        .select({ id: notificationOutbox.id, status: notificationOutbox.status })
        .from(notificationOutbox)
        .where(eq(notificationOutbox.dedupeKey, dedupeKey))
        .limit(1)
    )[0];
    if (existing?.id) return { id: existing.id, status: existing.status };
  }
  await db.insert(notificationOutbox).values({
    id: rowId,
    channel: input.channel,
    event: input.event,
    chatId: input.chatId,
    body: input.body,
    status: "pending",
    dedupeKey,
    positionId: input.positionId ?? null,
    companyId: input.companyId ?? null,
    scheduledFor: input.scheduledFor ?? null,
  });
  notifyEnqueued.labels({ channel: input.channel, event: input.event }).inc();
  if (!input.scheduledFor) await flushNotify(rowId);
  return { id: rowId, status: "pending" };
}

export async function flushNotify(rowId: string): Promise<void> {
  const db = await getDb();
  const row = (
    await db
      .update(notificationOutbox)
      .set({ providerRef: `lock:${rowId}` })
      .where(
        and(eq(notificationOutbox.id, rowId), eq(notificationOutbox.status, "pending"), isNull(notificationOutbox.providerRef)),
      )
      .returning()
  )[0];
  if (!row) return;
  if (row.scheduledFor && row.scheduledFor.getTime() > Date.now()) {
    await db.update(notificationOutbox).set({ providerRef: null }).where(eq(notificationOutbox.id, rowId));
    return;
  }
  const settings = await getSettings();
  const sender = getWahaSender();
  const result = await sender.sendText(row.chatId, row.body, settings.notifications.session);
  if (result.ok) {
    await db
      .update(notificationOutbox)
      .set({ status: "sent" as NotifyOutboxStatus, sentAt: new Date(), providerRef: result.providerRef ?? null, error: null })
      .where(eq(notificationOutbox.id, rowId));
    notifySent.labels({ channel: row.channel, event: row.event, outcome: result.noop ? "noop" : "sent" }).inc();
  } else {
    await db
      .update(notificationOutbox)
      .set({ status: "failed" as NotifyOutboxStatus, providerRef: null, error: result.error ?? "send failed" })
      .where(eq(notificationOutbox.id, rowId));
    notifySent.labels({ channel: row.channel, event: row.event, outcome: "failed" }).inc();
    log.warn("notify.send.failed", { id: rowId, err: result.error });
  }
}

export async function flushDueNotifications(limit = 30): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select({ id: notificationOutbox.id })
    .from(notificationOutbox)
    .where(
      and(
        eq(notificationOutbox.status, "pending"),
        or(isNull(notificationOutbox.scheduledFor), lte(notificationOutbox.scheduledFor, new Date()))!,
      ),
    )
    .orderBy(asc(notificationOutbox.createdAt))
    .limit(limit);
  for (const r of rows) await flushNotify(r.id);
  return rows.length;
}

export async function retryFailedNotifications(limit = 20): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select({ id: notificationOutbox.id })
    .from(notificationOutbox)
    .where(eq(notificationOutbox.status, "failed"))
    .orderBy(asc(notificationOutbox.createdAt))
    .limit(limit);
  for (const r of rows) {
    await db
      .update(notificationOutbox)
      .set({ status: "pending", error: null, providerRef: null })
      .where(eq(notificationOutbox.id, r.id));
    await flushNotify(r.id);
  }
  return rows.length;
}

export async function sendTestNotify(channel: string): Promise<{ ok: boolean; error?: string; chatId: string }> {
  const settings = await getSettings();
  const ch = settings.notifications.channels[channel as keyof typeof settings.notifications.channels];
  if (!ch.chatId) return { ok: false, error: "channel has no chatId", chatId: "" };
  const r = await enqueueNotify({
    channel,
    event: "test",
    chatId: ch.chatId,
    body: `job-scout test · ${channel} · ${new Date().toISOString()}`,
  });
  const row = (await getDb().then((db) => db.select().from(notificationOutbox).where(eq(notificationOutbox.id, r.id)).limit(1)))[0];
  if (!row) return { ok: false, error: "outbox row missing", chatId: ch.chatId };
  return { ok: row.status === "sent", error: row.error ?? undefined, chatId: ch.chatId };
}

export async function advanceInboundCursor(ts: number, msgId: string): Promise<void> {
  await updateSettings({
    notifications: { chat: { cursorTs: ts, cursorId: msgId } },
  });
}

export async function enqueueStaleAppliedNags(): Promise<number> {
  const db = await getDb();
  const { positions, companies } = await import("@job-scout/db");
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const rows = await db
    .select({
      id: positions.id,
      slug: positions.slug,
      title: positions.title,
      companyId: positions.companyId,
      company: companies.name,
      url: positions.primaryUrl,
      appliedAt: positions.appliedAt,
    })
    .from(positions)
    .innerJoin(companies, eq(positions.companyId, companies.id))
    .where(and(eq(positions.status, "applied"), sql`${positions.appliedAt} is not null and ${positions.appliedAt} < ${weekAgo}`))
    .limit(25);
  let n = 0;
  for (const r of rows) {
    const day = r.appliedAt ? r.appliedAt.toISOString().slice(0, 10) : "unknown";
    const out = await emitNotify({
      event: "stale_applied",
      title: r.title,
      company: r.company,
      slug: r.slug,
      extra: `applied ${day} · no movement`,
      url: r.url,
      positionId: r.id,
      companyId: r.companyId,
      subjectId: r.id,
      revision: new Date().toISOString().slice(0, 10),
    });
    if (!("skipped" in out)) n++;
  }
  return n;
}

export async function listNotifyOutbox(opts: { status?: string; limit?: number } = {}) {
  const db = await getDb();
  const conds = [];
  if (opts.status && opts.status !== "all") conds.push(eq(notificationOutbox.status, opts.status as NotifyOutboxStatus));
  return db
    .select()
    .from(notificationOutbox)
    .where(conds.length ? and(...conds) : sql`true`)
    .orderBy(sql`${notificationOutbox.createdAt} desc`)
    .limit(Math.min(100, opts.limit ?? 30));
}

