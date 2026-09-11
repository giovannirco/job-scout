import { and, desc, eq } from "drizzle-orm";
import { evaluations, getDb, id, positions, timelineEvents, type EvaluationKind, type PositionStatus } from "@job-scout/db";
import {
  buildCompanyResearchMessages,
  buildEvaluateMessages,
  buildJdReviewMessages,
  CompanyResearchOutput,
  EvaluateOutput,
  JdReviewOutput,
} from "@job-scout/llm";
import { buildAtsKeywordChecklist } from "@job-scout/shared";
import { afterEvaluate } from "./autopilot.js";
import { getCompany } from "./companies.js";
import { gateOperation, getLlmClient, logged } from "./llm.js";
import { currentJdText, getPosition } from "./positions.js";
import { briefOf, getProfile, profileFingerprint } from "./profile.js";
import { addEvent } from "./timeline.js";

export async function getEvaluation(positionId: string, kind: EvaluationKind) {
  const db = await getDb();
  return (
    await db
      .select()
      .from(evaluations)
      .where(and(eq(evaluations.positionId, positionId), eq(evaluations.kind, kind)))
      .orderBy(desc(evaluations.createdAt))
      .limit(1)
  )[0] ?? null;
}

export async function getEvaluationById(evalId: string) {
  const db = await getDb();
  return (await db.select().from(evaluations).where(eq(evaluations.id, evalId)).limit(1))[0] ?? null;
}

export function nextStatusAfterEvaluate(status: PositionStatus): PositionStatus {
  if (status === "triaged") return "review";
  return status;
}

export async function runEvaluate(positionId: string, opts: { auto?: boolean } = {}) {
  const pos = await getPosition(positionId);
  if (!pos) throw new Error("position not found");
  if (opts.auto && (!["triaged", "review"].includes(pos.status) || pos.listingStatus === "closed" || pos.metadata?.quarantined)) {
    return { skipped: true, reason: "position_no_longer_eligible" };
  }
  const cfg = await gateOperation("evaluate");
  const profile = await getProfile();
  const jdText = await currentJdText(pos.id);
  const messages = buildEvaluateMessages({
    title: pos.title,
    company: pos.company.name,
    companyOverview: pos.company.overview,
    url: pos.primaryUrl,
    locationRaw: pos.remoteClass,
    salaryRaw: pos.salaryRaw,
    jdText,
    identityMarkdown: profile.identityMarkdown || "",
    masterResumeMarkdown: profile.masterResumeMarkdown || "",
    brief: briefOf(profile),
    triageJson: pos.triageJson,
  });
  const res = await logged("evaluate", cfg.model, pos.id, () =>
    getLlmClient().chatDocument({ model: cfg.model, fallbackModel: cfg.fallbackModel, messages, schema: EvaluateOutput, schemaName: "evaluate", temperature: cfg.temperature ?? 0.3, maxTokens: 9000 }),
    messages,
  );
  const db = await getDb();
  const evalId = id("ev");
  const profileHash = profileFingerprint(profile);
  const profileChanged = profileFingerprint(await getProfile()) !== profileHash;
  // Never hold a database lock during the model call. Revalidate under lock when
  // it returns; keep the report even when an operator decision superseded it.
  const completion = await db.transaction(async tx => {
    const current = (await tx.select().from(positions).where(eq(positions.id, pos.id)).limit(1).for("update"))[0];
    if (!current) throw new Error("position removed during evaluation");
    const stale = profileChanged || current.updatedAt.getTime() !== pos.updatedAt.getTime()
      || current.status !== pos.status || current.listingStatus !== pos.listingStatus || current.contentHash !== pos.contentHash
      || Boolean(current.metadata?.quarantined) !== Boolean(pos.metadata?.quarantined);
    await tx.insert(evaluations).values({
      id: evalId,
      positionId: pos.id,
      companyId: pos.companyId,
      kind: "evaluate",
      model: res.model,
      markdown: res.markdown,
      json: { ...res.data, profileHash, staleAtCompletion: stale, sourcePositionUpdatedAt: pos.updatedAt.toISOString() },
      tokensIn: res.tokensIn,
      tokensOut: res.tokensOut,
      latencyMs: res.latencyMs,
    });
    const status = stale || current.listingStatus === "closed" || current.metadata?.quarantined ? current.status : nextStatusAfterEvaluate(current.status);
    const updatedAt = status !== current.status ? new Date() : current.updatedAt;
    if (status !== current.status) {
      await tx.update(positions).set({ status, archiveReason: null, updatedAt }).where(eq(positions.id, pos.id));
      await tx.insert(timelineEvents).values({ id: id("tl"), positionId: pos.id, kind: "status", title: `${current.status} → ${status}`, actor: "evaluate" });
    }
    await tx.insert(timelineEvents).values({
      id: id("tl"),
      positionId: pos.id,
      kind: "evaluate",
      title: `Evaluation ${res.data.verdict} ${res.data.score.toFixed(1)}`,
      body: res.data.headline,
      metadata: { evaluationId: evalId, model: res.model, staleAtCompletion: stale },
    });
    return { status, updatedAt: updatedAt.toISOString(), stale };
  });
  const auto = completion.stale ? { autopilotSkipped: "evaluation_superseded" } : await afterEvaluate({
    positionId: pos.id,
    companyId: pos.companyId,
    evaluationId: evalId,
    score: res.data.score,
    verdict: res.data.verdict,
    headline: res.data.headline,
    status: completion.status,
    expectedUpdatedAt: completion.updatedAt,
  });
  return { evaluationId: evalId, summary: res.data, model: res.model, staleAtCompletion: completion.stale, ...auto };
}

