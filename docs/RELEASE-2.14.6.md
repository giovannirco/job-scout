# 2.14.6

Refresh runtime and development dependencies, retaining the security updates prepared for 2.14.5. No application behavior changes or database migration; rollback is image-only.

- **Runtime security.** MCP client/server 2.4.0, Hono 4.13.18, its Node adapter 2.1.7, Undici 7.30.2 and Zod 4.6.7 include upstream security fixes. The lockfile also refreshes transitive packages within the existing dependency ranges.
- **Node runtime.** Both image stages pin Node 22.23.5 on Debian Bookworm by digest, including the November 2026 Node security fixes.
- **Maintenance.** Refresh PGlite, Drizzle, React, TanStack Query/Router and related packages within their existing major versions. Vite 8.3.8, Vitest 4.1.12 and ESLint 10.14.0 update the development toolchain.

Take a database backup before upgrading. Existing profiles and application history remain in the runtime database; no repair command is required for this release. Build from a clean public checkout and verify the health endpoint, authentication and MCP tools after deployment as described in [DEPLOY](./DEPLOY.md).
