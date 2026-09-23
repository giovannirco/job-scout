import { Hono } from "hono";
import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { companies, getDb, interviews, jobs, positions, timelineEvents } from "@job-scout/db";
import { countFunnel, listApprovals, listChangesSince, listPositions, usageSummary } from "@job-scout/core";
import { fail, ok } from "../envelope.js";

export const todayRoutes = new Hono();

const SLIM = {
  id: positions.id,
  slug: positions.slug,
  title: positions.title,
  status: positions.status,
  triageScore: positions.triageScore,
  triageVerdict: positions.triageVerdict,
  triageOneLiner: sql<string | null>`${positions.triageJson}->>'oneLiner'`,
  listingStatus: positions.listingStatus,
  appliedAt: positions.appliedAt,
  lastChangedAt: positions.lastChangedAt,
  updatedAt: positions.updatedAt,
  company: { id: companies.id, slug: companies.slug, name: companies.name },
};

todayRoutes.get("/", async (c) => {
  const db = await getDb();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const base = () => db.select(SLIM).from(positions).innerJoin(companies, eq(positions.companyId, companies.id));

  const [decisions, followUps, changed, upcoming, counts, queue, usage, approvals, activity, funnelRows] = await Promise.all([
    // PASS verdicts waiting for the operator
    listPositions({ status: "triaged,review", verdict: "pass", actionable: "true", collapseFamilies: "true", sort: "score_desc", pageSize: "25" }).then(r => r.items),
    // applied > 7 days ago with no movement
    base()
      .where(and(eq(positions.status, "applied"), isNotNull(positions.appliedAt), lt(positions.appliedAt, weekAgo)))
      .orderBy(positions.appliedAt)
      .limit(25),
    // what changed on positions past triage in the last 7 days
    base()
      .where(
        and(
          inArray(positions.status, ["review", "materials", "applied", "screen", "interview", "offer"]),
          gte(positions.lastChangedAt, weekAgo),
          sql`${positions.lastChangedAt} > ${positions.firstSeenAt} + interval '1 minute'`,
        ),
      )
      .orderBy(desc(positions.lastChangedAt))
      .limit(25),
    db
      .select({ id: interviews.id, positionId: interviews.positionId, stage: interviews.stage, scheduledAt: interviews.scheduledAt, status: interviews.status, title: positions.title, company: companies.name, slug: positions.slug })
      .from(interviews)
      .innerJoin(positions, eq(interviews.positionId, positions.id))
      .innerJoin(companies, eq(positions.companyId, companies.id))
      .where(and(gte(interviews.scheduledAt, new Date(Date.now() - 86_400_000)), eq(interviews.status, "pending")))
      .orderBy(interviews.scheduledAt)
      .limit(10),
    db
      .select({ status: positions.status, verdict: positions.triageVerdict, c: sql<number>`count(*)::int` })
      .from(positions)
      .groupBy(positions.status, positions.triageVerdict),
    db.select({ status: jobs.status, type: jobs.type, c: sql<number>`count(*)::int` }).from(jobs).groupBy(jobs.status, jobs.type),
    usageSummary(24),
    listApprovals({ status: "pending", limit: 30 }),
    // recent activity across positions (timeline) for the activity rail
    db
      .select({
        id: timelineEvents.id,
        kind: timelineEvents.kind,
        title: timelineEvents.title,
        actor: timelineEvents.actor,
        createdAt: timelineEvents.createdAt,
        positionId: timelineEvents.positionId,
        slug: positions.slug,
        positionTitle: positions.title,
        company: companies.name,
      })
      .from(timelineEvents)
      .leftJoin(positions, eq(timelineEvents.positionId, positions.id))
      .leftJoin(companies, eq(positions.companyId, companies.id))
      .where(sql`${timelineEvents.kind} not in ('jd_noise')`)
      .orderBy(desc(timelineEvents.createdAt))
      .limit(40),
    db.select({ status: positions.status, firstSeenAt: positions.firstSeenAt, appliedAt: positions.appliedAt }).from(positions),
  ]);

  const byStatus: Record<string, number> = {};
  let untriaged = 0;
  for (const r of counts) {
    byStatus[r.status] = (byStatus[r.status] || 0) + r.c;
    if (r.status === "triaged" && !r.verdict) untriaged += r.c;
  }
  const funnel = countFunnel(funnelRows);
  return ok(c, {
    decisions,
    followUps,
    changed,
    upcoming,
    counts: { byStatus, untriaged, last30d: funnel.last30d, appliedThisWeek: funnel.appliedThisWeek },
    queue,
    llm: usage,
    approvals,
    activity,
  });
});

todayRoutes.get("/changes", async (c) => {
  const since = c.req.query("since");
  const d = since ? new Date(since) : new Date(Date.now() - 86_400_000);
  if (Number.isNaN(d.getTime())) return fail(c, "VALIDATION_ERROR", "since must be ISO date");
  return ok(c, await listChangesSince(d, Number(c.req.query("limit") || 200)));
});
