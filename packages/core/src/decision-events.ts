import { and, desc, eq, gt } from "drizzle-orm";
import { getDb, jdRevisions } from "@job-scout/db";
import { DecisionError } from "@job-scout/llm";
import { decisionContext, runDecision } from "./decisions.js";
import { enqueueJob } from "./jobs.js";
import { getPosition } from "./positions.js";
import { getSettings } from "./settings.js";
import { addEvent } from "./timeline.js";

const active = (position: NonNullable<Awaited<ReturnType<typeof getPosition>>>) =>
  position.listingStatus !== "closed" && !["archived", "rejected", "skip"].includes(position.status) && !position.metadata?.quarantined;

/** Queue a read-only fit check independently of writing-model automation. */
export async function enqueuePositionDecision(positionId: string, revision: number) {
  const cfg = (await getSettings()).jev;
  if (!cfg.enabled || cfg.triage === "off") return null;
  const position = await getPosition(positionId);
  if (!position || !active(position)) return null;
  return enqueueJob("jev_check", { positionId, revision, trigger: revision === 1 ? "new_position" : "jd_change" },
    { dedupeKey: `jev:${positionId}:${revision}`, priority: 75 });
}

export async function runPositionDecision(positionId: string, revision: number) {
  const cfg = (await getSettings({ fresh: true })).jev;
  if (!cfg.enabled || cfg.triage === "off") return { skipped: "disabled" };
  const position = await getPosition(positionId);
  if (!position || !active(position)) return { skipped: "position_no_longer_eligible" };
  const latest = (await (await getDb()).select().from(jdRevisions).where(eq(jdRevisions.positionId, position.id))
    .orderBy(desc(jdRevisions.revision)).limit(1)).at(0);
  if (!latest || latest.revision < revision) return { skipped: "revision_superseded" };
  if (latest.revision > revision) {
    const newer = (await (await getDb()).select({ id: jdRevisions.id }).from(jdRevisions)
      .where(and(eq(jdRevisions.positionId, position.id), gt(jdRevisions.revision, revision), eq(jdRevisions.material, true))).limit(1)).at(0);
    if (newer) return { skipped: "revision_superseded" };
  }
  if (!latest.descriptionText?.trim()) return { skipped: "missing_description" };
  const { state } = await decisionContext(position.id);
  try {
    const run = await runDecision({ recipe: "triage", positionId: position.id, mode: cfg.triage, state });
    if (!run.cached) await addEvent({ positionId: position.id, kind: "jev_check", title: "Jev job-fit check",
      body: run.error || `Result: ${run.summary?.route ?? "unknown"}. This check does not change the pipeline stage.`,
      metadata: { decisionRunId: run.id, revision, trigger: revision === 1 ? "new_position" : "jd_change" } });
    return { decisionRunId: run.id, status: run.status, cached: Boolean(run.cached), revision };
  } catch (error) {
    if (!(error instanceof DecisionError)) throw error;
    return { skipped: error.code, reason: error.message, revision };
  }
}
