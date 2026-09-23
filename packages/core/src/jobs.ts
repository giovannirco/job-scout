import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { getDb, id, jobs, type JobType } from "@job-scout/db";

export type JobRow = typeof jobs.$inferSelect;

export async function enqueueJob(
  type: JobType,
  payload: Record<string, unknown> = {},
  opts: { priority?: number; runAfter?: Date; dedupeKey?: string } = {},
): Promise<{ id: string; deduped: boolean }> {
  const db = await getDb();
  if (opts.dedupeKey) {
    const dup = (
      await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.type, type),
            inArray(jobs.status, ["queued", "running"]),
            sql`${jobs.payload}->>'dedupeKey' = ${opts.dedupeKey}`,
          ),
        )
        .limit(1)
    )[0];
    if (dup) return { id: dup.id, deduped: true };
    payload = { ...payload, dedupeKey: opts.dedupeKey };
  }
  const jobId = id("job");
  await db.insert(jobs).values({
    id: jobId,
    type,
    status: "queued",
    priority: opts.priority ?? 100,
    payload,
    runAfter: opts.runAfter ?? new Date(),
  });
  return { id: jobId, deduped: false };
}

/** Atomic claim: UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED). */
export async function claimNextJob(types?: JobType[]): Promise<JobRow | null> {
  const db = await getDb();
  const typeFilter = types?.length ? sql`and type in (${sql.join(types.map((t) => sql`${t}`), sql`, `)})` : sql``;
  const res = await db.execute(sql`
    update jobs set status = 'running', started_at = now(), attempts = attempts + 1
    where id = (
      select id from jobs
      where status = 'queued' and run_after <= now() ${typeFilter}
      order by priority asc, created_at asc
      limit 1
      for update skip locked
    )
    returning *
  `);
  const rows = (res as unknown as { rows?: Record<string, unknown>[] }).rows ?? (res as unknown as Record<string, unknown>[]);
  const r = rows?.[0];
  if (!r) return null;
  return camelJob(r);
}

function camelJob(r: Record<string, unknown>): JobRow {
  return {
    id: r.id as string,
    type: r.type as JobType,
    status: r.status as string,
    priority: r.priority as number,
    payload: (r.payload as Record<string, unknown>) ?? {},
    result: (r.result as Record<string, unknown>) ?? {},
    error: (r.error as string | null) ?? null,
    attempts: r.attempts as number,
    runAfter: new Date(r.run_after as string),
    startedAt: r.started_at ? new Date(r.started_at as string) : null,
    finishedAt: r.finished_at ? new Date(r.finished_at as string) : null,
    createdAt: new Date(r.created_at as string),
  };
}

export async function completeJob(jobId: string, result: Record<string, unknown> = {}) {
  const db = await getDb();
  await db
    .update(jobs)
    .set({ status: "succeeded", result, finishedAt: new Date(), error: null })
    .where(eq(jobs.id, jobId));
}

export async function failJob(jobId: string, error: string, opts: { retryInMs?: number } = {}) {
  const db = await getDb();
  if (opts.retryInMs) {
    await db
      .update(jobs)
      .set({ status: "queued", error: error.slice(0, 4000), runAfter: new Date(Date.now() + opts.retryInMs) })
      .where(eq(jobs.id, jobId));
    return;
  }
  await db
    .update(jobs)
    .set({ status: "failed", error: error.slice(0, 4000), finishedAt: new Date() })
    .where(eq(jobs.id, jobId));
}

export async function listJobs(opts: { status?: string; type?: string; limit?: number } = {}) {
  const db = await getDb();
  const conds = [];
  if (opts.status) conds.push(eq(jobs.status, opts.status));
  if (opts.type) conds.push(eq(jobs.type, opts.type as JobType));
  return db
    .select()
    .from(jobs)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(jobs.createdAt))
    .limit(Math.min(200, opts.limit ?? 50));
}

export async function jobStats() {
  const db = await getDb();
  const rows = await db
    .select({ type: jobs.type, status: jobs.status, count: sql<number>`count(*)::int` })
    .from(jobs)
    .groupBy(jobs.type, jobs.status)
    .orderBy(asc(jobs.type));
  return rows;
}

/** Put still-running jobs back in the queue (graceful worker shutdown). */
export async function releaseJobs(ids: string[]) {
  if (!ids.length) return 0;
  const db = await getDb();
  const res = await db
    .update(jobs)
    .set({ status: "queued", error: "requeued: worker shutdown" })
    .where(and(eq(jobs.status, "running"), inArray(jobs.id, ids)))
    .returning();
  return res.length;
}

/** Requeue jobs stuck in running for longer than staleMs (worker crash). */
export async function requeueStale(staleMs = 30 * 60_000) {
  const db = await getDb();
  const cutoff = new Date(Date.now() - staleMs);
  const res = await db
    .update(jobs)
    .set({ status: "queued", error: "requeued: stale running" })
    .where(and(eq(jobs.status, "running"), lte(jobs.startedAt, cutoff)))
    .returning();
  return res.length;
}
