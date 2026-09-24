# Security and private runtime data

Public source and runtime images are intended to contain application code and generic defaults only. Keep your profile, applications, notes, resumes, transcripts, service credentials, and database backups in runtime storage or a private deployment repository. Do not copy a private checkout into the public build context. The public repository is not a place to store real Helm Secret values.

## Authentication

Password sessions are HMAC-authenticated, expire after 30 days, and are invalidated when either configured credential changes. They use HttpOnly, SameSite=Lax and (in production) Secure cookies. Production therefore requires HTTPS at the browser-facing proxy.

* `AUTH_MODE=token`: configure `AUTH_PASSWORD` (at least 16 characters) for UI login and/or `API_TOKEN_SEED` (at least 32 characters) for API/MCP access. Use independently generated random credentials. A seed token cannot be used as a UI password. There are no built-in password or bearer credentials.
* `AUTH_MODE=cf_access`: configure `CF_ACCESS_ISSUER=https://your-team.cloudflareaccess.com` and `CF_ACCESS_AUDIENCE` for this Access application. Job Scout verifies the `Cf-Access-Jwt-Assertion` signature, issuer, audience, expiry and activation time against that team's HTTPS signing-key endpoint. The email header alone grants no access; local password/cookie login is disabled. Configured bearer tokens remain supported for automation. Signing keys are cached for five minutes; newly rotated keys may be rejected until the cache expires.
* `AUTH_MODE=dev`: no authentication; local development only. Production refuses this unless `ALLOW_INSECURE_DEV_AUTH=1` is explicit. The local Compose stack uses that opt-in and binds its published ports to loopback. Do not expose it through a public proxy or a shared untrusted container network. Helm defaults to token authentication and needs an existing Secret.

Bearer `agent` and `admin` scopes access the REST API; `mcp`, `agent`, and `admin` access MCP. Only an admin credential/session can list, mint or revoke API tokens. These are service scopes, not per-record permissions: agent/MCP access still exposes the operator's job and career data. Treat such tokens as privileged credentials.

Set `PUBLIC_BASE_URL` to the actual browser URL. `CORS_ORIGINS` accepts comma-separated additional trusted origins. Browser requests from other origins are rejected, including in dev mode; server-to-server bearer clients do not need an Origin header. Dev mode also restricts request hostnames to configured origins and loopback names to prevent DNS rebinding; health/readiness remain usable by internal probes. Cross-origin sibling sites are not treated as trusted same-origin callers. Do not add job-board sites to this list. Bookmarklets submit to an escaped confirmation page; a same-origin “Save job clip” action then imports the content using your session.

Use proxy-level request limits for Internet-facing login endpoints and protect `/metrics` at the network layer. Health/readiness endpoints intentionally remain public and contain no profile data or raw database errors.

## Public network fetches and browser isolation

ATS HTTP requests and the chat `web_fetch` HTTP fallback only connect to public HTTP(S) addresses on ports 80/443. Private, loopback, link-local, multicast and reserved addresses are rejected, including IP literals, mixed public/private DNS answers and redirects. DNS validation occurs in the connection lookup itself; a separate preflight cannot create a rebinding gap. Redirects are capped at five, and HTTPS redirects cannot downgrade to HTTP. Operators cannot bypass these protections with a user-supplied URL.

Steel and Playwright execute navigation, scripts, redirects and subresource fetches outside the application's HTTP client. Before enabling either, isolate the dedicated browser service's egress: deny loopback/private/link-local/metadata/cluster destinations for both IPv4 and IPv6, permit necessary DNS only, and route web traffic through a proxy that applies the same destination policy. A Kubernetes NetworkPolicy alone does not constrain a browser process's own loopback; enforce that in the browser container/proxy as well. Do not give the browser shared human sessions, cluster tokens, or unrelated credentials.

After that isolation is enforced, set `BROWSER_EGRESS_ISOLATED=1` alongside `STEEL_BASE_URL` and optionally `BROWSER_MCP_URL`. Both scrape rendering and interactive chat browser tools remain disabled without this explicit assertion. This flag does not install network controls. Chat only exposes browser navigation/read/lifecycle tools, even when local desk writes are enabled; script evaluation, clicks, form filling, typing, and keypress submission are not authorized. Navigation accepts public HTTP(S) URLs only. Third-party page scripts still run inside the isolated browser; this is not a JavaScript sandbox. Plain HTTP job ingestion continues to work without a browser.

## PostgreSQL TLS

PostgreSQL connections verify the server certificate and hostname by default, including `sslmode=require` URLs. For an internal CA, inject the PEM as `PGSSL_CA` through the existing runtime Secret, or set `PGSSLROOTCERT` to an already mounted CA file. `PGSSL_CA` takes precedence over the file. This works for the API, worker and CronJobs because the chart injects the same existing Secret into all of them.

`PGSSL=0`/`false` or an explicit URL `sslmode=disable` opts into plaintext for a trusted local database. Compose explicitly uses `PGSSL=0`. Do not disable TLS to work around a missing private CA in a remote deployment. URL TLS mode flags are normalized so node-postgres cannot silently replace the verification policy.

## Deploy the public image with private data

1. Build the public checkout without credentials or personal data. `.env.*`, `.data`, `private/`, and `backups/` are ignored; never rely on ignore rules to sanitize an arbitrary copied private tree.
2. Keep the existing private PostgreSQL database/PVC and a restorable backup. Repoint the deployment image to a reviewed public image while retaining that database. App migrations update schema; replacing the image does not require exporting a personal profile into source files.
3. Supply `DATABASE_URL`, authentication credentials, integration keys, and (if needed) `PGSSL_CA` through the chart's `existingSecret` or a secret-management controller. Keep site-specific routes and private overrides in private GitOps configuration. Do not use public `secrets.create` values for real credentials.
4. For a new empty database, enter your profile through Settings after authenticating, or perform a separately reviewed private data import. Public defaults intentionally contain no operator profile.
5. Verify login, private API rejection without credentials, DB readiness and worker operation in staging before switching traffic.

The WAHA webhook requires a separately configured `WAHA_WEBHOOK_KEY` in `X-Api-Key`, fails closed when unset, and filters configured chat/session/from-me events. Keep that key distinct from the WAHA service key and API seed.

## Source and deployment boundary

Public source supplies the application, schema, generic chart and public career-board catalog. Private runtime storage holds profiles, job-search state and generated documents. A private deployment repository supplies installation-specific values and secret references. A private legacy source repository is not automatically overlaid onto the public application; the deployed image digest and deployment manifests determine what runs. Never build a public image from a private source checkout.

Deleting sensitive text from the current tree does not remove it from previous commits, tags, pull-request diffs, clones or previously built image layers. Audit those separately when responding to an exposure. Keep evaluation inputs and reports private when they contain personal data.
