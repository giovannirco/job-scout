import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { boardDeltas, boardSnapshots, boardSources, discoveryFeed, getDb, id, positions } from "@job-scout/db";
import { detectAts, externalIdentityFromDetect, listBoard, type AtsJob, type BoardJobSummary } from "@job-scout/ats";
import { fetchJob as fetchJobFromUrl } from "./fetch-job.js";
import { craftFamily, gateListing, geoClass, isNoiseJobTitle, parseClipListing, type GateVerdict } from "@job-scout/shared";
import { enqueueJob } from "./jobs.js";
import { upsertFromJob } from "./positions.js";
import { getSettings } from "./settings.js";
import { boardErrorKind, type BoardErrorKind } from "./board-reconcile.js";
import type { PositionStatus } from "@job-scout/db";
import { log as rootLog } from "@job-scout/shared";
import { boardScans, scanListings } from "./metrics.js";
const log = rootLog.child({ scope: "scan" });

type Ident = { externalIdentity: string; title: string; url?: string; location?: string | null };

export type ScanResult = {
  boardId: string;
  company: string;
  total: number;
  seen: number;
  passed: number;
  filtered: number;
  created: number;
  updated: number;
  closed: number;
  triageEnqueued: number;
  error?: string;
  errorKind?: BoardErrorKind;
};

/**
 * Scan one board: list -> deterministic gate -> discovery_feed (all) ->
 * positions for gate passes (fetch JD) -> triage job. Rejected items are
 * recorded in discovery_feed lane=filtered with the reason, nothing else.
 */
