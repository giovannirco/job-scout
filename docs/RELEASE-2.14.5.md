# 2.14.5

Security dependency release. No application changes and no database migration; rollback is image-only.

- **MCP SDK** (`@modelcontextprotocol/server`, `client`) 2.0.0 → 2.4.0: four high and two moderate advisories. 2.4 logs a startup notice that `responseMode: 'json'` drops notifications sent mid-call; the handlers are unchanged.
- **undici** → 7.30.1, **zod** → 4.6.7 (GHSA-mrhx-c7xc-m3w5), **seroval** → 1.7.7 (web bundle), **hono** → 4.13.16, **@hono/node-server** → 2.1.6.
- Dev tooling: vite 8.3.5, vitest 4.1.12, eslint 10.14.0, `@tailwindcss/vite` 4.3.4.

`pnpm audit --prod` reports no known vulnerabilities.
