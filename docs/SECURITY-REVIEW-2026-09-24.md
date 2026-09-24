# Security differential review — 2026-09-24

## Executive summary

Reviewed the public baseline `4f7c0eb` through `47c5609` using Trail of Bits differential-review and adversarial-modeler methodology. This is a focused review of high-risk trust boundaries, not a claim that every line or dependency is vulnerability-free. No production service, private repository, private database, or live integration was queried or changed.

| Severity | Confirmed findings |
| --- | ---: |
| Critical | 1 |
| High | 4 |
| Medium | 2 |

Baseline risk: **critical**. Recommendation for this patch: **conditional approval**, after the regression suite and combined bugfix checks pass and operators provision the authentication/CA/browser-isolation settings documented in [SECURITY.md](SECURITY.md). The fixes intentionally fail closed for deployments still relying on insecure defaults.

The 250 tracked-file repository was reviewed surgically: auth/configuration, all middleware entry points, MCP transport and tool access, generic/ATS fetch call chains, browser dispatch, database client, webhook authorization, and deployment/build/privacy boundaries. The separate functional review inventories the recent public PRs. The findings below already exist in the public initial commit `4f7c0eb`; `git blame` of auth, fetch and TLS lines confirms they were not introduced by the latest functional PRs. This patch adds regression tests where the baseline had none (the existing clip test even accepted the forged cookie).

## Changes and blast radius

| Boundary | Reachability and patch |
| --- | --- |
| API authentication | 81 protected route registrations plus two clip methods use the central middleware. Replace forged sessions and unsigned identity headers; enforce API/admin token scopes. |
| MCP | One HTTP transport exposes 39 registered tools. Keep bearer authentication, remove wildcard browser origins, reject absent/revoked/unscoped tokens. |
| Public fetch | 14 callers of `fetchText` plus Ashby GraphQL, and chat HTTP fallback, now use socket-level DNS validation and manual redirects. |
| Browser | One rendering adapter plus interactive chat MCP connection are gated by the same isolated-egress assertion. |
| Database | One shared PostgreSQL pool creation path serves API, worker and CronJobs; verify certificates with optional private CA. |
| Deployment | Production auth fails closed, Helm defaults to token mode, local Compose's insecure exception remains explicit and loopback-published. Env files/backups are excluded from source/build context. |

## Findings and concrete attack paths

### S1 — Critical: forge a fully privileged session

**Baseline:** `apps/api/src/auth.ts:54-57`, `4f7c0eb`. **Attacker:** any unauthenticated client that can reach the API. **Exploitability:** easy, one request.

In the baseline, `curl -H 'Cookie: js_session=ok' https://your-deployment.example/api/v1/settings/profile` returned the personal profile without login. The same cookie reached token creation, all positions/notes, interview data, settings changes and chat actions. This crosses the authentication boundary for all protected REST routes and persists access by allowing the attacker to mint an API token.

**Fix:** random, expiring HMAC sessions, authenticated status checks, credential-rotation invalidation and fail-closed mode checks. Local password sessions cannot bypass Cloudflare mode. Tests cover the literal cookie, tampering, expiry, rotation, successful login and protected access.

### S2 — High: public default credentials and production no-auth default

**Baseline:** `apps/api/src/env.ts:6-8`, Helm values and Compose. **Attacker:** remote API/MCP client reaching an exposed deployment with omitted/example auth settings. **Exploitability:** easy.

The seed `dev-agent-token` granted administrator access through REST and MCP even in modes otherwise expecting authentication. `job-scout` was a default UI password; omitting AUTH_MODE selected dev without considering production. Knowing the public defaults was enough to read career data and mutate the desk.

**Fix:** remove default credentials, production defaults to protected token mode, reject example/weak protected credentials, require explicit production dev opt-in, bind host development to loopback and change Helm default to token. Local Compose remains intentionally insecure only with explicit opt-in and loopback host publishing. Tests assert every fail-closed configuration path.

### S3 — High: unsigned Cloudflare email header impersonates operator

**Baseline:** `apps/api/src/auth.ts:47-52`, `4f7c0eb`. **Attacker:** client with direct origin/service access in a cf_access deployment; not a client constrained to a correctly secured Access proxy. **Exploitability:** easy once the origin is reachable.

