import { Hono } from "hono";
import {
  archivePosition,
  enqueueJob,
  getCurrentMaterial,
  getEvaluation,
  getEvaluationById,
  getMaterial,
  getPosition,
  getPositionDetail,
  getRevision,
  intakeUrl,
  listEvents,
  listMaterials,
  listPositions,
  patchPosition,
  refreshPosition,
  saveMaterial,
  stampCareerOps,
  addEvent,
  LlmGateError,
  listQuestions,
  patchQuestion,
  runFormAnswers,
  runListingClassify,
  listPeople,
  addPerson,
  deletePerson,
  listInterviews,
  addInterview,
  patchInterview,
  deleteInterview,
  reconcileCareerOps,
} from "@job-scout/core";
import type { EvaluationKind } from "@job-scout/db";
import { body, fail, ok, queryMap } from "../envelope.js";

export const positionsRoutes = new Hono();

positionsRoutes.get("/", async (c) => {
  const r = await listPositions(queryMap(c));
  return ok(c, r.items, { page: r.page, pageSize: r.pageSize, total: r.total, nextCursor: r.nextCursor });
});

positionsRoutes.post("/reconcile-career-ops", async (c) => {
  try { return ok(c, await reconcileCareerOps(await body(c))); }
  catch (e) { return fail(c, "VALIDATION_ERROR", e instanceof Error ? e.message : String(e)); }
});

positionsRoutes.post("/", async (c) => {
  const b = await body<{ url?: string; companyName?: string; status?: "triaged" | "review" }>(c);
  if (!b.url) return fail(c, "VALIDATION_ERROR", "url required");
  try {
    const r = await intakeUrl(b.url, { companyName: b.companyName, status: b.status });
    return ok(c, r.position, { created: r.created, triageJobId: r.triageJobId }, r.created ? 201 : 200);
  } catch (e) {
    return fail(c, "VALIDATION_ERROR", e instanceof Error ? e.message : String(e));
  }
});

positionsRoutes.get("/:id", async (c) => {
  const p = await getPositionDetail(c.req.param("id"));
  return p ? ok(c, p) : fail(c, "NOT_FOUND", "position not found");
});

positionsRoutes.patch("/:id", async (c) => {
  const actor = c.get("user")?.name || "operator";
  try {
    const p = await patchPosition(c.req.param("id"), await body(c), actor);
    return p ? ok(c, p) : fail(c, "NOT_FOUND", "position not found");
  } catch (e) {
    return fail(c, "VALIDATION_ERROR", e instanceof Error ? e.message : String(e));
  }
});

positionsRoutes.post("/:id/archive", async (c) => {
  const b = await body<{ reason?: string }>(c);
  const p = await archivePosition(c.req.param("id"), b.reason || "manual", c.get("user")?.name || "operator");
  return p ? ok(c, p) : fail(c, "NOT_FOUND", "position not found");
});

positionsRoutes.post("/:id/refresh", async (c) => {
  try {
    const r = await refreshPosition(c.req.param("id"), "manual");
    return ok(c, r);
  } catch (e) {
    return fail(c, "VALIDATION_ERROR", e instanceof Error ? e.message : String(e));
  }
});

positionsRoutes.post("/:id/notes", async (c) => {
  const b = await body<{ title?: string; body?: string }>(c);
  if (!b.title && !b.body) return fail(c, "VALIDATION_ERROR", "title or body required");
  const p = await getPositionDetail(c.req.param("id"));
  if (!p) return fail(c, "NOT_FOUND", "position not found");
  const id = await addEvent({ positionId: p.id, kind: "note", title: b.title || "Note", body: b.body, actor: c.get("user")?.name || "operator" });
  return ok(c, { id }, {}, 201);
});

