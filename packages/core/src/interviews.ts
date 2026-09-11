import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { companies, getDb, id, interviews, positions } from "@job-scout/db";
import {
  INTERVIEW_OUTCOMES,
  INTERVIEW_STATUSES,
  PROCESS_STATUSES,
  type InterviewOutcome,
  type InterviewStatus,
} from "@job-scout/shared";
import { enqueueJob } from "./jobs.js";

export { INTERVIEW_OUTCOMES, INTERVIEW_STAGES, INTERVIEW_STATUSES, PROCESS_STATUSES } from "@job-scout/shared";
export type { InterviewOutcome, InterviewStage, InterviewStatus, ProcessStatus } from "@job-scout/shared";

export type InterviewInput = {
  stage?: string;
  title?: string | null;
  interviewerName?: string | null;
  interviewerRole?: string | null;
  scheduledAt?: string | Date | null;
  occurredAt?: string | Date | null;
  durationSeconds?: number | null;
  status?: string;
  outcome?: string | null;
  notes?: string | null;
  notesMarkdown?: string | null;
  reviewMarkdown?: string | null;
  transcriptMarkdown?: string | null;
  transcriptSource?: string | null;
  sourcePath?: string | null;
  metadata?: Record<string, unknown> | null;
  skipBrief?: boolean;
};

const INTERVIEW_ROW = {
  id: interviews.id,
  positionId: interviews.positionId,
  stage: interviews.stage,
  title: interviews.title,
  interviewerName: interviews.interviewerName,
  interviewerRole: interviews.interviewerRole,
  scheduledAt: interviews.scheduledAt,
  occurredAt: interviews.occurredAt,
  durationSeconds: interviews.durationSeconds,
  status: interviews.status,
  outcome: interviews.outcome,
  notes: interviews.notes,
  notesMarkdown: interviews.notesMarkdown,
  reviewMarkdown: interviews.reviewMarkdown,
  transcriptMarkdown: interviews.transcriptMarkdown,
  transcriptSource: interviews.transcriptSource,
  aiBriefMarkdown: interviews.aiBriefMarkdown,
  aiBriefJson: interviews.aiBriefJson,
  aiBriefModel: interviews.aiBriefModel,
  aiBriefedAt: interviews.aiBriefedAt,
  sourcePath: interviews.sourcePath,
  metadata: interviews.metadata,
  createdAt: interviews.createdAt,
  updatedAt: interviews.updatedAt,
};

const INTERVIEW_LIST_ROW = {
  id: interviews.id,
  positionId: interviews.positionId,
  stage: interviews.stage,
  title: interviews.title,
  interviewerName: interviews.interviewerName,
  interviewerRole: interviews.interviewerRole,
  scheduledAt: interviews.scheduledAt,
  occurredAt: interviews.occurredAt,
  durationSeconds: interviews.durationSeconds,
  status: interviews.status,
  outcome: interviews.outcome,
  notes: interviews.notes,
  transcriptSource: interviews.transcriptSource,
  aiBriefModel: interviews.aiBriefModel,
  aiBriefedAt: interviews.aiBriefedAt,
  sourcePath: interviews.sourcePath,
  metadata: interviews.metadata,
  createdAt: interviews.createdAt,
  updatedAt: interviews.updatedAt,
  transcriptChars: sql<number>`coalesce(char_length(${interviews.transcriptMarkdown}), 0)`.mapWith(Number),
  reviewChars: sql<number>`coalesce(char_length(${interviews.reviewMarkdown}), 0)`.mapWith(Number),
  notesMarkdownChars: sql<number>`coalesce(char_length(${interviews.notesMarkdown}), 0)`.mapWith(Number),
  aiBriefChars: sql<number>`coalesce(char_length(${interviews.aiBriefMarkdown}), 0)`.mapWith(Number),
};

function trimOrNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t ? t : null;
}

function parseWhen(v: string | Date | null | undefined): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error("date must be ISO");
  return d;
}

function parseStatus(v: string | undefined, fallback: InterviewStatus): InterviewStatus {
  if (v == null || v === "") return fallback;
  if (!(INTERVIEW_STATUSES as readonly string[]).includes(v)) throw new Error(`status must be ${INTERVIEW_STATUSES.join("|")}`);
  return v as InterviewStatus;
}

