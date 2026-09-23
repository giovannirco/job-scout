# Retry, sources, Pipeline timestamps Implementation Plan

> Historical implementation plan from 2026-09-04. Current behavior is in `README.md` and `docs/`. This file is not kept in sync.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship 2.3.9: bulk retry of failed LLM ops, Remotive + crypto/remote ATS sources, Pipeline first-seen/changed columns.

**Architecture:** `retryFailedLlm` selects latest error `llm_runs` per (position, op) and enqueues existing job types with `force`. Remotive clones the WWR `listBoard` path against public JSON. Pipeline already returns timestamps; the table must show them. Bootstrap promotes `FULL_CATALOG` `list_api` on boot.

**Tech Stack:** TypeScript, drizzle/pglite, Hono, Vitest, React 19, GitOps Helm pin.

**Spec:** `docs/superpowers/specs/2026-09-04-retry-sources-pipeline-design.md`

## Global Constraints

- `v2` is production. Image tag `2.3.9`. Do not apply. Do not resume Huntr.
- TDD: failing test first. No fallbacks. UTC timestamps.
- Daily caps / `LlmGateError` still apply on re-run.
- LinkedIn is not a scanner. Himalayas stays `manual_watch`.
- Inline execution (unattended). One image.

## File layout

- Modify: `packages/core/src/llm.ts` — `retryFailedLlm`
- Modify: `apps/api/src/routes/settings.ts` — POST `/llm/retry`
- Modify: `apps/api/src/mcp/server.ts` — `retry_failed_llm`
- Modify: `apps/web/src/pages/Today.tsx`, `Settings.tsx` — Retry failed button
- Modify: `packages/ats/src/fetch.ts` — `listRemotive`
- Modify: `packages/shared/src/source-catalog.ts` — Remotive list_api + ATS + Bitcoiner Jobs
- Modify: `apps/web/src/pages/Pipeline.tsx`, `Radar.tsx` — timestamps + copy
- Modify: `packages/core/src/positions.ts` — sort `last_changed`
- Modify: docs API/MCP/AI, version pins, GitOps tag

---

### Task 1: retryFailedLlm

**Files:**
- Modify: `packages/core/src/llm.ts`
- Modify: `packages/core/src/core.test.ts`
- Test: `packages/core/src/core.test.ts`

**Interfaces:**
- Consumes: `enqueueJob`, `llmRuns`, `positions`, `getDb`
- Produces: `retryFailedLlm(opts?) → { enqueued, skipped, items }`

- [ ] **Step 1: Write the failing tests** inside the existing `core on pglite` describe (shared bootstrap).

