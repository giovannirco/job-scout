import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, id, interviews } from "@job-scout/db";

export const INTERVIEW_STATUSES = ["pending", "completed", "cancelled"] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

export type InterviewInput = {
  stage?: string;
  scheduledAt?: string | Date | null;
  status?: string;
  notes?: string | null;
};

const INTERVIEW_ROW = {
  id: interviews.id,
  positionId: interviews.positionId,
  stage: interviews.stage,
  scheduledAt: interviews.scheduledAt,
  status: interviews.status,
  notes: interviews.notes,
  createdAt: interviews.createdAt,
  updatedAt: interviews.updatedAt,
};

function trimOrNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t ? t : null;
}

function parseScheduledAt(v: string | Date | null | undefined): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error("scheduledAt must be ISO date");
  return d;
}

function parseStatus(v: string | undefined, fallback: InterviewStatus): InterviewStatus {
  if (v == null || v === "") return fallback;
  if (!(INTERVIEW_STATUSES as readonly string[]).includes(v)) throw new Error(`status must be ${INTERVIEW_STATUSES.join("|")}`);
  return v as InterviewStatus;
}

export async function listInterviews(positionId: string) {
  const db = await getDb();
  return db
    .select(INTERVIEW_ROW)
    .from(interviews)
    .where(eq(interviews.positionId, positionId))
    .orderBy(sql`${interviews.scheduledAt} asc nulls last`, desc(interviews.createdAt));
}

export async function addInterview(positionId: string, input: InterviewInput) {
  const stage = (input.stage || "screen").trim();
  if (!stage) throw new Error("stage required");
  const status = parseStatus(input.status, "pending");
  const scheduledAt = parseScheduledAt(input.scheduledAt);
  const db = await getDb();
  const iid = id("iv");
  const now = new Date();
  await db.insert(interviews).values({
    id: iid,
    positionId,
    stage,
    scheduledAt: scheduledAt === undefined ? null : scheduledAt,
    status,
    notes: trimOrNull(input.notes),
    metadata: {},
    createdAt: now,
    updatedAt: now,
  });
  const row = (await db.select(INTERVIEW_ROW).from(interviews).where(eq(interviews.id, iid)))[0];
  if (!row) throw new Error("interview insert failed");
  return row;
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
  const patch: { stage?: string; scheduledAt?: Date | null; status?: string; notes?: string | null; updatedAt: Date } = {
    updatedAt: new Date(),
  };
  if (input.stage !== undefined) {
    const stage = input.stage.trim();
    if (!stage) throw new Error("stage required");
    patch.stage = stage;
  }
  if (input.status !== undefined) patch.status = parseStatus(input.status, existing.status as InterviewStatus);
  if (input.scheduledAt !== undefined) patch.scheduledAt = parseScheduledAt(input.scheduledAt) ?? null;
  if (input.notes !== undefined) patch.notes = trimOrNull(input.notes);
  if (patch.stage === undefined && patch.status === undefined && patch.scheduledAt === undefined && patch.notes === undefined) {
    throw new Error("nothing to update");
  }
  await db.update(interviews).set(patch).where(eq(interviews.id, interviewId));
  const row = (await db.select(INTERVIEW_ROW).from(interviews).where(eq(interviews.id, interviewId)))[0];
  if (!row) throw new Error("interview update failed");
  return row;
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
