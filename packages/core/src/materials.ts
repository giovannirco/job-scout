import { and, desc, eq, sql } from "drizzle-orm";
import { applicationMaterials, getDb, id, positions } from "@job-scout/db";
import { buildMaterialsMessages, MaterialsOutput } from "@job-scout/llm";
import { buildAtsKeywordChecklist } from "@job-scout/shared";
import { afterMaterials } from "./autopilot.js";
import { getEvaluation } from "./evaluate.js";
import { gateOperation, getLlmClient, logged } from "./llm.js";
import { currentJdText, getPosition } from "./positions.js";
import { getProfile } from "./profile.js";
import { addEvent } from "./timeline.js";

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
  return (await db.select().from(applicationMaterials).where(eq(applicationMaterials.id, materialId)).limit(1))[0] ?? null;
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
  )[0] ?? null;
}

async function nextVersion(positionId: string, kind: string) {
  const db = await getDb();
  const r = (
    await db
      .select({ v: sql<number>`coalesce(max(${applicationMaterials.version}),0)::int` })
      .from(applicationMaterials)
      .where(and(eq(applicationMaterials.positionId, positionId), eq(applicationMaterials.kind, kind)))
  )[0];
  return (r?.v ?? 0) + 1;
}

/** Store a material version (LLM or human-written) and make it current. */
export async function saveMaterial(input: {
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
}) {
  const db = await getDb();
  const version = await nextVersion(input.positionId, input.kind);
  await db
    .update(applicationMaterials)
    .set({ isCurrent: false })
    .where(and(eq(applicationMaterials.positionId, input.positionId), eq(applicationMaterials.kind, input.kind)));
  const mid = id("mat");
  await db.insert(applicationMaterials).values({
    id: mid,
    positionId: input.positionId,
    kind: input.kind,
    version,
    isCurrent: true,
    status: "ready",
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
  const evaluation = await getEvaluation(pos.id, "evaluate");
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
  const resume = await saveMaterial({
    positionId: pos.id,
    kind: "resume",
    bodyMarkdown: res.sections.resume || res.markdown,
    title: `Resume — ${pos.company.name} — ${pos.title}`,
    model: res.model,
    notes: res.data.notes,
    metadata: { surface: res.data.resumeSurface, keywordsCovered: res.data.keywordsCovered, keywordsMissing: res.data.keywordsMissing },
  });
  const cover = await saveMaterial({
    positionId: pos.id,
    kind: "cover",
    bodyMarkdown: res.sections.cover || "",
    title: `Cover — ${pos.company.name} — ${pos.title}`,
    model: res.model,
  });
  const db = await getDb();
  const set: Record<string, unknown> = { resumeSurface: res.data.resumeSurface, updatedAt: new Date() };
  // Autopilot drafts do not move the pipeline: the approval inbox does.
  if (!opts.auto && (pos.status === "triaged" || pos.status === "review")) set.status = "materials";
  await db.update(positions).set(set).where(eq(positions.id, pos.id));
  await addEvent({
    positionId: pos.id,
    kind: "materials",
    title: `Materials v${resume.version} (${res.data.resumeSurface})${opts.auto ? " — autopilot draft" : ""}`,
    body: res.data.notes,
    actor: opts.auto ? "autopilot" : "operator",
    metadata: { resumeId: resume.id, coverId: cover.id, model: res.model },
  });
  const auto = opts.auto
    ? await afterMaterials({ positionId: pos.id, companyId: pos.companyId, materialIds: [resume.id, cover.id], surface: res.data.resumeSurface })
    : {};
  return { resumeId: resume.id, coverId: cover.id, version: resume.version, surface: res.data.resumeSurface, model: res.model, ...auto };
}
