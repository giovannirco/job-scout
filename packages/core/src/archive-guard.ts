import { and, desc, eq, like } from "drizzle-orm";
import { getDb, timelineEvents } from "@job-scout/db";
import { AUTOMATED_ACTOR } from "@job-scout/shared";

/**
 * The newest restore out of `archived` made by a person or an operator agent
 * (any actor that is not the app itself). Autopilot must never re-archive such
 * a position; only a person may archive it again.
 */
export async function humanRestore(positionId: string): Promise<{ actor: string; at: Date } | null> {
  const db = await getDb();
  const rows = await db
    .select({ actor: timelineEvents.actor, at: timelineEvents.createdAt })
    .from(timelineEvents)
    .where(and(eq(timelineEvents.positionId, positionId), eq(timelineEvents.kind, "status"), like(timelineEvents.title, "archived → %")))
    .orderBy(desc(timelineEvents.createdAt));
  const row = rows.find((r) => !AUTOMATED_ACTOR.test(r.actor || "system"));
  return row ? { actor: row.actor || "operator", at: row.at } : null;
}
