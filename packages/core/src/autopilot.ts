import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import {
  approvals,
  evaluations,
  getDb,
  id,
  positions,
  timelineEvents,
  type ApprovalKind,
  type ApprovalStatus,
  type PositionStatus,
} from "@job-scout/db";
import { HOT_STATUSES, type AutopilotConfig } from "@job-scout/shared";
import { enqueueJob } from "./jobs.js";
import { getPosition } from "./positions.js";
import { getSettings } from "./settings.js";
import { addEvent } from "./timeline.js";
import { log as rootLog } from "@job-scout/shared";
import { approvalsResolved, autopilotActions } from "./metrics.js";
const log = rootLog.child({ scope: "autopilot" });

/**
 * Autopilot — the policy layer between "an event happened" and "the worker does more work".
 * Every hook is best-effort: a failure here must never fail the job that triggered it.
 * Jobs enqueued from here carry `auto: true` so the UI can label them.
 */

type Hook<T> = (ctx: T, cfg: AutopilotConfig) => Promise<Record<string, unknown>>;

const snake = (s: string) => s.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());

async function safe<T>(label: string, ctx: T, hook: Hook<T>): Promise<Record<string, unknown>> {
  try {
    const settings = await getSettings();
    const out = await hook(ctx, settings.autopilot);
    const actions: string[] = [];
    for (const [k, v] of Object.entries(out)) {
      if (v == null) continue;
      if (k.endsWith("JobId")) actions.push(`enqueue_${snake(k.slice(0, -5))}`);
      else if (k === "approvalId") actions.push("approval");
      else if (k === "archived") actions.push("archive");
    }
    if (!actions.length) actions.push("noop");
    for (const a of actions) autopilotActions.labels({ hook: label, action: a }).inc();
    const c = ctx as Record<string, unknown>;
    log.info("autopilot.hook", { hook: label, preset: settings.autopilot.preset, positionId: c.positionId, actions, ...out });
    return out;
  } catch (e) {
    log.warn("autopilot.hook.failed", { hook: label, err: e });
    return { autopilotError: e instanceof Error ? e.message : String(e) };
  }
}

/** Company has research newer than `staleDays`? */
async function hasFreshResearch(companyId: string, staleDays: number): Promise<boolean> {
  const db = await getDb();
  const since = new Date(Date.now() - staleDays * 86_400_000);
  const r = await db
    .select({ id: evaluations.id })
    .from(evaluations)
    .where(and(eq(evaluations.companyId, companyId), eq(evaluations.kind, "company_research"), gte(evaluations.createdAt, since)))
    .limit(1);
  return r.length > 0;
}

/** After LLM triage: maybe evaluate, maybe research the company. */
export function afterTriage(ctx: { positionId: string; companyId: string; score: number; verdict: "pass" | "marginal" | "fail"; status: PositionStatus }) {
  return safe("afterTriage", ctx, async (c, cfg) => {
    const out: Record<string, unknown> = {};
    if (c.verdict !== "pass" || !["triaged", "review"].includes(c.status)) return out;
    const wantEval = cfg.evaluate.mode === "all_pass" || (cfg.evaluate.mode === "threshold" && c.score >= cfg.evaluate.minTriageScore);
    if (wantEval) {
      const q = await enqueueJob("evaluate", { positionId: c.positionId, auto: true }, { dedupeKey: `evaluate:${c.positionId}`, priority: 70 });
      out.evaluateJobId = q.id;
    }
    if (cfg.companyResearch.mode === "on_pass" && !(await hasFreshResearch(c.companyId, cfg.companyResearch.staleDays))) {
      const q = await enqueueJob(
        "company_research",
        { companyId: c.companyId, positionId: c.positionId, auto: true },
        { dedupeKey: `company_research:${c.companyId}`, priority: 90 },
      );
      out.companyResearchJobId = q.id;
    }
    return out;
  });
}

