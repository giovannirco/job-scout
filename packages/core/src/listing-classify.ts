import { and, desc, eq, ne, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { companies, discoveryFeed, getDb, jdRevisions, positions } from "@job-scout/db";
import {
  classifyListing,
  listingClassifyNeeded,
  mergeListingClassify,
  remoteClass,
  type GeoClass,
  type Workplace,
} from "@job-scout/shared";
import { z } from "zod";
import type { ChatMessage } from "@job-scout/llm";
import { enqueueJob } from "./jobs.js";
import { gateOperation, getLlmClient, logged, LlmGateError } from "./llm.js";
import { currentJdText, getPosition } from "./positions.js";
import { getSettings, updateSettings } from "./settings.js";

const ListingClassifyOutput = z.object({
  workplace: z.enum(["remote", "hybrid", "onsite", "unknown"]),
  geoClass: z.enum(["brazil_friendly", "worldwideish", "hard_geo", "ambiguous_remote", "unknown"]),
  geoNote: z.string().optional(),
  evidence: z.string().optional(),
});

async function classificationFingerprint(pos: NonNullable<Awaited<ReturnType<typeof getPosition>>>, model: string) {
  const db = await getDb();
  const rev = (await db.select().from(jdRevisions).where(eq(jdRevisions.positionId, pos.id)).orderBy(desc(jdRevisions.revision)).limit(1))[0];
  return createHash("sha256").update(JSON.stringify({ version: 1, model, title: pos.title, company: pos.company.name,
    location: rev?.locationRaw, ats: pos.metadata?.ats, jd: (await currentJdText(pos.id)).slice(0, 8000) })).digest("hex");
}

function classificationInactive(pos: NonNullable<Awaited<ReturnType<typeof getPosition>>>) {
  return pos.listingStatus === "closed" || ["archived", "skip", "rejected"].includes(pos.status) || Boolean(pos.metadata?.quarantined);
}

export async function maybeEnqueueListingClassify(
  positionId: string,
  facts: { workplace: Workplace; geoClass: GeoClass; locationDiscarded: boolean },
): Promise<{ enqueued: boolean; jobId?: string }> {
  const s = await getSettings();
  const cfg = s.llm.operations.listing_classify;
  if (!cfg?.enabled || !cfg.model) return { enqueued: false };
  const pos = await getPosition(positionId);
  if (!pos || classificationInactive(pos) || !(await currentJdText(pos.id)).trim()) return { enqueued: false };
  const fingerprint = await classificationFingerprint(pos, cfg.model);
  const cache = pos.metadata?.listingClassify as { inputHash?: string; result?: Record<string, unknown> } | undefined;
  if (cache?.inputHash === fingerprint && cache.result) {
    const parsed = ListingClassifyOutput.safeParse(cache.result);
    if (parsed.success) {
      const db = await getDb();
      const rev = (await db.select().from(jdRevisions).where(eq(jdRevisions.positionId, pos.id)).orderBy(desc(jdRevisions.revision)).limit(1))[0];
      const result = mergeListingClassify({ ...facts, locationRaw: rev?.locationRaw || "" }, parsed.data);
      // afterAtsFetch recomputes deterministic facts: restore the same-input model result.
      await db.update(positions).set({ workplace: result.workplace, geoClass: result.geoClass,
        remoteClass: remoteClass(rev?.locationRaw || "", result.workplace === "remote" ? "remote" : ""),
        geoNotes: parsed.data.geoNote || pos.geoNotes }).where(eq(positions.id, pos.id));
      return { enqueued: false };
    }
  }
  if (!listingClassifyNeeded(facts)) return { enqueued: false };
  const q = await enqueueJob("listing_classify", { positionId }, { dedupeKey: `listing_classify:${positionId}`, priority: 90 });
  return { enqueued: !q.deduped, jobId: q.id };
}

export async function runListingClassify(positionId: string) {
  const pos = await getPosition(positionId);
  if (!pos) throw new Error("position not found");
  if (classificationInactive(pos)) return { skipped: true, reason: "inactive" };
  const jdText = await currentJdText(pos.id);
  if (!jdText.trim()) return { skipped: true, reason: "missing_jd" };
  const settings = await getSettings();
  const inputHash = await classificationFingerprint(pos, settings.llm.operations.listing_classify.model);
  if ((pos.metadata?.listingClassify as { inputHash?: string } | undefined)?.inputHash === inputHash) return { skipped: true, reason: "unchanged_input" };
  const db = await getDb();
  const rev = (
    await db
      .select({ locationRaw: jdRevisions.locationRaw })
      .from(jdRevisions)
      .where(eq(jdRevisions.positionId, pos.id))
      .orderBy(desc(jdRevisions.revision))
      .limit(1)
  )[0];
  const ats = ((pos.metadata || {}) as { ats?: { workplaceType?: string | null; isRemote?: boolean | null } }).ats;
  const det = classifyListing({
    locationRaw: rev?.locationRaw || "",
    workplaceType: ats?.workplaceType,
    isRemote: ats?.isRemote,
    company: pos.company.name,
    title: pos.title,
  });
  const cfg = await gateOperation("listing_classify");
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "Classify workplace (remote|hybrid|onsite|unknown) and geoClass (brazil_friendly|worldwideish|hard_geo|ambiguous_remote|unknown). Use hard_geo only for US-only, EMEA-only, must-reside, or onsite-city restrictions with evidence from the JD. A remote posting that lists three or more countries without only/must-reside/must-be-located is a timezone or entity list, not hard_geo; Portugal in that list is allow, not a block. Never invent a restriction. Never weaken an existing hard_geo.",
    },
    {
      role: "user",
      content: JSON.stringify({
        title: pos.title,
        company: pos.company.name,
        locationRaw: rev?.locationRaw || "",
        workplaceType: ats?.workplaceType ?? null,
        deterministic: det,
        jd: jdText.slice(0, 8000),
      }),
    },
  ];
  try {
    const res = await logged(
      "listing_classify",
      cfg.model,
      pos.id,
      () =>
        getLlmClient().chatJson({
          model: cfg.model,
          fallbackModel: cfg.fallbackModel,
          messages,
          schema: ListingClassifyOutput,
          schemaName: "listing_classify",
          temperature: cfg.temperature ?? 0,
          maxTokens: 800,
        }),
      messages,
    );
    const merged = mergeListingClassify(
      { ...det, locationRaw: det.locationClean || rev?.locationRaw || "" },
      res.data,
    );
    const workplaceBlob = merged.workplace === "remote" ? "remote" : ats?.workplaceType || "";
    const rc = remoteClass(det.locationClean, workplaceBlob);
    await db
      .update(positions)
      .set({
        workplace: merged.workplace,
        geoClass: merged.geoClass,
        remoteClass: rc,
        geoNotes: res.data.geoNote || pos.geoNotes,
        metadata: {
          ...(pos.metadata || {}),
          listingClassify: {
            inputHash,
            result: { workplace: merged.workplace, geoClass: merged.geoClass, geoNote: res.data.geoNote },
            at: new Date().toISOString(),
            model: res.model,
            evidence: res.data.evidence ?? null,
            geoNote: res.data.geoNote ?? null,
          },
        },
        updatedAt: new Date(),
      })
      .where(eq(positions.id, pos.id));
    return {
      workplace: merged.workplace,
      geoClass: merged.geoClass,
      model: res.model,
      tightened: merged.geoClass !== det.geoClass,
    };
  } catch (e) {
    if (e instanceof LlmGateError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (/timeout|429|5\d\d|ECONN|fetch failed/i.test(msg)) throw e;
    return { kept: true, error: msg, workplace: det.workplace, geoClass: det.geoClass };
  }
}

