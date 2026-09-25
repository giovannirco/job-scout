import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { decisionRuns, getDb, id, jdRevisions, positions, settings as settingsTable } from "@job-scout/db";
import { DecisionError, requestDecision } from "@job-scout/llm";
import { resolveSettings, type DecisionRecipe, type DecisionRecord, type JevConfig } from "@job-scout/shared";
import { getSettings } from "./settings.js";
import { currentJdText, getPosition, listPositions } from "./positions.js";
import { getProfile, profileFingerprint, triageBriefOf } from "./profile.js";
import { DECISION_RECIPE_VERSION, decisionQuestions, summarizeDecision } from "./decision-recipes.js";

const key = () => process.env.OPENROUTER_API_KEY || "";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const dto = (row: typeof decisionRuns.$inferSelect): DecisionRecord => ({ ...row, createdAt: row.createdAt.toISOString() });
const startOfDay = () => { const date = new Date(); date.setUTCHours(0, 0, 0, 0); return date; };

export async function runDecision(input: { recipe: DecisionRecipe; state: unknown; positionId?: string; mode?: string; fresh?: boolean }): Promise<DecisionRecord> {
  const db = await getDb();
  const cfg = (await getSettings({ fresh: true })).jev;
  if (!cfg.enabled) throw new DecisionError("disabled", "Enable Jev in Settings > AI models first.");
  if (!key()) throw new DecisionError("not_configured", "Set OPENROUTER_API_KEY on the server to connect Jev.");
  if (JSON.stringify(input.state).length > cfg.maxStateChars) throw new DecisionError("input_limit", "This input exceeds the Jev context limit in Settings. The full input was kept out of the request.");
  const questions = decisionQuestions(input.recipe);
  const inputHash = hash({ version: DECISION_RECIPE_VERSION, config: cfg, recipe: input.recipe, positionId: input.positionId, state: input.state, questions });
  const reservation = await db.transaction(async tx => {
    await tx.insert(settingsTable).values({ id: "default", data: {} }).onConflictDoNothing();
    const locked = (await tx.select().from(settingsTable).where(eq(settingsTable.id, "default")).for("update"))[0];
    if (hash(resolveSettings(locked.data).jev) !== hash(cfg)) throw new DecisionError("settings_changed", "Jev settings changed. Try again with the saved settings.");
    if (!input.fresh && cfg.cacheMinutes > 0) {
      const cached = (await tx.select().from(decisionRuns).where(and(eq(decisionRuns.inputHash, inputHash), eq(decisionRuns.status, "ok"), gte(decisionRuns.createdAt, new Date(Date.now() - cfg.cacheMinutes * 60_000)))).orderBy(desc(decisionRuns.createdAt)).limit(1)).at(0);
      if (cached) return { cached: dto(cached) };
    }
    const pending = (await tx.select({ id: decisionRuns.id }).from(decisionRuns).where(and(eq(decisionRuns.inputHash, inputHash), eq(decisionRuns.status, "running"), gte(decisionRuns.createdAt, new Date(Date.now() - cfg.timeoutMs - 5000)))).limit(1)).at(0);
    if (pending) throw new DecisionError("in_progress", "This decision is already running.");
    const count = (await tx.select({ n: sql<number>`count(*)::int` }).from(decisionRuns).where(gte(decisionRuns.createdAt, startOfDay())))[0].n;
    if (count >= cfg.dailyCalls) throw new DecisionError("daily_cap", `Jev reached its daily limit of ${cfg.dailyCalls} requests.`);
    const runId = id("dec");
    await tx.insert(decisionRuns).values({ id: runId, recipe: input.recipe, positionId: input.positionId, mode: input.mode ?? "preview", status: "running", model: cfg.model, inputHash });
    return { runId };
  });
  if (reservation.cached) return { ...reservation.cached, cached: true };
  const runId = reservation.runId!;
  try {
    const result = await requestDecision({ apiKey: key(), model: cfg.model, state: input.state, questions, timeoutMs: cfg.timeoutMs });
    const summary = summarizeDecision(input.recipe, result, cfg);
    const rows = await db.update(decisionRuns).set({ status: "ok", model: result.model, result, summary }).where(eq(decisionRuns.id, runId)).returning();
    return dto(rows[0]);
  } catch (error) {
    const message = error instanceof DecisionError ? error.message : "Jev could not complete this decision.";
    const rows = await db.update(decisionRuns).set({ status: "error", error: message }).where(eq(decisionRuns.id, runId)).returning();
    return dto(rows[0]);
  }
}

