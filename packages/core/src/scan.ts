import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { boardDeltas, boardSnapshots, boardSources, companies, discoveryFeed, getDb, id, positions } from "@job-scout/db";
import { detectAts, externalIdentityFromDetect, fetchGreenhouseJob, greenhouseBoardToken, greenhouseListingNeedsBoardFetch, listBoard, type AtsJob, type BoardJobSummary } from "@job-scout/ats";
import { fetchJob as fetchJobFromUrl } from "./fetch-job.js";
import { applyProfileToGate, classifyListing, cleanJobTitle, craftFamily, gateListing, geoClass, homeMarket, isNoiseJobTitle, missesHomeMarket, parseClipListing, type GateConfig, type GateVerdict } from "@job-scout/shared";
import { enqueueJob } from "./jobs.js";
import { llmConfigured } from "./llm.js";
import { archivePosition, upsertFromJob } from "./positions.js";
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
  const profile = await profileGate();
  for (const j of list) {
    j.title = cleanJobTitle(j.title);
    const verdict: GateVerdict = isNoiseJobTitle(j.title)
      ? { pass: false, reason: "junk_title", matchedInclude: null }
      : listingGate(j, settings.gate, profile, { listedNow: true });
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
          geoClass: geoClass(j.locationRaw || ""),
          craftFamily: craftFamily(j.title),
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
      if (!existing.triagedAt && settings.autopilot.triageNew && existing.status === "triaged" && llmConfigured()) {
        const q = await enqueueJob("triage", { positionId: existing.id }, { dedupeKey: `triage:${existing.id}`, priority: 60 });
        if (!q.deduped) res.triageEnqueued++;
      }
      continue;
    }
    if (!j.url) continue;
    try {
      let job: AtsJob | null = null;
      try {
        job = await fetchJobFromUrl(j.url);
      } catch (e) {
        log.warn("scan.listing.fetch_failed", { company: board.company, url: j.url, err: e });
      }
      if (
        board.token &&
        j.jobId &&
        greenhouseListingNeedsBoardFetch(job, {
          provider: board.provider,
          token: board.token,
          jobId: j.jobId,
        })
      ) {
        const direct = await fetchGreenhouseJob(board.token, j.jobId);
        if (direct.descriptionText?.trim()) job = { ...direct, url: j.url || direct.url };
      }
      if (!job) continue;
      job.company = job.company || j.company || board.company;
      job.boardToken = board.token || job.boardToken;
      job.externalIdentity = j.externalIdentity || job.externalIdentity;
      job.locationRaw = job.locationRaw || j.locationRaw;
      if (!job.title || job.title.length < 3) job.title = j.title;
      const { position, created } = await upsertFromJob(job, { source: `scan:${board.provider}`, companyName: j.company || board.company });
      if (created) res.created++;
      else res.updated++;
      await db.update(discoveryFeed).set({ positionId: position.id }).where(eq(discoveryFeed.externalIdentity, j.externalIdentity));
      if (settings.autopilot.triageNew && llmConfigured() && (created || !position.triagedAt)) {
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

type ProfileGate = { home: string; northStar: string };

async function profileGate(): Promise<ProfileGate> {
  const { getProfile } = await import("./profile.js");
  const profile = await getProfile();
  return { home: profile.location || "", northStar: profile.northStar || "" };
}

function listingGate(
  input: { title: string; locationRaw?: string | null; postedAt?: string | Date | null; workplaceType?: string | null; isRemote?: boolean | null },
  gate: GateConfig,
  profile: ProfileGate = { home: "", northStar: "" },
  opts: { listedNow?: boolean } = {},
): GateVerdict {
  const title = cleanJobTitle(input.title);
  if (isNoiseJobTitle(title)) return { pass: false, reason: "junk_title", matchedInclude: null };
  const facts = classifyListing({
    locationRaw: input.locationRaw,
    workplaceType: input.workplaceType,
    isRemote: input.isRemote,
    title,
  });
  const workplaceType = facts.workplace !== "unknown" ? facts.workplace : input.workplaceType;
  const verdict = gateListing({
    title,
    locationRaw: input.locationRaw,
    postedAt: input.postedAt,
    workplaceType,
  }, applyProfileToGate(gate, { home: profile.home, northStar: profile.northStar, listedNow: opts.listedNow }));
  if (verdict.pass && missesHomeMarket(input.locationRaw || "", profile.home)) {
    return { pass: false, reason: "geo_home", matchedInclude: verdict.matchedInclude };
  }
  return verdict;
}

function titleGateMiss(title: string, gate: GateConfig): string | null {
  const verdict = gateListing(
    { title, locationRaw: "Remote" },
    { ...gate, maxPostingAgeDays: 0, geoAllow: ["remote"], geoBlock: [], allowUnknownGeo: true },
  );
  if (verdict.pass) return null;
  if (verdict.reason === "title_no_include" || verdict.reason?.startsWith("title_exclude:")) return verdict.reason;
  return null;
}

function filingMiss(verdict: GateVerdict): string | null {
  if (verdict.pass || !verdict.reason) return null;
  if (verdict.reason === "title_no_include" || verdict.reason.startsWith("title_exclude:")) return verdict.reason;
  if (verdict.reason.startsWith("geo_block:") || verdict.reason === "geo_unlisted" || verdict.reason === "geo_home") return verdict.reason;
  return null;
}

/** Archive a scan filing the operator has not touched when its title no longer matches. */
async function withdrawUntouchedScanPosition(
  positionId: string,
  gate: GateConfig,
  opts?: { allowManual?: boolean; reason?: string },
): Promise<boolean> {
  const db = await getDb();
  const pos = (
    await db
      .select({
        id: positions.id,
        title: positions.title,
        status: positions.status,
        triagedAt: positions.triagedAt,
        triageVerdict: positions.triageVerdict,
        source: positions.source,
        notes: positions.notes,
        priority: positions.priority,
        watchEnabled: positions.watchEnabled,
      })
      .from(positions)
      .where(eq(positions.id, positionId))
      .limit(1)
  )[0];
  if (!pos || pos.status !== "triaged" || pos.triagedAt || pos.triageVerdict) return false;
  const fromScan = Boolean(pos.source?.startsWith("scan:"));
  const misstampedManual = Boolean(opts?.allowManual && pos.source === "manual");
  if ((!fromScan && !misstampedManual) || pos.notes?.trim() || pos.priority !== "P2" || pos.watchEnabled) return false;
  const reason = opts?.reason ?? titleGateMiss(pos.title, gate);
  if (!reason) return false;
  const label = reason.startsWith("geo_") ? "left the location gate" : "left the title gate";
  await archivePosition(pos.id, `${label} (${reason})`, "scan");
  await db.update(discoveryFeed).set({ lane: "filtered", gateReason: reason }).where(eq(discoveryFeed.positionId, pos.id));
  return true;
}

/** Re-apply the current gate to listings already stored in discovery. Newly passing rows are queued for intake. */
export async function regateRecentDiscovery(hours = 24 * 7): Promise<{
  checked: number;
  nowPassed: number;
  nowFiltered: number;
  promoted: number;
  withdrawn: number;
}> {
  const db = await getDb();
  const settings = await getSettings({ fresh: true });
  const since = new Date(Date.now() - hours * 3_600_000);
  const rows = await db
    .select({
      id: discoveryFeed.id,
      title: discoveryFeed.title,
      locationRaw: discoveryFeed.locationRaw,
      postedAt: discoveryFeed.postedAt,
      lane: discoveryFeed.lane,
      gateReason: discoveryFeed.gateReason,
      url: discoveryFeed.url,
      positionId: discoveryFeed.positionId,
      company: discoveryFeed.company,
      externalIdentity: discoveryFeed.externalIdentity,
    })
    .from(discoveryFeed)
    .where(gte(discoveryFeed.observedAt, since));

  let nowPassed = 0;
  let nowFiltered = 0;
  let promoted = 0;
  let withdrawn = 0;
  const considered = new Set<string>();
  const profile = await profileGate();
  const positionIds = [...new Set(rows.map((r) => r.positionId).filter((id): id is string => Boolean(id)))];
  const storedWorkplace = new Map<string, string | null>();
  if (positionIds.length) {
    const places = await db.select({ id: positions.id, workplace: positions.workplace }).from(positions).where(inArray(positions.id, positionIds));
    for (const place of places) storedWorkplace.set(place.id, place.workplace);
  }
  for (const row of rows) {
    const workplaceType = row.positionId ? storedWorkplace.get(row.positionId) : undefined;
    const verdict = listingGate({
      title: row.title,
      locationRaw: row.locationRaw,
      postedAt: row.postedAt,
      workplaceType: workplaceType && workplaceType !== "unknown" ? workplaceType : undefined,
    }, settings.gate, profile, { listedNow: true });
    const lane = verdict.pass ? "passed" : "filtered";
    const miss = filingMiss(verdict);
    if (miss && row.positionId && !considered.has(row.positionId)) {
      considered.add(row.positionId);
      if (await withdrawUntouchedScanPosition(row.positionId, settings.gate, { reason: miss })) withdrawn++;
    }
    if (lane === row.lane && (verdict.reason ?? null) === (row.gateReason ?? null)) continue;
    await db
      .update(discoveryFeed)
      .set({ lane, gateReason: verdict.reason, metadata: { matchedInclude: verdict.matchedInclude } })
      .where(eq(discoveryFeed.id, row.id));
    if (lane === "passed" && row.lane !== "passed") {
      nowPassed++;
      if (!row.positionId && row.url) {
        const q = await enqueueJob(
          "scan_url",
          { url: row.url, companyName: row.company ?? undefined },
          { dedupeKey: `scan_url:${row.externalIdentity || row.url}`, priority: 200 },
        );
        if (!q.deduped) promoted++;
      }
    } else if (lane === "filtered" && row.lane === "passed") {
      nowFiltered++;
    }
  }
  if (nowPassed || nowFiltered || withdrawn) {
    log.info("scan.regate", { checked: rows.length, nowPassed, nowFiltered, promoted, withdrawn, hours });
  }
  return { checked: rows.length, nowPassed, nowFiltered, promoted, withdrawn };
}

/** Passed rows whose filing was later archived for the gate should leave the passed lane. */
export async function syncGateArchiveLanes(): Promise<{ updated: number }> {
  const db = await getDb();
  const rows = await db
    .select({ id: positions.id, archiveReason: positions.archiveReason })
    .from(positions)
    .where(and(eq(positions.status, "archived"), sql`${positions.archiveReason} ~ '^left the (title|location) gate \\('`));
  let updated = 0;
  for (const row of rows) {
    const reason = row.archiveReason?.match(/\(([^)]+)\)\s*$/)?.[1];
    if (!reason) continue;
    const changed = await db
      .update(discoveryFeed)
      .set({ lane: "filtered", gateReason: reason })
      .where(and(eq(discoveryFeed.positionId, row.id), eq(discoveryFeed.lane, "passed")))
      .returning({ id: discoveryFeed.id });
    updated += changed.length;
  }
  return { updated };
}

/**
 * Discovery promotions made before scan_url stamped source "scan:discovery" were
 * stored as manual. A later title-gate miss could not withdraw them. Run once.
 * A URL the operator adds by hand stays, because ordinary regate does not pass allowManual.
 */
export async function repairMisstampedDiscoveryFilings(): Promise<{ withdrawn: number }> {
  const db = await getDb();
  const settings = await getSettings({ fresh: true });
  const rows = await db
    .select({
      positionId: discoveryFeed.positionId,
      title: discoveryFeed.title,
      locationRaw: discoveryFeed.locationRaw,
      postedAt: discoveryFeed.postedAt,
    })
    .from(discoveryFeed)
    .where(sql`${discoveryFeed.positionId} is not null`);
  const seen = new Set<string>();
  let withdrawn = 0;
  for (const row of rows) {
    if (!row.positionId || seen.has(row.positionId)) continue;
    const verdict = isNoiseJobTitle(row.title)
      ? { pass: false, reason: "junk_title" }
      : gateListing({ title: row.title, locationRaw: row.locationRaw, postedAt: row.postedAt }, settings.gate);
    const titleMiss = !verdict.pass && (verdict.reason === "title_no_include" || verdict.reason?.startsWith("title_exclude:"));
    if (!titleMiss) continue;
    seen.add(row.positionId);
    if (await withdrawUntouchedScanPosition(row.positionId, settings.gate, { allowManual: true })) withdrawn++;
  }
  return { withdrawn };
}

/**
 * Office listings promoted before the gate could see a city. Ordinary regate
 * withdraws scan sources. This one-shot also withdraws a discovery promotion
 * that was stored as manual. A URL pasted by hand, with no discovery row, stays.
 */
export async function repairOfficeDiscoveryFilings(): Promise<{ withdrawn: number }> {
  const db = await getDb();
  const settings = await getSettings({ fresh: true });
  const rows = await db
    .select({
      id: positions.id,
      title: positions.title,
      workplace: positions.workplace,
      source: positions.source,
    })
    .from(positions)
    .where(and(eq(positions.status, "triaged"), inArray(positions.workplace, ["onsite", "hybrid"])));
  let withdrawn = 0;
  const profile = await profileGate();
  for (const row of rows) {
    const feed = (
      await db
        .select({ locationRaw: discoveryFeed.locationRaw, postedAt: discoveryFeed.postedAt })
        .from(discoveryFeed)
        .where(eq(discoveryFeed.positionId, row.id))
        .limit(1)
    )[0];
    if (row.source === "manual" && !feed) continue;
    const verdict = listingGate({
      title: row.title,
      locationRaw: feed?.locationRaw,
      postedAt: feed?.postedAt,
      workplaceType: row.workplace,
    }, settings.gate, profile);
    const miss = filingMiss(verdict);
    if (!miss?.startsWith("geo_")) continue;
    if (await withdrawUntouchedScanPosition(row.id, settings.gate, { allowManual: row.source === "manual", reason: miss })) withdrawn++;
  }
  return { withdrawn };
}

/**
 * A US profile location cannot take a role that requires another country.
 * Scan filings and discovery promotions are withdrawn. A hand-pasted URL with no discovery row stays.
 */
export async function repairHomeMarketFilings(): Promise<{ withdrawn: number }> {
  const db = await getDb();
  const settings = await getSettings({ fresh: true });
  const profile = await profileGate();
  if (!homeMarket(profile.home)) return { withdrawn: 0 };
  const rows = await db
    .select({
      id: positions.id,
      title: positions.title,
      workplace: positions.workplace,
      source: positions.source,
    })
    .from(positions)
    .where(eq(positions.status, "triaged"));
  let withdrawn = 0;
  for (const row of rows) {
    const feed = (
      await db
        .select({ locationRaw: discoveryFeed.locationRaw, postedAt: discoveryFeed.postedAt })
        .from(discoveryFeed)
        .where(eq(discoveryFeed.positionId, row.id))
        .limit(1)
    )[0];
    if (row.source === "manual" && !feed) continue;
    const verdict = listingGate({
      title: row.title,
      locationRaw: feed?.locationRaw,
      postedAt: feed?.postedAt,
      workplaceType: row.workplace && row.workplace !== "unknown" ? row.workplace : undefined,
    }, settings.gate, profile);
    if (verdict.reason !== "geo_home") continue;
    if (await withdrawUntouchedScanPosition(row.id, settings.gate, { allowManual: row.source === "manual", reason: "geo_home" })) withdrawn++;
  }
  return { withdrawn };
}

/** Re-apply profile rules (north star excludes, home market, listed-now age) and archive untouched misses. */
export async function repairProfileGateFilings(): Promise<{ withdrawn: number; regated: number }> {
  const regate = await regateRecentDiscovery();
  const db = await getDb();
  const settings = await getSettings({ fresh: true });
  const profile = await profileGate();
  const rows = await db
    .select({ id: positions.id, title: positions.title, workplace: positions.workplace, source: positions.source })
    .from(positions)
    .where(eq(positions.status, "triaged"));
  let withdrawn = 0;
  for (const row of rows) {
    const feed = (
      await db
        .select({ locationRaw: discoveryFeed.locationRaw, postedAt: discoveryFeed.postedAt })
        .from(discoveryFeed)
        .where(eq(discoveryFeed.positionId, row.id))
        .limit(1)
    )[0];
    if (row.source === "manual" && !feed) continue;
    const verdict = listingGate({
      title: row.title,
      locationRaw: feed?.locationRaw,
      postedAt: feed?.postedAt,
      workplaceType: row.workplace && row.workplace !== "unknown" ? row.workplace : undefined,
    }, settings.gate, profile, { listedNow: true });
    const miss = filingMiss(verdict);
    if (!miss) continue;
    if (await withdrawUntouchedScanPosition(row.id, settings.gate, { allowManual: row.source === "manual", reason: miss })) withdrawn++;
  }
  return { withdrawn: withdrawn + regate.withdrawn, regated: regate.nowPassed };
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
  if (!position.triagedAt && !llmConfigured()) return { triageJobId: null };
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

/** A gh_jid careers URL has no board token. The company board has the location and the JD. */
async function fetchListingForIntake(url: string, companyName?: string): Promise<AtsJob> {
  const detected = detectAts(url);
  if (detected.provider === "greenhouse" && detected.jobId && !detected.boardToken) {
    const token = await greenhouseTokenFor(url, companyName);
    if (token) {
      try {
        const direct = await fetchGreenhouseJob(token, detected.jobId);
        if (direct.title || direct.descriptionText?.trim()) {
          return { ...direct, url, company: direct.company || companyName };
        }
      } catch (e) {
        log.warn("intake.greenhouse_board_failed", { url, token, err: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return fetchJobFromUrl(url);
}

async function greenhouseTokenFor(url: string, companyName?: string): Promise<string | null> {
  const db = await getDb();
  const boards = await db
    .select({ company: boardSources.company, token: boardSources.token, careersUrl: boardSources.careersUrl })
    .from(boardSources)
    .where(eq(boardSources.provider, "greenhouse"));
  return greenhouseBoardToken(boards, { companyName, url });
}

async function openScanFiling(url: string): Promise<{ id: string } | undefined> {
  const db = await getDb();
  const byUrl = (
    await db.select({ id: positions.id, status: positions.status }).from(positions).where(eq(positions.primaryUrl, url)).limit(1)
  )[0];
  if (byUrl?.status === "triaged") return byUrl;
  const jobId = detectAts(url).jobId;
  if (!jobId) return undefined;
  const byJob = (
    await db.select({ id: positions.id, status: positions.status }).from(positions).where(eq(positions.atsJobId, jobId)).limit(1)
  )[0];
  return byJob?.status === "triaged" ? byJob : undefined;
}

/** Filings saved from a careers page with no location get the board job, then the gate. */
export async function refetchBlankGreenhouseFilings(): Promise<{ checked: number; updated: number; withdrawn: number; failed: number }> {
  const db = await getDb();
  const rows = await db
    .select({
      url: positions.primaryUrl,
      company: companies.name,
      provider: positions.atsProvider,
      location: sql<string | null>`(select location_raw from jd_revisions jr where jr.position_id = ${positions.id} order by jr.revision desc limit 1)`,
    })
    .from(positions)
    .innerJoin(companies, eq(positions.companyId, companies.id))
    .where(eq(positions.status, "triaged"));
  const blank = rows.filter((row) => row.url && row.provider === "greenhouse" && !(row.location || "").trim());
  let updated = 0;
  let withdrawn = 0;
  let failed = 0;
  for (const row of blank) {
    try {
      const result = await intakeUrl(row.url!, { companyName: row.company, source: "scan:discovery" });
      if ("skipped" in result && result.skipped) withdrawn++;
      else if (result.position) updated++;
    } catch (e) {
      failed++;
      log.warn("intake.blank_greenhouse_failed", { url: row.url, err: e instanceof Error ? e.message : String(e) });
    }
  }
  if (blank.length && failed === blank.length) throw new Error("greenhouse location refetch failed");
  return { checked: blank.length, updated, withdrawn, failed };
}

/** Manual intake: URL -> position (status triaged) -> triage job. */
export async function intakeUrl(url: string, opts: { companyName?: string; status?: "triaged" | "review"; source?: string } = {}) {
  const job = await fetchListingForIntake(url, opts.companyName);
  if ((opts.source || "").startsWith("scan:")) {
    const settings = await getSettings();
    const verdict = listingGate(job, settings.gate, await profileGate(), { listedNow: true });
    if (!verdict.pass) {
      const db = await getDb();
      await db.update(discoveryFeed).set({ lane: "filtered", gateReason: verdict.reason }).where(eq(discoveryFeed.url, url));
      const existing = await openScanFiling(url);
      if (existing) {
        const { position } = await upsertFromJob(job, {
          source: opts.source || "scan:discovery",
          companyName: opts.companyName,
          status: "triaged",
        });
        await withdrawUntouchedScanPosition(position.id, settings.gate, { reason: verdict.reason ?? undefined });
      }
      return { position: null, created: false, revived: false, triageJobId: null, skipped: true as const, reason: verdict.reason };
    }
  }
  const { position, created, revived } = await upsertFromJob(job, {
    source: opts.source || "manual",
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
