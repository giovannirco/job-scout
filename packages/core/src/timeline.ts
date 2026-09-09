import { desc, eq } from "drizzle-orm";
import { getDb, id, timelineEvents } from "@job-scout/db";

export async function addEvent(input: {
  positionId?: string | null;
  kind: string;
  title: string;
  body?: string | null;
  actor?: string;
  metadata?: Record<string, unknown>;
}) {
  const db = await getDb();
  const eid = id("tl");
  await db.insert(timelineEvents).values({
    id: eid,
    positionId: input.positionId ?? null,
    kind: input.kind,
    title: input.title.slice(0, 300),
    body: input.body ?? null,
    actor: input.actor ?? "system",
    metadata: input.metadata ?? {},
  });
  return eid;
}

export async function listEvents(positionId: string, limit = 100) {
  const db = await getDb();
  return db
    .select()
    .from(timelineEvents)
    .where(eq(timelineEvents.positionId, positionId))
    .orderBy(desc(timelineEvents.occurredAt))
    .limit(Math.min(500, limit));
}
