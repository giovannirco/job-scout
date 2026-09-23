# job-scout listing truth and desk IA

> Historical design record from 2026-09-04. Current behavior is in `README.md` and `docs/`. This file is not kept in sync.

Status: implemented on `v2` (2.3.0)  
Date: 2026-09-04  
Branch: `v2`

## Problem

Promote reused v1-archived rows, so autopilot skipped evaluate. Ashby “Location Type: Remote” with location “Lightning Labs” (company name) stored as empty Facts (Remote —, Geo —). Application form questions are fetched for Greenhouse, stuffed into `metadata.ats.questions`, never shown. Radar packs Discovery, boards, and watches into one tabby page. Long tables barely sort.

## Decisions (locked)

- One spec: listing truth + left-nav split + table sorting.
- Rail: Today · Pipeline · Discovery · Sources · Companies · Inbox. Settings footer. Forms is a Position tab + MCP, not a top-level page.
- Two Facts fields: **workplace** and **geo**. Remote + no country → geo `worldwideish`. Explicit US-only / EMEA-only still blocks.
- Deterministic classify first. LLM `listing_classify` only when ATS is messy. LLM may **tighten** geo (find a hidden US-only); it must not **weaken** a hard block.
- Forms: harvest questions + LLM draft answers. Button always. Autopilot preset also drafts after evaluate. Assisted is button-only.
- Usage: existing per-op enable/model/daily cap, made visible (Today + Settings › AI remaining). No Pause-all, no USD cap. New ops: `listing_classify`, `form_answers`.
- Sort every table that has a header. Sort in the URL.
- Do not apply on the operator’s behalf.

## Data model

### `positions`

Add `workplace text` (`remote | hybrid | onsite | unknown`).

- **workplace** comes from ATS location type / `isRemote` / hybrid-onsite markers, not from a company-name location string.
- **geoClass** stays eligibility only: `brazil_friendly | worldwideish | hard_geo | ambiguous_remote | unknown`.
- **remoteClass** remains a stored compatibility column, **recomputed** from cleaned location + workplace (same helper as today). Filters like `remoteClass=latam` keep working. Workplace is the Facts “Remote” chip; geoClass is the Facts “Geo” chip. Do not show remoteClass on Facts.
- Ignore location strings that equal or are only the company name (Lightning Labs). That text is not a place.

Facts UI: Employment, Workplace, Geo, Comp, Craft, Source, Surface, ATS id, Checked.

### `application_questions` (exists)

Use this table as source of truth, not `metadata.ats.questions`.

Keep: `question`, `answer`, `status` (`open | answered | skipped`), `source`, `metadata`, `sortOrder`.

Add: `required boolean default false`, `inputType text` (`text | textarea | select | boolean | file | unknown`).

Idempotent upsert key: `(positionId, question)` (normalized prompt text). `sortOrder` updates on harvest. **Do not** clobber a human-edited `answer` or a `status` other than `open`. Prompts that disappear from the ATS stay on the row with `metadata.droppedAt` rather than deleting answered ones.

## Classify (deterministic)

Input: `title`, `locationRaw`, `workplaceType`, `company`, optional `isRemote`.

1. Drop location if it is the company name (case-insensitive, trimmed).
2. Workplace: `Remote` / `isRemote` → `remote`; hybrid → `hybrid`; onsite/office → `onsite`; else `unknown`.
3. Geo on remaining location + workplace + JD is **not** used here (JD is LLM-only).
4. If workplace is `remote` and no country/region tokens remain → `geoClass = worldwideish`.
5. If US-only / EMEA-only / onsite-city hard markers remain → `hard_geo` (block). Brazil/LATAM/worldwide tokens as today.
6. Gate on **board list** also receives workplace when the list API has it; unknown geo still passes (`allowUnknownGeo` unchanged). Mis-empty Facts must not hide listings under current defaults.

## LLM `listing_classify`

Enqueue after JD fetch when any of:

- workplace is `unknown`, or
- geoClass is `unknown`, or
- location was discarded as company name (optimistic worldwideish may still hide a US-only line in the JD).

Cheap model, own daily cap. JSON: `{ workplace, geoClass, geoNote, evidence }`.

