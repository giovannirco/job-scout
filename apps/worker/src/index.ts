import { appVersion as version, bootstrap, initMetrics, startMetricsServer } from "@job-scout/core";
import { log, setLogContext } from "@job-scout/shared";
import { startWorker } from "./loop.js";

async function main() {
  setLogContext({ component: "worker", version });
  initMetrics("worker", version);
  const metrics = startMetricsServer();
  await bootstrap({ seedBoards: false });
  const w = startWorker({
    pollMs: Number(process.env.WORKER_POLL_MS || 1500),
    concurrency: Number(process.env.WORKER_CONCURRENCY || 2),
    scheduler: process.env.WORKER_SCHEDULER !== "0",
  });
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("worker.shutdown", { signal });
    metrics?.close();
    // k8s terminationGracePeriodSeconds is 30s by default; leave headroom for the DB write.
    void w.stop(20_000).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 28_000).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((e) => {
  log.error("worker.fatal", { err: e });
  process.exit(1);
});