export async function scanBoard(boardId: string, opts: { force?: boolean } = {}): Promise<ScanResult> {
  const db = await getDb();
  const settings = await getSettings();
  const board = (await db.select().from(boardSources).where(eq(boardSources.id, boardId)).limit(1))[0];
  if (!board) throw new Error("board not found");
  const res: ScanResult = { boardId, company: board.company, total: 0, seen: 0, passed: 0, filtered: 0, created: 0, updated: 0, closed: 0, triageEnqueued: 0 };

  let list: BoardJobSummary[] = [];
  try {
    const out = await listBoard(board.provider, board.token, board.company);
    list = out.jobs;
    res.total = out.total;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.update(boardSources).set({ lastScannedAt: new Date(), lastError: msg.slice(0, 500) }).where(eq(boardSources.id, board.id));
    res.error = msg;
    res.errorKind = boardErrorKind(msg);
    boardScans.labels({ provider: board.provider, status: "error" }).inc();
    log.warn("scan.board.failed", { boardId: board.id, company: board.company, provider: board.provider, errorKind: res.errorKind, err: e });
    return res;
  }
  res.seen = list.length;

  const prev = (
    await db.select().from(boardSnapshots).where(eq(boardSnapshots.boardSourceId, board.id)).orderBy(desc(boardSnapshots.observedAt)).limit(1)
  )[0];
  const prevIdents = (Array.isArray(prev?.identities) ? prev!.identities : []) as Ident[];
  const prevById = new Map(prevIdents.map((x) => [x.externalIdentity, x]));
  const isBaseline = !prev;

  const passedJobs: Array<{ j: BoardJobSummary; verdict: GateVerdict }> = [];
  const nowIso = new Date();
  for (const j of list) {
    const verdict: GateVerdict = isNoiseJobTitle(j.title)
      ? { pass: false, reason: "junk_title", matchedInclude: null }
      : gateListing({ title: j.title, locationRaw: j.locationRaw, postedAt: j.postedAt }, settings.gate);
    const lane = verdict.pass ? "passed" : "filtered";
    if (verdict.pass) {
      res.passed++;
      passedJobs.push({ j, verdict });
    } else res.filtered++;

    // Everything lands in discovery_feed (upsert by external identity) so Radar can show the filtered lane.
    await db
      .insert(discoveryFeed)
      .values({
        id: id("df"),
        externalIdentity: j.externalIdentity,
        boardSourceId: board.id,
        company: board.company,
        title: j.title,
        url: j.url,
        locationRaw: j.locationRaw || null,
        craftFamily: craftFamily(j.title),
        geoClass: geoClass(j.locationRaw || ""),
        lane,
        gateReason: verdict.reason,
        provider: j.provider,
        observedAt: nowIso,
        postedAt: j.postedAt ? new Date(j.postedAt) : null,
        metadata: { matchedInclude: verdict.matchedInclude },
      })
      .onConflictDoUpdate({
        target: discoveryFeed.externalIdentity,
        set: {
          title: j.title,
          url: j.url,
          locationRaw: j.locationRaw || null,
          lane,
          gateReason: verdict.reason,
          observedAt: nowIso,
          postedAt: j.postedAt ? new Date(j.postedAt) : null,
        },
      });

    if (!isBaseline && !prevById.has(j.externalIdentity)) {
      await db.insert(boardDeltas).values({
        id: id("bd"),
        boardSourceId: board.id,
        event: "new",
        externalIdentity: j.externalIdentity,
        title: j.title,
        company: board.company,
        url: j.url,
        locationRaw: j.locationRaw || null,
        craftFamily: craftFamily(j.title),
        geoClass: geoClass(j.locationRaw || ""),
        metadata: { gate: lane, reason: verdict.reason },
      });
    }
  }

  // Closed: identities that disappeared from the board and exist as positions.
  const nextIds = new Set(list.map((j) => j.externalIdentity));
  for (const p of prevIdents) {
    if (nextIds.has(p.externalIdentity)) continue;
    const pos = (
      await db
        .select({ id: positions.id, listingStatus: positions.listingStatus, status: positions.status })
        .from(positions)
        .where(eq(positions.externalIdentity, p.externalIdentity))
        .limit(1)
    )[0];
    await db.insert(boardDeltas).values({
      id: id("bd"),
      boardSourceId: board.id,
      event: "closed",
      externalIdentity: p.externalIdentity,
      title: p.title,
      company: board.company,
      url: p.url,
      locationRaw: p.location ?? null,
      craftFamily: craftFamily(p.title),
      metadata: { positionId: pos?.id ?? null },
    });
    if (pos && pos.listingStatus !== "closed") {
      const now = new Date();
      const set: Record<string, unknown> = { listingStatus: "closed", closedAt: now, lastChangedAt: now, updatedAt: now };
      if (pos.status === "triaged" || pos.status === "review") {
        set.status = "archived";
        set.archiveReason = "listing_closed";
        set.watchEnabled = false;
      }
      await db.update(positions).set(set).where(eq(positions.id, pos.id));
      res.closed++;
    }
  }

  // Passed: make sure a position exists (fetch full JD only for new identities or forced).
  for (const { j } of passedJobs) {
    const existing = (
      await db.select({ id: positions.id, triagedAt: positions.triagedAt, status: positions.status }).from(positions).where(eq(positions.externalIdentity, j.externalIdentity)).limit(1)
    )[0];
    if (existing && !opts.force) {
      await db.update(discoveryFeed).set({ positionId: existing.id }).where(eq(discoveryFeed.externalIdentity, j.externalIdentity));
      // Known position: watch_check refreshes JDs on its own schedule. Enqueue triage if never run.
      if (!existing.triagedAt && settings.autopilot.triageNew && existing.status === "triaged") {
        const q = await enqueueJob("triage", { positionId: existing.id }, { dedupeKey: `triage:${existing.id}`, priority: 60 });
        if (!q.deduped) res.triageEnqueued++;
      }
      continue;
    }
    if (!j.url) continue;
    try {
      const job = await fetchJobFromUrl(j.url);
      job.company = job.company || j.company || board.company;
      job.boardToken = job.boardToken || board.token;
      job.externalIdentity = job.externalIdentity || j.externalIdentity;
      if (!job.title || job.title.length < 3) job.title = j.title;
      const { position, created } = await upsertFromJob(job, { source: `scan:${board.provider}`, companyName: j.company || board.company });
      if (created) res.created++;
      else res.updated++;
      await db.update(discoveryFeed).set({ positionId: position.id }).where(eq(discoveryFeed.externalIdentity, j.externalIdentity));
      if (settings.autopilot.triageNew && (created || !position.triagedAt)) {
        const q = await enqueueJob("triage", { positionId: position.id }, { dedupeKey: `triage:${position.id}`, priority: 60 });
        if (!q.deduped) res.triageEnqueued++;
      }
    } catch (e) {
      log.warn("scan.listing.failed", { company: board.company, url: j.url, err: e });
    }
  }

  await db.insert(boardSnapshots).values({
    id: id("snap"),
    boardSourceId: board.id,
    jobCount: res.total,
    matchCount: res.passed,
    identities: list.map((j) => ({ externalIdentity: j.externalIdentity, title: j.title, url: j.url, location: j.locationRaw ?? null })) satisfies Ident[],
  });
  await db.update(boardSources).set({ lastScannedAt: new Date(), lastError: null }).where(eq(boardSources.id, board.id));
  boardScans.labels({ provider: board.provider, status: "ok" }).inc();
  const sl = (outcome: string, n: number) => n && scanListings.labels({ provider: board.provider, outcome }).inc(n);
  sl("seen", res.seen);
  sl("gate_pass", res.passed);
  sl("gate_fail", res.filtered);
  sl("created", res.created);
  sl("updated", res.updated);
  sl("closed", res.closed);
  log.info("scan.board.done", { provider: board.provider, baseline: isBaseline, ...res });
  return res;
}

