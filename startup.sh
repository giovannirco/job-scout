#!/bin/sh
set -eu
cd /workspace
if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/api/v1/health; then
  exit 0
fi
export HOST=0.0.0.0
export PORT=8080
export AUTH_MODE="${AUTH_MODE:-dev}"
export API_TOKEN_SEED="${API_TOKEN_SEED:-dev-agent-token}"
export EMBED_WORKER="${EMBED_WORKER:-1}"
export PGLITE_DATA_DIR="${PGLITE_DATA_DIR:-/workspace/.data/pglite}"
mkdir -p "$PGLITE_DATA_DIR"
npx tsx apps/api/src/index.ts >>/tmp/app-startup.log 2>&1 &
# wait for health
i=0
while [ "$i" -lt 60 ]; do
  if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/api/v1/health; then
    exit 0
  fi
  i=$((i + 1))
  sleep 0.5
done
echo "startup: health check failed" >&2
tail -n 50 /tmp/app-startup.log >&2 || true
exit 1