/** Enqueue an LLM operation (or run it synchronously with ?sync=1 for MCP callers). */
const LLM_ACTIONS = ["triage", "evaluate", "materials", "jd_review", "company_research", "form_answers", "listing_classify"] as const;
positionsRoutes.post("/:id/actions/:action", async (c) => {
  const action = c.req.param("action") as (typeof LLM_ACTIONS)[number];
  if (!LLM_ACTIONS.includes(action)) return fail(c, "VALIDATION_ERROR", `unknown action ${action}`);
  const p = await getPositionDetail(c.req.param("id"));
  if (!p) return fail(c, "NOT_FOUND", "position not found");
  const b = await body<{ force?: boolean; surface?: string }>(c);
  const sync = c.req.query("sync") === "1";
  const payload =
    action === "company_research"
      ? { companyId: p.companyId, positionId: p.id }
      : { positionId: p.id, force: Boolean(b.force), surface: b.surface };
  if (!sync) {
    const q = await enqueueJob(action, payload, { dedupeKey: `${action}:${p.id}`, priority: 20 });
    return ok(c, { jobId: q.id, deduped: q.deduped, action }, {}, 202);
  }
  try {
    const core = await import("@job-scout/core");
    const result =
      action === "triage"
        ? await core.runTriage(p.id, { force: Boolean(b.force) })
        : action === "evaluate"
          ? await core.runEvaluate(p.id)
          : action === "materials"
            ? await core.runMaterials(p.id, { surface: b.surface })
            : action === "jd_review"
              ? await core.runJdReview(p.id)
              : action === "form_answers"
                ? await core.runFormAnswers(p.id)
                : action === "listing_classify"
                  ? await runListingClassify(p.id)
                : await core.runCompanyResearch(p.companyId, p.id);
    return ok(c, result);
  } catch (e) {
    if (e instanceof LlmGateError) return fail(c, "LLM_GATE", e.message, { code: e.code });
    return fail(c, "INTERNAL", e instanceof Error ? e.message : String(e));
  }
});

positionsRoutes.get("/:id/questions", async (c) => {
  const p = await getPositionDetail(c.req.param("id"));
  if (!p) return fail(c, "NOT_FOUND", "position not found");
  return ok(c, await listQuestions(p.id, { sort: c.req.query("sort") }));
});

positionsRoutes.patch("/:id/questions/:qid", async (c) => {
  const p = await getPositionDetail(c.req.param("id"));
  if (!p) return fail(c, "NOT_FOUND", "position not found");
  const b = await body<{ answer?: string | null; status?: string }>(c);
  const row = await patchQuestion(c.req.param("qid"), b);
  return row ? ok(c, row) : fail(c, "NOT_FOUND", "question not found");
});

positionsRoutes.get("/:id/timeline", async (c) => {
  const p = await getPositionDetail(c.req.param("id"));
  if (!p) return fail(c, "NOT_FOUND", "position not found");
  return ok(c, await listEvents(p.id, Number(c.req.query("limit") || 100)));
});

positionsRoutes.get("/:id/revisions/:rev", async (c) => {
  const p = await getPositionDetail(c.req.param("id"));
  if (!p) return fail(c, "NOT_FOUND", "position not found");
  const r = await getRevision(p.id, Number(c.req.param("rev")));
  return r ? ok(c, r) : fail(c, "NOT_FOUND", "revision not found");
});

positionsRoutes.get("/:id/evaluations/:kind", async (c) => {
  const p = await getPositionDetail(c.req.param("id"));
  if (!p) return fail(c, "NOT_FOUND", "position not found");
  const kind = c.req.param("kind") as EvaluationKind;
  const e = kind.startsWith("ev_") ? await getEvaluationById(kind) : await getEvaluation(p.id, kind);
  return e ? ok(c, e) : fail(c, "NOT_FOUND", "no evaluation of that kind yet");
});

positionsRoutes.get("/:id/materials", async (c) => {
  const p = await getPositionDetail(c.req.param("id"));
  if (!p) return fail(c, "NOT_FOUND", "position not found");
  return ok(c, await listMaterials(p.id));
});

positionsRoutes.get("/:id/materials/current/:kind", async (c) => {
  const p = await getPositionDetail(c.req.param("id"));
  if (!p) return fail(c, "NOT_FOUND", "position not found");
  const m = await getCurrentMaterial(p.id, c.req.param("kind") as "resume" | "cover");
  return m ? ok(c, m) : fail(c, "NOT_FOUND", "no material yet");
});

