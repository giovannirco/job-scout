import { Hono, type Context } from "hono";
import {
  CursorError,
  getLead,
  linkLeadPosition,
  listLeadInterviews,
  listLeads,
  logLeadMessage,
  mergeLeads,
  promoteLead,
  upsertLead,
  upsertLeadInterview,
} from "@job-scout/core";
import { body, fail, ok } from "../envelope.js";

/** Recruiter leads. Tracking only: no route here sends a message. */
export const leadsRoutes = new Hono();

const actorOf = (c: Context) => (c.get("user") as { name?: string } | undefined)?.name || "operator";

function failFrom(c: Context, e: unknown) {
  const err = e as { message?: string; code?: string; leadId?: string };
  if (err?.code === "not_found") return fail(c, "NOT_FOUND", err.message || "not found");
  if (err?.code === "duplicate_lead") return fail(c, "CONFLICT", err.message || "duplicate lead", { leadId: err.leadId });
  if (e instanceof CursorError) return fail(c, "VALIDATION_ERROR", e.message, { code: e.code });
  return fail(c, "VALIDATION_ERROR", err?.message || String(e));
}

leadsRoutes.get("/", async (c) => {
  const q = c.req.query();
  try {
    const r = await listLeads({
      status: q.status,
      lane: q.lane,
      q: q.q,
      includeClosed: q.includeClosed === "true",
      pageSize: q.pageSize ? Number(q.pageSize) : undefined,
      page: q.page ? Number(q.page) : undefined,
      cursor: q.cursor,
    });
    return ok(c, r.items, { total: r.total, page: r.page, pageSize: r.pageSize, nextCursor: r.nextCursor });
  } catch (e) {
    return failFrom(c, e);
  }
});

leadsRoutes.post("/", async (c) => {
  try {
    const { id: _id, ...input } = await body<Parameters<typeof upsertLead>[0]>(c);
    const r = await upsertLead(input, actorOf(c));
    if (!r) return fail(c, "NOT_FOUND", "lead not found");
    return ok(c, r.lead, { created: r.created }, r.created ? 201 : 200);
  } catch (e) {
    return failFrom(c, e);
  }
});

leadsRoutes.get("/:id", async (c) => {
  const r = await getLead(c.req.param("id"));
  return r ? ok(c, r) : fail(c, "NOT_FOUND", "lead not found");
});

leadsRoutes.patch("/:id", async (c) => {
  try {
    const { message: _m, ...input } = await body<Parameters<typeof upsertLead>[0]>(c);
    const r = await upsertLead({ ...input, id: c.req.param("id") }, actorOf(c));
    return r ? ok(c, r.lead) : fail(c, "NOT_FOUND", "lead not found");
  } catch (e) {
    return failFrom(c, e);
  }
});

leadsRoutes.post("/:id/messages", async (c) => {
  try {
    const r = await logLeadMessage(c.req.param("id"), await body(c));
    return r ? ok(c, r, {}, 201) : fail(c, "NOT_FOUND", "lead not found");
  } catch (e) {
    return failFrom(c, e);
  }
});

leadsRoutes.get("/:id/interviews", async (c) => {
  const lead = await getLead(c.req.param("id"));
  return lead ? ok(c, await listLeadInterviews(lead.id)) : fail(c, "NOT_FOUND", "lead not found");
});

leadsRoutes.post("/:id/interviews", async (c) => {
  try {
    const r = await upsertLeadInterview(c.req.param("id"), await body(c));
    return r ? ok(c, r, {}, 201) : fail(c, "NOT_FOUND", "lead or interview not found");
  } catch (e) {
    return failFrom(c, e);
  }
});

leadsRoutes.patch("/:id/interviews/:interviewId", async (c) => {
  try {
    const r = await upsertLeadInterview(c.req.param("id"), { ...(await body(c)), id: c.req.param("interviewId") });
    return r ? ok(c, r) : fail(c, "NOT_FOUND", "lead or interview not found");
  } catch (e) {
    return failFrom(c, e);
  }
});

leadsRoutes.post("/:id/actions/promote", async (c) => {
  try {
    const r = await promoteLead(c.req.param("id"), await body(c), actorOf(c));
    return r ? ok(c, r) : fail(c, "NOT_FOUND", "lead not found");
  } catch (e) {
    return failFrom(c, e);
  }
});

leadsRoutes.post("/:id/actions/link-position", async (c) => {
  try {
    const { positionIdOrSlug } = await body<{ positionIdOrSlug?: string }>(c);
    if (!positionIdOrSlug) return fail(c, "VALIDATION_ERROR", "positionIdOrSlug required");
    const r = await linkLeadPosition(c.req.param("id"), positionIdOrSlug, actorOf(c));
    return r ? ok(c, r) : fail(c, "NOT_FOUND", "lead not found");
  } catch (e) {
    return failFrom(c, e);
  }
});

leadsRoutes.post("/:id/actions/merge", async (c) => {
  try {
    const { sourceIds } = await body<{ sourceIds?: string[] }>(c);
    if (!Array.isArray(sourceIds)) return fail(c, "VALIDATION_ERROR", "sourceIds must be an array of lead ids");
    const r = await mergeLeads(c.req.param("id"), sourceIds, actorOf(c));
    return r ? ok(c, r) : fail(c, "NOT_FOUND", "lead not found");
  } catch (e) {
    return failFrom(c, e);
  }
});
