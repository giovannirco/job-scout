# Product

job-scout is a personal career control plane for an engineer who runs a real job hunt with AI at hand: a pipeline CRM, a market radar, an append-only record of every job description seen, model-assisted triage and evaluation with a configurable degree of autonomy, and a chat agent that knows the pipeline and can look at the actual web page.

## Principles

1. **Discovery is not applying.** The system finds, filters, scores, drafts and suggests. `applied` is a human action, and status changes proposed by the model wait in an inbox.
2. **Filter first, model second.** Deterministic gates run on everything. With no model key, passes sit in the pipeline unscored and the model is never called. Rejections stay visible under Discovery › Filtered.
3. **One model call, one row.** Every operation has a model, a switch and a cap; every call is logged with tokens and latency. There is no hidden AI activity.
4. **Append-only JD history.** Postings change quietly — comp, location, scope, closure. Each observation is a revision with a diff; nothing is overwritten.
5. **Honest data.** Null salary when unknown, never invented. Scores are 1–5 from a documented brief, shown with the reason.
6. **The operator owns the truth.** Settings, profile and scout brief are editable; presets are starting points. career-ops (markdown in git) can hold the same pipeline and the two reconcile.

## Who talks to it

| actor | through |
|--|--|
| you | the web UI (Today, Pipeline, Radar, Companies, Inbox, Position, Settings), the dock chat, the API, WhatsApp **job-scout chat** |
| the worker | the queue — scans, checks, model operations, retention, WhatsApp outbox flush |
| agents (career-ops sync, Grok, Cursor, Claude Code) | MCP at `/mcp` with a scoped token |
| the chat agent | local tools plus, when configured, a headless browser through Playwright MCP; WhatsApp **job-scout chat** uses the same agent on grok-4.6 via a ClusterIP webhook |

## What a day looks like

With no model key, Today opens on unscored filings and the pipeline opens on everything still open. Chat and the scoring buttons stay off.

With a key, Today opens on the funnel and the count of things that need a decision: PASS verdicts, approvals filed by autopilot, JDs that changed on positions in play, interviews coming up, applications with no reply for a week. Decide from the list (Review / Skip), open a position for the brief, the A–H evaluation and the JD history, ask the scoped chat to compare the role against your master resume, draft materials, mark applied. The Wire shows what the worker is doing meanwhile; the Machine panel shows what it cost.

WhatsApp is a second surface for the same desk: Settings › Notifications routes triage PASS to **job-scout new**, inbox/interview/stale nags to **job-scout desk**, hot process and JD changes to **job-scout process**, company packs to **job-scout research**. Paste a JD URL in **job-scout chat** to intake and triage (webhook → desk agent; never apply). Product alerts never go to **an engineering-only room**.

## Non-goals

- Submitting applications, filling forms, or messaging recruiters.
- Being a general job board. Sources are the boards and companies you add.
- Multi-tenant SaaS. One operator, one profile, one database.
