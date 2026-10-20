import { and, asc, eq, ne, sql } from "drizzle-orm";
import { applicationMaterials, companies, getDb, positions, timelineEvents, type Db } from "@job-scout/db";
import { PipelineStatus } from "@job-scout/shared";
import { addEvent } from "./timeline.js";

/**
 * `materials` means "materials exist for this position": a non-failed resume or
 * cover in job-scout, or a packaged PDF recorded on the career-ops stamp.
 */
export class MaterialsMissingError extends Error {
  constructor(positionId: string) {
    super(`materials_missing: ${positionId} has no materials yet; generate or attach a resume/cover (or stamp career-ops pdfPath) before moving it to materials`);
    this.name = "MaterialsMissingError";
  }
}

type Tx = Pick<Db, "select">;

export async function hasMaterials(positionId: string, metadata?: Record<string, unknown> | null, tx?: Tx): Promise<boolean> {
  const stamp = (metadata?.careerOps || null) as { pdfPath?: unknown } | null;
  if (typeof stamp?.pdfPath === "string" && stamp.pdfPath.trim()) return true;
  const db = tx ?? (await getDb());
  const row = (await db
    .select({ id: applicationMaterials.id })
    .from(applicationMaterials)
    .where(and(eq(applicationMaterials.positionId, positionId), ne(applicationMaterials.status, "failed"), sql`(coalesce(${applicationMaterials.bodyMarkdown}, '') <> '' or ${applicationMaterials.pdfBase64} is not null)`))
    .limit(1))[0];
  return Boolean(row);
}

/** Tracker labels that name a pipeline stage (drop labels are notes, not stages). */
const TRACKER_STAGE: Record<string, PipelineStatus> = {
  evaluated: "review", applied: "applied", responded: "screen", interview: "interview", offer: "offer", rejected: "rejected",
};

/** The pipeline stage a career-ops stamp claims, or null when it names none. */
export function careerOpsStampStage(status: unknown): PipelineStatus | null {
  if (typeof status !== "string" || !status.trim()) return null;
  const parsed = PipelineStatus.safeParse(status.trim().toLowerCase());
  if (parsed.success) return parsed.data;
  return TRACKER_STAGE[status.trim().toLowerCase()] ?? null;
}

/** Compare a stamp with the position: `stale` when the stamp names a different stage. */
export function careerOpsStampState(positionStatus: string, stamp: Record<string, unknown> | null | undefined) {
  if (!stamp) return null;
  const stage = careerOpsStampStage(stamp.status);
  return { stampStatus: stamp.status ?? null, stampStage: stage, positionStatus, stale: Boolean(stage && stage !== positionStatus), syncedAt: stamp.syncedAt ?? null };
}

/**
 * The career-ops stamp after a job-scout status change. A stamp without a
 * trackerId whose status is a pipeline stage was written from job-scout's own
 * status, so job-scout keeps it current. A tracker-linked stamp mirrors the
 * tracker (the external sync owns `status`); job-scout records its own status
 * beside it so drift is visible instead of overwriting the tracker's value.
 */
export function refreshedCareerOpsStamp(stamp: Record<string, unknown> | null | undefined, nextStatus: string, at = new Date()) {
  if (!stamp || typeof stamp !== "object") return null;
  const next: Record<string, unknown> = { ...stamp, jsStatus: nextStatus, jsStatusAt: at.toISOString() };
  const ownedByJobScout = !stamp.trackerId && PipelineStatus.safeParse(stamp.status).success;
  if (ownedByJobScout) next.status = nextStatus;
  return next;
}

/** Positions in `materials` with no materials on file, and the stage they came from. */
export async function listMaterialsWithoutFiles() {
  const db = await getDb();
  const rows = await db
    .select({ id: positions.id, slug: positions.slug, title: positions.title, company: companies.name, metadata: positions.metadata, updatedAt: positions.updatedAt })
    .from(positions)
    .innerJoin(companies, eq(positions.companyId, companies.id))
    .where(eq(positions.status, "materials"));
  const out: Array<{ id: string; slug: string; company: string; title: string; enteredBy: string | null; enteredAt: string | null; from: string; revertTo: "triaged" | "review" }> = [];
  for (const r of rows) {
    if (await hasMaterials(r.id, r.metadata)) continue;
    const moves = await db
      .select({ title: timelineEvents.title, actor: timelineEvents.actor, createdAt: timelineEvents.createdAt })
      .from(timelineEvents)
      .where(and(eq(timelineEvents.positionId, r.id), eq(timelineEvents.kind, "status"), sql`${timelineEvents.title} like '% → materials'`))
      .orderBy(asc(timelineEvents.createdAt));
    const last = moves.at(-1);
    const from = last?.title.split(" → ")[0]?.trim() || "";
    const revertTo: "triaged" | "review" = from === "triaged" ? "triaged" : "review";
    out.push({ id: r.id, slug: r.slug, company: r.company, title: r.title, enteredBy: last?.actor ?? null, enteredAt: last?.createdAt.toISOString() ?? null, from: from || "unknown", revertTo });
  }
  return out;
}

/** Dry-run by default; with apply, moves each listed position back to the stage it came from. */
export async function repairMaterialsWithoutFiles(opts: { apply?: boolean } = {}) {
  const affected = await listMaterialsWithoutFiles();
  if (!opts.apply) return { dryRun: true as const, affected };
  const db = await getDb();
  for (const a of affected) {
    await db.update(positions).set({ status: a.revertTo, updatedAt: new Date() }).where(and(eq(positions.id, a.id), eq(positions.status, "materials")));
    await addEvent({ positionId: a.id, kind: "status", title: `materials → ${a.revertTo}`, body: "repair: status was materials with no materials on file", actor: "repair" });
  }
  return { dryRun: false as const, affected };
}
