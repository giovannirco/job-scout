/**
 * One-shot entry for CronJobs: `tsx apps/worker/src/once.ts discovery|retention|watch`.
 * Enqueues (or runs) and exits; the long-running worker processes the queue.
 * Short-lived, so no /metrics server: outcomes land in the DB gauges the API exposes and in JSON logs.
 */
import { bootstrap, closeDbSafe, enqueueDueBoardScans, enqueueDueWatchChecks, runRetention } from "@job-scout/core";
import { log, setLogContext } from "@job-scout/shared";

async function main() {
  const task = process.argv[2] || "discovery";
  setLogContext({ component: "once", task });
  const t0 = Date.now();
  await bootstrap({ seedBoards: false });
  let result: Record<string, unknown>;
  if (task === "discovery") result = await enqueueDueBoardScans({ all: process.argv.includes("--all") });
  else if (task === "watch") result = await enqueueDueWatchChecks();
  else if (task === "retention") result = await runRetention();
  else throw new Error(`unknown task ${task}`);
  log.info("once.done", { ms: Date.now() - t0, ...result });
  await closeDbSafe();
}

main().catch((e) => {
  log.error("once.failed", { err: e });
  process.exit(1);
});
