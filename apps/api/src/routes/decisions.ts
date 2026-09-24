import { Hono } from "hono";
import { z } from "zod";
import { decisionFeedback, jevStatus, previewDecision, rankReviewQueue, recentDecisions } from "@job-scout/core";
import { DecisionError } from "@job-scout/llm";
import { body, fail, ok } from "../envelope.js";

export const decisionRoutes = new Hono();
decisionRoutes.get("/", async c => ok(c, await jevStatus()));
decisionRoutes.get("/runs", async c => ok(c, await recentDecisions(c.req.query("positionId"))));
decisionRoutes.post("/preview", async c => {
  const parsed = z.object({ recipe: z.enum(["triage", "ranking", "evaluation_check", "materials_check", "connection_test"]), positionId: z.string().min(1).max(100).optional(), fresh: z.boolean().default(false) }).safeParse(await body(c));
  if (!parsed.success) return fail(c, "VALIDATION_ERROR", "Choose a valid Jev task and position.");
  try { return ok(c, await previewDecision(parsed.data.recipe, parsed.data.positionId, parsed.data.fresh)); }
  catch (error) { return fail(c, "VALIDATION_ERROR", error instanceof DecisionError ? error.message : "Could not run this decision.", {}, 400); }
});
decisionRoutes.post("/rank", async c => {
  const parsed = z.object({ limit: z.number().int().min(1).max(20).default(10) }).safeParse(await body(c));
  if (!parsed.success) return fail(c, "VALIDATION_ERROR", "Choose between 1 and 20 positions.");
  try { return ok(c, await rankReviewQueue(parsed.data.limit)); }
  catch (error) { return fail(c, "VALIDATION_ERROR", error instanceof DecisionError ? error.message : "Could not rank this queue.", {}, 400); }
});
decisionRoutes.patch("/runs/:id", async c => {
  const parsed = z.object({ feedback: z.enum(["agree", "disagree"]).nullable() }).safeParse(await body(c));
  if (!parsed.success) return fail(c, "VALIDATION_ERROR", "Feedback must be agree, disagree, or null.");
  try { return ok(c, await decisionFeedback(c.req.param("id"), parsed.data.feedback)); }
  catch (error) { return fail(c, "NOT_FOUND", error instanceof DecisionError ? error.message : "Could not save feedback.", {}, 404); }
});