export async function runJdReview(positionId: string) {
  const pos = await getPosition(positionId);
  if (!pos) throw new Error("position not found");
  const cfg = await gateOperation("jd_review");
  const profile = await getProfile();
  const jdText = await currentJdText(pos.id);
  const checklist = buildAtsKeywordChecklist({ jdText, materialsText: profile.masterResumeMarkdown || "" });
  const messages = buildJdReviewMessages({
    title: pos.title,
    company: pos.company.name,
    jdText,
    masterResumeMarkdown: profile.masterResumeMarkdown || "",
    atsKeywords: checklist.items.filter((i) => i.inJd).map((i) => i.term).slice(0, 40),
  });
  const res = await logged("jd_review", cfg.model, pos.id, () =>
    getLlmClient().chatDocument({ model: cfg.model, fallbackModel: cfg.fallbackModel, messages, schema: JdReviewOutput, schemaName: "jd_review", temperature: cfg.temperature ?? 0.2, maxTokens: 5000 }),
    messages,
  );
  const db = await getDb();
  const evalId = id("ev");
  await db.insert(evaluations).values({
    id: evalId,
    positionId: pos.id,
    companyId: pos.companyId,
    kind: "jd_review",
    model: res.model,
    markdown: res.markdown,
    json: res.data,
    tokensIn: res.tokensIn,
    tokensOut: res.tokensOut,
    latencyMs: res.latencyMs,
  });
  await addEvent({ positionId: pos.id, kind: "jd_review", title: `JD review ${res.data.score.toFixed(1)}`, metadata: { evaluationId: evalId } });
  return { evaluationId: evalId, summary: res.data, model: res.model };
}

export async function runCompanyResearch(companyIdOrSlug: string, positionId?: string | null) {
  const company = await getCompany(companyIdOrSlug);
  if (!company) throw new Error("company not found");
  const cfg = await gateOperation("company_research");
  const sampleJd = positionId ? await currentJdText(positionId) : company.positions[0] ? await currentJdText(company.positions[0].id) : null;
  const messages = buildCompanyResearchMessages({
    company: company.name,
    website: company.website,
    careersUrl: company.careersUrl,
    knownOverview: company.overview,
    openTitles: company.positions.filter((p) => p.listingStatus !== "closed").map((p) => p.title),
    sampleJd,
  });
  const res = await logged("company_research", cfg.model, positionId ?? null, () =>
    getLlmClient().chatDocument({ model: cfg.model, fallbackModel: cfg.fallbackModel, messages, schema: CompanyResearchOutput, schemaName: "company_research", temperature: cfg.temperature ?? 0.3, maxTokens: 4000 }),
    messages,
  );
  const db = await getDb();
  const evalId = id("ev");
  await db.insert(evaluations).values({
    id: evalId,
    positionId: positionId ?? null,
    companyId: company.id,
    kind: "company_research",
    model: res.model,
    markdown: res.markdown,
    json: res.data,
    tokensIn: res.tokensIn,
    tokensOut: res.tokensOut,
    latencyMs: res.latencyMs,
  });
  const { companies } = await import("@job-scout/db");
  await db
    .update(companies)
    .set({ overview: company.overview || res.data.oneLiner, updatedAt: new Date() })
    .where(eq(companies.id, company.id));
  if (positionId) await addEvent({ positionId, kind: "company_research", title: `Company research: ${company.name}`, metadata: { evaluationId: evalId } });
  return { evaluationId: evalId, summary: res.data, model: res.model };
}
