# 2.9.6

- Triage uses current profile facts, identity and resume alongside the scout brief. Legacy or changed-profile scores rerun without requiring force; current scores remain cached.
- Today and chat disclose stale rankings. A bounded refresh action is available in Today, REST and MCP, with preview by default for API/MCP callers. Refresh jobs preserve pipeline stages and skip downstream autopilot/notifications.

No database migration or automatic historical rescore runs on startup.
