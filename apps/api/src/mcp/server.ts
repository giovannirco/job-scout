import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { companies, getDb, positions, timelineEvents, type EvaluationKind } from "@job-scout/db";
import {
  addEvent,
  currentJdText,
  discoverySummary,
  enqueueDueBoardScans,
  enqueueJob,
  getCompany,
  getEvaluation,
  getPositionDetail,
  getProfile,
  intakeUrl,
  listChangesSince,
  listCompanies,
  listDiscovery,
  listPositions,
  reconcileCareerOps,
  ReconcileInput,
  patchPosition,
  recordAtsFetchFailure,
  refreshPosition,
  runEvaluate,
  runJdReview,
  runMaterials,
  runTriage,
  refreshStaleTriage,
  RefreshStaleTriageInput,
  runListingClassify,
  stampCareerOps,
  careerOpsStampState,
  upsertFromJob,
  usageSummary,
  getLlmHealth,
  retryFailedLlm,
  LlmGateError,
  CursorError,
  getCurrentMaterial,
  listEvents,
  briefOf,
  triageBriefOf,
  mcpCalls,
  mcpDuration,
  jevStatus,
  recentDecisions,
  previewDecision,
  setStatusFromCaller,
  patchFromCaller,
  mapCareerOpsStatus,
  careerOpsDropStatus,
  noteCareerOpsDrop,
  groupingRows,
  matchCareerOpsRow,
  createManualCareerOpsPosition,
  setCareerOpsUrl,
  upsertLead,
  listLeads,
  getLead,
  logLeadMessage,
  promoteLead,
  linkLeadPosition,
  mergeLeads,
} from "@job-scout/core";
import { GeoClass, LEAD_BUCKETS, LEAD_DIRECTIONS, LEAD_STATUSES, log as rootLog, redactContactText, Workplace } from "@job-scout/shared";
import { env } from "../env.js";
import { errorDetails } from "../error-details.js";
import { text } from "./result.js";
import { interviewSummary, positionSummary } from "./summary.js";
import { fitPage, leanRow, PAGE_BUDGET_BYTES } from "./page.js";
import { workQueue, WorkQueueInput } from "./work-queue.js";

type ToolAuth = { clientId?: string; scopes?: string[]; extra?: Record<string, unknown> };
type ToolCtx = { authInfo?: ToolAuth; http?: { authInfo?: ToolAuth } };
/**
 * Who made the call. The bearer token's name (clientId) is shared by every
 * agent using that token, so a caller can identify itself with the
 * `X-Job-Scout-Actor` / `X-Agent-Name` header (authInfo.extra.actor) or an
 * `actor` tool argument. Recorded as "<caller> via <token>" so the token stays
 * auditable and a caller can never pass itself off as another actor.
 */