export async function backfillListingFacts(opts: { force?: boolean } = {}) {
  // v3: a named country or city is hard_geo. v2 left Spain, Ireland, Seattle, and San Francisco as unknown.
  const BACKFILL_VERSION = "3";
  const s = await getSettings({ fresh: true });
  if (!opts.force && s.listingFactsBackfillVersion === BACKFILL_VERSION) {
    return { skipped: true as const, archivedSkipped: 0, updated: 0, enqueued: 0 };
  }
  const db = await getDb();
  const rows = await db
    .select({
      id: positions.id,
      status: positions.status,
      listingStatus: positions.listingStatus,
      metadata: positions.metadata,
      title: positions.title,
      companyName: companies.name,
    })
    .from(positions)
    .innerJoin(companies, eq(positions.companyId, companies.id))
    .where(ne(positions.listingStatus, "closed"));
  let archivedSkipped = 0;
  let updated = 0;
  let enqueued = 0;
  for (const row of rows) {
    if (row.status === "archived") {
      archivedSkipped++;
      continue;
    }
    const rev = (
      await db
        .select({ locationRaw: jdRevisions.locationRaw })
        .from(jdRevisions)
        .where(eq(jdRevisions.positionId, row.id))
        .orderBy(desc(jdRevisions.revision))
        .limit(1)
    )[0];
    const ats = ((row.metadata || {}) as { ats?: { workplaceType?: string | null; isRemote?: boolean | null } }).ats;
    const facts = classifyListing({
      locationRaw: rev?.locationRaw || "",
      workplaceType: ats?.workplaceType,
      isRemote: ats?.isRemote,
      company: row.companyName,
      title: row.title,
    });
    await db
      .update(positions)
      .set({
        workplace: facts.workplace,
        geoClass: facts.geoClass,
        remoteClass: facts.remoteClass,
        updatedAt: new Date(),
      })
      .where(and(eq(positions.id, row.id), sql`${positions.status} <> 'archived'`));
    await db.update(discoveryFeed).set({ geoClass: facts.geoClass }).where(eq(discoveryFeed.positionId, row.id));
    updated++;
    const q = await maybeEnqueueListingClassify(row.id, facts);
    if (q.enqueued) enqueued++;
  }
  await updateSettings({ listingFactsBackfillAt: new Date().toISOString(), listingFactsBackfillVersion: BACKFILL_VERSION });
  return { skipped: false as const, archivedSkipped, updated, enqueued };
}
