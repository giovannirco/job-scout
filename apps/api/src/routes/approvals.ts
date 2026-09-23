import { Hono } from "hono";
import { autopilotSummary, listApprovals, resolveApproval } from "@job-scout/core";
import { body, fail, ok } from "../envelope.js";

export const approvalsRoutes = new Hono();

approvalsRoutes.get("/", async (c) => {
  const status = (c.req.query("status") || "pending") as "pending" | "approved" | "dismissed" | "expired" | "all";
  return ok(c, await listApprovals({ status, limit: Number(c.req.query("limit") || 50), sort: c.req.query("sort") ?? undefined }));
});

approvalsRoutes.get("/summary", async (c) => ok(c, await autopilotSummary()));

approvalsRoutes.post("/:id/approve", async (c) => {
  try {
    return ok(c, await resolveApproval(c.req.param("id"), "approved", "operator"));
  } catch (e) {
    return fail(c, "NOT_FOUND", e instanceof Error ? e.message : String(e));
  }
});

approvalsRoutes.post("/:id/dismiss", async (c) => {
  try {
    return ok(c, await resolveApproval(c.req.param("id"), "dismissed", "operator"));
  } catch (e) {
    return fail(c, "NOT_FOUND", e instanceof Error ? e.message : String(e));
  }
});

/** Bulk: { ids: string[], decision: approved|dismissed } */
approvalsRoutes.post("/resolve", async (c) => {
  const b = (await body(c)) as { ids?: string[]; decision?: "approved" | "dismissed" };
  if (!Array.isArray(b.ids) || !b.ids.length || !b.decision) return fail(c, "VALIDATION_ERROR", "ids[] and decision required");
  const out = [];
  for (const id of b.ids.slice(0, 100)) out.push(await resolveApproval(id, b.decision, "operator").catch((e) => ({ id, error: e instanceof Error ? e.message : String(e) })));
  return ok(c, out);
});