function parseOutcome(v: string | null | undefined): InterviewOutcome | null | undefined {
  if (v === undefined) return undefined;
  if (v == null || v === "") return null;
  if (!(INTERVIEW_OUTCOMES as readonly string[]).includes(v)) throw new Error(`outcome must be ${INTERVIEW_OUTCOMES.join("|")}`);
  return v as InterviewOutcome;
}

function parseDuration(v: number | null | undefined): number | null | undefined {
  if (v === undefined) return undefined;
  if (v == null) return null;
  if (!Number.isFinite(v) || v < 0) throw new Error("durationSeconds must be >= 0");
  return Math.round(v);
}

export async function listInterviews(positionId: string) {
  const db = await getDb();
  return db
    .select(INTERVIEW_LIST_ROW)
    .from(interviews)
    .where(eq(interviews.positionId, positionId))
    .orderBy(sql`${interviews.occurredAt} asc nulls last`, sql`${interviews.scheduledAt} asc nulls last`, desc(interviews.createdAt));
}

const INTERVIEW_DESK_ROW = {
  ...INTERVIEW_LIST_ROW,
  positionTitle: positions.title,
  positionSlug: positions.slug,
  positionStatus: positions.status,
  companyName: companies.name,
  companySlug: companies.slug,
};

export async function listAllInterviews(opts: { lane?: string; stage?: string; q?: string; limit?: number } = {}) {
  const db = await getDb();
  const conds = [];
  const lane = (opts.lane || "all").trim();
  if (lane === "upcoming") {
    conds.push(eq(interviews.status, "pending"));
    conds.push(sql`${interviews.scheduledAt} is not null`);
  } else if (lane === "completed") {
    conds.push(eq(interviews.status, "completed"));
  } else if (lane === "needs_brief") {
    conds.push(sql`coalesce(char_length(${interviews.transcriptMarkdown}), 0) > 0`);
    conds.push(sql`${interviews.aiBriefedAt} is null`);
  }
  const stage = opts.stage?.trim();
  if (stage) conds.push(eq(interviews.stage, stage));
  const q = opts.q?.trim();
  if (q) {
    const like = `%${q}%`;
    conds.push(
      or(
        ilike(positions.title, like),
        ilike(companies.name, like),
        ilike(interviews.interviewerName, like),
        ilike(interviews.title, like),
        ilike(interviews.notes, like),
      )!,
    );
  }
  const where = conds.length ? and(...conds) : undefined;
  const order =
    lane === "upcoming"
      ? [sql`${interviews.scheduledAt} asc nulls last`]
      : [sql`coalesce(${interviews.occurredAt}, ${interviews.scheduledAt}, ${interviews.createdAt}) desc`];
  return db
    .select(INTERVIEW_DESK_ROW)
    .from(interviews)
    .innerJoin(positions, eq(interviews.positionId, positions.id))
    .innerJoin(companies, eq(positions.companyId, companies.id))
    .where(where)
    .orderBy(...order)
    .limit(Math.min(Math.max(opts.limit ?? 200, 1), 500));
}

export type ProcessRound = {
  id: string;
  stage: string;
  title: string | null;
  interviewerName: string | null;
  scheduledAt: Date | null;
  occurredAt: Date | null;
  status: string;
  outcome: string | null;
  transcriptChars: number;
  aiBriefChars: number;
  aiBriefedAt: Date | null;
};

export type ProcessRow = {
  id: string;
  slug: string;
  title: string;
  status: string;
  priority: string;
  nextAction: string | null;
  notes: string | null;
  appliedAt: Date | null;
  updatedAt: Date;
  company: { id: string; slug: string; name: string };
  roundCount: number;
  pendingCount: number;
  completedCount: number;
  lastRound: ProcessRound | null;
  nextRound: ProcessRound | null;
  rounds: ProcessRound[];
};

function toProcessRound(r: Awaited<ReturnType<typeof listInterviews>>[number]): ProcessRound {
  return {
    id: r.id,
    stage: r.stage,
    title: r.title,
    interviewerName: r.interviewerName,
    scheduledAt: r.scheduledAt,
    occurredAt: r.occurredAt,
    status: r.status,
    outcome: r.outcome,
    transcriptChars: r.transcriptChars,
    aiBriefChars: r.aiBriefChars,
    aiBriefedAt: r.aiBriefedAt,
  };
}

