import { eq } from "drizzle-orm";
import { getDb, positions } from "@job-scout/db";
import { buildTriageMessages, TriageOutput, verdictFor } from "@job-scout/llm";
import { afterTriage } from "./autopilot.js";
import { gateOperation, getLlmClient, logged } from "./llm.js";
import { currentJdText, getPosition } from "./positions.js";
import { triageBriefOf, getProfile, profileFingerprint } from "./profile.js";
import { getSettings } from "./settings.js";
import { addEvent } from "./timeline.js";
import { log } from "@job-scout/shared";
import { ingestQuality } from "./metrics.js";
import { decisionListingOf, sameJevConfig, tryDecision } from "./decisions.js";
import { fastTriageOutput } from "./fast-triage.js";

/** Score one position and record the result. */
export async function runTriage(positionId: string, opts: { force?: boolean; refreshOnly?: boolean } = {}) {
  const pos = await getPosition(positionId);
  if (!pos) throw new Error("position not found");
  if (opts.refreshOnly && (!["triaged", "review"].includes(pos.status) || pos.listingStatus === "closed" || pos.metadata?.quarantined))
    return { skipped: true as const, reason: "position_no_longer_eligible", verdict: pos.triageVerdict };
  const profile = await getProfile();
  if (pos.triagedAt && pos.triageJson?.profileHash === profileFingerprint(profile) && !opts.force) return { skipped: true as const, reason: "already triaged", verdict: pos.triageVerdict };

  const settings = await getSettings();
  if (!settings.llm.operations.triage?.enabled) await gateOperation("triage", settings);
  const jdText = await currentJdText(pos.id);
  const listing = await decisionListingOf(pos, jdText);
  const ats = ((pos.metadata || {}) as { ats?: { workplaceType?: string | null } }).ats;

  const messages = buildTriageMessages({
    title: pos.title,
    company: pos.company.name,
    locationRaw: listing.location,
    workplaceType: ats?.workplaceType ?? null,
    salaryRaw: pos.salaryRaw,
    employmentType: pos.employmentType,
    jdText,
    brief: triageBriefOf(profile),
    jdMaxChars: settings.triage.jdMaxChars,
    passThreshold: settings.triage.passThreshold,
    marginalThreshold: settings.triage.marginalThreshold,
  });

  const decision = settings.jev.enabled && settings.jev.triage !== "off" ? await tryDecision({
    recipe: "triage", positionId: pos.id, mode: settings.jev.triage,
    state: { candidateEvidence: triageBriefOf(profile), listing },
  }) : null;
  const fast = settings.jev.triage === "apply" && sameJevConfig(settings.jev, (await getSettings({ fresh: true })).jev)
    ? fastTriageOutput(decision?.run ?? null, { salaryRaw: pos.salaryRaw, jdText, passThreshold: settings.triage.passThreshold }) : null;
  const runNormal = async () => {
    const cfg = await gateOperation("triage");
    return logged("triage", cfg.model, pos.id, () =>
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
  };
  const res = fast && decision?.run?.result ? { data: fast, model: decision.run.result.model, tokensIn: decision.run.result.inputTokens, tokensOut: decision.run.result.outputTokens } : await runNormal();
  const out = res.data;
  const score = Math.round(out.score * 10) / 10;
  if (score === 0) {
    ingestQuality.labels({ reason: "triage_zero_score" }).inc();
    log.warn("triage.score_anomaly", { positionId: pos.id, score, model: res.model, jdChars: jdText.length });
  }
  const verdict = verdictFor(score, out.hardDq, settings.triage);
  const db = await getDb();
  const now = new Date();
  const set: Record<string, unknown> = {
    triageScore: score,
    triageVerdict: verdict,
    triageJson: { ...out, verdict, model: res.model, at: now.toISOString(), profileHash: profileFingerprint(profile), ...(decision ? { jev: { runId: decision.run?.id, used: Boolean(fast), summary: decision.run?.summary, error: decision.error || decision.run?.error } } : {}) },
    triagedAt: now,
    triageModel: res.model,
    updatedAt: now,
  };
  // Only auto-archive fails that the operator has not touched.
  if (!opts.refreshOnly && verdict === "fail" && pos.status === "triaged") {
    set.status = "archived";
    set.archiveReason = `triage fail ${score.toFixed(1)}: ${out.hardDq[0] || out.oneLiner}`.slice(0, 300);
  }
  if (!opts.refreshOnly && verdict === "marginal" && pos.status === "triaged" && !settings.triage.keepMarginal) {
    set.status = "archived";
    set.archiveReason = `triage marginal ${score.toFixed(1)}`;
  }
  const profileChanged = profileFingerprint(await getProfile()) !== profileFingerprint(profile);
  if (profileChanged && fast) return { skipped: true as const, reason: "profile_changed", verdict: pos.triageVerdict };
  if (profileChanged) { delete set.status; delete set.archiveReason; }
  const completion = await db.transaction(async tx => {
    const current = (await tx.select().from(positions).where(eq(positions.id, pos.id)).for("update")).at(0);
    if (!current || current.updatedAt.getTime() !== pos.updatedAt.getTime() || current.contentHash !== pos.contentHash || current.status !== pos.status || current.listingStatus !== pos.listingStatus) {
      const retryable = Boolean(current && !current.triagedAt && current.status === pos.status && ["triaged", "review"].includes(current.status)
        && current.listingStatus !== "closed" && !current.metadata?.quarantined);
      return { applied: false, retryable };
    }
    await tx.update(positions).set(set).where(eq(positions.id, pos.id));
    return { applied: true, retryable: false };
  });
  if (!completion.applied) return { skipped: true as const, reason: "position_changed", verdict: pos.triageVerdict, retryable: completion.retryable };
  await addEvent({
    positionId: pos.id,
    kind: "triage",
    title: `Triage ${verdict.toUpperCase()} ${score.toFixed(1)}`,
    body: out.oneLiner,
    metadata: { model: res.model, tokensIn: res.tokensIn, tokensOut: res.tokensOut },
  });
  const auto = opts.refreshOnly || profileChanged ? {} : await afterTriage({
    positionId: pos.id,
    companyId: pos.companyId,
    score,
    verdict,
    status: (set.status as typeof pos.status | undefined) ?? pos.status,
  });
  if (verdict === "pass" && !opts.refreshOnly && !profileChanged) {
    const { emitNotify } = await import("./notify.js");
    await emitNotify({
      event: "triage_pass",
      title: pos.title,
      company: pos.company.name,
      slug: pos.slug,
      score,
      url: pos.primaryUrl,
      extra: out.oneLiner,
      positionId: pos.id,
      companyId: pos.companyId,
      subjectId: pos.id,
    });
  }
  return { skipped: false as const, score, verdict, oneLiner: out.oneLiner, model: res.model, ...auto };
}
