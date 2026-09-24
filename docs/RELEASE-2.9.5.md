# 2.9.5 upgrade validation

This release includes the public regression and security reviews, plus a second adversarial pass after those changes merged. See [the post-merge security report](POST-MERGE-SECURITY-REVIEW-2.9.5.md) for reproduced findings and fixes.

The chat endpoint drains queued SSE writes before closing, preserving the final message and completion events. A regression test reproduced lost events before the fix.

Additional changes reject cancelled AI requests before sending them, remove cancellation listeners after requests, reject empty completions, and report streams that end without a finish reason as failures. Explicit repairs now support `--list` and `--steps` so operators can preview and apply independent corrections without rerunning unavailable remote sources. Selected repairs remain atomic and versioned.

## Rehearsal

A fresh PostgreSQL 16 production backup was restored into isolated local databases. Credentials, records, screenshots, transcripts and detailed repair reports remained in private runtime storage outside the public checkout.

- All 23 restored public tables retained identical row hashes after migration and normal API startup.
- Authenticated health, readiness, dashboard, positions, geographic filtering, discovery, companies and model catalog reads succeeded.
- Chromium loaded the dashboard, positions, settings and chat without page errors; password login succeeded.
- Live Grok and GPT calls succeeded through the configured OpenAI-compatible gateway. A real streamed chat turn invoked desk read tools and completed without error.
- MCP initialization, tool listing and a pipeline summary tool call succeeded over authenticated Streamable HTTP, including its SSE response representation.
- The full repair preview detected a remote ATS fetch failure, reported the failed step, and rolled back. This is expected fail-closed behavior, not a reason to run broad repairs automatically on production.
- An independent local repair selection previewed and applied successfully on another restored copy. Production deployment does not implicitly run historical repairs.

External messaging was not sent as part of rehearsal. Notification routing remains covered by automated tests. Browser integrations require verified public-only network egress before enabling `BROWSER_EGRESS_ISOLATED=1`; the application flag alone does not enforce that isolation.
