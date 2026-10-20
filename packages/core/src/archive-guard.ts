import { and, desc, eq, like, or } from "drizzle-orm";
import { getDb, timelineEvents } from "@job-scout/db";
import { AUTOMATED_ACTOR } from "@job-scout/shared";

/**
 * The newest restore out of `archived` or `skip` made by a person or an
 * operator agent (any actor that is not the app itself or the career-ops
 * sync). Autopilot and the career-ops sync must never re-archive or re-skip
 * such a position; only a person may do that again.
 */
export async function humanRestore(positionId: string): Promise<{ actor: string; at: Date } | null> {
  const db = await getDb();
  const rows = await db
    .select({ actor: timelineEvents.actor, at: timelineEvents.createdAt })
    .from(timelineEvents)
    .where(and(eq(timelineEvents.positionId, positionId), eq(timelineEvents.kind, "status"), or(like(timelineEvents.title, "archived → %"), like(timelineEvents.title, "skip → %"))))
    .orderBy(desc(timelineEvents.createdAt));
  const row = rows.find((r) => !AUTOMATED_ACTOR.test(r.actor || "system"));
  return row ? { actor: row.actor || "operator", at: row.at } : null;
}