```ts
it("retries the latest failed llm op and skips a later success", async () => {
  const { upsertFromJob } = await import("./positions.js");
  const { retryFailedLlm } = await import("./llm.js");
  const { getDb, llmRuns, id, jobs } = await import("@job-scout/db");
  const { eq } = await import("drizzle-orm");
  const { position } = await upsertFromJob(job({ jobId: "retry-1", externalIdentity: "greenhouse:acme:retry-1", url: "https://boards.greenhouse.io/acme/jobs/retry-1" }), { source: "test" });
  const db = await getDb();
  const old = new Date(Date.now() - 60_000);
  await db.insert(llmRuns).values([
    { id: id("run"), operation: "triage", model: "m", positionId: position.id, status: "error", error: "quota", createdAt: old },
    { id: id("run"), operation: "evaluate", model: "m", positionId: position.id, status: "error", error: "quota" },
    { id: id("run"), operation: "evaluate", model: "m", positionId: position.id, status: "ok" },
  ]);
  const r = await retryFailedLlm({ hours: 24, scope: "failed" });
  expect(r.items.some((i) => i.operation === "triage" && i.positionId === position.id)).toBe(true);
  expect(r.items.some((i) => i.operation === "evaluate")).toBe(false);
  const queued = await db.select().from(jobs).where(eq(jobs.type, "triage"));
  expect(queued.some((j) => (j.payload as { positionId?: string; force?: boolean }).positionId === position.id && (j.payload as { force?: boolean }).force === true)).toBe(true);
});

it("does not retry archived positions; failed_and_missing enqueues untriaged opens", async () => {
  const { upsertFromJob, archivePosition } = await import("./positions.js");
  const { retryFailedLlm } = await import("./llm.js");
  const { getDb, llmRuns, id } = await import("@job-scout/db");
  const dead = await upsertFromJob(job({ jobId: "retry-arch", externalIdentity: "greenhouse:acme:retry-arch", url: "https://boards.greenhouse.io/acme/jobs/retry-arch" }), { source: "test" });
  const open = await upsertFromJob(job({ jobId: "retry-miss", externalIdentity: "greenhouse:acme:retry-miss", url: "https://boards.greenhouse.io/acme/jobs/retry-miss", title: "Staff SRE" }), { source: "test" });
  await archivePosition(dead.position.id, "test", "test");
  const db = await getDb();
  await db.insert(llmRuns).values({ id: id("run"), operation: "triage", model: "m", positionId: dead.position.id, status: "error", error: "quota" });
  const failedOnly = await retryFailedLlm({ hours: 24, scope: "failed" });
  expect(failedOnly.items.some((i) => i.positionId === dead.position.id)).toBe(false);
  const r = await retryFailedLlm({ hours: 24, scope: "failed_and_missing", limit: 500 });
  expect(r.items.some((i) => i.positionId === open.position.id && i.operation === "triage")).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test packages/core/src/core.test.ts`
Expected: FAIL — `retryFailedLlm` is not exported.

- [ ] **Step 3: Write minimal implementation** in `packages/core/src/llm.ts`

```ts
export const RETRYABLE_LLM_OPS = [
  "triage", "evaluate", "materials", "jd_review",
  "company_research", "form_answers", "listing_classify",
] as const;

export type RetryFailedScope = "failed" | "failed_and_missing";

export async function retryFailedLlm(opts: {
  hours?: number;
  scope?: RetryFailedScope;
  operations?: string[];
  limit?: number;
} = {}) {
  const hours = Math.min(168, Math.max(1, opts.hours ?? 24));
  const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
  const scope = opts.scope ?? "failed";
  const allowed = new Set(RETRYABLE_LLM_OPS);
  const ops = (opts.operations?.length ? opts.operations : [...RETRYABLE_LLM_OPS]).filter((o) => allowed.has(o as never));
  // latest llm_runs per (positionId, operation) in window
  // keep status=error; join positions; skip archived/skip
  // enqueue force + existing dedupe keys
  // if failed_and_missing, add open positions with no ok triage
}
```

Use DISTINCT ON / window in SQL via drizzle `sql`. Enqueue `company_research` with `{ companyId, positionId }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test packages/core/src/core.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(llm): bulk retry failed and missing-triage runs"
```

---

### Task 2: API + MCP

**Files:**
- Modify: `apps/api/src/routes/settings.ts`
- Modify: `apps/api/src/mcp/server.ts`
- Modify: `docs/API.md`, `docs/MCP.md`, `docs/AI.md`

**Interfaces:**
- Consumes: `retryFailedLlm`
- Produces: `POST /api/v1/settings/llm/retry` 202; MCP `retry_failed_llm`

- [ ] **Step 1: Write failing route test** in `apps/api/src/routes/desk.test.ts` (or a small settings test) that POSTs `/api/v1/settings/llm/retry` and expects 202 with `enqueued`. If desk tests need a running app, skip HTTP and unit-test the handler by importing `retryFailedLlm` (already covered) plus a smoke import of the route. Prefer an HTTP test if desk.test already boots the app.

If no cheap HTTP harness exists, document MCP/route as wiring-only and cover via core tests. Check `desk.test.ts` first; if it boots Hono, add a POST case.

- [ ] **Step 2: Implement**