export function agentOf(ctx: ToolCtx, callerActor?: string | null): string {
  const auth = ctx.http?.authInfo || ctx.authInfo;
  const token = auth?.clientId || "mcp-client";
  const fromHeader = auth?.extra?.actor;
  const raw = callerActor || (typeof fromHeader === "string" ? fromHeader : "");
  const caller = raw.replace(/[^\w.:@-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!caller || caller === token) return token;
  return `${caller} via ${token}`;
}

const VERBOSE = z.boolean().optional().describe("Return the full record instead of the compact summary");
type Summarizable = Parameters<typeof positionSummary>[0];
/** Write echo: compact by default, the full position row with verbose. */
const echo = (p: Summarizable | null | undefined, verbose?: boolean) => (p ? text(verbose ? p : positionSummary(p)) : text({ error: "not found" }, true));

const errText = (e: unknown) => text({
  error: e instanceof Error ? e.message : String(e),
  code: e instanceof LlmGateError || e instanceof CursorError ? e.code : (e as { code?: unknown } | null)?.code === "board_index" ? "board_index" : undefined,
  ...errorDetails(e),
}, true);

async function resolvePositionId(idOrSlug?: string, q?: string) {
  if (idOrSlug) {
    const p = await getPositionDetail(idOrSlug);
    if (p) return p;
  }
  if (q) {
    const r = await listPositions({ q, pageSize: "1" });
    if (r.items[0]) return getPositionDetail(r.items[0].id);
  }
  return null;
}

const mcpLog = rootLog.child({ scope: "mcp" });

/** Wrap every registerTool handler with a counter, a latency histogram and one JSON log line. */
function instrumentTools(server: McpServer) {
  const original = server.registerTool.bind(server);
  type Handler = (...args: unknown[]) => Promise<{ isError?: boolean } | unknown> | { isError?: boolean } | unknown;
  (server as unknown as { registerTool: (name: string, cfg: unknown, handler: Handler) => unknown }).registerTool = (name, cfg, handler) =>
    (original as unknown as (name: string, cfg: unknown, handler: Handler) => unknown)(name, cfg, async (...args: unknown[]) => {
      const t0 = Date.now();
      try {
        const out = (await handler(...args)) as { isError?: boolean } | null | undefined;
        const status = out?.isError ? "error" : "ok";
        const ms = Date.now() - t0;
        mcpCalls.labels({ tool: name, status }).inc();
        mcpDuration.labels({ tool: name }).observe(ms / 1000);
        mcpLog[status === "ok" ? "info" : "warn"]("mcp.tool", { tool: name, status, ms, args: compactArgs(args[0], name) });
        return out;
      } catch (e) {
        const ms = Date.now() - t0;
        mcpCalls.labels({ tool: name, status: "throw" }).inc();
        mcpDuration.labels({ tool: name }).observe(ms / 1000);
        mcpLog.error("mcp.tool", { tool: name, status: "throw", ms, args: compactArgs(args[0], name), err: e });
        throw e;
      }
    });
}
/** Lead tools carry recruiter contacts and message bodies: their logged args never include a phone number or email. */
const CONTACT_TOOLS = /lead|interview/;
export function compactArgs(a: unknown, tool = ""): unknown {
  if (!a || typeof a !== "object") return undefined;
  const raw = JSON.stringify(a);
  const s = CONTACT_TOOLS.test(tool) ? redactContactText(raw) : raw;
  if (s.length > 300) return s.slice(0, 300) + "…";
  if (s === raw) return a;
  try { return JSON.parse(s); } catch { return s; }
}

/**
 * job-scout MCP. Keeps the original 22 tool names (semantics mapped onto the
 * current pipeline) and adds the sync tools used by the career-ops skill.
 */
export function createJobScoutMcpServer() {
  const server = new McpServer({ name: "job-scout", version: env.version });
  instrumentTools(server);

  server.registerTool(
    "server_info",
    { title: "Server info", description: "job-scout identity, version, endpoints, LLM usage and LLM health (failing operations, failure kind: auth, quota, upgrade_required, outage).", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () => text({ name: "job-scout", version: env.version, publicBaseUrl: env.publicBaseUrl, mcp: `${env.publicBaseUrl}/mcp`, api: `${env.publicBaseUrl}/api/v1`, llm: await usageSummary(24), llmHealth: await getLlmHealth() }),
  );

  server.registerTool(
    "market_summary",
    { title: "Pipeline + radar summary", description: "Counts by status/verdict, discovery lanes for the last N hours, LLM usage.", inputSchema: { hours: z.number().int().min(1).max(720).optional() }, annotations: { readOnlyHint: true } },
    async (a) => {
      const db = await getDb();
      const counts = await db.select({ status: positions.status, verdict: positions.triageVerdict, c: sql<number>`count(*)::int` }).from(positions).groupBy(positions.status, positions.triageVerdict);
      return text({ positions: counts, discovery: await discoverySummary(a.hours ?? 24), llm: await usageSummary(a.hours ?? 24) });
    },
  );

  server.registerTool(
    "list_positions",
    {
      title: "List positions",
      description: "Lean rows by default (id, slug, title, company, status, priority, primaryUrl, triage score/verdict/oneLiner, listingStatus, geoClass, workplace, appliedAt, lastChangedAt, updatedAt, careerOps stamp); fields=full adds salary, location, departments, repost and ATS fields. Never includes triageJson or JD text (use get_position). Filters: status (comma list, 'hot', 'active', 'all' incl. archived), verdict (pass|marginal|fail|none), q, company, minScore, sort (updated_desc|score_desc|company|status|first_seen_desc|last_changed_desc|triaged_asc|title_asc|...), includeArchived. Paging: pass nextCursor back as cursor with the same filters and sort until it is null; works for every sort. A page is cut to stay under the result size limit (truncated=true) and nextCursor then resumes after the last row returned. For a full sync use the default sort or first_seen_asc.",
      inputSchema: {
        status: z.string().optional(),
        verdict: z.string().optional(),
        q: z.string().optional(),
        company: z.string().optional(),
        minScore: z.number().optional(),
        sort: z.string().optional(),
        includeArchived: z.boolean().optional(),
        includeDuplicates: z.boolean().optional(),
        collapseFamilies: z.boolean().optional(),
        listingStatus: z.string().optional(),
        geoClass: z.string().optional(),
        staleProfile: z.boolean().optional(),
        pageSize: z.number().int().min(1).max(200).optional().describe("Rows per page, default 50. Large pages are cut to the result size limit; follow nextCursor"),
        cursor: z.string().optional().describe("nextCursor from the previous page, unchanged"),
        page: z.number().int().positive().optional(),
        fields: z.enum(["lean", "full"]).optional().describe("lean (default) or full row projection"),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      let r;
      try {
        r = await listPositions({
          status: a.status,
          verdict: a.verdict,
          q: a.q,
          company: a.company,
          minScore: a.minScore != null ? String(a.minScore) : undefined,
          sort: a.sort,
          includeArchived: a.includeArchived ? "true" : undefined,
          includeDuplicates: a.includeDuplicates ? "true" : undefined,
          collapseFamilies: a.collapseFamilies ? "true" : undefined,
          listingStatus: a.listingStatus,
          geoClass: a.geoClass,
          staleProfile: a.staleProfile ? "true" : undefined,
          pageSize: String(a.pageSize ?? 50),
          cursor: a.cursor,
          page: a.page ? String(a.page) : undefined,
        });
      } catch (e) {
        return errText(e);
      }
      const rows = a.fields === "full" ? r.items : r.items.map(leanRow);
      const page = fitPage(rows, r.cursors, r.nextCursor);
      return text({ items: page.items, total: r.total, pageSize: r.pageSize, nextCursor: page.nextCursor, ...(page.truncated ? { truncated: true } : {}) });
    },
  );

  server.registerTool(
    "get_position",
    { title: "Get position", description: "Full detail: company, current JD text, revisions, evaluations, materials.", inputSchema: { idOrSlug: z.string(), includeJd: z.boolean().optional() }, annotations: { readOnlyHint: true } },
    async (a) => {
      const p = await getPositionDetail(a.idOrSlug);
      if (!p) return text({ error: "not found" }, true);
      if (a.includeJd === false && p.jd) p.jd = { ...p.jd, descriptionText: `(${p.jd.descriptionText?.length ?? 0} chars, omitted)` };
      return text(p);
    },
  );

  server.registerTool(
    "scout_context",
    { title: "Scout context pack", description: "Everything needed to reason about one role: position, triage JSON, JD text, latest evaluation summary, profile brief.", inputSchema: { positionId: z.string().optional(), slug: z.string().optional(), q: z.string().optional() }, annotations: { readOnlyHint: true } },
    async (a) => {
      const p = await resolvePositionId(a.positionId || a.slug, a.q);
      if (!p) return text({ error: "not found" }, true);
      const profile = await getProfile();
      const ev = await getEvaluation(p.id, "evaluate");
      return text({ position: { ...p, jd: undefined }, jdText: await currentJdText(p.id), triage: p.triageJson, evaluation: ev ? { id: ev.id, model: ev.model, summary: ev.json, createdAt: ev.createdAt } : null, brief: triageBriefOf(profile) });
    },
  );

  server.registerTool(
    "update_position",
    { title: "Update position", description: "PATCH status, priority, notes, nextAction, resumeSurface, watchEnabled, appliedAt, and listing corrections: title, primaryUrl, workplace, geoClass, geoNotes. A title change reslugs the position (the old slug still resolves); a primaryUrl must be a public http(s) URL not already used by another position, re-derives the ATS identity and keeps the old URL in metadata.previousUrls (refresh_jd re-reads the JD from it); workplace/geoClass are recorded as a human override that ATS snapshots and listing_classify keep. Each correction is a timeline event, attributed to `actor` (or the X-Job-Scout-Actor header) via the token name. A status of skip/archived from the career-ops sync (token named career-ops…, or source=career-ops) is recorded as a note and not applied; the other fields still apply. status=materials is refused with a materials_missing error until the position has a resume/cover in job-scout or a career-ops stamp with pdfPath: create materials (run_llm materials) or upsert_career_ops_stamp with pdfPath first. Returns a compact position summary (verbose=true for the full row).", inputSchema: { idOrSlug: z.string(), status: z.string().optional(), priority: z.string().optional(), notes: z.string().optional(), nextAction: z.string().optional(), resumeSurface: z.string().optional(), watchEnabled: z.boolean().optional(), appliedAt: z.string().optional(), title: z.string().optional(), primaryUrl: z.string().optional(), workplace: Workplace.optional(), geoClass: GeoClass.optional(), geoNotes: z.string().optional(), source: z.string().optional(), actor: z.string().optional().describe("Calling agent name for the audit trail, recorded as \"<actor> via <token name>\""), verbose: VERBOSE } },
    async ({ idOrSlug, source, actor, verbose, ...patch }, ctx) => {
      try {
        return echo(await patchFromCaller(idOrSlug, patch, { actor: agentOf(ctx as ToolCtx, actor), source }), verbose);
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.registerTool(
    "set_position_status",
    { title: "Set status", description: "Set pipeline status (triaged|review|materials|applied|screen|interview|offer|rejected|skip|archived). archived requires reason. A skip/archive from the career-ops sync (source=career-ops, or a note starting 'career-ops') is recorded as a note and not applied. materials is refused with a materials_missing error until the position has a resume/cover in job-scout or a career-ops stamp with pdfPath: create materials (run_llm materials) or upsert_career_ops_stamp with pdfPath first. Returns a compact position summary (verbose=true for the full row).", inputSchema: { idOrSlug: z.string(), status: z.string(), reason: z.string().optional(), note: z.string().optional(), source: z.string().optional(), actor: z.string().optional().describe("Calling agent name for the audit trail, recorded as \"<actor> via <token name>\""), verbose: VERBOSE } },
    async (a, ctx) => {
      try {
        return echo(await setStatusFromCaller(a.idOrSlug, a.status, { actor: agentOf(ctx as ToolCtx, a.actor), reason: a.reason, note: a.note, source: a.source }), a.verbose);
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.registerTool(
    "set_match_override",
    { title: "Skip / unskip", description: "v1 compat: label=human_skip archives the position; label=match moves it to review. From the career-ops sync (token named career-ops…) human_skip is recorded as a note and not applied.", inputSchema: { idOrSlug: z.string(), label: z.enum(["match", "human_skip"]), verbose: VERBOSE } },
    async (a, ctx) => {
      const actor = agentOf(ctx as ToolCtx);
      return echo(a.label === "human_skip" ? await setStatusFromCaller(a.idOrSlug, "archived", { actor, reason: "human_skip" }) : await setStatusFromCaller(a.idOrSlug, "review", { actor }), a.verbose);
    },
  );

  server.registerTool(
    "work_queue",
    { title: "Work queue", description: "Compact decision lanes with profile freshness, plus a leads lane of active recruiter leads, each with a bucket (call_soon: a screening within 72h · needs_reply: the recruiter wrote last · waiting: you replied in the last 7 days · stalled: nothing for 7 days). Use lane and page to read more; pagination reports totals and nextPage for each lane. Use get_position / get_lead for full details.", inputSchema: WorkQueueInput, annotations: { readOnlyHint: true } },
    async (a) => text(await workQueue(a)),
  );

  server.registerTool(
    "list_eval_inbox",
    { title: "Eval inbox", description: "v1 compat: positions in review with no evaluation yet.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () => {
      const rows = await listPositions({ status: "review,triaged", verdict: "pass", actionable: "true", collapseFamilies: "true", withoutEvaluation: "true", sort: "score_desc", pageSize: "50" });
      return text(rows.items);
    },
  );

  server.registerTool(
    "write_resume_eval",
    { title: "Write external eval", description: "Store an evaluation produced outside job-scout (career-ops) as an `evaluate` record and stamp careerOps metadata.", inputSchema: { idOrSlug: z.string(), score: z.number(), summary: z.string(), reasons: z.array(z.string()).optional(), markdown: z.string().optional(), source: z.string().optional() } },
    async (a, ctx) => {
      const p = await getPositionDetail(a.idOrSlug);
      if (!p) return text({ error: "not found" }, true);
      const db = await getDb();
      const { evaluations, id } = await import("@job-scout/db");
      const evId = id("ev");
      await db.insert(evaluations).values({ id: evId, positionId: p.id, companyId: p.companyId, kind: "evaluate", model: a.source || "career-ops", markdown: a.markdown || a.summary, json: { score: a.score, verdict: a.score >= 3.5 ? "apply" : a.score >= 3 ? "consider" : "skip", headline: a.summary, strengths: a.reasons || [], gaps: [], questionsToAsk: [], resumeAngle: "" } });
      await addEvent({ positionId: p.id, kind: "evaluate", title: `External eval ${a.score.toFixed(1)}`, body: a.summary, actor: agentOf(ctx as ToolCtx), metadata: { evaluationId: evId } });
      return text({ evaluationId: evId });
    },
  );

  server.registerTool(
    "list_discovery",
    { title: "Discovery feed", description: "lane=passed|filtered|marginal|all, hours, q, reason prefix (title_exclude, geo_block, stale...). Cursor pagination.", inputSchema: { lane: z.string().optional(), hours: z.number().optional(), q: z.string().optional(), reason: z.string().optional(), pageSize: z.number().int().min(1).max(200).optional(), cursor: z.string().optional() }, annotations: { readOnlyHint: true } },
    async (a) => {
      const r = await listDiscovery({ lane: a.lane, hours: a.hours != null ? String(a.hours) : undefined, q: a.q, reason: a.reason, pageSize: String(a.pageSize ?? 50), cursor: a.cursor });
      return text({ items: r.items, total: r.total, nextCursor: r.nextCursor });
    },
  );

  server.registerTool(
    "run_discovery_radar",
    { title: "Run discovery", description: "Enqueue board scans for due boards (all=true forces every enabled board).", inputSchema: { all: z.boolean().optional(), limit: z.number().int().min(1).max(500).optional() } },
    async (a) => text(await enqueueDueBoardScans({ all: a.all, limit: a.limit })),
  );

  server.registerTool(
    "promote_discovery",
    { title: "Promote discovery row", description: "Create a position from a discovery row (by id or url) and run triage.", inputSchema: { id: z.string().optional(), url: z.string().optional(), company: z.string().optional() } },
    async (a) => {
      try {
        let url = a.url;
        let company = a.company;
        if (a.id) {
          const db = await getDb();
          const { discoveryFeed } = await import("@job-scout/db");
          const row = (await db.select().from(discoveryFeed).where(eq(discoveryFeed.id, a.id)).limit(1)).at(0);
          if (!row?.url) return text({ error: "discovery row not found or has no url" }, true);
          url = row.url;
          company = company || row.company || undefined;
        }
        if (!url) return text({ error: "id or url required" }, true);
        const r = await intakeUrl(url, { companyName: company });
        return text({ position: r.position, created: r.created, triageJobId: r.triageJobId });
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.registerTool(
    "list_companies",
    { title: "List companies", description: "Companies with position counts.", inputSchema: { q: z.string().optional(), withPositions: z.boolean().optional(), pageSize: z.number().int().min(1).max(200).optional() }, annotations: { readOnlyHint: true } },
    async (a) => text(await listCompanies({ q: a.q, withPositions: a.withPositions ? "true" : undefined, pageSize: String(a.pageSize ?? 50) })),
  );
  server.registerTool(
    "get_company",
    { title: "Get company", description: "Company detail with positions and latest research.", inputSchema: { idOrSlug: z.string() }, annotations: { readOnlyHint: true } },
    async (a) => {
      const r = await getCompany(a.idOrSlug);
      return r ? text(r) : text({ error: "not found" }, true);
    },
  );

  server.registerTool(
    "intake",
    { title: "Intake URL", description: "Create/refresh a position from a job URL; queues triage. Returns the position.", inputSchema: { url: z.string(), company: z.string().optional(), status: z.enum(["triaged", "review"]).optional() } },
    async (a) => {
      try {
        const r = await intakeUrl(a.url, { companyName: a.company, status: a.status });
        return text({ position: r.position, created: r.created, triageJobId: r.triageJobId });
      } catch (e) {
        return errText(e);
      }
    },
  );
  server.registerTool(
    "refresh_jd",
    {
      title: "Refresh JD",
      description: "Re-fetch the ATS page and record a revision if it changed. The JD is frozen from interview stage on (refusal `frozen:<status>`); pass force=true only when the operator explicitly asks to refresh it anyway.",
      inputSchema: { idOrSlug: z.string(), force: z.boolean().optional().describe("Explicit operator refresh: override the interview/offer freeze") },
    },
    async (a) => {
      try {
        return text(await refreshPosition(a.idOrSlug, "mcp", { force: a.force === true }));
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.registerTool(
    "get_profile",
    { title: "Get profile", description: "Operator profile (identity, resume, surfaces, brief).", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () => text(await getProfile()),
  );
  server.registerTool(
    "get_identity",
    { title: "Get identity", description: "identity + master resume + scout brief markdown only.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () => {
      const p = await getProfile();
      return text({ identityMarkdown: p.identityMarkdown, masterResumeMarkdown: p.masterResumeMarkdown, masterCoverMarkdown: p.masterCoverMarkdown, scoutBrief: briefOf(p), resumeSurfaces: p.resumeSurfaces });
    },
  );

  server.registerTool(
    "list_activity",
    { title: "List activity", description: "Timeline events, optionally for one position.", inputSchema: { idOrSlug: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }, annotations: { readOnlyHint: true } },
    async (a) => {
      if (a.idOrSlug) {
        const p = await getPositionDetail(a.idOrSlug);
        if (!p) return text({ error: "not found" }, true);
        return text(await listEvents(p.id, a.limit ?? 50));
      }
      const db = await getDb();
      return text(await db.select().from(timelineEvents).orderBy(desc(timelineEvents.occurredAt)).limit(a.limit ?? 50));
    },
  );
  server.registerTool(
    "log_activity",
    { title: "Log activity", description: "Append a timeline note to a position (or global when no position).", inputSchema: { idOrSlug: z.string().optional(), title: z.string(), body: z.string().optional(), kind: z.string().optional() } },
    async (a, ctx) => {
      const p = a.idOrSlug ? await getPositionDetail(a.idOrSlug) : null;
      if (a.idOrSlug && !p) return text({ error: "not found" }, true);
      return text({ id: await addEvent({ positionId: p?.id ?? null, kind: a.kind || "note", title: a.title, body: a.body, actor: agentOf(ctx as ToolCtx) }) });
    },
  );

  // ---- newer tools --------------------------------------------------------

  server.registerTool(
    "refresh_stale_triage",
    { title: "Refresh stale decision scores", description: "Preview up to 25 stale PASS decision candidates. Set dryRun=false to queue score-only refreshes using the current profile; preserves pipeline stages and sends no notifications.", inputSchema: RefreshStaleTriageInput.shape },
    async (a) => { try { return text(await refreshStaleTriage(a)); } catch (e) { return errText(e); } },
  );

  server.registerTool(
    "run_llm",
    { title: "Run LLM operation", description: "Run triage|evaluate|materials|jd_review|form_answers|listing_classify synchronously on a position (uses Settings > AI model). Returns the result.", inputSchema: { idOrSlug: z.string(), operation: z.enum(["triage", "evaluate", "materials", "jd_review", "form_answers", "listing_classify"]), force: z.boolean().optional() } },
    async (a) => {
      const p = await getPositionDetail(a.idOrSlug);
      if (!p) return text({ error: "not found" }, true);
      try {
        const r =
          a.operation === "triage"
            ? await runTriage(p.id, { force: a.force })
            : a.operation === "evaluate"
              ? await runEvaluate(p.id)
              : a.operation === "materials"
                ? await runMaterials(p.id)
                : a.operation === "form_answers"
                  ? await (await import("@job-scout/core")).runFormAnswers(p.id)
                  : a.operation === "listing_classify"
                    ? await runListingClassify(p.id)
                    : await runJdReview(p.id);
        return text(r);
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.registerTool(
    "list_questions",
    { title: "List application questions", description: "ATS form prompts and drafted answers for a position.", inputSchema: { idOrSlug: z.string() }, annotations: { readOnlyHint: true } },
    async (a) => {
      const p = await getPositionDetail(a.idOrSlug);
      if (!p) return text({ error: "not found" }, true);
      const { listQuestions } = await import("@job-scout/core");
      return text(await listQuestions(p.id));
    },
  );
  server.registerTool(
    "update_question",
    { title: "Update application question", description: "Set answer and/or status (open|answered|skipped).", inputSchema: { id: z.string(), answer: z.string().optional(), status: z.string().optional() } },
    async (a) => {
      const { patchQuestion } = await import("@job-scout/core");
      const row = await patchQuestion(a.id, { answer: a.answer, status: a.status });
      return row ? text(row) : text({ error: "not found" }, true);
    },
  );

  server.registerTool(
    "get_evaluation",
    { title: "Get evaluation", description: "Latest evaluation markdown+json for a position. kind=evaluate|jd_review|company_research.", inputSchema: { idOrSlug: z.string(), kind: z.enum(["evaluate", "jd_review", "company_research"]).optional() }, annotations: { readOnlyHint: true } },
    async (a) => {
      const p = await getPositionDetail(a.idOrSlug);
      if (!p) return text({ error: "not found" }, true);
      const e = await getEvaluation(p.id, (a.kind || "evaluate") as EvaluationKind);
      return e ? text(e) : text({ error: "no evaluation yet" }, true);
    },
  );

  server.registerTool(
    "get_materials",
    { title: "Get current materials", description: "Current resume + cover markdown for a position.", inputSchema: { idOrSlug: z.string() }, annotations: { readOnlyHint: true } },
    async (a) => {
      const p = await getPositionDetail(a.idOrSlug);
      if (!p) return text({ error: "not found" }, true);
      const [resume, cover] = await Promise.all([getCurrentMaterial(p.id, "resume"), getCurrentMaterial(p.id, "cover")]);
      return text({ resume: resume ? { id: resume.id, version: resume.version, markdown: resume.bodyMarkdown, model: resume.model } : null, cover: cover ? { id: cover.id, version: cover.version, markdown: cover.bodyMarkdown, model: cover.model } : null });
    },
  );

  server.registerTool(
    "retry_failed_llm",
    {
      title: "Retry failed LLM jobs",
      description:
        "Re-enqueue the latest failed LLM ops in a time window and release jobs parked during an LLM outage. scope=failed_and_missing also triages open positions with no successful triage. Does not re-run successful evaluate/materials.",
      inputSchema: {
        hours: z.number().int().min(1).max(168).optional(),
        scope: z.enum(["failed", "failed_and_missing"]).optional(),
        operations: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async (a) => text(await retryFailedLlm(a)),
  );

  server.registerTool(
    "list_changes",
    {
      title: "List changes since",
      description:
        "Positions, then evaluations, changed after an ISO timestamp — the primitive the career-ops sync uses. A position counts as changed when something the operator sees moved (status, notes and other edits, JD revisions, triage, listing facts); unchanged watch checks, form harvests and career-ops stamps do not count. Rows are lean (fields=full for salary, location, departments, repost and ATS fields); lastChangedAt marks the last material JD change. Pages: pass nextCursor back as cursor with the same since until it is null, then use the returned now (fixed by the first page) as the next since. limit is rows per page (default 200); a page is also cut to stay under the result size limit (truncated=true).",
      inputSchema: {
        since: z.string(),
        limit: z.number().int().min(1).max(500).optional(),
        cursor: z.string().optional().describe("nextCursor from the previous page, unchanged"),
        fields: z.enum(["lean", "full"]).optional().describe("lean (default) or full row projection"),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const d = new Date(a.since);
      if (Number.isNaN(d.getTime())) return text({ error: "since must be ISO" }, true);
      let r;
      try {
        r = await listChangesSince(d, { limit: a.limit ?? 200, cursor: a.cursor });
      } catch (e) {
        return errText(e);
      }
      const rows: object[] = a.fields === "full" ? r.positions : r.positions.map(leanRow);
      const pos = fitPage(rows, r.positionCursors, r.nextCursor);
      // Evaluations follow only once a page has handed back every changed position.
      if (pos.truncated || r.positionsMore) {
        return text({ positions: pos.items, evaluations: [], now: r.now, nextCursor: pos.nextCursor, ...(pos.truncated ? { truncated: true } : {}) });
      }
      const used = Buffer.byteLength(JSON.stringify(pos.items));
      const evs = r.evaluations.length ? fitPage(r.evaluations, r.evaluationCursors, r.nextCursor, Math.max(1, PAGE_BUDGET_BYTES - used)) : { items: [], nextCursor: r.nextCursor, truncated: false };
      return text({ positions: pos.items, evaluations: evs.items, now: r.now, nextCursor: evs.nextCursor, ...(evs.truncated ? { truncated: true } : {}) });
    },
  );

  server.registerTool(
    "upsert_career_ops_stamp",
    { title: "Stamp career-ops link", description: "Store the career-ops tracker id/score/status/report path on a position (metadata.careerOps).", inputSchema: { idOrSlug: z.string(), trackerId: z.string().optional(), score: z.number().optional(), status: z.string().optional(), reportPath: z.string().optional(), pdfPath: z.string().optional(), jdPath: z.string().optional() } },
    async ({ idOrSlug, ...stamp }) => {
      const r = await stampCareerOps(idOrSlug, stamp);
      return r ? text(r) : text({ error: "not found" }, true);
    },
  );

  server.registerTool(
    "reconcile_career_ops",
    { title: "Reconcile career-ops export", description: "Bulk reconciliation of tracker rows (trackerId, company, title, optional url). Dry run by default. Matching, in order: the position already stamped with the row's trackerId, then the posting URL, then (rows without a URL only) an exact, unique company + title. A row without a URL that matches nothing is created as a manual position stamped with its trackerId on a real run (created; dry run lists it in wouldCreate), so re-running never duplicates it. A URL that appears later for a stamped URL-less position is set on that same position (urlSet); a URL another position holds is a conflict. Report existence is supplied by the client that owns the files; otherwise unverified.", inputSchema: ReconcileInput },
    async (a) => text(await reconcileCareerOps(a)),
  );

  server.registerTool(
    "list_career_ops_stamps",
    { title: "List career-ops stamps", description: "All positions that carry a careerOps stamp (id, slug, url, stamp, stampState.stale when the stamp names a different stage than the position).", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () => {
      const db = await getDb();
      const rows = await db
        .select({ id: positions.id, slug: positions.slug, title: positions.title, status: positions.status, primaryUrl: positions.primaryUrl, company: companies.name, careerOps: sql<Record<string, unknown>>`${positions.metadata}->'careerOps'` })
        .from(positions)
        .innerJoin(companies, eq(positions.companyId, companies.id))
        .where(and(sql`${positions.metadata} ? 'careerOps'`))
        .limit(1000);
      // `stale`: the stamp names a pipeline stage other than the position's current status.
      return text(rows.map((r) => ({ ...r, stampState: careerOpsStampState(r.status, r.careerOps) })));
    },
  );

  server.registerTool(
    "create_position_from_career_ops",
    { title: "Create from career-ops", description: "Create or link the position for one career-ops tracker row. Matching, in order: the position already stamped with trackerId (unless it holds a different posting URL than the one given), then the posting URL (fetched when reachable; a manual record titled from the role when not), then, without a URL, the one manual URL-less position with the same company and role. A row with no URL (recruiter lead, referral, closed posting) becomes a manual position keyed by company + role and stamped with trackerId, so re-running it links the same position (via). When a URL arrives later for a stamped URL-less position, it is set on that same position as a listing correction (urlSet: true; refresh_jd then reads the JD); a URL another position already holds is reported in urlConflict instead of merged. A row the tracker dropped (Discarded/SKIP/Withdrawn) that matches no position is not created (skipped: true, reason tracker_dropped). Always stamps careerOps (trackerId, score, status, reportPath) on the linked or created position. Pass trackerId whenever the tracker has one.", inputSchema: { url: z.string().optional().describe("Posting URL; omit or leave empty for a tracker row without one"), company: z.string(), role: z.string(), score: z.number().optional(), status: z.string().optional(), reportPath: z.string().optional(), trackerId: z.string().optional().describe("Tracker row id: the key that links a URL-less row to its position on re-runs"), verbose: z.boolean().optional().describe("Return the full position detail (JD text, revisions, evaluations) instead of the compact summary") } },
    async (a) => {
      try {
        const url = a.url?.trim() || undefined;
        let position: { id: string; status: string; title: string | null; primaryUrl?: string | null } | null | undefined;
        let fetchFailure: Record<string, unknown> | undefined;
        let via: string = url ? "url" : "created";
        let manualRecord = false;
        let urlSet = false;
        let urlConflict: string | undefined;
        const linked = matchCareerOpsRow(await groupingRows(), { trackerId: a.trackerId, company: a.company, title: a.role, url });
        if (linked && "ambiguous" in linked) {
          return text({ error: "ambiguous_tracker_row: several positions match this tracker row; pass the posting URL or fix the trackerId stamps", positionIds: linked.ambiguous }, true);
        }
        // A row the tracker dropped (Discarded, SKIP…, Withdrawn) that matches nothing never becomes an active position.
        if (!linked && careerOpsDropStatus(a.status)) {
          return text({ skipped: true, reason: "tracker_dropped", trackerId: a.trackerId ?? null, status: a.status ?? null });
        }
        if (linked) {
          via = linked.via;
          if (url && !linked.primaryUrl) {
            const r = await setCareerOpsUrl(linked.id, url);
            if ("urlSet" in r) urlSet = true;
            else urlConflict = r.conflict;
          }
          position = await getPositionDetail(linked.id);
        } else if (url) {
          try {
            // source=career-ops: a revive of an archived row here is the sync, not a person.
            position = (await intakeUrl(url, { companyName: a.company, status: "review", source: "career-ops" })).position;
          } catch (intakeError) {
            // Never silent: the manual record carries the fetch reason (metadata.lastAtsFetch + response).
            fetchFailure = { message: intakeError instanceof Error ? intakeError.message : String(intakeError), ...errorDetails(intakeError) };
            manualRecord = true;
            const r = await upsertFromJob({ provider: "other", title: a.role, company: a.company, url, listingStatus: "unknown" }, { source: "career-ops", companyName: a.company, status: "review" });
            position = r.position;
            if (r.created) await recordAtsFetchFailure(position.id, intakeError, "career-ops");
          }
        } else {
          manualRecord = true;
          position = await createManualCareerOpsPosition({ company: a.company, title: a.role });
        }
        if (!position) throw new Error("position missing");
        const mapped = mapCareerOpsStatus(a.status);
        if (careerOpsDropStatus(a.status)) await noteCareerOpsDrop(position.id, String(a.status));
        const patch: Record<string, unknown> = {};
        if (mapped && mapped !== position.status) patch.status = mapped;
        // Workday/landing pages often yield no title from the fetch: the tracker role is the truth then.
        if (!position.title?.trim()) patch.title = a.role;
        // Same precedence as set_position_status: a stale tracker row never moves the role backwards.
        if (Object.keys(patch).length) await patchFromCaller(position.id, patch, { actor: "career-ops", source: "career-ops", trackerStatus: a.status, note: `career-ops tracker${a.trackerId ? ` #${a.trackerId}` : ""} is ${a.status ?? "unknown"}` });
        const stamp = await stampCareerOps(position.id, { trackerId: a.trackerId, score: a.score, status: a.status, reportPath: a.reportPath });
        const detail = await getPositionDetail(position.id);
        return text({ position: a.verbose || !detail ? detail : positionSummary(detail), stamp, via,
          ...(manualRecord ? { manualRecord: true } : {}), ...(fetchFailure ? { fetchFailure } : {}),
          ...(urlSet ? { urlSet: true } : {}), ...(urlConflict ? { urlConflict } : {}) });
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.registerTool(
    "list_processes",
    {
      title: "List live processes",
      description: "Positions in applied/screen/interview/offer with round timeline, nextAction, last/next round. The process desk.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { listProcesses } = await import("@job-scout/core");
      return text(await listProcesses());
    },
  );

  server.registerTool(
    "list_all_interviews",
    {
      title: "List all interview rounds",
      description: "Desk of every round across positions and recruiter leads; a lead round has positionId null plus leadId, leadRole and leadStatus. Slim (no transcript bodies). lane=upcoming|completed|needs_brief|all. Use get_interview for the corpus.",
      inputSchema: { lane: z.string().optional(), q: z.string().optional(), stage: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const { listAllInterviews } = await import("@job-scout/core");
      return text(await listAllInterviews({ lane: a.lane, q: a.q, stage: a.stage }));
    },
  );

  server.registerTool(
    "list_interviews",
    {
      title: "List interviews",
      description: "Interview rounds for a position (screen, hiring manager, technical). Slim: metadata + char counts, not transcript bodies. Use get_interview for the corpus.",
      inputSchema: { idOrSlug: z.string() },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const p = await getPositionDetail(a.idOrSlug);
      if (!p) return text({ error: "not found" }, true);
      const { listInterviews } = await import("@job-scout/core");
      return text(await listInterviews(p.id));
    },
  );

  server.registerTool(
    "get_interview",
    {
      title: "Get one interview round",
      description: "Full round: notes, review, transcript, AI brief vs JD/company pack.",
      inputSchema: { idOrSlug: z.string(), interviewId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const p = await getPositionDetail(a.idOrSlug);
      if (!p) return text({ error: "not found" }, true);
      const { getInterview } = await import("@job-scout/core");
      const row = await getInterview(p.id, a.interviewId);
      return row ? text(row) : text({ error: "not found" }, true);
    },
  );

  server.registerTool(
    "upsert_interview",
    {
      title: "Create or update an interview round",
      description:
        "Store a screen/interview: stage, interviewer, outcome, notes, review, transcript. If transcriptMarkdown is set, queues an AI brief against the JD and company pack unless skipBrief=true. Pass id to patch an existing round. For a recruiter screening before there is a position, pass leadId instead of idOrSlug (no AI brief, no alert; a scheduled round moves the lead to screening_scheduled, a completed one to screened). Returns round metadata and char counts (verbose=true for the full round); get_interview reads the bodies.",
      inputSchema: {
        idOrSlug: z.string().optional().describe("Position id or slug. Required unless leadId is set"),
        leadId: z.string().optional().describe("Recruiter lead id, for a round on a lead with no position"),
        id: z.string().optional(),
        stage: z.string().optional(),
        title: z.string().optional(),
        interviewerName: z.string().optional(),
        interviewerRole: z.string().optional(),
        scheduledAt: z.string().optional(),
        occurredAt: z.string().optional(),
        durationSeconds: z.number().optional(),
        status: z.string().optional().describe("pending | completed | cancelled. Aliases: scheduled and upcoming are stored as pending, canceled as cancelled, done as completed. Default pending on create"),
        outcome: z.string().optional().describe("advanced | hold | rejected | cancelled | unclear"),
        notes: z.string().optional(),
        notesMarkdown: z.string().optional(),
        reviewMarkdown: z.string().optional(),
        transcriptMarkdown: z.string().optional(),
        transcriptSource: z.string().optional(),
        sourcePath: z.string().optional(),
        skipBrief: z.boolean().optional(),
        verbose: z.boolean().optional().describe("Return the full round (notes, review, transcript, AI brief) instead of metadata and char counts"),
      },
    },
    async (a) => {
      if (!a.idOrSlug && !a.leadId) return text({ error: "idOrSlug or leadId required" }, true);
      const p = a.idOrSlug ? await getPositionDetail(a.idOrSlug) : null;
      if (a.idOrSlug && !p) return text({ error: "not found" }, true);
      const { addInterview, patchInterview, upsertLeadInterview } = await import("@job-scout/core");
      const input = {
        stage: a.stage,
        title: a.title,
        interviewerName: a.interviewerName,
        interviewerRole: a.interviewerRole,
        scheduledAt: a.scheduledAt,
        occurredAt: a.occurredAt,
        durationSeconds: a.durationSeconds,
        status: a.status,
        outcome: a.outcome,
        notes: a.notes,
        notesMarkdown: a.notesMarkdown,
        reviewMarkdown: a.reviewMarkdown,
        transcriptMarkdown: a.transcriptMarkdown,
        transcriptSource: a.transcriptSource,
        sourcePath: a.sourcePath,
        skipBrief: a.skipBrief,
      };
      try {
        const row = !p ? await upsertLeadInterview(a.leadId!, { ...input, id: a.id }) : a.id ? await patchInterview(p.id, a.id, input) : await addInterview(p.id, input);
        if (!row) return text({ error: "not found" }, true);
        return text(a.verbose ? row : interviewSummary(row));
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.registerTool(
    "brief_interview",
    {
      title: "AI-brief an interview",
      description:
        "Run (or queue) the interview_brief model: reasoned view of this round vs the JD, company pack, and candidate identity. Default queues a worker job; sync=true runs in-process.",
      inputSchema: { idOrSlug: z.string(), interviewId: z.string(), sync: z.boolean().optional() },
    },
    async (a) => {
      const p = await getPositionDetail(a.idOrSlug);
      if (!p) return text({ error: "not found" }, true);
      const { enqueueInterviewBrief, runInterviewBrief } = await import("@job-scout/core");
      try {
        if (a.sync) return text(await runInterviewBrief(p.id, a.interviewId));
        const q = await enqueueInterviewBrief(p.id, a.interviewId);
        return q ? text({ jobId: q.id, deduped: q.deduped }) : text({ error: "not found" }, true);
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.registerTool("jev_status", { title: "Jev settings and usage", description: "Read decision settings, credential availability and today's usage. Does not call a model.", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => text(await jevStatus()));
  server.registerTool("jev_history", { title: "Jev decision history", description: "Read recent decision summaries and feedback for a position. Does not call a model.", inputSchema: { positionId: z.string().optional(), limit: z.number().int().min(1).max(20).default(5) }, annotations: { readOnlyHint: true } }, async a => text((await recentDecisions(a.positionId)).slice(0, a.limit).map(({ result, ...run }) => ({ ...run, usage: result ? { inputTokens: result.inputTokens, cost: result.cost, latencyMs: result.latencyMs } : null }))));
  server.registerTool("jev_preview", { title: "Preview a Jev decision", description: "Run a job-fit, ranking, or draft check using saved Jev settings. Sends job/profile evidence and, for draft checks, the draft to OpenRouter. Consumes the Jev request budget and records a result; leaves positions and approvals unchanged.", inputSchema: { positionId: z.string(), recipe: z.enum(["triage", "ranking", "evaluation_check", "materials_check"]), fresh: z.boolean().default(false) }, annotations: { readOnlyHint: false, destructiveHint: false } }, async a => {
    try { const run = await previewDecision(a.recipe, a.positionId, a.fresh); return text(run, run.status !== "ok"); }
    catch { return text({ error: "Jev could not run this preview. Check the saved settings, request budget and available source material." }, true); }
  });

  const LEAD_FIELDS = {
    source: z.string().optional().describe("linkedin | email | whatsapp | referral | other"),
    recruiterName: z.string().optional(),
    recruiterCompany: z.string().optional().describe("The recruiting firm (or the employer, for an in-house recruiter)"),
    recruiterProfileUrl: z.string().optional().describe("Recruiter profile URL; the dedupe key together with pitchedRole"),
    recruiterEmail: z.string().optional(),
    recruiterPhone: z.string().optional(),
    pitchedRole: z.string().optional(),
    clientHint: z.string().optional().describe("What is known about the hiring client (\"Series B fintech\"), or its name"),
    statedPay: z.string().optional().describe("Pay as stated, free text. Only an explicit USD yearly figure is compared with the cash floor"),
    statedGeo: z.string().optional().describe("Geography / remote terms as stated"),
    statedContract: z.string().optional().describe("Contract terms as stated (PJ, contractor, FTE via EOR, duration)"),
    openUnknowns: z.array(z.string()).optional().describe("Questions still open (replaces the list)"),
    threadUrls: z.array(z.string()).optional().describe("Thread URLs to add"),
    threadUrl: z.string().optional().describe("One thread URL to add"),
    notes: z.string().optional(),
    nextAction: z.string().optional(),
    closedReason: z.string().optional(),
  };
  const MESSAGE = z.object({
    direction: z.enum(LEAD_DIRECTIONS),
    body: z.string().max(50_000).optional().describe("Message text; phone numbers and emails are redacted before storage"),
    channel: z.string().optional(),
    who: z.string().optional(),
    occurredAt: z.string().optional(),
    threadUrl: z.string().optional(),
  });
  const leadErr = (e: unknown) => errText(e);

  server.registerTool(
    "upsert_lead",
    {
      title: "Create or update a recruiter lead",
      description: `Track a recruiter message that has no job URL yet (recruiter × pitched role × threads). Without id it dedupes on recruiter profile URL (else email, else name + firm) + pitchedRole: a second thread from the same recruiter about the same role updates that lead and appends its thread URL. With id it patches that lead (status: ${LEAD_STATUSES.join(" → ")}). Optional message logs the first message (phone numbers and emails redacted). Returns the lead with leadTriage (cash floor only on an explicit USD yearly figure, geography, stack, open unknowns). Tracking only: never sends a message and never raises a fit alert.`,
      inputSchema: { id: z.string().optional(), status: z.enum(LEAD_STATUSES).optional(), ...LEAD_FIELDS, message: MESSAGE.optional() },
    },
    async (a, ctx) => {
      try {
        const r = await upsertLead(a, agentOf(ctx as ToolCtx));
        return r ? text({ ...r.lead, created: r.created }) : text({ error: "not found" }, true);
      } catch (e) {
        return leadErr(e);
      }
    },
  );

  server.registerTool(
    "list_leads",
    {
      title: "List recruiter leads",
      description: `Lean lead rows, latest activity first: id, status, bucket (${LEAD_BUCKETS.join("|")}), recruiter, pitchedRole, clientHint, stated pay/geo, triageVerdict, unknownCount, threadCount, positionId, last inbound/outbound. Contacts and message bodies only via get_lead. Default leaves out promoted/closed; status takes a comma list or all. Paging: pass nextCursor back as cursor with the same filters until it is null.`,
      inputSchema: {
        status: z.string().optional(),
        lane: z.enum(LEAD_BUCKETS).optional(),
        q: z.string().optional(),
        includeClosed: z.boolean().optional(),
        pageSize: z.number().int().min(1).max(200).optional().describe("Rows per page, default 50"),
        cursor: z.string().optional().describe("nextCursor from the previous page, unchanged"),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      try {
        const r = await listLeads({ ...a, pageSize: a.pageSize ?? 50 });
        const page = fitPage(r.items, r.cursors, r.nextCursor);
        return text({ items: page.items, total: r.total, pageSize: r.pageSize, nextCursor: page.nextCursor, ...(page.truncated ? { truncated: true } : {}) });
      } catch (e) {
        return leadErr(e);
      }
    },
  );

  server.registerTool(
    "get_lead",
    { title: "Get a recruiter lead", description: "Full lead: recruiter contact, stated terms, thread URLs, leadTriage, work-queue bucket, message log (newest first, redacted) and interview rounds.", inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
    async (a) => {
      const r = await getLead(a.id);
      return r ? text(r) : text({ error: "not found" }, true);
    },
  );

  server.registerTool(
    "log_lead_message",
    { title: "Log a lead message", description: "Append an inbound/outbound/note message to a lead's outreach log. Phone numbers and emails in the body are redacted before storage. An outbound message moves a new/vetted lead to replied. Records only; nothing is sent.", inputSchema: { id: z.string(), ...MESSAGE.shape } },
    async ({ id: leadId, ...msg }) => {
      try {
        const r = await logLeadMessage(leadId, msg);
        return r ? text(r) : text({ error: "not found" }, true);
      } catch (e) {
        return leadErr(e);
      }
    },
  );

  server.registerTool(
    "promote_lead",
    {
      title: "Promote a lead to a position",
      description: "Once the recruiter shares a job: link an existing position (positionIdOrSlug) or create one from a job URL (url; fetch=false stores a manual record without fetching, and a failed fetch falls back to a manual record). The lead becomes promoted; its rounds and messages are linked to the position. Title defaults to pitchedRole, company to clientHint, then the recruiting firm.",
      inputSchema: { id: z.string(), positionIdOrSlug: z.string().optional(), url: z.string().optional(), title: z.string().optional(), company: z.string().optional(), fetch: z.boolean().optional() },
    },
    async ({ id: leadId, ...input }, ctx) => {
      try {
        const r = await promoteLead(leadId, input, agentOf(ctx as ToolCtx));
        return r ? text(r) : text({ error: "not found" }, true);
      } catch (e) {
        return leadErr(e);
      }
    },
  );

  server.registerTool(
    "link_lead_position",
    { title: "Link a lead to a position", description: "Attach a lead (and its rounds and messages) to an existing position without changing the lead status. Use promote_lead to also mark it promoted.", inputSchema: { id: z.string(), positionIdOrSlug: z.string() } },
    async (a, ctx) => {
      try {
        const r = await linkLeadPosition(a.id, a.positionIdOrSlug, agentOf(ctx as ToolCtx));
        return r ? text(r) : text({ error: "not found" }, true);
      } catch (e) {
        return leadErr(e);
      }
    },
  );

  server.registerTool(
    "merge_leads",
    { title: "Merge leads", description: "Merge sourceIds into id: messages and rounds move over, thread URLs and unknowns are combined, empty fields are filled from the sources. Sources are closed with mergedIntoId; nothing is deleted.", inputSchema: { id: z.string(), sourceIds: z.array(z.string()).min(1) } },
    async (a, ctx) => {
      try {
        const r = await mergeLeads(a.id, a.sourceIds, agentOf(ctx as ToolCtx));
        return r ? text(r) : text({ error: "not found" }, true);
      } catch (e) {
        return leadErr(e);
      }
    },
  );

  server.registerTool(
    "screen_recruiter_threat",
    {
      title: "Screen recruiter outreach",
      description:
        "Screen an inbound recruiter email, URL or domain (and optional message text) for fake-interview malware signals: operator blocklist (THREAT_BLOCKLIST_DOMAINS), domain age from a public RDAP lookup at rdap.org, free-mail sender and installer/script lures in the text. Message text is untrusted input; it is scanned, never followed, and not echoed back. Returns a structured verdict (riskLevel, score, flags, recommendations).",
      inputSchema: {
        domainOrEmail: z.string().max(320),
        messageText: z.string().max(20_000).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) => {
      const { evaluateRecruiterThreat } = await import("@job-scout/core");
      try {
        return text(await evaluateRecruiterThreat({ domainOrEmail: a.domainOrEmail, messageText: a.messageText }));
      } catch (e) {
        return errText(e);
      }
    },
  );
  return server;
}

export { mapCareerOpsStatus };
