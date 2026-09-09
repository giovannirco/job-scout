import { Hono } from "hono";
import { enqueueJob, getCompany, listCompanies, updateCompany } from "@job-scout/core";
import { body, fail, ok, queryMap } from "../envelope.js";

export const companiesRoutes = new Hono();

companiesRoutes.get("/", async (c) => {
  const r = await listCompanies(queryMap(c));
  return ok(c, r.items, { page: r.page, pageSize: r.pageSize, total: r.total });
});

companiesRoutes.get("/:id", async (c) => {
  const r = await getCompany(c.req.param("id"));
  return r ? ok(c, r) : fail(c, "NOT_FOUND", "company not found");
});

companiesRoutes.patch("/:id", async (c) => {
  const r = await updateCompany(c.req.param("id"), await body(c));
  return r ? ok(c, r) : fail(c, "NOT_FOUND", "company not found");
});

companiesRoutes.post("/:id/actions/research", async (c) => {
  const co = await getCompany(c.req.param("id"));
  if (!co) return fail(c, "NOT_FOUND", "company not found");
  const q = await enqueueJob("company_research", { companyId: co.id }, { dedupeKey: `company_research:${co.id}`, priority: 30 });
  return ok(c, { jobId: q.id, deduped: q.deduped }, {}, 202);
});
