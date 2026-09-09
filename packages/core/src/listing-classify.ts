import { and, desc, eq, ne, sql } from "drizzle-orm";
import { companies, getDb, jdRevisions, positions } from "@job-scout/db";
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

export async function maybeEnqueueListingClassify(
  positionId: string,
  facts: { workplace: Workplace; geoClass: GeoClass; locationDiscarded: boolean },
): Promise<{ enqueued: boolean; jobId?: string }> {
  if (!listingClassifyNeeded(facts)) return { enqueued: false };
  const s = await getSettings();
  const cfg = s.llm.operations.listing_classify;
  if (!cfg?.enabled || !cfg.model) return { enqueued: false };
  const q = await enqueueJob("listing_classify", { positionId }, { dedupeKey: `listing_classify:${positionId}`, priority: 90 });
  return { enqueued: !q.deduped, jobId: q.id };
}

export async function runListingClassify(positionId: string) {
  const pos = await getPosition(positionId);
  if (!pos) throw new Error("position not found");
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
  const jdText = await currentJdText(pos.id);
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
  const BACKFILL_VERSION = "2";
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
    updated++;
    const q = await maybeEnqueueListingClassify(row.id, facts);
    if (q.enqueued) enqueued++;
  }
  await updateSettings({ listingFactsBackfillAt: new Date().toISOString(), listingFactsBackfillVersion: BACKFILL_VERSION });
  return { skipped: false as const, archivedSkipped, updated, enqueued };
}