A request with `Cf-Access-Authenticated-User-Email: attacker@example.com` gained admin access without any assertion. A bypassed/misconfigured proxy or an internal cluster caller could retrieve the profile and mint credentials.

**Fix:** verify RS256 signature, issuer, application audience, expiration, optional not-before and email from the signed assertion. Signing keys come only from the configured HTTPS Cloudflare team. Tests use real RSA keypairs, valid assertions, forged signatures, wrong issuer/audience, expiry and unreachable key endpoints. No live Access account was tested.

### S4 — High: untrusted job/page URLs reach internal services

**Baseline:** `packages/ats/src/fetch.ts:21-39` and `packages/core/src/browser.ts` public fetch paths, `4f7c0eb`. **Attacker:** authenticated intake/chat caller or compromised upstream job-board response; auth bypass S1 made the first path unauthenticated on baseline. **Exploitability:** easy with intake access; medium through compromised upstream content.

Submitting `http://169.254.169.254/latest/meta-data/` to URL intake/chat could make the worker/API fetch cloud metadata. A public listing URL redirecting to that address or a private cluster HTTP service also worked because fetch followed redirects without destination checks. Returned internal page content could enter the operator-visible description/chat/tool transcript, and GET requests could hit internal side-effect endpoints.

**Fix:** public HTTP(S) destination validation, port restrictions, actual connection DNS validation (all addresses must be public), redirect-by-redirect validation and downgrade/loop limits. Tests prove no second fetch on a metadata redirect and exercise the real fetch dispatcher against mocked DNS answers returning loopback and mixed private/public addresses. Browser rendering is a separate trust boundary: it remains disabled until the operator asserts externally enforced browser egress isolation; URL validation alone does not protect browser subresources.

### S5 — High: malicious website can read a local no-auth desk

**Baseline:** wildcard CORS in `apps/api/src/app.ts` and MCP handler, combined with dev no-auth mode. **Attacker:** website visited by the operator while a local dev desk is running. **Exploitability:** easy in browsers/network configurations permitting the request; private-network browser controls may reduce reachability but are not an application authorization boundary.

The website could fetch `http://localhost:8080/api/v1/settings/profile`; the desk needed no credential and returned wildcard CORS, permitting the attacker script to read the personal profile. Cross-site form requests also lacked an origin boundary, and production sessions used SameSite=None.

**Fix:** exact configured origins before authentication and preflight; SameSite=Lax session cookies; no MCP wildcard. Cross-site bookmarklets stage an escaped, non-writing preview with anti-framing CSP, then require a same-origin confirmation. Tests prove blocked malicious origins, preserved native requests/trusted origins and clip confirmation with HTML injection escaped.

### S6 — Medium: non-admin tokens mint administrator credentials

**Baseline:** auth middleware and settings token routes, `4f7c0eb`. **Attacker:** holder of an otherwise limited/revocable API token. **Exploitability:** easy.

Every resolved token reached `/api/v1/settings/tokens`, regardless of scopes. An agent/MCP-only token could POST `{name:"persistent",scopes:["admin"]}` to create an independent admin credential. Revoking the original token then left the attacker's new credential active.

**Fix:** REST requires agent/admin scopes; token management requires admin; MCP-only and empty-scope tokens cannot access REST. Real PGlite tests store bcrypt credentials and exercise agent, MCP-only, admin, empty and revoked cases, including attempted admin-token creation.

### S7 — Medium: encrypted PostgreSQL connections do not authenticate server

**Baseline:** `packages/db/src/client.ts:33-48`, `4f7c0eb`. **Attacker:** network/on-path attacker between the app and PostgreSQL. **Exploitability:** medium; requires network interception or name-resolution control.

The client stripped sslmode and set `rejectUnauthorized:false`, even for a `verify-full` connection URL. An impersonating server could receive database authentication traffic and queries containing the entire operator's career data; the application could accept malicious results. Outside a hostname heuristic, TLS might not be enabled at all.

**Fix:** verified TLS by default, explicit CA injection/file support and explicit local plaintext opt-out. Normalize conflicting URL options rather than allowing node-postgres to replace the verification policy. Tests cover defaults, require/verify-full, option override attempts, local opt-out and missing CA. No real cluster CA or PostgreSQL deployment was used.

## Reviewed boundaries without a new finding

