# syntax=docker/dockerfile:1
# job-scout — one image, three entrypoints:
#   api:       node --import tsx apps/api/src/index.ts     (serves apps/web/dist, runs migrations on boot)
#   worker:    node --import tsx apps/worker/src/index.ts
#   cron:      node --import tsx apps/worker/src/once.ts discovery|watch|retention
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json vitest.config.ts ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
ARG APP_VERSION=2.0.0
ENV APP_VERSION=${APP_VERSION}
RUN pnpm build
# drop dev-only weight (vite, tailwind, drizzle-kit, vitest) — runtime is tsx + hono + drizzle + pg
RUN pnpm prune --prod

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ARG APP_VERSION=2.0.0
ENV APP_VERSION=${APP_VERSION}
RUN useradd -m -u 10001 appuser
COPY --from=build --chown=appuser:appuser /app /app
USER appuser
EXPOSE 8080 9464
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "apps/api/src/index.ts"]
