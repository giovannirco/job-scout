# Product

Job Scout is a job-search workspace for one person. It combines job discovery, application tracking, description history and optional AI assistance. Its default sources and filters focus on engineering roles.

## Workflow

1. Set your location, target roles, career direction and resume in Settings › Profile.
2. Review listings found by the scanners. Discovery explains why listings passed or were filtered out.
3. With AI configured, compare scores and evaluations against the actual job description. Without it, review unscored listings directly.
4. Save promising positions, draft materials and prepare answers. Review those drafts before using them.
5. Submit on the employer's site, mark the position applied, and track interviews and follow-ups here.

Today brings together decisions, approvals, changed job descriptions and upcoming interviews. Position pages hold the description, evaluations, materials, questions and history. Chat can read that context, and authenticated MCP clients can use the pipeline tools.

## Behavior

- Filters run before automatic AI triage. Rejected listings stay visible with a reason.
- Each AI operation has a model, an enable switch and a daily cap. Logs show usage, latency and failures.
- Previous job descriptions remain available, with differences between versions. Text cleaned up by the app is labeled separately from employer changes.
- Unknown compensation stays unknown. Scores reflect the profile used when they were generated; stale scores need refreshing after profile changes.
- AI suggestions to change status and automatically drafted materials require review in the Inbox. Updating filters can archive untouched scan results.
- Optional WhatsApp notifications go to the chats configured in Settings. The inbound chat can inspect positions and save job URLs.

## Scope

Job Scout does not submit applications or message recruiters. Its source catalog is configurable, but it does not cover the entire job market. Home-country filtering currently supports the US and Brazil; other locations need explicit rules. It is designed for one profile and one database, not a shared service with separate user accounts.
