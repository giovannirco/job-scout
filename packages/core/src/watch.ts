import { and, asc, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { getDb, id, positions, watches } from "@job-scout/db";
import { detectAts, fetchGreenhouseJob } from "@job-scout/ats";
import { fetchJob as fetchJobFromUrl } from "./fetch-job.js";
import { contentHash, HOT_STATUSES } from "@job-scout/shared";
import { enqueueJob } from "./jobs.js";
import { applySnapshot } from "./positions.js";
import { addEvent } from "./timeline.js";

/**
 * Watches are the positions themselves (watch_enabled) plus the legacy
 * free-form `watches` table for URLs without a position.
 */
export async function checkWatch(watchId: string) {
  const db = await getDb();
  const w = (await db.select().from(watches).where(eq(watches.id, watchId)).limit(1))[0];
  if (!w) throw new Error("watch not found");
  const job = await fetchJobFromUrl(w.url);
  const now = new Date();
  if (w.positionId) {
    const r = await applySnapshot({ positionId: w.positionId, job, source: "watch" });
    await db
      .update(watches)
      .set({ lastCheckedAt: now, lastChangedAt: r.changed ? now : w.lastChangedAt, listingStatus: job.listingStatus === "closed" ? "closed" : "open", updatedAt: now })
      .where(eq(watches.id, w.id));
    return { changed: r.changed, positionId: w.positionId };
  }
  const hash = contentHash({ title: job.title, descriptionText: job.descriptionText, salaryRaw: job.salaryRaw, locationRaw: job.locationRaw });
  const changed = Boolean(w.contentHash) && w.contentHash !== hash;
  await db
    .update(watches)
    .set({
      contentHash: hash,
      lastCheckedAt: now,
      lastChangedAt: changed ? now : w.lastChangedAt,
      listingStatus: job.listingStatus === "closed" ? "closed" : "open",
      label: w.label || job.title,
      updatedAt: now,
    })
    .where(eq(watches.id, w.id));
  return { changed, positionId: null };
}

/** Refresh the JD of a watched or hot position. */
export async function checkPosition(positionId: string) {
  return applySnapshot({ positionId, job: await fetchPositionJob(positionId), source: "watch" });
}

async function fetchPositionJob(positionId: string) {
  const db = await getDb();
  const p = (
    await db
      .select({ url: positions.primaryUrl, atsBoardToken: positions.atsBoardToken })
      .from(positions)
      .where(eq(positions.id, positionId))
      .limit(1)
  )[0];
  if (!p?.url) throw new Error("position has no URL");
  const detected = detectAts(p.url);
  if (detected.provider === "greenhouse" && detected.jobId && !detected.boardToken && p.atsBoardToken) {
    const direct = await fetchGreenhouseJob(p.atsBoardToken, detected.jobId);
    if (direct.descriptionText?.trim()) return { ...direct, url: p.url };
  }
  return fetchJobFromUrl(p.url);
}

/** Enqueue watch_check for positions due (hot or watchEnabled, open, not checked in N hours). */
export async function enqueueDueWatchChecks(opts: { hours?: number; limit?: number } = {}) {
  const db = await getDb();
  const cutoff = new Date(Date.now() - (opts.hours ?? 12) * 3_600_000);
  const rows = await db
    .select({ id: positions.id })
    .from(positions)
    .where(
      and(
        or(eq(positions.watchEnabled, true), sql`${positions.status} in (${sql.join(HOT_STATUSES.map((s) => sql`${s}`), sql`, `)})`),
        sql`${positions.listingStatus} <> 'closed'`,
        sql`${positions.primaryUrl} is not null`,
        or(isNull(positions.lastCheckedAt), lt(positions.lastCheckedAt, cutoff))!,
      ),
    )
    .orderBy(asc(positions.lastCheckedAt))
    .limit(Math.min(500, opts.limit ?? 100));
  let enqueued = 0;
  for (const r of rows) {
    const q = await enqueueJob("watch_check", { positionId: r.id }, { dedupeKey: `watch:${r.id}`, priority: 90 });
    if (!q.deduped) enqueued++;
  }
  const legacy = await db
    .select({ id: watches.id })
    .from(watches)
    .where(and(eq(watches.enabled, true), isNull(watches.positionId), or(isNull(watches.lastCheckedAt), lt(watches.lastCheckedAt, cutoff))!))
    .limit(50);
  for (const w of legacy) {
    const q = await enqueueJob("watch_check", { watchId: w.id }, { dedupeKey: `watch:${w.id}`, priority: 95 });
    if (!q.deduped) enqueued++;
  }
  return { due: rows.length + legacy.length, enqueued };
}

export async function listWatches(q: { sort?: string } = {}) {
  const db = await getDb();
  const { parseListSort } = await import("@job-scout/shared");
  const { field, dir } = parseListSort(q.sort, ["updated", "url", "label", "checked"], "updated", "desc");
  const d = <T>(col: T) => (dir === "asc" ? asc(col as never) : desc(col as never));
  const order =
    field === "url"
      ? [d(watches.url)]
      : field === "label"
        ? [d(watches.label)]
        : field === "checked"
          ? [d(watches.lastCheckedAt)]
          : [d(watches.updatedAt)];
  return db.select().from(watches).where(eq(watches.enabled, true)).orderBy(...order).limit(200);
}

export async function createWatch(input: { url: string; label?: string | null; positionId?: string | null }) {
  const db = await getDb();
  const wid = id("w");
  await db.insert(watches).values({ id: wid, url: input.url, label: input.label ?? null, positionId: input.positionId ?? null });
  if (input.positionId) {
    await db.update(positions).set({ watchEnabled: true, updatedAt: new Date() }).where(eq(positions.id, input.positionId));
    await addEvent({ positionId: input.positionId, kind: "watch", title: "Watch enabled" });
  }
  return wid;
}

export async function deleteWatch(watchId: string) {
  const db = await getDb();
  await db.update(watches).set({ enabled: false, updatedAt: new Date() }).where(eq(watches.id, watchId));
}
