import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

it("adds recruiter leads to a 2.13.1 database without touching its rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "job-scout-leads-migration-"));
  const source = fileURLToPath(new URL("../migrations/", import.meta.url));
  const journal = JSON.parse(readFileSync(join(source, "meta/_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] };
  const cut = journal.entries.findIndex((e) => e.tag.endsWith("recruiter_leads"));
  expect(cut).toBeGreaterThan(0);
  // drizzle applies a migration only when its timestamp is newer than the last one applied.
  expect(journal.entries[cut].when).toBeGreaterThan(journal.entries[cut - 1].when);
  mkdirSync(join(dir, "meta"));
  for (const entry of journal.entries.slice(0, cut)) copyFileSync(join(source, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, cut) }));
  const client = new PGlite();
  const db = drizzle(client);
  try {
    await migrate(db, { migrationsFolder: dir });
    // 2.13.1 data: a company, a position, an interview round and an outreach row.
    await client.query("insert into companies (id, slug, name) values ('co_1', 'fictional-co', 'Fictional Co')");
    await client.query("insert into positions (id, company_id, slug, title, primary_url) values ('pos_1', 'co_1', 'fictional-co-sre', 'SRE', 'https://boards.greenhouse.io/fictionalco/jobs/1')");
    await client.query("insert into interviews (id, position_id, stage, scheduled_at) values ('iv_1', 'pos_1', 'screen', now() + interval '1 day')");
    await client.query("insert into outreach_events (id, position_id, channel, note) values ('out_1', 'pos_1', 'email', 'sent a note')");

    await migrate(db, { migrationsFolder: source });

    const iv = (await client.query<{ position_id: string; lead_id: string | null; stage: string }>("select position_id, lead_id, stage from interviews where id='iv_1'")).rows[0];
    expect(iv).toEqual({ position_id: "pos_1", lead_id: null, stage: "screen" });
    const out = (await client.query<{ note: string; lead_id: string | null; direction: string | null; body: string | null }>("select note, lead_id, direction, body from outreach_events where id='out_1'")).rows[0];
    expect(out).toEqual({ note: "sent a note", lead_id: null, direction: null, body: null });
    expect((await client.query("select * from leads")).rows).toEqual([]);

    // A round on a lead with no position is allowed; a round on neither is not.
    await client.query("insert into leads (id, recruiter_name, pitched_role) values ('lead_1', 'Dana Fictional', 'SRE')");
    await client.query("insert into interviews (id, lead_id, stage) values ('iv_2', 'lead_1', 'screen')");
    await expect(client.query("insert into interviews (id, stage) values ('iv_3', 'screen')")).rejects.toThrow(/interviews_position_or_lead_chk/);

    // A 2.13.1-style read (inner join on positions) still sees only position rounds.
    const old = await client.query("select i.id from interviews i inner join positions p on p.id = i.position_id");
    expect(old.rows).toEqual([{ id: "iv_1" }]);

    await migrate(db, { migrationsFolder: source });
    expect((await client.query("select id from leads")).rows).toEqual([{ id: "lead_1" }]);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