Merge: if deterministic already set `hard_geo`, keep it. LLM may replace `worldwideish`/`unknown`/`ambiguous_remote` with `hard_geo` when evidence is a restriction. Never the reverse.

Park on cap. Three retries on 429/timeout. Invalid JSON → keep deterministic labels, `llm_runs` failed.

## Forms harvest

On every JD fetch (scan, promote, refresh):

| ATS | How |
|---|---|
| Greenhouse | existing `?questions=true` |
| Lever | existing job payload if questions present |
| Ashby | posting API has no form; fetch `/application` HTML, then Steel/browser render if configured |

If scrape fails: empty Forms list, banner “could not fetch form”, retry on next refresh. Position remains usable.

`form_answers`: fills `answer` from profile + resume + JD. Status stays `open` until the operator marks answered/skipped. Skip legal/comp/identity guesses that are not in the profile (leave blank + note in metadata). Button on Forms tab; MCP `run_llm operation=form_answers`. Autopilot preset also enqueues after evaluate (`dedupeKey: form_answers:<positionId>`). Assisted does not.

## Intake / promote

Operator Promote or URL intake:

- Upsert by ATS identity.
- If status is `archived`: revive to `triaged`, clear `archiveReason`, timeline event.
- Link `discovery_feed.positionId`.
- If never triaged → enqueue triage. If already PASS → `afterTriage` (evaluate may run per autopilot).
- Live non-archived duplicate → no extra triage; toast “already in the pipeline”; navigate to the position.

Scan **does not** revive archived rows. Discovery list joins position by `positionId` **or** `externalIdentity` so archived v1 rows show in the In-pipeline column.

Evaluate on `archived` or `triaged` moves status to `review`.

Radar: Promote when no live position; **Revive** when `positionStatus === archived`; navigate to the position after success.

## Desk

| Path | Page |
|---|---|
| `/today` | Today (add remaining calls/tokens per op, including the two new ones) |
| `/pipeline` | Pipeline; workplace + geo chips/filters |
| `/discovery` | Lanes, Promote/Revive, board deltas (tab or sub-panel) |
| `/sources` | Boards + watches |
| `/companies` | unchanged role |
| `/inbox` | approvals |
| `/settings` | AI table includes `listing_classify` and `form_answers` |
| `/radar` | redirect → `/discovery` |
| `/positions/:id?tab=forms` | Forms tab |

Sort: clickable headers, URL `sort=<field>_<asc|desc>`. Defaults: Pipeline `updated_desc`, Discovery `observed_desc`. Applies to Pipeline, Discovery, Sources (boards and watches), Companies, Inbox, Forms.

## MCP

Existing tools keep working. Add:

- `list_questions` (`idOrSlug`)
- `update_question` (`id`, `answer?`, `status?`)
- `run_llm` enum includes `form_answers` and `listing_classify`

`get_position` includes `workplace`, `geoClass`, and a short questions summary (count open / drafted).

## Backfill

On deploy, for **open, non-archived** positions only: recompute workplace/geo from stored ATS metadata + location (deterministic). Enqueue `listing_classify` only if still messy (including discarded company-name location). Do not mass-run `form_answers`.

## Tests (PGlite)

- Promote revives archived; `afterTriage` on existing PASS; scan does not revive; discovery joins by identity.
- Evaluate archived → `review`.
- Classifier: Remote + company-name location → workplace `remote`, geo `worldwideish`; “US only” stays hard; LLM merge cannot clear hard_geo.
- Questions upsert idempotent; does not wipe a non-open human answer.
- `form_answers` / `listing_classify` honor enable + daily cap (gate).
- List endpoints honor `sort=`.

## Out of scope

Submitting or filling ATS forms in the browser as the applicant of record. USD budgets. Pause-all. LLM classify when ATS workplace and geo are already clear and location is a real place. A top-level Forms inbox.

## Success

Lightning Labs Facts show Workplace **remote**, Geo **worldwide** (or **hard** if the JD says US-only after classify). Forms tab lists Ashby application questions. Promote of a v1-archived PASS runs evaluate under Autopilot. Discovery and Sources are separate rail items. Tables sort from headers.
