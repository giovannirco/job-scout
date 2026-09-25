import { and, asc, desc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { getDb, id, jobs, positions, watches } from "@job-scout/db";
import { assertPublicUrl, detectAts, fetchGreenhouseJob } from "@job-scout/ats";
import { fetchJob as fetchJobFromUrl } from "./fetch-job.js";
import { contentHash, HOT_STATUSES, jobRecovery } from "@job-scout/shared";
import { enqueueJob } from "./jobs.js";
import { applySnapshot } from "./positions.js";
import { addEvent } from "./timeline.js";

function watchableUrl(url: string | null) {
  if (!url) return false;
  try { assertPublicUrl(url); return true; } catch { return false; }
}

/**
 * Watches are the positions themselves (watch_enabled) plus the legacy
 * free-form `watches` table for URLs without a position.
 */
export async function checkWatch(watchId: string) {
  const db = await getDb();
  const w = (await db.select().from(watches).where(eq(watches.id, watchId)).limit(1))[0];
  if (!w) throw new Error("watch not found");
  if (!watchableUrl(w.url)) return { skipped: "unsupported_url", positionId: w.positionId };
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
  const db = await getDb();
  const position = (await db.select({ url: positions.primaryUrl }).from(positions).where(eq(positions.id, positionId)).limit(1)).at(0);
  if (!position) throw new Error("position not found");
  if (!watchableUrl(position.url)) return { skipped: "unsupported_url", positionId };
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
  const blocked = (await db.select({ payload: jobs.payload, error: jobs.error }).from(jobs).where(and(
    eq(jobs.type, "watch_check"), eq(jobs.status, "failed"), gte(jobs.finishedAt, new Date(Date.now() - 24 * 3_600_000)),
  ))).filter(j => jobRecovery("watch_check", j.error).kind === "blocked");
  const coolingDown = (target: "positionId" | "watchId", id: string, url: string | null) =>
    blocked.some(j => j.payload?.[target] === id && (!j.payload.url || j.payload.url === url));
  const candidates = await db
    .select({ id: positions.id, url: positions.primaryUrl })
    .from(positions)
    .where(
      and(
        or(eq(positions.watchEnabled, true), sql`${positions.status} in (${sql.join(HOT_STATUSES.map((s) => sql`${s}`), sql`, `)})`),
        sql`${positions.listingStatus} <> 'closed'`,
        sql`${positions.primaryUrl} ~* '^https?://'`,
        or(isNull(positions.lastCheckedAt), lt(positions.lastCheckedAt, cutoff))!,
      ),
    )
    .orderBy(asc(positions.lastCheckedAt))
    .limit(500);
  const rows = candidates.filter(r => watchableUrl(r.url) && !coolingDown("positionId", r.id, r.url)).slice(0, Math.min(500, opts.limit ?? 100));
  let enqueued = 0;
  for (const r of rows) {
    const q = await enqueueJob("watch_check", { positionId: r.id, url: r.url }, { dedupeKey: `watch:${r.id}`, priority: 90 });
    if (!q.deduped) enqueued++;
  }
  const legacy = await db
    .select({ id: watches.id, url: watches.url })
    .from(watches)
    .where(and(eq(watches.enabled, true), isNull(watches.positionId), sql`${watches.url} ~* '^https?://'`, or(isNull(watches.lastCheckedAt), lt(watches.lastCheckedAt, cutoff))!))
    .limit(500);
  const dueLegacy = legacy.filter(w => watchableUrl(w.url) && !coolingDown("watchId", w.id, w.url)).slice(0, 50);
  for (const w of dueLegacy) {
    const q = await enqueueJob("watch_check", { watchId: w.id, url: w.url }, { dedupeKey: `watch:${w.id}`, priority: 95 });
    if (!q.deduped) enqueued++;
  }
  return { due: rows.length + dueLegacy.length, enqueued };
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
