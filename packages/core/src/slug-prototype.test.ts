import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { closeDb, companies, getDb, positions, timelineEvents } from "@job-scout/db";
import { bootstrap } from "./bootstrap.js";
import { getCompany, resolveCompanyForName } from "./companies.js";
import { getPosition, upsertFromJob } from "./positions.js";
import { repairPrototypeSlugs } from "./slug-repair.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-slug-"));

describe("prototype-key company names (PGlite)", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DATA_DIR = dir;
    await bootstrap({ seedBoards: false });
  });
  afterAll(async () => { await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it.each(["Constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])("company %s gets a sane slug", async (name) => {
    const c = await resolveCompanyForName(name);
    expect(c.slug).not.toMatch(/native|function|[{}()]/);
    const jobId = String(name.length);
    const { position } = await upsertFromJob({
      provider: "greenhouse", boardToken: c.slug, company: name, jobId, externalIdentity: `greenhouse:${c.slug}:${jobId}`,
      title: "Platform Engineer", url: `https://job-boards.greenhouse.io/${c.slug}/jobs/${jobId}`, descriptionText: "Kubernetes platform work.", listingStatus: "open",
    }, { companyName: name });
    expect(position.slug).not.toMatch(/native|function/);
  });

  it("repair reslugs bad rows (dry-run first) and keeps old slugs resolvable", async () => {
    const db = await getDb();
    const c = await resolveCompanyForName("Constructor");
    const p = (await db.select().from(positions).where(eq(positions.companyId, c.id)).limit(1))[0]!;
    const badCompany = "function Object() { [native code] }";
    const badPos = `function-object-native-code-platform-engineer-${p.id.slice(-4)}`;
    await db.update(companies).set({ slug: badCompany }).where(eq(companies.id, c.id));
    const jobId = p.externalIdentity!.split(":").pop()!;
    await db.update(positions).set({ slug: badPos, externalIdentity: `greenhouse:${badCompany}:${jobId}` }).where(eq(positions.id, p.id));

    const dry = await repairPrototypeSlugs();
    expect(dry.dryRun).toBe(true);
    expect(dry.companies).toEqual([{ id: c.id, name: c.name, from: badCompany, to: "constructor" }]);
    expect(dry.positions.map(x => x.id)).toEqual([p.id]);
    expect(dry.identities).toEqual([expect.objectContaining({ id: p.id, from: `greenhouse:${badCompany}:${jobId}`, to: `greenhouse:constructor:${jobId}` })]);
    expect((await getPosition(p.id))!.slug).toBe(badPos);

    await repairPrototypeSlugs({ apply: true });
    const after = (await getPosition(p.id))!;
    expect(after.company.slug).toBe("constructor");
    expect(after.slug).toMatch(/^constructor-platform-engineer-/);
    expect(after.externalIdentity).toBe(`greenhouse:constructor:${jobId}`);
    expect((await getPosition(badPos))?.id).toBe(p.id);
    expect((await getCompany(badCompany))?.id).toBe(c.id);
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.positionId, p.id));
    expect(events.some(e => e.kind === "repair" && e.actor === "repair:prototype-slugs")).toBe(true);

    const again = await repairPrototypeSlugs();
    expect(again.companies).toEqual([]);
    expect(again.positions).toEqual([]);
    expect(again.identities).toEqual([]);
  });

  it("re-running fixes identities left behind on an already-reslugged company", async () => {
    const db = await getDb();
    const c = await resolveCompanyForName("Constructor");
    expect(c.slug).toBe("constructor");
    const p = (await db.select().from(positions).where(eq(positions.companyId, c.id)).limit(1))[0]!;
    const uuid = "00000000-0000-4000-8000-000000000001";
    const leftover = `ashby:function Object() { [native code] }:${uuid}`;
    await db.update(positions).set({ externalIdentity: leftover, atsBoardToken: "function Object() { [native code] }" }).where(eq(positions.id, p.id));

    const dry = await repairPrototypeSlugs();
    expect(dry.companies).toEqual([]);
    expect(dry.positions).toEqual([]);
    expect(dry.identities).toEqual([{ id: p.id, name: p.title, from: leftover, to: `ashby:constructor:${uuid}`, boardToken: "constructor" }]);
    expect((await db.select().from(positions).where(eq(positions.id, p.id)))[0]!.externalIdentity).toBe(leftover);

    await repairPrototypeSlugs({ apply: true });
    const row = (await db.select().from(positions).where(eq(positions.id, p.id)))[0]!;
    expect(row.externalIdentity).toBe(`ashby:constructor:${uuid}`);
    expect(row.atsBoardToken).toBe("constructor");
    expect((await repairPrototypeSlugs()).identities).toEqual([]);
  });
});
