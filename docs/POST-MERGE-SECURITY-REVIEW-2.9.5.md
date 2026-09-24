# Post-merge security review for 2.9.5

## Scope and evidence

Independent Trail of Bits differential-review Phase 5 pass against public merged master `e1daf6e` (PRs #114 and #115), covering request authentication, browser origins/Host headers, MCP bearer/protocol dispatch, AI tool authority, browser navigation, and the public HTTP redirect helper. This work used only the public checkout, synthetic tests, and published upstream package source. No private repository, production database, secrets, or cluster access was used by this reviewer. Restored-data tests and deployment verification are separate release-owner checks.

The pass found three concrete authorization gaps, one missing defense at browser navigation dispatch, and a redirect behavior regression. The fixes below are targeted to those findings. The previous forged-cookie, unsigned Cloudflare assertion, token-scope, database TLS, and direct HTTP SSRF tests remain in the suite.

## Findings

### A1 — High: DNS rebinding still bypassed dev-mode origin protection

**Attacker:** a website the operator visits while a no-auth local desk contains data. The attacker controls that website's DNS. **Required state:** the browser/network permits rebinding; browser private-network restrictions may independently block it, but cannot be assumed. **Exploitability:** medium.

After loading a page from `rebinding.attacker.example`, the attacker changes that hostname's answer to loopback and requests `/api/v1/settings/profile` on the same origin/port. Such GETs can omit `Origin` and report `Sec-Fetch-Site: same-origin`. The merged `originMiddleware` accepted them and `AUTH_MODE=dev` authenticated them. CORS cannot prevent reading a response that the browser considers same-origin. The concrete impact is disclosure of profile, applications and notes, or desk mutations through the unprotected local API.

**History:** incomplete hardening in PR #115; this was not introduced by the new Host check. The actual Node adapter constructs its request URL from the HTTP Host header.

**Fix:** dev-mode protected requests also require a hostname from the operator-configured origins or an explicit loopback name. Health/readiness keep working for internal probes. Native authenticated production clients retain their existing behavior.

**Evidence:** regression tests reject both no-header and same-origin/no-Origin requests to the attacker hostname. A separate real TCP test uses `@hono/node-server` with `Host: rebinding.attacker.example` and proves a 403 response without the synthetic private field; `Host: localhost` still succeeds.

### A2 — Medium: sibling-domain navigation bypassed clip confirmation

**Attacker:** a website on an untrusted sibling subdomain of the desk. **Required state:** the operator is signed in to the desk. **Exploitability:** easy once that sibling site is controlled.

A top-level GET to `/clip?url=...` from a sibling origin can omit Origin, include the session cookie because it is same-site, and use `Sec-Fetch-Site: same-site`. The merged checks only distinguished `cross-site`, so this request imported a job and queued work without the new confirmation page. This crosses the intended exact-origin authorization boundary; SameSite is not SameOrigin.

**History:** incomplete origin/clip hardening in PR #115.

**Fix:** both cross-site and same-site requests lacking an allowed Origin are rejected for API actions. Both kinds of clip navigation stage the non-writing confirmation page. A subsequent same-origin confirmation still works.

**Evidence:** API tests distinguish same-site from same-origin using a valid signed session, and clip tests assert neither cross-site nor same-site GET navigation invokes intake before confirmation.

### A3 — High: desk write permission authorized external form submission

**Attacker/input:** an unsafe model-returned browser action, potentially influenced by untrusted page text. No successful prompt injection against a live provider is claimed. **Required state:** browser tools configured and desk `writeTools=true`. **Exploitability:** medium; the application accepted a model action with no separate external-action approval.

`runChatTurn` advertised `browser_evaluate`, click, fill, type, select and keypress tools when desk writes were enabled. `execTool` accepted an advertised `browser_evaluate` with `function: "() => document.querySelector('form').submit()"`. The deployed upstream tool's implementation evaluates that function on the current page. Thus a model could submit an employer application or send other external form data despite the README's no-application promise and the system prompt limiting write authority to desk state. Network isolation does not block submission to a public employer site.

**History:** the broad browser allowlist dates to public initial commit `4f7c0eb`; PR #114 enforced the list at dispatch but did not separate desk writes from external browser actions.

**Fix:** browser capabilities are always limited to public navigation, snapshots, screenshots, waiting, back navigation and close. Desk write permission still controls local pipeline mutations; it never enables arbitrary page scripts, clicks, typing, form filling, select changes or keypress submission. Both advertised capabilities and dispatch use the same restriction. A generic browser click/evaluate interface cannot distinguish a harmless navigation from an application submission.

**Evidence:** a regression supplies realistic model calls for each forbidden action, including an actual form-submit script, and verifies the MCP client is never invoked even when `writes=true` and the tool name appears in the supplied advertised set. Public navigation and snapshot dispatch remain available.

### A4 — Defense in depth: browser navigation lacked the HTTP URL policy

The app dispatched `browser_navigate` with `file:`, `data:`, `javascript:` or direct private/metadata URLs even in read-only mode. The public-fetch guard did not run on this separate path. Data/JavaScript navigation can introduce active page content without the arbitrary-script tool; network isolation alone does not validate URL schemes.

The exact published `@playwright/mcp@0.0.80` package depends on `playwright-core@1.63.0-alpha-2026-08-31`. Inspection of its `coreBundle.js` shows `checkUrlAllowed` blocks `file:` by default unless unrestricted file access is enabled; therefore this report **does not claim a confirmed production file-read exploit**. That check does not impose the application's public-HTTP(S) policy. See the [published MCP package](https://www.npmjs.com/package/@playwright/mcp/v/0.0.80) and [exact upstream source archive](https://registry.npmjs.org/playwright-core/-/playwright-core-1.63.0-alpha-2026-08-31.tgz).

**Fix/evidence:** `execTool` validates navigation with the same public HTTP(S)/host/port policy before calling MCP. Tests prove file/data/JavaScript/metadata/loopback requests never reach the client. Renderer DNS, redirects and subresources still require externally enforced egress isolation. Third-party JavaScript still executes in the isolated browser; these controls do not create a JavaScript sandbox or guarantee that a third-party page is passive.

### A5 — Functional regression: manual redirects replayed POST bodies

The manual redirect loop introduced in security commit `452354d0` reused the original method/body for every hop. A POST returning 301/302/303 therefore issued another POST, whereas Fetch normally changes a POST to GET for 301/302 and non-GET/HEAD to GET for 303. The existing Ashby GraphQL caller uses POST, so an upstream redirect would send its request to a redirected endpoint with the wrong method/body.

**Fix/evidence:** preserve Fetch method/body transitions, delete body headers when changing to GET, and retain body/method for 307/308. Regression tests exercise all three POST-to-GET statuses and a body-preserving 307. As additional defense, origin-changing redirects drop authorization/cookie/Host headers. Current public-fetch callers do not supply credentials, so no existing credential-exfiltration finding is claimed.

## Other reviewed boundaries

* REST continues to require agent/admin scopes and admin scope for token management. MCP transport requires mcp/agent/admin and rejects missing, revoked and empty-scope credentials. The MCP scope intentionally allows the existing desk tools; this is not a per-record or read-only scope.
* Local AI tools still enforce the `write` flag at dispatch. Supplying an unadvertised tool or a forbidden browser tool does not bypass the allowlist.
* `BROWSER_EGRESS_ISOLATED` remains a prerequisite for both renderer and interactive browser configuration. It is an operator assertion, not a substitute for real egress controls.
* Public HTTP fetch validates the actual connection's DNS answers and each redirect destination. IPv4/IPv6 private and metadata tests remain green. The Undici 7 dispatcher compatibility fix is retained.
* No new seed-token, signed-cookie, CF JWT, SQL injection, or webhook authentication bypass was demonstrated in this pass. This is a scoped review, not a claim of universal absence of vulnerabilities.

## Validation

The new focused tests were run against the unchanged `e1daf6e` implementation: **14 failed, 35 passed**. Restoring the fixes yielded **49/49 passing** in those same four files. This includes a changed expectation that external browser mutation remains forbidden even when desk writes are enabled.

A real TCP Host-header integration test also passes. The final full suite passes **511/511 tests across 59 files** (`pnpm exec vitest run --maxWorkers=4`). Typecheck and lint pass; the repository retains its existing lint warnings. No dependency or application version changes were made in this review branch. Final combined release validation must rerun these checks alongside the release owner's LLM, repair and restored-database work.
