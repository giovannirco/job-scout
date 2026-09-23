import { Hono } from "hono";
import { handleWahaWebhookEvent, wahaWebhookAuthorized } from "@job-scout/core";
import { fail, ok } from "../envelope.js";

export const webhookRoutes = new Hono();

webhookRoutes.post("/waha", async (c) => {
  const header = c.req.header("x-api-key") || c.req.header("X-Api-Key");
  if (!wahaWebhookAuthorized(header)) return fail(c, "UNAUTHORIZED", "Invalid webhook key", {}, 401);
  const raw = await c.req.json().catch(() => null);
  if (!raw || typeof raw !== "object") return fail(c, "VALIDATION_ERROR", "JSON body required");
  const result = await handleWahaWebhookEvent(raw);
  return ok(c, result);
});