* WAHA route is public at API middleware, but its handler independently requires a nonempty configured webhook key before parsing/dispatch. The core filters session/chat/from-me events and tracks cursor/deduplication. Existing webhook tests remain relevant; no authorization bypass was found in that path.
* MCP already required a valid bearer and mcp/agent/admin scope. Its defects here were shared default credentials and wildcard browser origins, not an entirely unauthenticated tool transport.
* Database writes use Drizzle parameters in reviewed call chains. No SQL injection was demonstrated in this pass.
* The image copies public application/package/script sources; secret injection is runtime-only through existing Helm Secret references. No private data migration or live production verification was performed. Ignore rules reduce accidental commits but cannot prove that every possible personal file is absent.

## Validation and limits

Dedicated tests exercise auth, actual RSA validation, stored bcrypt token scopes/revocation, origin checks, clip confirmation/XSS escaping, destination ranges/redirects, real dispatcher DNS rejection and TLS configuration. Existing ATS/browser/clip tests run alongside them. Full baseline test failures in identity/gate/core behavior are owned by the separate bugfix PR and must also pass in the combined merge result.

This review does not replace continuous dependency monitoring, a production penetration test, or audit of the external Access/Steel/Playwright/WAHA/LLM providers. Verify real TLS CA provisioning and browser egress controls in staging. Rate limiting, infrastructure availability and prompt-injection resistance are not fully assessed. No new exploit was asserted merely from a theoretical prompt injection or from wildcard CORS on a bearer-only endpoint.

### Recorded checks on the security branch

* `pnpm typecheck`: passed.
* `pnpm build`: passed; existing bundle-size warning remains.
* `pnpm lint`: passed, zero errors and 326 existing warnings; strict lint is not claimed green.
* Nine targeted security/ATS/browser/clip test files: 76 tests passed.
* Full `pnpm exec vitest run --maxWorkers=4` (bounded concurrency avoids local PGlite startup contention): 467 passed, 12 failed across the same three baseline functional suites (`core`, `queue-integrity`, `audit-regressions`) addressed by the separate bugfix work. The security branch is intentionally independent of those fixes.
* `git diff --check`: passed; representative `.env.production`, private profile and compressed database-backup paths are ignored.

Tests use temporary synthetic PGlite databases, generated RSA keys, fake DNS answers and mocked upstream HTTP responses. The worktree uses its own frozen-lockfile dependency install; test results do not rely on symlinks to another checkout's lint configuration.

### Dependency audit

`pnpm audit --prod` reported three moderate advisories on Hono 4.13.1. The patch raises the minimum to 4.13.9 and updates the lockfile; the subsequent audit reports zero known production vulnerabilities. The upstream reports are [SSG traversal](https://github.com/honojs/hono/security/advisories/GHSA-gqvv-2mrq-wpjv), [dot-notation body expansion](https://github.com/honojs/hono/security/advisories/GHSA-g6gw-c38x-mqfc), and [fragment/query interpretation](https://github.com/honojs/hono/security/advisories/GHSA-crvj-82cr-hjcx). The first two concern features not enabled here. Query parsing is used, but this review did not demonstrate a deployment-level proxy/cache exploit; the dependency advisories are tracked separately from the seven confirmed application findings above.

### Combined merge validation

The security PR is stacked on functional PR #114 so its diff stays limited to security and its CI includes the baseline bug fixes. On the combined branch, all 496 tests passed across 58 files, typecheck/build passed, and lint passed with 322 advisory warnings. PostgreSQL 16 repair tests also passed with the explicit local PGSSL=0 setting. Production dependency audit reports zero known vulnerabilities. This supersedes the independent-baseline suite result above for the proposed merge result.

The production Docker image also built successfully. A disposable, network-disabled container passed readiness, valid-token login/session checks, anonymous/forged-cookie rejection and untrusted-origin rejection. The image contained none of the checked `.env`, `.data`, `private/` or `backups/` paths. Only synthetic credentials/data were used; no external integrations ran.

CI found that Undici 8's dispatcher rejects the handler used by Node 22 native fetch. The dependency is constrained to the patched Undici 7 series (7.29.1); the real socket/DNS tests and full suite pass on Node 22.23.3, and the dependency audit remains clean. This prevents the network guard from disabling otherwise valid ATS requests on the production runtime.
