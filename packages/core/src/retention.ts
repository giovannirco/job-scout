import { sql } from "drizzle-orm";
import { getDb } from "@job-scout/db";
import { getSettings } from "./settings.js";
import { log as rootLog } from "@job-scout/shared";
import { retentionDeleted } from "./metrics.js";
const log = rootLog.child({ scope: "retention" });

function count(r: unknown): number | null {
  const x = r as { rowCount?: number; affectedRows?: number };
  return typeof x?.rowCount === "number" ? x.rowCount : typeof x?.affectedRows === "number" ? x.affectedRows : null;
}

/** Prune diagnostic and queue records according to Settings > retention. */
export async function runRetention() {
  const db = await getDb();
  const r = (await getSettings()).retention;
  const out = {
    jobs: count(
      await db.execute(
        sql`delete from jobs where status in ('succeeded','failed','cancelled') and created_at < now() - (${String(r.jobsDays)} || ' days')::interval`,
      ),
    ),
    snapshots: count(
      await db.execute(sql`
        delete from board_snapshots s using (
          select id, row_number() over (partition by board_source_id order by observed_at desc) rn from board_snapshots
        ) x where s.id = x.id and x.rn > ${r.snapshotsKeep}`),
    ),
    discovery: count(
      await db.execute(
        sql`delete from discovery_feed where position_id is null and observed_at < now() - (${String(r.discoveryDays)} || ' days')::interval`,
      ),
    ),
    deltas: count(
      await db.execute(sql`delete from board_deltas where observed_at < now() - (${String(r.deltasDays)} || ' days')::interval`),
    ),
    llmRuns: count(
      await db.execute(sql`delete from llm_runs where created_at < now() - (${String(r.llmRunsDays)} || ' days')::interval`),
    ),
    // Drop the bodies first: usage stats only need the metadata row, and transcripts dominate the table size.
    llmTranscripts: count(
      await db.execute(sql`update llm_runs set prompt = null, response = null
        where (prompt is not null or response is not null)
          and created_at < now() - (${String(r.llmTranscriptDays)} || ' days')::interval`),
    ),
  };
  for (const [table, n] of Object.entries(out)) if (n) retentionDeleted.labels({ table }).inc(n);
  log.info("retention.done", { ...out });
  return out;
}
