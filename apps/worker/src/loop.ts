import {
  checkPosition,
  checkWatch,
  claimNextJob,
  completeJob,
  enqueueDueBoardScans,
  enqueueDueWatchChecks,
  enqueueStaleAppliedNags,
  failJob,
  flushDueNotifications,
  intakeUrl,
  LlmGateError,
  jobDuration,
  jobsInFlight,
  jobsProcessed,
  releaseJobs,
  requeueStale,
  schedulerRuns,
  runCompanyResearch,
  runEvaluate,
  runFormAnswers,
  runListingClassify,
  runJdReview,
  runMaterials,
  runRetention,
  runTriage,
  runInterviewBrief,
  pollWhatsAppInbox,
  scanBoard,
  type JobRow,
} from "@job-scout/core";
import type { JobType } from "@job-scout/db";
import { log as rootLog } from "@job-scout/shared";

const log = rootLog.child({ scope: "worker" });

const LLM_TYPES: JobType[] = ["triage", "evaluate", "materials", "company_research", "jd_review", "listing_classify", "form_answers", "interview_brief"];

export async function processJob(job: JobRow): Promise<Record<string, unknown>> {
  const p = job.payload as Record<string, unknown>;
  switch (job.type) {
    case "board_scan":
      return (await scanBoard(String(p.boardId), { force: Boolean(p.force) })) as unknown as Record<string, unknown>;
    case "watch_check":
      if (p.watchId) return (await checkWatch(String(p.watchId))) as unknown as Record<string, unknown>;
      return (await checkPosition(String(p.positionId))) as unknown as Record<string, unknown>;
    case "scan_url": {
      const r = await intakeUrl(String(p.url), { companyName: p.companyName ? String(p.companyName) : undefined, source: "scan:discovery" });
      return { positionId: r.position.id, created: r.created, triageJobId: r.triageJobId };
    }
    case "triage":
      return (await runTriage(String(p.positionId), { force: Boolean(p.force) })) as unknown as Record<string, unknown>;
    case "evaluate":
      return await runEvaluate(String(p.positionId), { auto: Boolean(p.auto) });
    case "materials":
      return await runMaterials(String(p.positionId), { surface: p.surface ? String(p.surface) : null, auto: Boolean(p.auto) });
    case "company_research":
      return await runCompanyResearch(String(p.companyId), p.positionId ? String(p.positionId) : null);
    case "jd_review":
      return await runJdReview(String(p.positionId));
    case "form_answers":
      return (await runFormAnswers(String(p.positionId))) as unknown as Record<string, unknown>;
    case "listing_classify":
      return (await runListingClassify(String(p.positionId))) as unknown as Record<string, unknown>;
    case "interview_brief":
      return (await runInterviewBrief(String(p.positionId), String(p.interviewId))) as unknown as Record<string, unknown>;
    case "retention":
      return (await runRetention()) as unknown as Record<string, unknown>;
    default:
      throw new Error(`unknown job type ${String(job.type)}`);
  }
}

export type WorkerOptions = {
  pollMs?: number;
  concurrency?: number;
  /** Run the discovery/watch/retention schedulers inside this process */
  scheduler?: boolean;
  discoveryEveryMs?: number;
  watchEveryMs?: number;
  retentionEveryMs?: number;
  /** Only pick these job types (e.g. a dedicated LLM worker) */
  types?: JobType[];
};