/** After a full evaluation: company research, materials draft, status suggestion. */
export function afterEvaluate(ctx: {
  positionId: string;
  companyId: string;
  evaluationId: string;
  score: number;
  verdict: "apply" | "consider" | "skip";
  headline: string;
  status: PositionStatus;
  expectedUpdatedAt?: string;
}) {
  return safe("afterEvaluate", ctx, async (c, cfg) => {
    const out: Record<string, unknown> = {};
    if (!["triaged", "review", "materials"].includes(c.status)) return out;
    if (c.expectedUpdatedAt) {
      const current = await getPosition(c.positionId);
      if (!current || current.updatedAt.toISOString() !== c.expectedUpdatedAt || current.status !== c.status || current.listingStatus === "closed" || current.metadata?.quarantined) {
        return { autopilotSkipped: "position_changed" };
      }
    }
    if (cfg.companyResearch.mode !== "off" && !(await hasFreshResearch(c.companyId, cfg.companyResearch.staleDays))) {
      const q = await enqueueJob(
        "company_research",
        { companyId: c.companyId, positionId: c.positionId, auto: true },
        { dedupeKey: `company_research:${c.companyId}`, priority: 90 },
      );
      out.companyResearchJobId = q.id;
    }
    if (cfg.preset === "autopilot") {
      const fq = await enqueueJob("form_answers", { positionId: c.positionId, auto: true }, { dedupeKey: `form_answers:${c.positionId}`, priority: 80 });
      out.formAnswersJobId = fq.id;
    }
    if (cfg.materials.mode === "threshold" && c.verdict !== "skip" && c.score >= cfg.materials.minEvaluateScore) {
      const q = await enqueueJob("materials", { positionId: c.positionId, auto: true }, { dedupeKey: `materials:${c.positionId}`, priority: 80 });
      out.materialsJobId = q.id;
    }
    if (cfg.suggestStatus && (c.verdict === "apply" || c.verdict === "skip")) {
      // Only when the operator has not already decided.
      if (c.status === "triaged" || c.status === "review") {
        const kind: ApprovalKind = c.verdict === "apply" ? "status_suggestion" : "archive_suggestion";
        const title = c.verdict === "apply" ? `Apply — evaluation ${c.score.toFixed(1)}` : `Skip — evaluation ${c.score.toFixed(1)}`;
        const a = await createApproval({
          kind,
          positionId: c.positionId,
          companyId: c.companyId,
          title,
          body: c.headline,
          payload: c.verdict === "apply" ? { toStatus: "materials", evaluationId: c.evaluationId } : { reason: `evaluation skip ${c.score.toFixed(1)}: ${c.headline}`, evaluationId: c.evaluationId },
          dedupe: true,
        });
        out.approvalId = a?.id ?? null;
      }
    }
    return out;
  });
}

/** After a material JD change lands on a position. */
export function afterJdChange(ctx: { positionId: string; status: PositionStatus; changeKind: string; revision: number }) {
  return safe("afterJdChange", ctx, async (c, cfg) => {
    if (cfg.jdReview.mode === "off" || c.revision <= 1) return {};
    const active = c.status !== "archived" && c.status !== "rejected" && c.status !== "skip";
    const hot = (HOT_STATUSES as readonly string[]).includes(c.status);
    if (cfg.jdReview.mode === "hot_only" && !hot) return {};
    if (cfg.jdReview.mode === "all_active" && !active) return {};
    const q = await enqueueJob("jd_review", { positionId: c.positionId, auto: true, changeKind: c.changeKind }, { dedupeKey: `jd_review:${c.positionId}:${c.revision}`, priority: 85 });
    return { jdReviewJobId: q.id };
  });
}

/** After materials were drafted by autopilot: file them for approval. */
export function afterMaterials(ctx: { positionId: string; companyId: string; materialIds: string[]; surface: string | null }) {
  return safe("afterMaterials", ctx, async (c) => {
    const a = await createApproval({
      kind: "materials_draft",
      positionId: c.positionId,
      companyId: c.companyId,
      title: `Materials drafted${c.surface ? ` (${c.surface})` : ""}`,
      body: "Resume + cover drafted by autopilot. Review before sending.",
      payload: { materialIds: c.materialIds, surface: c.surface },
      dedupe: true,
    });
    return { approvalId: a?.id ?? null };
  });
}

// ---------------------------------------------------------------------------
// Approvals inbox

export async function createApproval(input: {
  kind: ApprovalKind;
  positionId?: string | null;
  companyId?: string | null;
  title: string;
  body?: string | null;
  payload?: Record<string, unknown>;
  source?: string;
  /** Skip if a pending approval of the same kind exists for the position */
  dedupe?: boolean;
}) {
  const db = await getDb();
  if (input.dedupe && input.positionId) {
    const existing = await db
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.positionId, input.positionId), eq(approvals.kind, input.kind), eq(approvals.status, "pending")))
      .limit(1);
    if (existing.length) return null;
  }
  const row = {
    id: id("apr"),
    kind: input.kind,
    status: "pending" as ApprovalStatus,
    positionId: input.positionId ?? null,
    companyId: input.companyId ?? null,
    title: input.title,
    body: input.body ?? null,
    payload: input.payload ?? {},
    source: input.source ?? "autopilot",
  };
  await db.insert(approvals).values(row);
  if (input.positionId) await addEvent({ positionId: input.positionId, kind: "approval", title: `Inbox: ${input.title}`, actor: row.source });
  const { emitNotify } = await import("./notify.js");
  await emitNotify({
    event: "approval_pending",
    title: input.title,
    company: "",
    extra: input.body ?? null,
    positionId: input.positionId ?? null,
    companyId: input.companyId ?? null,
    subjectId: row.id,
    slug: null,
  });
  return row;
}

