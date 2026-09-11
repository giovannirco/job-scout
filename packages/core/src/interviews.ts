import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, id, interviews } from "@job-scout/db";
import { INTERVIEW_OUTCOMES, INTERVIEW_STATUSES, type InterviewOutcome, type InterviewStatus } from "@job-scout/shared";
import { enqueueJob } from "./jobs.js";

export { INTERVIEW_OUTCOMES, INTERVIEW_STAGES, INTERVIEW_STATUSES } from "@job-scout/shared";
export type { InterviewOutcome, InterviewStage, InterviewStatus } from "@job-scout/shared";

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