export function startWorker(opts: WorkerOptions = {}) {
  const pollMs = opts.pollMs ?? 1500;
  const concurrency = opts.concurrency ?? 2;
  let busy = 0;
  let stopped = false;
  const inFlight = new Set<string>();
  log.info("worker.start", { pollMs, concurrency, scheduler: opts.scheduler !== false, types: opts.types ?? null });

  const tick = async () => {
    if (stopped) return;
    while (busy < concurrency) {
      const job = await claimNextJob(opts.types).catch((e) => {
        log.error("worker.claim.failed", { err: e });
        return null;
      });
      if (!job) break;
      busy++;
      inFlight.add(job.id);
      jobsInFlight.set(inFlight.size);
      void run(job).finally(() => {
        busy--;
        inFlight.delete(job.id);
        jobsInFlight.set(inFlight.size);
      });
    }
  };

  const run = async (job: JobRow) => {
    const t0 = Date.now();
    const jlog = log.child({ jobId: job.id, type: job.type, attempt: job.attempts, positionId: (job.payload as Record<string, unknown> | null)?.positionId ?? undefined });
    try {
      const result = await processJob(job);
      await completeJob(job.id, result);
      const ms = Date.now() - t0;
      jobDuration.labels({ type: job.type }).observe(ms / 1000);
      jobsProcessed.labels({ type: job.type, outcome: "ok" }).inc();
      jlog.info("job.ok", { ms, ...summarize(result) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const gate = e instanceof LlmGateError;
      const ms = Date.now() - t0;
      let outcome: "failed" | "retry" | "parked" = "failed";
      // LLM gate errors (cap/disabled) are not failures of the job: park it for later.
      if (gate && ((e as LlmGateError).code === "cap_reached" || (e as LlmGateError).code === "budget_reached")) {
        outcome = "parked";
        await failJob(job.id, msg, { retryInMs: 60 * 60_000 });
      } else if (job.type === "scan_url" && msg === "unparseable job title") {
        await completeJob(job.id, { skipped: "junk_title" });
        jobDuration.labels({ type: job.type }).observe(ms / 1000);
        jobsProcessed.labels({ type: job.type, outcome: "ok" }).inc();
        jlog.info("job.skipped", { ms, reason: "junk_title" });
        return;
      } else if (!gate && LLM_TYPES.includes(job.type) && job.attempts < 3 && /timeout|429|5\d\d|ECONN|fetch failed/i.test(msg)) {
        outcome = "retry";
        await failJob(job.id, msg, { retryInMs: 2 * 60_000 * job.attempts });
      } else {
        await failJob(job.id, msg);
      }
      jobDuration.labels({ type: job.type }).observe(ms / 1000);
      jobsProcessed.labels({ type: job.type, outcome }).inc();
      jlog[outcome === "failed" ? "error" : "warn"]("job.failed", { ms, outcome, gate: gate ? (e as LlmGateError).code : undefined, err: e });
    }
  };

  const timers: NodeJS.Timeout[] = [];
  timers.push(setInterval(() => void tick(), pollMs));

  const safe = (label: string, fn: () => Promise<unknown>) => () => {
    const t0 = Date.now();
    return fn()
      .then((r) => {
        schedulerRuns.labels({ task: label, status: "ok" }).inc();
        log.info("scheduler.ok", { task: label, ms: Date.now() - t0, ...summarize(r) });
      })
      .catch((e) => {
        schedulerRuns.labels({ task: label, status: "error" }).inc();
        log.error("scheduler.failed", { task: label, ms: Date.now() - t0, err: e });
      });
  };

  // Worker hygiene runs even when the cron scheduler is off (k8s CronJobs own discovery/watch/retention there):
  // jobs left "running" by a crashed or SIGKILLed worker go back to the queue.
  const stale = safe("requeue-stale", async () => ({ requeued: await requeueStale() }));
  setTimeout(stale, 5_000);
  timers.push(setInterval(stale, 15 * 60_000));
  const notifyFlush = safe("notify-flush", () => flushDueNotifications());
  const inbox = safe("whatsapp-inbox", () => pollWhatsAppInbox());
  setTimeout(notifyFlush, 8_000);
  setTimeout(inbox, 12_000);
  timers.push(setInterval(notifyFlush, 4_000));
  timers.push(setInterval(inbox, 5_000));
  const nagStale = safe("stale-applied-nags", () => enqueueStaleAppliedNags());
  setTimeout(nagStale, 90_000);
  timers.push(setInterval(nagStale, 6 * 3_600_000));

  if (opts.scheduler !== false) {
    const discovery = safe("discovery", () => enqueueDueBoardScans());
    const watch = safe("watch", () => enqueueDueWatchChecks());
    const retention = safe("retention", () => runRetention());
    setTimeout(discovery, 10_000);
    setTimeout(watch, 20_000);
    setTimeout(retention, 40_000);
    timers.push(setInterval(discovery, opts.discoveryEveryMs ?? 10 * 60_000));
    timers.push(setInterval(watch, opts.watchEveryMs ?? 30 * 60_000));
    timers.push(setInterval(retention, opts.retentionEveryMs ?? 6 * 3_600_000));
  }

  void tick();
  return {
    /** Stop claiming, wait up to graceMs for in-flight jobs, then release the rest back to the queue. */
    async stop(graceMs = 20_000) {
      stopped = true;
      for (const t of timers) clearInterval(t);
      const deadline = Date.now() + graceMs;
      while (inFlight.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
      if (inFlight.size) {
        const n = await releaseJobs([...inFlight]).catch(() => 0);
        log.info("worker.released", { count: n });
      }
    },
  };
}

function summarize(r: unknown): Record<string, unknown> {
  if (!r || typeof r !== "object") return {};
  const o = r as Record<string, unknown>;
  const keys = ["company", "total", "passed", "filtered", "created", "closed", "triageEnqueued", "verdict", "score", "changed", "enqueued", "due", "skipped", "accepted", "replied", "seen"];
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in o) out[k] = o[k];
  return out;
}
