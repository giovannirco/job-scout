# Job Scout

Job Scout helps you find engineering jobs, compare them against your profile, and track your applications. It scans company career pages, filters listings by role and location, and can use AI to score matches, research companies, and draft application materials. It keeps previous versions of job descriptions and shows what changed.

This is a self-hosted app for one person and one database. You review drafts and submit applications on the employer's site.

## What it does

- **Discovery:** scans Greenhouse, Ashby, Lever and BambooHR boards, plus selected public job feeds. Rejected listings remain visible with the filter reason.
- **Pipeline:** tracks reviews, applications, interviews and follow-ups. Related postings can share one row with their available locations.
- **AI assistance:** scores jobs against your profile, evaluates roles, researches companies, and drafts resumes, cover letters and form answers. Each operation has its own model and daily limit.
- **Job history:** records changes to descriptions, compensation, location and availability.
- **Chat and MCP:** lets an assistant inspect your pipeline and work with individual positions. Optional browser integration reads public job pages.

Without a model key, scanning, filtering and the application tracker still work. AI features stay disabled. Scores and drafts need your review; a high score does not establish eligibility or guarantee an interview.

The default sources and filters focus on engineering roles. Automatic home-country filtering currently covers the US and Brazil; other locations need explicit geographic rules.

## Run locally

Use Node.js 22.12 or newer and pnpm 9.15.0:

```sh
cp .env.example .env
pnpm install --frozen-lockfile
pnpm dev
```

Open [localhost:8080](http://localhost:8080), then fill in Settings › Profile. With `DATABASE_URL` unset, the app stores data locally in PGlite. The example configuration includes an embedded worker.

Development, server, worker and database maintenance commands load `.env` when present. Exported environment variables take precedence. Local defaults use unauthenticated development mode on loopback; configure authentication before exposing the app. See [Security](docs/SECURITY.md).

To enable AI, set `OPENAI_BASE_URL` and `OPENAI_API_KEY`, restart, and select models in Settings › AI. The gateway needs the structured-output and streaming features used by your selected operations. Set a random `API_TOKEN_SEED` or create a token in Settings › System for MCP clients.

## Docker Compose

```sh
cp .env.example .env
docker compose up --build
```

Compose includes PostgreSQL and reads `.env`. It publishes the app on loopback at port 8080 with development authentication. The model gateway is separate: set `COMPOSE_OPENAI_BASE_URL` if it is not reachable on the host at port 8317.

For a server installation, build the image from `deploy/Dockerfile` and use the chart under `deploy/helm/job-scout`. Keep credentials, profiles and deployment-specific values outside the public repository.

## Daily use

Start with **Today** for decisions, approvals, changed jobs and upcoming interviews. **Pipeline** holds your positions; **Discovery** shows what scans accepted and rejected. Open a position to read its description, evaluation, materials and history.

Settings › Autopilot controls how much AI work runs automatically:

| Preset | Behavior |
| --- | --- |
| Manual | Scans and filters; AI runs when requested. |
| Assisted | Triages matches, evaluates high scores, and suggests next steps. |
| Autopilot | Also evaluates every PASS and drafts materials above a configured score. |

AI status suggestions and automatic material drafts go to the Inbox for review. Filter changes can archive untouched scan results that no longer qualify. See [AI behavior and limits](docs/AI.md).

Optional WhatsApp integration routes alerts to chats you configure and supports a job-search chat through WAHA. See [API documentation](docs/API.md) and [Security](docs/SECURITY.md) for webhook setup.

## Development

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Application tests live beside the source in `*.test.ts` files. Database repair logic lives in `packages/core/src/repairs.ts`, with its command entrypoint in `packages/core/src/cli/repair-data.ts`. Run `pnpm db:repair --list` to see available repairs and read [Upgrading](docs/UPGRADING.md) before using them.

| Directory | Contents |
| --- | --- |
| `apps/api` | HTTP API, authentication and MCP server |
| `apps/web` | React interface |
| `apps/worker` | Job queue, schedules and one-shot commands |
| `packages/core` | Application services and maintenance commands |
| `packages/ats` | Job-board clients and page readers |
| `packages/llm` | Model client and prompts |
| `packages/db` | Schema, migrations and database clients |
| `packages/shared` | Filters, validation and shared types |
| `.github` | CI workflows and public-source checks |
| `deploy` | Container build, Helm chart and monitoring dashboard |

## Documentation

[Product](docs/PRODUCT.md) · [Architecture](docs/ARCHITECTURE.md) · [AI](docs/AI.md) · [Jev](docs/JEV.md) · [Data model](docs/DATA-MODEL.md) · [API](docs/API.md) · [MCP](docs/MCP.md) · [Monitoring](docs/OBSERVABILITY.md) · [Security](docs/SECURITY.md) · [Contributing](docs/PUBLIC-CONTRIBUTING.md)
