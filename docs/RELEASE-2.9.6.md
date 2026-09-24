# 2.9.6

- Triage uses current profile facts, identity and resume alongside the scout brief. Legacy or changed-profile scores rerun without requiring force; current scores remain cached.
- Today and chat disclose stale rankings. A bounded refresh action is available in Today, REST and MCP, with preview by default for API/MCP callers. Refresh jobs preserve pipeline stages and skip downstream autopilot/notifications.
- Benchmark cases are supplied through a private local file. Embedded personal annotations were removed from the public source catalog and benchmark script. Database exports are excluded from Git/build contexts, and benchmark tooling is excluded from runtime images. Removing current-tree text does not erase historical commits or previously built images.

No database migration or automatic historical rescore runs on startup.
