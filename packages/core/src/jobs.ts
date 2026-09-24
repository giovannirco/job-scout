import { jobRecovery } from "@job-scout/shared";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { getDb, id, jobs, positions, type JobType } from "@job-scout/db";

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

/** A missing model key, or a company-insert race whose filing already exists, is not a broken queue. */
export async function settleExpectedQueueFailures(): Promise<{ cleared: number }> {
  const db = await getDb();
  const rows = await db
    .select({ id: jobs.id, type: jobs.type, error: jobs.error, payload: jobs.payload })
    .from(jobs)
    .where(eq(jobs.status, "failed"));
  let cleared = 0;
  for (const row of rows) {
    const err = row.error || "";
    if (err.includes("OPENAI_API_KEY is not set")) {
      await completeJob(row.id, { skipped: "not_configured" });
      cleared++;
      continue;
    }
    if (row.type === "scan_url" && /insert into "companies"/i.test(err)) {
      const url = String((row.payload as { url?: string } | null)?.url || "");
      if (!url) continue;
      const filed = (await db.select({ id: positions.id }).from(positions).where(eq(positions.primaryUrl, url)).limit(1))[0];
      if (!filed) continue;
      await completeJob(row.id, { skipped: "company_race" });
      cleared++;
    }
  }
  return { cleared };
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

/** Reset only a failed, transient scan; preserve its payload and guard double clicks. */
export async function retryFailedScan(jobId: string) {
  const db = await getDb();
  return db.transaction(async tx => {
    const row = (await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update")).at(0);
    if (!row) throw new Error("Job not found");
    if (row.status !== "failed") throw new Error("Only failed checks can be retried");
    const recovery = jobRecovery(row.type, row.error);
    if (!recovery.retryable) throw new Error(recovery.advice);
    const payload = row.payload ?? {};
    const target = row.type === "board_scan" ? "boardId" : row.type === "scan_url" ? "url" : payload.watchId ? "watchId" : "positionId";
    const value = payload[target];
    if (typeof value !== "string" || !value) throw new Error("This check has no target. Queue a new check from Sources or the position page.");
    const pending = (await tx.select({ id: jobs.id }).from(jobs).where(and(
      eq(jobs.type, row.type), inArray(jobs.status, ["queued", "running"]),
      sql`${jobs.payload}->>${target} = ${value}`,
    )).limit(1)).at(0);
    if (pending) return { id: pending.id, deduped: true };
    await tx.update(jobs).set({ status: "queued", attempts: 0, error: null, result: {},
      startedAt: null, finishedAt: null, runAfter: new Date() }).where(and(eq(jobs.id, row.id), eq(jobs.status, "failed")));
    return { id: row.id, deduped: false };
  });
}
