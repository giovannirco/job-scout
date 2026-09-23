# job-scout 2.3.9 — retry, sources, positions panel

> Historical design record from 2026-09-04. Current behavior is in `README.md` and `docs/`. This file is not kept in sync.

Status: accepted (unattended; operator asked to lock decisions and ship)  
Date: 2026-09-04  
Branch: `v2` → image `2.3.9`  
Live: `http://localhost:8080`

## Problem

1. Today's triage failed in bulk, with some evaluate/materials errors, after OpenAI-quota exhaustion. Per-position Re-triage exists; there is no bulk retry. Operator also wanted failed work (and still-untriaged opens) to run again after model/fallback changes — not a blast of already-successful expensive evals.
2. Discovery coverage is thin on remote indexes and crypto ATS. LinkedIn/X articles point at Remotive, WWR, Remote OK, Himalayas, Wellfound, plus company career pages. Crypto aggregators (web3.career, CryptoJobsList) have no stable public JSON we can scan.
3. Operator is missing a panel of *owned positions* with first seen, last updated, and a bit more. They guessed Discovery. Discovery is the scan firehose (`observedAt`). Pipeline already lists owned positions but hides `firstSeenAt` / `lastChangedAt` even though the API returns them.

## Decisions (locked)

- One ship: retry + sources + Pipeline timestamps. Image **2.3.9**.
- Do not invent a fourth positions page. **Pipeline is the positions panel.** Discovery stays the firehose; its subtitle must say so.
- Retry **failed latest LLM ops** in a time window, plus optional **open positions with no successful triage**. Do not re-run successful evaluate/materials.
- Prefer **ATS list_api** over aggregators. LinkedIn Jobs is not a scanner (auth/ToS). Himalayas has a public JSON API but it is an unfilterable ~100k firehose (query params ignored); keep `manual_watch`. Working Nomads `jobsapi` is a schema dump, not jobs; skip.
- Remotive public JSON (`/api/remote-jobs?category=software-dev`) is list_api, title-gated with `isCraftMatch` (same as WWR).
- Quota fallback (2.3.6) stays as-is. Daily caps / `LlmGateError` still apply on the re-run. Do not apply on the operator's behalf.

## Retry

### Shape

`retryFailedLlm(opts)` in `packages/core/src/llm.ts`.

```ts
export const RETRYABLE_LLM_OPS = [
  "triage", "evaluate", "materials", "jd_review",
  "company_research", "form_answers", "listing_classify",
] as const;

export type RetryFailedScope = "failed" | "failed_and_missing";

export async function retryFailedLlm(opts?: {
  hours?: number;          // default 24, clamp 1..168
  scope?: RetryFailedScope; // default "failed"
  operations?: string[];   // intersect RETRYABLE; default all
  limit?: number;          // default 200, clamp 1..500
}): Promise<{
  enqueued: number;
  skipped: number;
  items: { positionId: string; operation: string; jobId: string; deduped: boolean }[];
}>;
```

### Selection

1. Latest `llm_runs` row per `(positionId, operation)` in the window, `positionId` not null, operation in the retryable set.
2. Keep the row only when `status = 'error'`.
3. Drop if the position is missing or `status ∈ {archived, skip}`.
4. Enqueue with `force: true`, existing dedupe keys (`triage:${id}`, …). `company_research` payload is `{ companyId, positionId }` (look up `companyId`). Others `{ positionId, force: true }`. Priority 20.
5. `scope = failed_and_missing`: also enqueue `triage` (force) for positions whose status is not archived/skip and that have **no** `llm_runs` row with `operation=triage` and `status=ok` (ever). Cap still applies to the combined list.
6. Dedupe of already queued/running jobs is `enqueueJob`'s job. Failed jobs can re-enqueue the same key (existing behavior).
7. Skip `chat` and `test`. Do not touch succeeded evaluate/materials.

### Surface

- `POST /api/v1/settings/llm/retry` → 202 + result.
- Today › Machine: **Retry failed** when any 24h LLM failure count > 0. Body `{ hours: 24, scope: "failed_and_missing" }` — this is the recovery button after quota.
- Settings › AI: same button, always visible.
- MCP `retry_failed_llm` with the same opts.
- After 2.3.9 is live, the deploy step POSTs once (`hours=48`, `failed_and_missing`) so today's quota failures actually re-run.

## Positions panel (Pipeline)

Pipeline already owns the rows. Add:

- Column **First seen** (`firstSeenAt`), sortable (`first_seen`).
- Column **Changed** (`lastChangedAt` — JD/watch material change), sortable (`last_changed`).
- Keep **Updated** (`updatedAt`, any row touch) — default sort stays `updated_desc`.
- Sort dropdown: add `last_changed_desc`.
- Board cards: show first seen under the title when present.
- Subtitle: `Owned positions. Discovery is the scan firehose.`
- Discovery subtitle: `Scan firehose — listings observed this window, not owned positions. Owned roles live in Pipeline.`

No schema change. `LIST_ROW` already has both timestamps.

## Sources

### Promote to list_api

| Source | How |
|--|--|
| Remotive | `https://remotive.com/api/remote-jobs?category=software-dev`. Provider stays `market`, token `remotive` (WWR pattern). Keep rows with `isCraftMatch(title)`. `jobId` = string id, `url` = job url, `locationRaw` = `candidate_required_location`, `company` = `company_name`. |

Bootstrap already promotes `FULL_CATALOG` `list_api` rows to enabled. Flip Remotive capability; existing board row is updated on boot.

### ATS catalog additions (live 200 tokens, not already in FULL_CATALOG)

Greenhouse: Galaxy (`galaxy`), Canonical (`canonical`), Hut8 (`hut8`), Blockchain.com (`blockchain`), Consensys (`consensys`).  
Ashby: Blockstream (`blockstream`), Polymarket (`polymarket`), Camunda (`camunda`), OpenAI (`openai`), Primer (`primer.io`).

Tags: crypto where true; Canonical/Camunda/OpenAI/Primer as platform/remote/ai as fits.

### Manual watches only

- Bitcoiner Jobs (`https://bitcoinerjobs.com`) — crypto board, no public JSON.
- Keep web3.career, CryptoJobsList, Cryptocurrency Jobs, Himalayas, Wellfound as `manual_watch`.
- Do not add Job Surface newsletter, FlexJobs, Working Nomads, LinkedIn Jobs as scanners.

`SCOUT_PLAYBOOK.pass0` mentions Remotive JSON alongside Remote OK + WWR.

## Out of scope

- Auto-apply, Huntr gauntlet, form-harvest quality, Ashby comp parsing.
- Re-running successful evaluate/materials.
- Himalayas list_api (API exists, filter does not).
- New top-level nav item.

## Testing

- `retryFailedLlm`: error latest → enqueue; later ok → skip; archived skip; missing triage when scope says so; cap; company_research payload has companyId; failed job re-enqueues same dedupe key.
- Remotive `listBoard`: craft titles kept, copywriter dropped, 403 throws, `market`+`remotive` accepted.
- Catalog: Remotive `list_api`; unique provider+token; new ATS tokens present.
- Bootstrap enqueue test: Remotive **is** queued with Remote OK / WWR.
- Pipeline sort accepts `last_changed`.

## Deploy

Bump `2.3.8` → `2.3.9` (package.json, helm Chart/values). Build `linux/amd64`, push `ghcr.io/giovannirco/job-scout:2.3.9`. Pin GitOps `apps/job-scout-v2`. Argo hard refresh. Verify `/api/v1/health` version. POST retry. Do not apply.
