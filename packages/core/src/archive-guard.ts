import { and, desc, eq } from "drizzle-orm";
import { getDb, timelineEvents } from "@job-scout/db";
import { isAutomatedActor } from "@job-scout/shared";

const DROPPED = new Set(["archived", "skip"]);

/**
 * Classify a status timeline title. Writers use two shapes:
 * `${from} → ${to}` (patchPosition, autopilot, evaluate, triage, repair) and
 * `archived: ${reason}` (archivePosition).
 */
export function statusTransition(title: string | null | undefined): "restore" | "drop" | "other" {
  const t = String(title || "").trim();
  if (/^archived:/i.test(t)) return "drop";
  const m = /^(\S+)\s*→\s*(\S+)/.exec(t);
  if (!m) return "other";
  const [, from, to] = m;
  if (DROPPED.has(to!)) return "drop";
  if (DROPPED.has(from!)) return "restore";
  return "other";
}

/**
 * The restore out of `archived` or `skip` that is still in force, made by a
 * person or an operator agent (see isAutomatedActor). Automated status events
 * are ignored. Among human status events the newest restore-or-drop decides:
 * a later human archive or skip cancels an earlier restore, so automation may
 * archive again; other human moves (triaged → review) leave it in force.
 */
export async function humanRestore(positionId: string): Promise<{ actor: string; at: Date } | null> {
  const db = await getDb();
  const rows = await db
    .select({ actor: timelineEvents.actor, at: timelineEvents.createdAt, title: timelineEvents.title })
    .from(timelineEvents)
    .where(and(eq(timelineEvents.positionId, positionId), eq(timelineEvents.kind, "status")))
    .orderBy(desc(timelineEvents.createdAt));
  for (const r of rows) {
    if (isAutomatedActor(r.actor)) continue;
    const t = statusTransition(r.title);
    if (t === "drop") return null;
    if (t === "restore") return { actor: r.actor || "operator", at: r.at };
  }
  return null;
}