export async function listProcesses(): Promise<ProcessRow[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: positions.id,
      slug: positions.slug,
      title: positions.title,
      status: positions.status,
      priority: positions.priority,
      nextAction: positions.nextAction,
      notes: positions.notes,
      appliedAt: positions.appliedAt,
      updatedAt: positions.updatedAt,
      companyId: companies.id,
      companySlug: companies.slug,
      companyName: companies.name,
    })
    .from(positions)
    .innerJoin(companies, eq(positions.companyId, companies.id))
    .where(inArray(positions.status, [...PROCESS_STATUSES]))
    .orderBy(desc(positions.updatedAt));
  if (!rows.length) return [];
  const rounds = await db.select(INTERVIEW_LIST_ROW).from(interviews).where(inArray(interviews.positionId, rows.map((r) => r.id)));
  const byPos = new Map<string, ProcessRound[]>();
  for (const r of rounds) {
    const list = byPos.get(r.positionId) || [];
    list.push(toProcessRound(r));
    byPos.set(r.positionId, list);
  }
  const now = Date.now();
  const out: ProcessRow[] = rows.map((r) => {
    const rs = (byPos.get(r.id) || []).slice().sort((a, b) => {
      const at = (a.occurredAt || a.scheduledAt || new Date(0)).getTime();
      const bt = (b.occurredAt || b.scheduledAt || new Date(0)).getTime();
      return at - bt;
    });
    const completed = rs.filter((x) => x.status === "completed");
    const pending = rs.filter((x) => x.status === "pending");
    const nextRound = pending.filter((x) => x.scheduledAt && x.scheduledAt.getTime() >= now - 86_400_000).sort((a, b) => (a.scheduledAt?.getTime() || 0) - (b.scheduledAt?.getTime() || 0))[0] || pending[0] || null;
    const lastRound = completed.filter((x) => x.occurredAt).sort((a, b) => (b.occurredAt?.getTime() || 0) - (a.occurredAt?.getTime() || 0))[0] || completed.at(-1) || null;
    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      status: r.status,
      priority: r.priority,
      nextAction: r.nextAction,
      notes: r.notes,
      appliedAt: r.appliedAt,
      updatedAt: r.updatedAt,
      company: { id: r.companyId, slug: r.companySlug, name: r.companyName },
      roundCount: rs.length,
      pendingCount: pending.length,
      completedCount: completed.length,
      lastRound,
      nextRound,
      rounds: rs,
    };
  });
  out.sort((a, b) => {
    const an = a.nextRound?.scheduledAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bn = b.nextRound?.scheduledAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (an !== bn) return an - bn;
    const al = a.lastRound?.occurredAt?.getTime() ?? a.updatedAt.getTime();
    const bl = b.lastRound?.occurredAt?.getTime() ?? b.updatedAt.getTime();
    return bl - al;
  });
  return out;
}

export async function getInterview(positionId: string, interviewId: string) {
  const db = await getDb();
  return (
    await db
      .select(INTERVIEW_ROW)
      .from(interviews)
      .where(and(eq(interviews.id, interviewId), eq(interviews.positionId, positionId)))
      .limit(1)
  )[0] ?? null;
}

export async function getInterviewById(interviewId: string) {
  const db = await getDb();
  return (await db.select(INTERVIEW_ROW).from(interviews).where(eq(interviews.id, interviewId)).limit(1))[0] ?? null;
}

async function maybeEnqueueBrief(positionId: string, interviewId: string, transcript: string | null, skip?: boolean) {
  if (skip || !transcript?.trim()) return null;
  const q = await enqueueJob("interview_brief", { positionId, interviewId }, { dedupeKey: `interview_brief:${interviewId}`, priority: 25 });
  return q.id;
}

export async function addInterview(positionId: string, input: InterviewInput) {
  const stage = (input.stage || "screen").trim();
  if (!stage) throw new Error("stage required");
  const status = parseStatus(input.status, "pending");
  const scheduledAt = parseWhen(input.scheduledAt);
  const occurredAt = parseWhen(input.occurredAt);
  const outcome = parseOutcome(input.outcome);
  const durationSeconds = parseDuration(input.durationSeconds);
  const transcriptMarkdown = trimOrNull(input.transcriptMarkdown);
  const db = await getDb();
  const iid = id("iv");
  const now = new Date();
  await db.insert(interviews).values({
    id: iid,
    positionId,
    stage,
    title: trimOrNull(input.title),
    interviewerName: trimOrNull(input.interviewerName),
    interviewerRole: trimOrNull(input.interviewerRole),
    scheduledAt: scheduledAt === undefined ? null : scheduledAt,
    occurredAt: occurredAt === undefined ? null : occurredAt,
    durationSeconds: durationSeconds === undefined ? null : durationSeconds,
    status,
    outcome: outcome === undefined ? null : outcome,
    notes: trimOrNull(input.notes),
    notesMarkdown: trimOrNull(input.notesMarkdown),
    reviewMarkdown: trimOrNull(input.reviewMarkdown),
    transcriptMarkdown,
    transcriptSource: trimOrNull(input.transcriptSource),
    sourcePath: trimOrNull(input.sourcePath),
    metadata: input.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  });
  const row = (await db.select(INTERVIEW_ROW).from(interviews).where(eq(interviews.id, iid)))[0];
  if (!row) throw new Error("interview insert failed");
  const briefJobId = await maybeEnqueueBrief(positionId, iid, transcriptMarkdown, input.skipBrief);
  return { ...row, briefJobId };
}

