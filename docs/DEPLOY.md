# Deploy

A server installation is one image with three entrypoints (api, worker, CronJobs), a PostgreSQL database and the Helm chart in `deploy/helm/job-scout`. The examples use placeholders: `registry.example.com` for your private registry, `jobs.example.com` for the public URL and `job-scout` for the namespace. Keep real hostnames, registry paths, values overrides and credentials in a private deployment repository ([SECURITY](./SECURITY.md#source-and-deployment-boundary)).

## Build the image

Build from a clean public checkout. The build context must not contain `.env` files, database dumps or private notes.

```sh
VERSION=$(node -p "require('./package.json').version")
docker buildx build --platform linux/amd64 \
  -f deploy/Dockerfile \
  --build-arg APP_VERSION="$VERSION" \
  -t registry.example.com/job-scout:"$VERSION" \
  --push .
```

`APP_VERSION` is what the running app reports (in `/api/v1/health`, `server_info` and `job_scout_build_info`). Without it, or with it empty, the app reports the root `package.json` version baked into the image; pass it to report something else, such as a commit-suffixed tag. Use `--platform` to match your nodes. Pin the deployment to the pushed tag or digest.

## Secret

Create the Secret outside the chart and point `existingSecret` at it. The chart injects it, together with the `env` ConfigMap, into the api, worker and every CronJob.

| key | required | for |
|--|--|--|
| `DATABASE_URL` | yes | PostgreSQL connection. TLS is verified by default; see [SECURITY › PostgreSQL TLS](./SECURITY.md#postgresql-tls) |
| `AUTH_PASSWORD` and/or `API_TOKEN_SEED` | yes with `AUTH_MODE=token` (the chart default) | UI login (≥ 16 characters) / admin bearer token (≥ 32 characters) |
| `OPENAI_API_KEY` | for AI features | OpenAI-compatible gateway key (`OPENAI_BASE_URL` goes in `env`) |
| `PGSSL_CA` | private CA only | CA PEM for the database certificate |
| `CF_ACCESS_ISSUER`, `CF_ACCESS_AUDIENCE` | with `AUTH_MODE=cf_access` | Access application verification |
| `WAHA_API_KEY`, `WAHA_WEBHOOK_KEY` | WhatsApp only | outbound sends / inbound webhook `X-Api-Key` |
| `OPENROUTER_API_KEY` | Jev only | [JEV](./JEV.md) decisions |
| `THREAT_BLOCKLIST_DOMAINS` | optional | extra blocked recruiter domains for `screen_recruiter_threat` |

```sh
kubectl -n job-scout create secret generic job-scout-secrets \
  --from-literal=DATABASE_URL='postgresql://job_scout:<password>@postgres.example.internal:5432/job_scout?sslmode=require' \
  --from-literal=API_TOKEN_SEED="$(openssl rand -hex 32)" \
  --from-literal=AUTH_PASSWORD="$(openssl rand -base64 24)" \
  --from-literal=OPENAI_API_KEY='<gateway key>'
```

Do not use `secrets.create` for real credentials; it exists for throwaway test installs.

## Install

Non-secret settings go in `env` (rendered into a ConfigMap). Every variable is described in `.env.example`.

```yaml
# values.private.yaml (kept in your private deployment repository)
image:
  repository: registry.example.com/job-scout
  tag: "2.14.5"
imagePullSecrets:
  - name: registry-credentials
env:
  AUTH_MODE: token
  PUBLIC_BASE_URL: https://jobs.example.com
  OPENAI_BASE_URL: https://llm-gateway.example.com/v1
existingSecret: job-scout-secrets
httpRoute:           # optional Gateway API route; or bring your own Ingress to service job-scout:8080
  enabled: true
  hostnames: [jobs.example.com]
  parentRefs:
    - name: example-gateway
      namespace: gateway
```

```sh
helm upgrade --install job-scout deploy/helm/job-scout \
  -n job-scout --create-namespace -f values.private.yaml
```

The chart runs one api and one worker (`Recreate` strategy) and three CronJobs: `discovery` (every 30 minutes), `watch` (every two hours; it also runs the capped stale-triage sweep) and `retention` (daily). The worker's in-process scheduler stays off (`worker.inProcessScheduler: false`) because the CronJobs own those timers; turn it on only if you disable the CronJobs. Prometheus annotations are on by default (`metrics.enabled`); the Grafana dashboard ConfigMap is opt-in (`dashboard.enabled`). See [OBSERVABILITY](./OBSERVABILITY.md).

TLS terminates at your proxy or gateway; production session cookies are `Secure`, so the browser URL must be HTTPS. Protect `/metrics` (port 9464) at the network layer.

## Migrations

There is no separate migration job. The api, the worker and each CronJob run pending migrations at startup, then create missing profile and settings rows; an existing installation's data is not otherwise changed. On Postgres each run holds a session-level advisory lock (`pg_advisory_lock`) for its duration, so processes that start together apply a migration once, one after another, and the others find nothing left to do; the api, worker and CronJobs can roll out in any order. `pnpm db:migrate` takes the same lock. A process that dies mid-run loses its session and with it the lock. PGlite is single-process and needs no lock. Release notes and [UPGRADING](./UPGRADING.md) say when a release carries a migration and whether rollback is image-only. Data repairs never run at startup; run them explicitly as described in UPGRADING.

## Verify

```sh
B=https://jobs.example.com/api/v1
curl -fsS $B/health        # status ok | degraded (LLM failing; still HTTP 200), version, llm
curl -fsS $B/ready         # 503 until the database answers
curl -s -o /dev/null -w '%{http_code}\n' $B/today                      # 401 without credentials
curl -fsS -H "Authorization: Bearer $JOB_SCOUT_TOKEN" $B/settings/system  # version, auth mode, queue, browser
```

Check that `version` matches the tag you deployed, the worker logs `worker.start`, and the queue drains (`job_scout_queue_oldest_queued_age_seconds` stays low). For MCP, run the `tools/list` call in [MCP › Verify](./MCP.md#verify). For a new, empty database, sign in and fill in Settings › Profile.

## Roll back

Redeploy the previous image tag. When the release notes call a migration additive and rollback image-only, the older version runs on the migrated schema; do not reverse migrations by hand. If a release is not marked that way, restore the database backup taken before the upgrade together with the older image. Take a backup before every upgrade, and before any `--apply` repair.