export async function decisionListingOf(position: NonNullable<Awaited<ReturnType<typeof getPosition>>>, description: string) {
  const db = await getDb();
  const revision = (await db.select({ location: jdRevisions.locationRaw }).from(jdRevisions).where(eq(jdRevisions.positionId, position.id)).orderBy(desc(jdRevisions.revision)).limit(1)).at(0);
  const location = position.geoNotes ? [position.remoteClass, position.geoNotes].filter(Boolean).join(" ") : revision?.location || position.remoteClass;
  return { title: position.title, company: position.company.name, companyOverview: position.company.overview, location, salary: position.salaryRaw, employmentType: position.employmentType, description };
}

export async function decisionContext(positionId: string) {
  const position = await getPosition(positionId);
  if (!position) throw new DecisionError("not_found", "Position not found.");
  const profile = await getProfile();
  const jdText = await currentJdText(position.id);
  return { position, profile, state: {
    candidateEvidence: triageBriefOf(profile),
    listing: await decisionListingOf(position, jdText),
  } };
}

export async function previewDecision(recipe: DecisionRecipe, positionId?: string, fresh = false) {
  if (recipe === "connection_test") return runDecision({ recipe, state: "The project uses TypeScript.", fresh: true });
  if (!positionId) throw new DecisionError("position_required", "Choose a position first.");
  const { position, profile, state } = await decisionContext(positionId);
  let input: unknown = state;
  if (recipe === "evaluation_check") {
    const { getEvaluation } = await import("./evaluate.js");
    const evaluation = await getEvaluation(position.id, "evaluate");
    if (!evaluation) throw new DecisionError("missing_draft", "This position has no evaluation to check.");
    input = { ...state, draft: evaluation.markdown };
  }
  if (recipe === "materials_check") {
    const { getCurrentMaterial } = await import("./materials.js");
    const resume = await getCurrentMaterial(position.id, "resume"), cover = await getCurrentMaterial(position.id, "cover");
    if (!resume && !cover) throw new DecisionError("missing_draft", "This position has no materials to check.");
    input = { ...state, candidateEvidence: [state.candidateEvidence, profile.masterCoverMarkdown].filter(Boolean).join("\n\n"), draft: [resume?.bodyMarkdown, cover?.bodyMarkdown].filter(Boolean).join("\n\n") };
  }
  return runDecision({ recipe, state: input, positionId: position.id, fresh });
}

export async function tryDecision(input: Parameters<typeof runDecision>[0]) {
  try { return { run: await runDecision(input), error: null }; }
  catch (error) { return { run: null, error: error instanceof DecisionError ? error.message : "Jev is unavailable. The normal workflow will continue." }; }
}

export async function verificationFor(input: { recipe: "evaluation_check" | "materials_check"; positionId: string; candidateEvidence: string; listing: unknown; draft: string }) {
  const cfg = (await getSettings({ fresh: true })).jev;
  if (!cfg.enabled || cfg.verification === "off") return null;
  const { run, error } = await tryDecision({ recipe: input.recipe, positionId: input.positionId, mode: cfg.verification, state: { candidateEvidence: input.candidateEvidence, listing: input.listing, draft: input.draft } });
  const current = (await getSettings({ fresh: true })).jev;
  const changed = hash(current) !== hash(cfg);
  return { runId: run?.id ?? null, mode: cfg.verification, accepted: run?.summary?.accepted === true && !changed, hold: (cfg.verification === "apply" || (current.enabled && current.verification === "apply")) && (run?.summary?.accepted !== true || changed), error: changed ? "Jev settings changed during this check." : error || run?.error || null, summary: run?.summary ?? null };
}