export async function listApprovals(opts: { status?: ApprovalStatus | "all"; limit?: number; sort?: string } = {}) {
  const db = await getDb();
  const status = opts.status ?? "pending";
  const { parseListSort } = await import("@job-scout/shared");
  const { field, dir } = parseListSort(opts.sort, ["created", "title", "status"], "created", "desc");
  const d = <T>(col: T) => (dir === "asc" ? asc(col as never) : desc(col as never));
  const order = field === "title" ? [d(approvals.title)] : field === "status" ? [d(approvals.status), desc(approvals.createdAt)] : [d(approvals.createdAt)];
  const rows = await db
    .select({
      id: approvals.id,
      kind: approvals.kind,
      status: approvals.status,
      positionId: approvals.positionId,
      companyId: approvals.companyId,
      title: approvals.title,
      body: approvals.body,
      payload: approvals.payload,
      source: approvals.source,
      createdAt: approvals.createdAt,
      resolvedAt: approvals.resolvedAt,
      position: sql<{ slug: string; title: string; status: string; company: string } | null>`(
        select jsonb_build_object('slug', p.slug, 'title', p.title, 'status', p.status, 'company', c.name)
        from positions p join companies c on c.id = p.company_id where p.id = ${approvals.positionId})`,
    })
    .from(approvals)
    .where(status === "all" ? sql`true` : eq(approvals.status, status))
    .orderBy(...order)
    .limit(Math.min(200, opts.limit ?? 50));
  return rows;
}

export async function pendingApprovalCount(): Promise<number> {
  const db = await getDb();
  return (await db.select({ c: sql<number>`count(*)::int` }).from(approvals).where(eq(approvals.status, "pending")))[0]?.c ?? 0;
}

/** Approve (apply the proposed action) or dismiss. */
export async function resolveApproval(approvalId: string, decision: "approved" | "dismissed", actor = "operator") {
  const db = await getDb();
  // Lock both records: approval resolution and the position transition are one action.
  // An old suggestion is not authority to resurrect an archived/closed job or regress an application.
  return db.transaction(async (tx) => {
    const row = (await tx.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1).for("update"))[0];
    if (!row) throw new Error("approval not found");
    if (row.status !== "pending") return { id: row.id, status: row.status, applied: false };
    let applied = false;
    let status: ApprovalStatus = decision;
    let staleReason: string | null = null;
    if (decision === "approved") {
      const pos = row.positionId ? (await tx.select().from(positions).where(eq(positions.id, row.positionId)).limit(1).for("update"))[0] : null;
      const p = row.payload || {};
      if (!pos) staleReason = "position_missing";
      else if (pos.listingStatus === "closed") staleReason = "listing_closed";
      else if (!["triaged", "review", ...(row.kind === "materials_draft" ? ["materials"] : [])].includes(pos.status)) staleReason = "operator_already_decided";
      else if (row.kind === "status_suggestion" && p.toStatus !== "materials") staleReason = "unsupported_transition";
      if (!staleReason && pos && typeof p.evaluationId === "string") {
        const latest = (await tx.select().from(evaluations).where(and(eq(evaluations.positionId, pos.id), eq(evaluations.kind, "evaluate"))).orderBy(desc(evaluations.createdAt), desc(evaluations.id)).limit(1))[0];
        if (latest?.id !== p.evaluationId) staleReason = "evaluation_superseded";
      }
      if (staleReason) status = "expired";
      else if (pos) {
        const nextStatus = row.kind === "archive_suggestion" ? "archived" : "materials";
        if (pos.status !== nextStatus) {
          const metadata = { ...(pos.metadata || {}) };
          delete metadata.reviewIntent;
          await tx.update(positions).set({
            status: nextStatus, metadata, updatedAt: new Date(),
            archiveReason: nextStatus === "archived" ? String(p.reason || "autopilot suggestion").slice(0, 300) : null,
            ...(nextStatus === "archived" ? { watchEnabled: false } : {}),
          }).where(eq(positions.id, pos.id));
          await tx.insert(timelineEvents).values({ id: id("tl"), positionId: pos.id, kind: "status", title: `${pos.status} → ${nextStatus}`, actor });
        }
        applied = true;
      }
    }
    await tx.update(approvals).set({ status, resolvedAt: new Date(), resolvedBy: actor }).where(eq(approvals.id, approvalId));
    if (row.positionId) await tx.insert(timelineEvents).values({ id: id("tl"), positionId: row.positionId, kind: "approval", title: `${status}: ${row.title}`.slice(0, 300), actor, metadata: { staleReason } });
    approvalsResolved.labels({ kind: row.kind, decision: status }).inc();
    log.info("approval.resolved", { approvalId, kind: row.kind, decision: status, applied, actor, positionId: row.positionId, staleReason });
    return { id: row.id, status, applied, staleReason };
  });
}

/** Counts for the Today page / settings header. */
export async function autopilotSummary() {
  const db = await getDb();
  const since = new Date(Date.now() - 24 * 3_600_000);
  const auto = await db
    .select({ type: sql<string>`type`, status: sql<string>`status`, c: sql<number>`count(*)::int` })
    .from(sql`jobs`)
    .where(sql`payload->>'auto' = 'true' and created_at > ${since}`)
    .groupBy(sql`type`, sql`status`);
  const pending = await pendingApprovalCount();
  const untriaged = (await db.select({ c: sql<number>`count(*)::int` }).from(positions).where(sql`${positions.triagedAt} is null and ${positions.status} = 'triaged'`))[0]?.c ?? 0;
  return { pendingApprovals: pending, untriaged, autoJobs24h: auto };
}