export async function patchInterview(positionId: string, interviewId: string, input: InterviewInput) {
  const db = await getDb();
  const existing = (
    await db
      .select(INTERVIEW_ROW)
      .from(interviews)
      .where(and(eq(interviews.id, interviewId), eq(interviews.positionId, positionId)))
      .limit(1)
  )[0];
  if (!existing) return null;
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.stage !== undefined) {
    const stage = input.stage.trim();
    if (!stage) throw new Error("stage required");
    patch.stage = stage;
  }
  if (input.title !== undefined) patch.title = trimOrNull(input.title);
  if (input.interviewerName !== undefined) patch.interviewerName = trimOrNull(input.interviewerName);
  if (input.interviewerRole !== undefined) patch.interviewerRole = trimOrNull(input.interviewerRole);
  if (input.status !== undefined) patch.status = parseStatus(input.status, existing.status as InterviewStatus);
  if (input.scheduledAt !== undefined) patch.scheduledAt = parseWhen(input.scheduledAt) ?? null;
  if (input.occurredAt !== undefined) patch.occurredAt = parseWhen(input.occurredAt) ?? null;
  if (input.durationSeconds !== undefined) patch.durationSeconds = parseDuration(input.durationSeconds) ?? null;
  if (input.outcome !== undefined) patch.outcome = parseOutcome(input.outcome) ?? null;
  if (input.notes !== undefined) patch.notes = trimOrNull(input.notes);
  if (input.notesMarkdown !== undefined) patch.notesMarkdown = trimOrNull(input.notesMarkdown);
  if (input.reviewMarkdown !== undefined) patch.reviewMarkdown = trimOrNull(input.reviewMarkdown);
  if (input.transcriptMarkdown !== undefined) patch.transcriptMarkdown = trimOrNull(input.transcriptMarkdown);
  if (input.transcriptSource !== undefined) patch.transcriptSource = trimOrNull(input.transcriptSource);
  if (input.sourcePath !== undefined) patch.sourcePath = trimOrNull(input.sourcePath);
  if (input.metadata !== undefined) patch.metadata = input.metadata ?? {};
  const keys = Object.keys(patch).filter((k) => k !== "updatedAt");
  if (!keys.length) throw new Error("nothing to update");
  await db.update(interviews).set(patch).where(eq(interviews.id, interviewId));
  const row = (await db.select(INTERVIEW_ROW).from(interviews).where(eq(interviews.id, interviewId)))[0];
  if (!row) throw new Error("interview update failed");
  const transcript = input.transcriptMarkdown !== undefined ? row.transcriptMarkdown : null;
  const briefJobId = await maybeEnqueueBrief(positionId, interviewId, transcript, input.skipBrief);
  return { ...row, briefJobId };
}

export async function deleteInterview(positionId: string, interviewId: string) {
  const db = await getDb();
  const row = (
    await db
      .select({ id: interviews.id })
      .from(interviews)
      .where(and(eq(interviews.id, interviewId), eq(interviews.positionId, positionId)))
      .limit(1)
  )[0];
  if (!row) return false;
  await db.delete(interviews).where(eq(interviews.id, interviewId));
  return true;
}

export async function enqueueInterviewBrief(positionId: string, interviewId: string) {
  const row = await getInterview(positionId, interviewId);
  if (!row) return null;
  if (!row.transcriptMarkdown?.trim() && !row.notesMarkdown?.trim() && !row.notes?.trim()) {
    throw new Error("interview has no transcript or notes to brief");
  }
  return enqueueJob("interview_brief", { positionId, interviewId }, { dedupeKey: `interview_brief:${interviewId}`, priority: 20 });
}