export async function jevStatus() {
  const db = await getDb();
  const cfg = (await getSettings({ fresh: true })).jev;
  const today = (await db.select({ calls: sql<number>`count(*)::int`, errors: sql<number>`count(*) filter (where ${decisionRuns.status} = 'error')::int`, cost: sql<number>`coalesce(sum((${decisionRuns.result}->>'cost')::numeric),0)::float`, tokens: sql<number>`coalesce(sum((${decisionRuns.result}->>'inputTokens')::int),0)::int` }).from(decisionRuns).where(gte(decisionRuns.createdAt, startOfDay())))[0];
  return { config: cfg, configured: Boolean(key()), endpoint: "https://openrouter.ai/api/alpha/decisions", today };
}

export async function recentDecisions(positionId?: string) {
  const db = await getDb();
  const rows = await db.select().from(decisionRuns).where(positionId ? eq(decisionRuns.positionId, positionId) : undefined).orderBy(desc(decisionRuns.createdAt), desc(decisionRuns.id)).limit(50);
  return rows.map(dto);
}

export async function decisionFeedback(runId: string, feedback: "agree" | "disagree" | null) {
  const db = await getDb();
  const rows = await db.update(decisionRuns).set({ feedback }).where(and(eq(decisionRuns.id, runId), eq(decisionRuns.status, "ok"))).returning();
  if (!rows.length) throw new DecisionError("not_found", "Completed decision not found.");
  return dto(rows[0]);
}

export async function rankReviewQueue(limit = 10) {
  const cfg = (await getSettings({ fresh: true })).jev;
  if (!cfg.enabled || !cfg.ranking) throw new DecisionError("disabled", "Enable Jev ranking in Settings > AI models first.");
  const candidates = await listPositions({ status: "triaged,review", pageSize: String(Math.min(20, Math.max(1, limit))), sort: "score_desc", actionable: "true", collapseFamilies: "true" });
  const rows = [];
  const sourceProfile = profileFingerprint(await getProfile());
  for (const position of candidates.items) {
    const { state, position: source } = await decisionContext(position.id);
    const decision = await tryDecision({ recipe: "ranking", state, positionId: position.id, mode: "ranking" });
    rows.push({ sourceUpdatedAt: source.updatedAt.getTime(), positionId: position.id, title: position.title, slug: position.slug, triageScore: position.triageScore, run: decision.run, error: decision.error });
  }
  const db = await getDb();
  if (profileFingerprint(await getProfile()) !== sourceProfile) throw new DecisionError("profile_changed", "Your profile changed during ranking. Run it again with the current profile.");
  const current = rows.length ? await db.select().from(positions).where(inArray(positions.id, rows.map(r => r.positionId))) : [];
  const active = new Map(current.filter(p => ["triaged", "review"].includes(p.status) && p.listingStatus !== "closed" && !p.metadata?.quarantined).map(p => [p.id, p.updatedAt.getTime()]));
  return { total: candidates.total, rows: rows.filter(r => active.get(r.positionId) === r.sourceUpdatedAt).sort((a, b) => rankGroup(b.run) - rankGroup(a.run) || (b.run?.summary?.score ?? -1) - (a.run?.summary?.score ?? -1)).map(({ sourceUpdatedAt: _, ...row }) => row) };
}

export function sameJevConfig(a: JevConfig, b: JevConfig) { return hash(a) === hash(b); }

function rankGroup(run: DecisionRecord | null): number {
  if (run?.summary?.accepted) return 3;
  if (run?.status !== "ok") return 0;
  const eligibility = run.result?.answers.eligible;
  const requirements = run.result?.answers.requirements;
  if (run.summary?.route === "mismatch" || (eligibility?.type === "noul" && eligibility.noul < 0.5) || (requirements?.type === "noul" && requirements.noul < 0.5)) return 1;
  return 2;
}