```ts
settingsRoutes.post("/llm/retry", async (c) => {
  const b = await body<{ hours?: number; scope?: "failed" | "failed_and_missing"; operations?: string[]; limit?: number }>(c);
  const r = await retryFailedLlm(b);
  return ok(c, r, {}, 202);
});
```

MCP:

```ts
server.registerTool(
  "retry_failed_llm",
  {
    title: "Retry failed LLM jobs",
    description: "Re-enqueue latest failed LLM ops in a window. scope=failed_and_missing also triages open positions with no successful triage. Does not re-run successful evaluate/materials.",
    inputSchema: {
      hours: z.number().int().min(1).max(168).optional(),
      scope: z.enum(["failed", "failed_and_missing"]).optional(),
      operations: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
  },
  async (a) => text(await retryFailedLlm(a)),
);
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(api): POST /settings/llm/retry and MCP retry_failed_llm"
```

---

### Task 3: Retry buttons

**Files:**
- Modify: `apps/web/src/pages/Today.tsx`
- Modify: `apps/web/src/pages/Settings.tsx`

- [ ] **Step 1:** Today Machine panel: if `d.llm.byOperation` has any `failures > 0`, show Btn "Retry failed" that POSTs `/api/v1/settings/llm/retry` with `{ hours: 24, scope: "failed_and_missing" }`, toasts `Retry queued: N jobs`, invalidates `["today"]` and `["llm"]`.
- [ ] **Step 2:** Settings › AI header: always-visible "Retry failed" with the same body.
- [ ] **Step 3: Commit**

```bash
git commit -m "feat(desk): retry-failed button on Today and Settings AI"
```

---

### Task 4: Remotive list_api

**Files:**
- Modify: `packages/ats/src/fetch.ts`
- Test: `packages/ats/src/fetch.test.ts`
- Modify: `packages/core/src/core.test.ts` (enqueue Remotive)

**Interfaces:**
- Consumes: `fetchText`, `isCraftMatch`
- Produces: `listRemotive` via `listBoard("market", "remotive", …)`

- [ ] **Step 1: Failing tests**

```ts
const REMOTIVE_API = "https://remotive.com/api/remote-jobs?category=software-dev";
export const REMOTIVE_FIXTURE = {
  "job-count": 3,
  jobs: [
    { id: 1, url: "https://remotive.com/remote-jobs/software-dev/senior-sre-1", title: "Senior SRE", company_name: "Grafana Labs", candidate_required_location: "Worldwide", category: "Software Development" },
    { id: 2, url: "https://remotive.com/remote-jobs/writing/freelance-copywriter-2", title: "Freelance Copywriter", company_name: "Coalition", candidate_required_location: "Worldwide", category: "Writing" },
    { id: 3, url: "https://remotive.com/remote-jobs/software-dev/platform-engineer-3", title: "Platform Engineer", company_name: "Neon", candidate_required_location: "Remote - Americas", category: "Software Development" },
  ],
};

it("returns craft-matching Remotive jobs and drops copywriters", async () => {
  mockRemotiveFetch();
  const { jobs, total } = await listBoard("market", "remotive", "Remotive");
  expect(total).toBe(2);
  expect(jobs.map((j) => j.title)).toEqual(["Senior SRE", "Platform Engineer"]);
  expect(jobs[0]).toMatchObject({
    provider: "remotive",
    boardToken: "remotive",
    jobId: "1",
    externalIdentity: "remotive:1",
    company: "Grafana Labs",
    locationRaw: "Worldwide",
  });
});
```

Also: provider `remotive` accepted; 403 throws `/remotive/i`.

Flip `core.test.ts` enqueue: `expect(queued.some((j) => company === "Remotive")).toBe(true)` and assert remotive board `capability === "list_api"`.

- [ ] **Step 2: Run to fail** — `pnpm test packages/ats/src/fetch.test.ts packages/shared/src/source-catalog.test.ts`

- [ ] **Step 3: Implement** `listRemotive` + `isRemotiveBoard` (provider `remotive` OR market+token remotive). Parse `jobs[]`. Skip without id/title. `isCraftMatch(title)` only.

