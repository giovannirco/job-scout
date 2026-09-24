# 2.9.7

- Development and maintenance commands load `.env`, while exported variables take precedence.
- MCP work queues return compact, paginated summaries. Oversized responses return a valid error instead of truncated JSON.
- Temporary scan failures retry up to three attempts. Settings explains blocked sources and offers targeted recovery.
- Score refreshes show progress and paused or failed states across reloads.
- New profiles get setup guidance, and mobile screens keep the activity panel closed until opened.
- The Watches action queues checks for due positions and URLs.

No database schema changes or automatic historical score refreshes are included.
