import { Hono } from "hono";
import { listAllInterviews, listProcesses } from "@job-scout/core";
import { ok, queryMap } from "../envelope.js";

export const interviewsDeskRoutes = new Hono();
export const processesRoutes = new Hono();

interviewsDeskRoutes.get("/", async (c) => {
  const q = queryMap(c);
  const limit = q.limit ? Number(q.limit) : 200;
  const rows = await listAllInterviews({ lane: q.lane, stage: q.stage, q: q.q, limit: Number.isFinite(limit) ? limit : 200 });
  return ok(c, rows, { total: rows.length });
});

processesRoutes.get("/", async (c) => {
  const rows = await listProcesses();
  return ok(c, rows, { total: rows.length });
});
