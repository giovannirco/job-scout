import { and, eq, gte, inArray } from "drizzle-orm";
import { getDb, positions, timelineEvents } from "@job-scout/db";
import { careerOpsStatusVerdict, isCareerOpsActor } from "@job-scout/shared";
import { addEvent } from "./timeline.js";

export type ReversalEvent = { id: string; positionId: string; kind: string; title: string; actor: string | null; createdAt: string | Date };
export type ReversalPosition = { id: string; status: string; listingStatus: string | null; archiveReason?: string | null };

const at = (v: string | Date) => (v instanceof Date ? v : new Date(v));
/** "a → b" status event, or "archived: reason" (a move into archived from an unknown stage). */
function parseMove(title: string): { from: string; to: string } | null {
  const m = /^(\w+) → (\w+)$/.exec(title.trim());
  return m ? { from: m[1]!, to: m[2]! } : null;
}

/**
 * Status writes from the career-ops sync that moved a role backwards (out of a
 * terminal status, to an earlier stage, or a pre-apply label onto an archived
 * or closed role), and the status to put back. Pure: plans from timeline events
 * and current positions, so it can run on an MCP export without a database.
 *
 * A write counts as sync-originated when its actor is a career-ops actor or one
 * of `actors` (the agent tokens the local sync runs under).
 */
export function planCareerOpsReversals(input: { positions: ReversalPosition[]; events: ReversalEvent[]; since: Date; actors?: string[] }) {
  const extra = new Set((input.actors || []).map((a) => a.toLowerCase()));
  const byPos = new Map<string, ReversalEvent[]>();
  for (const e of input.events) if (e.kind === "status") byPos.set(e.positionId, [...(byPos.get(e.positionId) || []), e]);
  const plans: Array<{ positionId: string; eventId: string; at: string; actor: string | null; move: string; why: string; currentStatus: string; revertTo: string | null; archiveReason: string | null; action: "revert" | "already_moved" }> = [];
  for (const pos of input.positions) {
    const evs = (byPos.get(pos.id) || []).sort((a, b) => at(a.createdAt).getTime() - at(b.createdAt).getTime());
    for (const [i, e] of evs.entries()) {
      if (at(e.createdAt) < input.since) continue;
      const actor = (e.actor || "").trim();
      if (!isCareerOpsActor(actor) && !extra.has(actor.toLowerCase())) continue;
      const move = parseMove(e.title);
      if (!move) continue;
      const v = careerOpsStatusVerdict(move.from, move.to, { listingClosed: pos.listingStatus === "closed" });
      if (v.apply) continue;
      // Any later status change (a person, or a later sync) means the backwards write is no longer the state.
      const later = evs.slice(i + 1).some((x) => at(x.createdAt) > at(e.createdAt));
      const lastArchive = move.from === "archived" ? [...evs.slice(0, i)].reverse().find((x) => x.title.startsWith("archived: ")) : undefined;
      plans.push({
        positionId: pos.id, eventId: e.id, at: at(e.createdAt).toISOString(), actor: e.actor, move: e.title, why: v.why,
        currentStatus: pos.status,
        revertTo: later || pos.status !== move.to ? null : move.from,
        archiveReason: move.from === "archived" ? (lastArchive?.title.slice("archived: ".length) || pos.archiveReason || (pos.listingStatus === "closed" ? "listing_closed" : "restored by career-ops reversal repair")) : null,
        action: later || pos.status !== move.to ? "already_moved" : "revert",
      });
    }
  }
  return plans;
}

/** Dry-run by default; with apply, puts each still-reversed role back to its prior status. */
export async function repairCareerOpsReversals(opts: { days?: number; actors?: string[]; apply?: boolean } = {}) {
  const db = await getDb();
  const since = new Date(Date.now() - (opts.days ?? 7) * 86_400_000);
  const cols = { id: timelineEvents.id, positionId: timelineEvents.positionId, kind: timelineEvents.kind, title: timelineEvents.title, actor: timelineEvents.actor, createdAt: timelineEvents.createdAt };
  const recent = await db.select({ positionId: timelineEvents.positionId }).from(timelineEvents).where(and(eq(timelineEvents.kind, "status"), gte(timelineEvents.createdAt, since)));
  const ids = [...new Set(recent.map((e) => e.positionId).filter((x): x is string => Boolean(x)))];
  const events = ids.length ? await db.select(cols).from(timelineEvents).where(and(eq(timelineEvents.kind, "status"), inArray(timelineEvents.positionId, ids))) : [];
  const rows = ids.length ? await db.select({ id: positions.id, status: positions.status, listingStatus: positions.listingStatus, archiveReason: positions.archiveReason }).from(positions).where(inArray(positions.id, ids)) : [];
  const plans = planCareerOpsReversals({ positions: rows, events: events as ReversalEvent[], since, actors: opts.actors });
  if (!opts.apply) return { dryRun: true as const, since: since.toISOString(), plans };
  for (const p of plans.filter((x) => x.action === "revert" && x.revertTo)) {
    const to = p.revertTo!;
    await db.update(positions).set({ status: to as never, updatedAt: new Date(), ...(to === "archived" ? { archiveReason: (p.archiveReason || "").slice(0, 300), watchEnabled: false } : { archiveReason: null }) })
      .where(and(eq(positions.id, p.positionId), eq(positions.status, p.currentStatus as never)));
    await addEvent({ positionId: p.positionId, kind: "status", title: `${p.currentStatus} → ${to}`, body: `repair: undo career-ops sync write "${p.move}" (${p.at})`, actor: "repair" });
  }
  return { dryRun: false as const, since: since.toISOString(), plans };
}