- [ ] **Step 4: Pass + commit**

```bash
git commit -m "feat(ats): scan Remotive public JSON with craft title gate"
```

---

### Task 5: Catalog

**Files:**
- Modify: `packages/shared/src/source-catalog.ts`
- Modify: `packages/shared/src/source-catalog.test.ts`

- [ ] **Step 1: Failing tests**

```ts
it("marks Remotive as a scanned list_api feed", () => {
  const remotive = MARKET_CATALOG.find((e) => e.token === "remotive");
  expect(remotive).toMatchObject({ capability: "list_api", sourceKind: "market" });
  expect(remotive?.notes).toMatch(/api/i);
});

it("includes crypto and remote ATS boards probed live", () => {
  const keys = ATS_CATALOG.map((e) => `${e.provider}:${e.token}`);
  for (const k of [
    "greenhouse:galaxy", "greenhouse:canonical", "greenhouse:hut8",
    "greenhouse:blockchain", "greenhouse:consensys",
    "ashby:blockstream", "ashby:polymarket", "ashby:camunda",
    "ashby:openai", "ashby:primer.io",
  ]) expect(keys).toContain(k);
});
```

Remove the old "keeps other market boards as operator watches" Remotive assertion; keep uniqueness.

- [ ] **Step 2: Implement catalog rows.** Bitcoiner Jobs `manual_watch`. Update `SCOUT_PLAYBOOK.pass0`.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(catalog): Remotive list_api plus crypto and remote ATS boards"
```

---

### Task 6: Pipeline timestamps

**Files:**
- Modify: `packages/core/src/positions.ts` — allow sort field `last_changed`
- Modify: `apps/web/src/pages/Pipeline.tsx`
- Modify: `apps/web/src/pages/Radar.tsx`
- Modify: `apps/api/src/mcp/server.ts` list_positions sort blurb
- Test: extend `core.test.ts` "list endpoints honor sort=" if it lists allowed fields

- [ ] **Step 1:** Add `last_changed` to `parseListSort` allowed list and order by `positions.lastChangedAt`.
- [ ] **Step 2:** Pipeline table: SortHead First seen / Changed; cells `ago(firstSeenAt)` / `ago(lastChangedAt)` or `—`. Sort dropdown option `last_changed_desc`. Subtitle: `Owned positions. Discovery is the scan firehose.` Board card: first seen line.
- [ ] **Step 3:** Discovery PageHeader subtitle: `Scan firehose — listings observed this window, not owned positions. Owned roles live in Pipeline.`
- [ ] **Step 4: Commit**

```bash
git commit -m "feat(desk): first seen and last changed on Pipeline"
```

---

### Task 7: Version, PR, live

**Files:**
- `package.json` version `2.3.9`
- `deploy/helm/job-scout/Chart.yaml` version + appVersion
- `deploy/helm/job-scout/values.yaml` image.tag
- GitOps `apps/job-scout-v2/values.yaml` + `helm/` copy

- [ ] Bump versions.
- [ ] `pnpm test` full suite green.
- [ ] PR into `v2`, merge, push.
- [ ] `docker buildx build --platform linux/amd64 --build-arg APP_VERSION=2.3.9 -f deploy/Dockerfile -t ghcr.io/giovannirco/job-scout:2.3.9 --push .`
- [ ] Pin GitOps tag `2.3.9`, push `main`.
- [ ] Argo hard refresh `cluster-job-scout-v2-prod`.
- [ ] Verify `GET http://localhost:8080/api/v1/health` version `2.3.9`.
- [ ] `POST /api/v1/settings/llm/retry` `{ hours: 48, scope: "failed_and_missing" }` with operator token.
- [ ] Confirm worker queue has triage jobs; Pipeline shows First seen / Changed.

---

## Self-review

- Spec retry / sources / panel each have a task.
- No TBD placeholders.
- `retryFailedLlm` name is consistent across core, API, MCP, UI.
- Final plan step: PR review of the branch, drop leftover comments, tests green.