/** Enqueue board_scan for enabled list_api boards that are due (discovery tick). */
export async function enqueueDueBoardScans(opts: { limit?: number; all?: boolean } = {}) {
  const db = await getDb();
  const settings = await getSettings();
  const cutoff = new Date(Date.now() - settings.scan.boardIntervalMinutes * 60_000);
  const limit = Math.min(500, opts.limit ?? settings.scan.boardsPerTick);
  const due = await db
    .select({ id: boardSources.id, company: boardSources.company })
    .from(boardSources)
    .where(
      and(
        eq(boardSources.enabled, true),
        or(eq(boardSources.capability, "list_api"), isNull(boardSources.capability)),
        opts.all ? sql`true` : or(isNull(boardSources.lastScannedAt), lt(boardSources.lastScannedAt, cutoff))!,
      ),
    )
    .orderBy(sql`${boardSources.lastScannedAt} ASC NULLS FIRST`)
    .limit(limit);
  let enqueued = 0;
  for (const b of due) {
    const q = await enqueueJob("board_scan", { boardId: b.id, company: b.company }, { dedupeKey: `board_scan:${b.id}`, priority: 120 });
    if (!q.deduped) enqueued++;
  }
  return { due: due.length, enqueued };
}

export async function followUpIntake(
  position: {
    id: string;
    companyId: string;
    triagedAt: Date | null;
    triageScore: number | null;
    triageVerdict: string | null;
    status: string;
  },
  opts: { created: boolean; revived: boolean },
): Promise<{ triageJobId: string | null }> {
  const settings = await getSettings();
  if (!settings.autopilot.triageNew) return { triageJobId: null };
  if (!position.triagedAt) {
    const q = await enqueueJob("triage", { positionId: position.id }, { dedupeKey: `triage:${position.id}`, priority: 20 });
    return { triageJobId: q.id };
  }
  if (opts.revived) {
    const { afterTriage } = await import("./autopilot.js");
    await afterTriage({
      positionId: position.id,
      companyId: position.companyId,
      score: position.triageScore ?? 0,
      verdict: (position.triageVerdict as "pass" | "marginal" | "fail") || "fail",
      status: position.status as PositionStatus,
    });
  }
  return { triageJobId: null };
}

/** Manual intake: URL -> position (status triaged) -> triage job. */
export async function intakeUrl(url: string, opts: { companyName?: string; status?: "triaged" | "review" } = {}) {
  const job = await fetchJobFromUrl(url);
  const { position, created, revived } = await upsertFromJob(job, {
    source: "manual",
    companyName: opts.companyName,
    status: opts.status || "triaged",
    reviveArchived: true,
  });
  const { triageJobId } = await followUpIntake(position, { created, revived });
  return { position, created, revived, triageJobId };
}

/** Bookmarklet intake: tab snapshot -> position. Never re-fetches the URL. */
export async function intakeClipSnapshot(input: { url: string; title?: string; text?: string }) {
  const url = (input.url || "").trim();
  const titleIn = (input.title || "").trim();
  const text = String(input.text || "");
  if (!url) throw new Error("url required");
  if (!titleIn && !text.trim()) throw new Error("snapshot empty");
  const parsed = parseClipListing({ url, title: titleIn, text });
  const detected = detectAts(url);
  const title = parsed.title.trim() || titleIn || "Clipped listing";
  const job: AtsJob = {
    provider: detected.provider === "unknown" ? "other" : detected.provider,
    boardToken: detected.boardToken,
    jobId: detected.jobId,
    externalIdentity: externalIdentityFromDetect(detected),
    title,
    company: parsed.company,
    url,
    descriptionText: parsed.descriptionText,
    listingStatus: "open",
    rawPayload: { clip: true, pageTitle: titleIn || undefined },
  };
  const { position, created, revived } = await upsertFromJob(job, {
    source: "clip",
    companyName: parsed.company,
    status: "triaged",
    reviveArchived: true,
  });
  const { triageJobId } = await followUpIntake(position, { created, revived });
  return { position, created, revived, triageJobId };
}
