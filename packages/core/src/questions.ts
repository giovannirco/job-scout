import { asc, desc, eq } from "drizzle-orm";
import { applicationQuestions, getDb, id, positions } from "@job-scout/db";
import type { AtsJob } from "@job-scout/ats";
import { normalizeQuestion, parseApplicationQuestions, type QuestionPrompt } from "@job-scout/ats";
import { parseListSort } from "@job-scout/shared";
import type { ChatMessage } from "@job-scout/llm";

export type { QuestionPrompt };
export { parseApplicationQuestions, normalizeQuestion };

export function promptsFromJob(job: AtsJob): QuestionPrompt[] {
  return (job.questions || []).map((q) => {
    const required = /\*\s*$/.test(q.trim());
    return { question: normalizeQuestion(q), required, inputType: "unknown" };
  }).filter((p) => p.question);
}

export async function harvestQuestions(positionId: string, prompts: QuestionPrompt[]): Promise<{ upserted: number }> {
  const db = await getDb();
  const incoming = new Set(prompts.map((p) => p.question.toLowerCase()));
  const existing = await db.select().from(applicationQuestions).where(eq(applicationQuestions.positionId, positionId));
  const byQ = new Map(existing.map((r) => [r.question.toLowerCase(), r]));
  let upserted = 0;
  const seen = new Set<string>();
  for (const [i, p] of prompts.entries()) {
    const key = p.question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const prev = byQ.get(key);
    if (!prev) {
      await db.insert(applicationQuestions).values({
        id: id("aq"),
        positionId,
        sortOrder: i,
        question: p.question,
        required: p.required,
        inputType: p.inputType,
        status: "open",
        source: "ats",
      });
      upserted++;
      continue;
    }
    const set: Record<string, unknown> = { sortOrder: i, required: p.required, inputType: p.inputType, updatedAt: new Date() };
    if (prev.status !== "open") {
      /* keep answer */
    }
    await db.update(applicationQuestions).set(set).where(eq(applicationQuestions.id, prev.id));
    upserted++;
  }
  for (const row of existing) {
    if (incoming.has(row.question.toLowerCase())) continue;
    if (row.status !== "open" || row.answer) {
      await db
        .update(applicationQuestions)
        .set({ metadata: { ...(row.metadata || {}), droppedAt: new Date().toISOString() }, updatedAt: new Date() })
        .where(eq(applicationQuestions.id, row.id));
    }
  }
  return { upserted };
}

export async function listQuestions(positionId: string, q: { sort?: string } = {}) {
  const db = await getDb();
  const { field, dir } = parseListSort(q.sort, ["sort", "question", "status"], "sort", "asc");
  const col =
    field === "question" ? applicationQuestions.question : field === "status" ? applicationQuestions.status : applicationQuestions.sortOrder;
  const order = dir === "asc" ? asc(col) : desc(col);
  return db.select().from(applicationQuestions).where(eq(applicationQuestions.positionId, positionId)).orderBy(order, applicationQuestions.id);
}

export async function harvestFromJob(positionId: string, job: AtsJob): Promise<{ upserted: number }> {
  const prompts = promptsFromJob(job);
  const upserted = prompts.length ? (await harvestQuestions(positionId, prompts)).upserted : 0;
  const db = await getDb();
  const pos = (await db.select({ metadata: positions.metadata }).from(positions).where(eq(positions.id, positionId)).limit(1))[0];
  const prev = (pos?.metadata || {}) as Record<string, unknown>;
  const forms = { ...((prev.forms as Record<string, unknown>) || {}) };
  if (job.formHarvestError) forms.harvestError = job.formHarvestError;
  else if (upserted > 0) delete forms.harvestError;
  forms.harvestedAt = new Date().toISOString();
  await db.update(positions).set({ metadata: { ...prev, forms }, updatedAt: new Date() }).where(eq(positions.id, positionId));
  return { upserted };
}

export async function patchQuestion(questionId: string, patch: { answer?: string | null; status?: string }) {
  const db = await getDb();
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.answer !== undefined) set.answer = patch.answer;
  if (patch.status) set.status = patch.status;
  await db.update(applicationQuestions).set(set).where(eq(applicationQuestions.id, questionId));
  return (await db.select().from(applicationQuestions).where(eq(applicationQuestions.id, questionId)).limit(1))[0] ?? null;
}

export async function runFormAnswers(positionId: string) {
  const { getPosition } = await import("./positions.js");
  const { currentJdText } = await import("./positions.js");
  const { getProfile, briefOf } = await import("./profile.js");
  const { gateOperation, getLlmClient, logged } = await import("./llm.js");
  const { z } = await import("zod");
  const pos = await getPosition(positionId);
  if (!pos) throw new Error("position not found");
  const open = (await listQuestions(positionId)).filter((q) => q.status === "open");
  if (!open.length) return { drafted: 0 };
  const cfg = await gateOperation("form_answers");
  const profile = await getProfile();
  const jdText = await currentJdText(positionId);
  const Schema = z.object({
    answers: z.array(z.object({ question: z.string(), answer: z.string() })),
  });
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "Draft honest application-form answers from the candidate profile and resume. Leave blank (empty string) for identity, legal, compensation, or anything not in the profile. Never invent metrics.",
    },
    {
      role: "user",
      content: JSON.stringify({
        company: pos.company.name,
        title: pos.title,
        brief: briefOf(profile),
        resume: (profile.masterResumeMarkdown || "").slice(0, 12000),
        jd: jdText.slice(0, 6000),
        questions: open.map((q) => q.question),
      }),
    },
  ];
  const res = await logged(
    "form_answers",
    cfg.model,
    positionId,
    () =>
      getLlmClient().chatJson({
        model: cfg.model,
        fallbackModel: cfg.fallbackModel,
        messages,
        schema: Schema,
        schemaName: "form_answers",
        temperature: cfg.temperature ?? 0.2,
        maxTokens: 4000,
      }),
    messages,
  );
  const byQ = new Map(res.data.answers.map((a) => [a.question.toLowerCase(), a.answer]));
  let drafted = 0;
  for (const q of open) {
    const answer = byQ.get(q.question.toLowerCase());
    if (answer == null || !answer.trim()) continue;
    await patchQuestion(q.id, { answer: answer.trim() });
    drafted++;
  }
  return { drafted, model: res.model };
}
