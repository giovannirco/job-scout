import { and, eq, gte, like, or } from "drizzle-orm";
import { getDb, positions } from "@job-scout/db";
import { triageArchiveDecision, type HardDisqualifierKind } from "@job-scout/shared";
import { getProfile } from "./profile.js";
import { addEvent } from "./timeline.js";

export type TriageArchiveRow = {
  id: string;
  slug: string;
  title: string;
  archiveReason: string | null;
  triageScore: number | null;
  triageVerdict: string | null;
  triagedAt: string | null;
  listingStatus: string | null;
  hardKind: HardDisqualifierKind | null;
  action: "restore" | "keep_archived" | "skip_closed";
};

/**
 * Find triage auto-archives ("triage fail …" / "triage marginal …") from the
 * last `days` whose reason is not a hard disqualifier, and (with `apply`)
 * restore them to `triaged` with their score kept. Dry-run by default.
 */
export async function repairTriageArchives(opts: { days?: number; apply?: boolean; now?: Date } = {}) {
  const db = await getDb();
  const days = opts.days ?? 30;
  const since = new Date((opts.now ?? new Date()).getTime() - days * 86_400_000);
  const profile = await getProfile();
  const rows = await db
    .select({
      id: positions.id, slug: positions.slug, title: positions.title, archiveReason: positions.archiveReason,
      triageScore: positions.triageScore, triageVerdict: positions.triageVerdict, triagedAt: positions.triagedAt,
      triageJson: positions.triageJson, salaryRaw: positions.salaryRaw, listingStatus: positions.listingStatus,
    })
    .from(positions)
    .where(and(
      eq(positions.status, "archived"),
      or(like(positions.archiveReason, "triage fail%"), like(positions.archiveReason, "triage marginal%")),
      gte(positions.triagedAt, since),
    ));

  const out: TriageArchiveRow[] = rows.map((r) => {
    const hardDq = Array.isArray((r.triageJson as { hardDq?: unknown } | null)?.hardDq) ? ((r.triageJson as { hardDq: string[] }).hardDq) : [];
    const fromReason = (r.archiveReason || "").replace(/^triage (fail|marginal) [\d.]+:?\s*/, "");
    const decision = triageArchiveDecision({ hardDq: hardDq.length ? hardDq : [fromReason], salaryRaw: r.salaryRaw, payFloorUsd: profile.cashFloorUsd });
    const hardKind = decision.archive ? decision.kind : null;
    const action: TriageArchiveRow["action"] = hardKind ? "keep_archived" : r.listingStatus === "closed" ? "skip_closed" : "restore";
    return {
      id: r.id, slug: r.slug, title: r.title, archiveReason: r.archiveReason, triageScore: r.triageScore, triageVerdict: r.triageVerdict,
      triagedAt: r.triagedAt?.toISOString() ?? null, listingStatus: r.listingStatus, hardKind, action,
    };
  });

  const restore = out.filter((r) => r.action === "restore");
  if (opts.apply) {
    for (const r of restore) {
      await db.update(positions).set({ status: "triaged", archiveReason: null, updatedAt: new Date() }).where(and(eq(positions.id, r.id), eq(positions.status, "archived")));
      await addEvent({ positionId: r.id, kind: "status", title: "archived → triaged", body: `Archive policy repair: "${r.archiveReason}" is not a hard disqualifier; score kept.`, actor: "repair" });
    }
  }
  return {
    dryRun: !opts.apply,
    since: since.toISOString(),
    total: out.length,
    restore: restore.length,
    keepArchived: out.filter((r) => r.action === "keep_archived").length,
    skippedClosed: out.filter((r) => r.action === "skip_closed").length,
    rows: out,
  };
}
