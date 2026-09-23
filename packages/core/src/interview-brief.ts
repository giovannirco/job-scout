import { eq } from "drizzle-orm";
import { getDb, interviews } from "@job-scout/db";
import { InterviewBriefOutput, buildInterviewBriefMessages } from "@job-scout/llm";
import { getEvaluation } from "./evaluate.js";
import { getInterview } from "./interviews.js";
import { gateOperation, getLlmClient, logged } from "./llm.js";
import { currentJdText, getPosition } from "./positions.js";
import { getSettings } from "./settings.js";
import { briefOf, getProfile } from "./profile.js";
import { addEvent } from "./timeline.js";

async function gateInterviewBrief() {
  const s = await getSettings();
  const own = s.llm.operations.interview_brief;
  const fallback = s.llm.operations.evaluate;
  if (own && own.enabled && !own.model && fallback?.model) {
    return gateOperation("evaluate").then((g) => ({ ...g, ...own, model: fallback.model, fallbackModel: g.fallbackModel }));
  }
  return gateOperation("interview_brief");
}

export async function runInterviewBrief(positionId: string, interviewId: string) {
  const pos = await getPosition(positionId);
  if (!pos) throw new Error("position not found");
  const round = await getInterview(positionId, interviewId);
  if (!round) throw new Error("interview not found");
  if (!round.transcriptMarkdown?.trim() && !round.notesMarkdown?.trim() && !round.notes?.trim()) {
    throw new Error("interview has no transcript or notes to brief");
  }
  const cfg = await gateInterviewBrief();
  const [profile, jdText, evaluation] = await Promise.all([
    getProfile(),
    currentJdText(pos.id),
    getEvaluation(pos.id, "evaluate"),
  ]);
  const evalJson = (evaluation?.json || null) as { headline?: string } | null;
  const messages = buildInterviewBriefMessages({
    stage: round.stage,
    title: round.title,
    interviewerName: round.interviewerName,
    interviewerRole: round.interviewerRole,
    outcome: round.outcome,
    positionTitle: pos.title,
    company: pos.company.name,
    url: pos.primaryUrl,
    locationRaw: pos.remoteClass,
    salaryRaw: pos.salaryRaw,
    jdText,
    companyOverview: pos.company.overview,
    evaluationHeadline: evalJson?.headline || null,
    identityMarkdown: profile.identityMarkdown || "",
    brief: briefOf(profile),
    notes: round.notes,
    notesMarkdown: round.notesMarkdown,
    reviewMarkdown: round.reviewMarkdown,
    transcriptMarkdown: round.transcriptMarkdown,
  });
  const res = await logged("interview_brief", cfg.model, pos.id, () =>
    getLlmClient().chatDocument({
      model: cfg.model,
      fallbackModel: cfg.fallbackModel,
      messages,
      schema: InterviewBriefOutput,
      schemaName: "interview_brief",
      temperature: cfg.temperature ?? 0.2,
      maxTokens: 7000,
    }),
    messages,
  );
  const db = await getDb();
  const now = new Date();
  await db
    .update(interviews)
    .set({
      aiBriefMarkdown: res.markdown,
      aiBriefJson: res.data as unknown as Record<string, unknown>,
      aiBriefModel: res.model,
      aiBriefedAt: now,
      updatedAt: now,
    })
    .where(eq(interviews.id, interviewId));
  await addEvent({
    positionId: pos.id,
    kind: "interview_brief",
    title: `AI brief (${round.stage}): ${res.data.headline.slice(0, 140)}`,
    body: res.data.headline,
    metadata: { interviewId, model: res.model, outcomeGuess: res.data.outcomeGuess, jdFitScore: res.data.jdFitScore },
    actor: "interview_brief",
  });
  return { interviewId, summary: res.data, model: res.model };
}
