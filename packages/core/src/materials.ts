import { and, desc, eq, sql } from "drizzle-orm";
import { applicationMaterials, getDb, id, positions, type Db } from "@job-scout/db";
import { buildMaterialsMessages, MaterialsOutput } from "@job-scout/llm";
import { buildAtsKeywordChecklist } from "@job-scout/shared";
import { afterMaterials } from "./autopilot.js";
import { getEvaluation } from "./evaluate.js";
import { gateOperation, getLlmClient, logged } from "./llm.js";
import { currentJdText, getPosition } from "./positions.js";
import { getProfile, profileFingerprint, triageBriefOf } from "./profile.js";
import { addEvent } from "./timeline.js";
import { decisionListingOf, verificationFor } from "./decisions.js";

export async function listMaterials(positionId: string) {
  const db = await getDb();
  return db
    .select({
      id: applicationMaterials.id,
      kind: applicationMaterials.kind,
      version: applicationMaterials.version,
      isCurrent: applicationMaterials.isCurrent,
      status: applicationMaterials.status,
      title: applicationMaterials.title,
      model: applicationMaterials.model,
      notes: applicationMaterials.notes,
      createdAt: applicationMaterials.createdAt,
      hasPdf: sql<boolean>`${applicationMaterials.pdfBase64} is not null`,
    })
    .from(applicationMaterials)
    .where(eq(applicationMaterials.positionId, positionId))
    .orderBy(desc(applicationMaterials.createdAt));
}

export async function getMaterial(materialId: string) {
  const db = await getDb();
  return (await db.select().from(applicationMaterials).where(eq(applicationMaterials.id, materialId)).limit(1)).at(0) ?? null;
}

export async function getCurrentMaterial(positionId: string, kind: "resume" | "cover") {
  const db = await getDb();
  return (
    await db
      .select()
      .from(applicationMaterials)
      .where(and(eq(applicationMaterials.positionId, positionId), eq(applicationMaterials.kind, kind), eq(applicationMaterials.isCurrent, true)))
      .orderBy(desc(applicationMaterials.version))
      .limit(1)
  ).at(0) ?? null;
}

type MaterialDb = Pick<Db, "select" | "insert" | "update">;

async function nextVersion(db: MaterialDb, positionId: string, kind: string) {
  const r = (
    await db
      .select({ v: sql<number>`coalesce(max(${applicationMaterials.version}),0)::int` })
      .from(applicationMaterials)
      .where(and(eq(applicationMaterials.positionId, positionId), eq(applicationMaterials.kind, kind)))
  )[0];
  return (r?.v ?? 0) + 1;
}

/** Store a material version (LLM or human-written) and make it current. */
type MaterialInput = {
  positionId: string;
  kind: "resume" | "cover";
  bodyMarkdown: string;
  title?: string | null;
  model?: string | null;
  source?: string;
  notes?: string | null;
  pdfBase64?: string | null;
  pdfFileName?: string | null;
  metadata?: Record<string, unknown>;
  needsReview?: boolean;
};

export async function saveMaterial(input: MaterialInput) {
  const db = await getDb();
  return db.transaction(async tx => {
    await tx.select({ id: positions.id }).from(positions).where(eq(positions.id, input.positionId)).for("update");
    return storeMaterial(tx, input);
  });
}

async function storeMaterial(db: MaterialDb, input: MaterialInput, makeCurrent = true) {
  const version = await nextVersion(db, input.positionId, input.kind);
  if (makeCurrent) await db
    .update(applicationMaterials)
    .set({ isCurrent: false })
    .where(and(eq(applicationMaterials.positionId, input.positionId), eq(applicationMaterials.kind, input.kind)));
  const mid = id("mat");
  await db.insert(applicationMaterials).values({
    id: mid,
    positionId: input.positionId,
    kind: input.kind,
    version,
    isCurrent: makeCurrent,
    status: input.needsReview ? "pending" : "ready",
    title: input.title ?? null,
    bodyMarkdown: input.bodyMarkdown,
    pdfBase64: input.pdfBase64 ?? null,
    pdfFileName: input.pdfFileName ?? null,
    model: input.model ?? null,
    source: input.source ?? "llm",
    notes: input.notes ?? null,
    metadata: input.metadata ?? {},
  });
  return { id: mid, version };
}