positionsRoutes.post("/:id/materials", async (c) => {
  const p = await getPositionDetail(c.req.param("id"));
  if (!p) return fail(c, "NOT_FOUND", "position not found");
  const b = await body<{ kind?: "resume" | "cover"; bodyMarkdown?: string; title?: string; notes?: string; pdfBase64?: string; pdfFileName?: string }>(c);
  if (!b.kind || !b.bodyMarkdown) return fail(c, "VALIDATION_ERROR", "kind and bodyMarkdown required");
  const r = await saveMaterial({ positionId: p.id, kind: b.kind, bodyMarkdown: b.bodyMarkdown, title: b.title, notes: b.notes, source: c.get("user")?.name || "human", pdfBase64: b.pdfBase64, pdfFileName: b.pdfFileName });
  return ok(c, r, {}, 201);
});

positionsRoutes.get("/materials/:materialId", async (c) => {
  const m = await getMaterial(c.req.param("materialId"));
  return m ? ok(c, m) : fail(c, "NOT_FOUND", "material not found");
});

positionsRoutes.put("/:id/career-ops", async (c) => {
  const b = await body<Record<string, unknown>>(c);
  const r = await stampCareerOps(c.req.param("id"), b);
  return r ? ok(c, r) : fail(c, "NOT_FOUND", "position not found");
});

positionsRoutes.get("/:id/people", async (c) => {
  const p = await getPosition(c.req.param("id"));
  if (!p) return fail(c, "NOT_FOUND", "position not found");
  return ok(c, await listPeople(p.companyId));
});

positionsRoutes.post("/:id/people", async (c) => {
  const p = await getPosition(c.req.param("id"));
  if (!p) return fail(c, "NOT_FOUND", "position not found");
  try {
    const row = await addPerson(p.companyId, await body(c));
    return ok(c, row, {}, 201);
  } catch (e) {
    return fail(c, "VALIDATION_ERROR", e instanceof Error ? e.message : String(e));
  }
});

positionsRoutes.delete("/:id/people/:personId", async (c) => {
  const p = await getPosition(c.req.param("id"));
  if (!p) return fail(c, "NOT_FOUND", "position not found");
  const gone = await deletePerson(p.companyId, c.req.param("personId"));
  return gone ? ok(c, { deleted: true }) : fail(c, "NOT_FOUND", "person not found");
});

positionsRoutes.get("/:id/interviews", async (c) => {
  const p = await getPosition(c.req.param("id"));
  if (!p) return fail(c, "NOT_FOUND", "position not found");
  return ok(c, await listInterviews(p.id));
});

positionsRoutes.post("/:id/interviews", async (c) => {
  const p = await getPosition(c.req.param("id"));
  if (!p) return fail(c, "NOT_FOUND", "position not found");
  try {
    const row = await addInterview(p.id, await body(c));
    return ok(c, row, {}, 201);
  } catch (e) {
    return fail(c, "VALIDATION_ERROR", e instanceof Error ? e.message : String(e));
  }
});

positionsRoutes.patch("/:id/interviews/:interviewId", async (c) => {
  const p = await getPosition(c.req.param("id"));
  if (!p) return fail(c, "NOT_FOUND", "position not found");
  try {
    const row = await patchInterview(p.id, c.req.param("interviewId"), await body(c));
    return row ? ok(c, row) : fail(c, "NOT_FOUND", "interview not found");
  } catch (e) {
    return fail(c, "VALIDATION_ERROR", e instanceof Error ? e.message : String(e));
  }
});

positionsRoutes.delete("/:id/interviews/:interviewId", async (c) => {
  const p = await getPosition(c.req.param("id"));
  if (!p) return fail(c, "NOT_FOUND", "position not found");
  const gone = await deleteInterview(p.id, c.req.param("interviewId"));
  return gone ? ok(c, { deleted: true }) : fail(c, "NOT_FOUND", "interview not found");
});
