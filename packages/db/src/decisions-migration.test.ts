import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

it("upgrades the previous schema without recreating existing tables or changing settings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "job-scout-migration-"));
  const source = fileURLToPath(new URL("../migrations/", import.meta.url));
  const journal = JSON.parse(readFileSync(join(source, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const cut = journal.entries.findIndex(e => e.tag.endsWith("jev_decisions"));
  expect(cut).toBeGreaterThan(0);
  mkdirSync(join(dir, "meta"));
  for (const entry of journal.entries.slice(0, cut)) copyFileSync(join(source, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, cut) }));
  const client = new PGlite(); const db = drizzle(client);
  try {
    await migrate(db, { migrationsFolder: dir });
    await client.query("insert into settings (id, data) values ('default', '{\"triage\":{\"passThreshold\":4.2}}')");
    await migrate(db, { migrationsFolder: source });
    expect((await client.query<{ data: unknown }>("select data from settings where id='default'")).rows[0].data).toEqual({ triage: { passThreshold: 4.2 } });
    expect((await client.query("select * from decision_runs")).rows).toEqual([]);
    expect((await client.query("select column_name from information_schema.columns where table_name='interviews' and column_name='transcript_markdown'")).rows).toHaveLength(1);
    await migrate(db, { migrationsFolder: source });
    expect((await client.query("select * from decision_runs")).rows).toEqual([]);
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});
