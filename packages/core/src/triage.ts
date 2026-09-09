import { eq } from "drizzle-orm";
import { getDb, positions } from "@job-scout/db";
import { buildTriageMessages, TriageOutput, verdictFor } from "@job-scout/llm";
import { afterTriage } from "./autopilot.js";
import { gateOperation, getLlmClient, logged } from "./llm.js";
import { currentJdText, getPosition } from "./positions.js";
import { briefOf, getProfile, profileFingerprint } from "./profile.js";
import { getSettings } from "./settings.js";
import { addEvent } from "./timeline.js";

/** Run LLM triage for one position and persist score/verdict/json. */
export async function runTriage(positionId: string, opts: { force?: boolean } = {}) {
  const pos = await getPosition(positionId);
  if (!pos) throw new Error("position not found");
  if (pos.triagedAt && !opts.force) return { skipped: true as const, reason: "already triaged", verdict: pos.triageVerdict };

  const settings = await getSettings();
  const cfg = await gateOperation("triage", settings);
  const profile = await getProfile();
  const jdText = await currentJdText(pos.id);
  const ats = ((pos.metadata || {}) as { ats?: { workplaceType?: string | null } }).ats;

  const messages = buildTriageMessages({
    title: pos.title,
    company: pos.company.name,
    locationRaw: pos.geoNotes ? `${pos.remoteClass || ""} ${pos.geoNotes}` : (await locationOf(pos.id)) || pos.remoteClass,
    workplaceType: ats?.workplaceType ?? null,
    salaryRaw: pos.salaryRaw,
    employmentType: pos.employmentType,
    jdText,
    brief: briefOf(profile),
    jdMaxChars: settings.triage.jdMaxChars,
    passThreshold: settings.triage.passThreshold,
    marginalThreshold: settings.triage.marginalThreshold,
  });

  const res = await logged("triage", cfg.model, pos.id, () =>
    getLlmClient().chatJson({
      model: cfg.model,
      fallbackModel: cfg.fallbackModel,
      messages,
      schema: TriageOutput,
      schemaName: "triage",
      temperature: cfg.temperature ?? 0.1,
      maxTokens: 900,
    }),
    messages,
  );
  const out = res.data;
  const score = Math.round(out.score * 10) / 10;
  const verdict = verdictFor(score, out.hardDq, settings.triage);
  const db = await getDb();
  const now = new Date();
  const set: Record<string, unknown> = {
    triageScore: score,
    triageVerdict: verdict,
    triageJson: { ...out, verdict, model: res.model, at: now.toISOString(), profileHash: profileFingerprint(profile) },
    triagedAt: now,
    triageModel: res.model,
    updatedAt: now,
  };
  // Only auto-archive fails that the operator has not touched.
  if (verdict === "fail" && pos.status === "triaged") {
    set.status = "archived";
    set.archiveReason = `triage fail ${score.toFixed(1)}: ${out.hardDq[0] || out.oneLiner}`.slice(0, 300);
  }
  if (verdict === "marginal" && pos.status === "triaged" && !settings.triage.keepMarginal) {
    set.status = "archived";
    set.archiveReason = `triage marginal ${score.toFixed(1)}`;
  }
  await db.update(positions).set(set).where(eq(positions.id, pos.id));
  await addEvent({
    positionId: pos.id,
    kind: "triage",
    title: `Triage ${verdict.toUpperCase()} ${score.toFixed(1)}`,
    body: out.oneLiner,
    metadata: { model: res.model, tokensIn: res.tokensIn, tokensOut: res.tokensOut },
  });
  const auto = await afterTriage({
    positionId: pos.id,
    companyId: pos.companyId,
    score,
    verdict,
    status: (set.status as typeof pos.status | undefined) ?? pos.status,
  });
  return { skipped: false as const, score, verdict, oneLiner: out.oneLiner, model: res.model, ...auto };
}

async function locationOf(positionId: string): Promise<string | null> {
  const db = await getDb();
  const { jdRevisions } = await import("@job-scout/db");
  const { desc } = await import("drizzle-orm");
  const r = (
    await db
      .select({ l: jdRevisions.locationRaw })
      .from(jdRevisions)
      .where(eq(jdRevisions.positionId, positionId))
      .orderBy(desc(jdRevisions.revision))
      .limit(1)
  )[0];
  return r?.l ?? null;
}