export async function runMaterials(positionId: string, opts: { surface?: string | null; auto?: boolean } = {}) {
  const pos = await getPosition(positionId);
  if (!pos) throw new Error("position not found");
  const cfg = await gateOperation("materials");
  const profile = await getProfile();
  const jdText = await currentJdText(pos.id);
  const listing = await decisionListingOf(pos, jdText);
  const evaluation = await getEvaluation(pos.id, "evaluate");
  const sourceResume = await getCurrentMaterial(pos.id, "resume");
  const sourceCover = await getCurrentMaterial(pos.id, "cover");
  const checklist = buildAtsKeywordChecklist({ jdText, materialsText: profile.masterResumeMarkdown || "" });
  const messages = buildMaterialsMessages({
    title: pos.title,
    company: pos.company.name,
    jdText,
    identityMarkdown: profile.identityMarkdown || "",
    masterResumeMarkdown: profile.masterResumeMarkdown || "",
    masterCoverMarkdown: profile.masterCoverMarkdown,
    resumeSurfaces: (profile.resumeSurfaces || {}) as Record<string, string>,
    preferredSurface: opts.surface || pos.resumeSurface,
    evaluationMarkdown: evaluation?.markdown,
    atsKeywords: checklist.items.filter((i) => i.inJd).map((i) => i.term).slice(0, 40),
  });
  const res = await logged("materials", cfg.model, pos.id, () =>
    getLlmClient().chatDocument({ model: cfg.model, fallbackModel: cfg.fallbackModel, messages, schema: MaterialsOutput, schemaName: "materials", sections: ["resume", "cover"], temperature: cfg.temperature ?? 0.4, maxTokens: 7000 }),
    messages,
  );
  const verification = await verificationFor({ recipe: "materials_check", positionId: pos.id, candidateEvidence: [triageBriefOf(profile), profile.masterCoverMarkdown].filter(Boolean).join("\n\n"), listing, draft: [res.sections.resume || res.markdown, res.sections.cover || ""].join("\n\n") });
  const db = await getDb();
  const currentProfile = await getProfile();
  const profileChanged = profileFingerprint(currentProfile) !== profileFingerprint(profile)
    || currentProfile.masterCoverMarkdown !== profile.masterCoverMarkdown
    || JSON.stringify(currentProfile.resumeSurfaces) !== JSON.stringify(profile.resumeSurfaces);
  const completion = await db.transaction(async tx => {
    const current = (await tx.select().from(positions).where(eq(positions.id, pos.id)).for("update"))[0];
    if (!current) throw new Error("position removed during materials generation");
    const currentMaterials = await tx.select({ id: applicationMaterials.id, kind: applicationMaterials.kind }).from(applicationMaterials).where(and(eq(applicationMaterials.positionId, pos.id), eq(applicationMaterials.isCurrent, true)));
    const stale = profileChanged || current.updatedAt.getTime() !== pos.updatedAt.getTime()
      || current.status !== pos.status || current.contentHash !== pos.contentHash || current.listingStatus !== pos.listingStatus
      || currentMaterials.find(m => m.kind === "resume")?.id !== sourceResume?.id
      || currentMaterials.find(m => m.kind === "cover")?.id !== sourceCover?.id;
    const needsReview = stale || verification?.hold;
    const provenance = { profileHash: profileFingerprint(profile), staleAtCompletion: stale, ...(verification ? { jev: verification } : {}) };
    const resume = await storeMaterial(tx, {
      positionId: pos.id,
      kind: "resume",
      bodyMarkdown: res.sections.resume || res.markdown,
      title: `Resume — ${pos.company.name} — ${pos.title}`,
      model: res.model,
      notes: needsReview ? `Claims review needed. ${res.data.notes || ""}`.trim() : res.data.notes,
      needsReview,
      metadata: { surface: res.data.resumeSurface, keywordsCovered: res.data.keywordsCovered, keywordsMissing: res.data.keywordsMissing, ...provenance },
    }, !stale);
    const cover = await storeMaterial(tx, {
      positionId: pos.id,
      kind: "cover",
      bodyMarkdown: res.sections.cover || "",
      title: `Cover — ${pos.company.name} — ${pos.title}`,
      model: res.model,
      metadata: provenance,
      needsReview,
      notes: needsReview ? "Claims review needed." : undefined,
    }, !stale);
    const set: Record<string, unknown> = { resumeSurface: res.data.resumeSurface, updatedAt: new Date() };
    // Autopilot drafts do not move the pipeline: the approval inbox does.
    if (!opts.auto && !verification?.hold && (pos.status === "triaged" || pos.status === "review")) set.status = "materials";
    if (!stale) await tx.update(positions).set(set).where(eq(positions.id, pos.id));
    return { resume, cover, stale };
  });
  const { resume, cover, stale } = completion;
  await addEvent({
    positionId: pos.id,
    kind: "materials",
    title: `Materials v${resume.version} (${res.data.resumeSurface})${opts.auto ? " — autopilot draft" : ""}`,
    body: res.data.notes,
    actor: opts.auto ? "autopilot" : "operator",
    metadata: { resumeId: resume.id, coverId: cover.id, model: res.model },
  });
  if (verification?.hold) await addEvent({ positionId: pos.id, kind: "note", title: "Materials need a claims review", body: verification.error || "Jev could not confirm the draft against its sources. Review the résumé and cover before using them.", metadata: { decisionRunId: verification.runId, resumeId: resume.id, coverId: cover.id } });
  if (stale) await addEvent({ positionId: pos.id, kind: "note", title: "Materials saved as older drafts", body: "The profile, position or current materials changed during generation. Your current versions were kept.", metadata: { resumeId: resume.id, coverId: cover.id } });
  const auto = opts.auto && !verification?.hold && !stale
    ? await afterMaterials({ positionId: pos.id, companyId: pos.companyId, materialIds: [resume.id, cover.id], surface: res.data.resumeSurface })
    : {};
  return { staleAtCompletion: stale, resumeId: resume.id, coverId: cover.id, version: resume.version, surface: res.data.resumeSurface, model: res.model, ...auto };
}
