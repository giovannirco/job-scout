import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { boardSources, closeDb, getDb, id } from "@job-scout/db";
import { bootstrap } from "./bootstrap.js";
import { BOARD_MIGRATIONS, boardErrorKind, reconcileBoardSources, UNSUPPORTED_BOARDS } from "./board-reconcile.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-boards-"));
const row = (provider: string, token: string, company: string, over: Record<string, unknown> = {}) =>
  ({ id: id("bs"), company, provider, token, enabled: true, capability: "list_api", sourceKind: "ats", lastError: "404", ...over });

describe("board reconciliation", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DATA_DIR = dir;
    await bootstrap({ seedBoards: false });
  });
  afterAll(async () => { await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("moves a migrated board in place, keeping its id and history", async () => {
    const db = await getDb();
    const before = row("greenhouse", "wellhub", "Wellhub");
    await db.insert(boardSources).values(before);

    const dry = await reconcileBoardSources();
    expect(dry.dryRun).toBe(true);
    expect(dry.migrated.join()).toContain("greenhouse/wellhub -> greenhouse/gympass");
    // a dry run writes nothing
    expect((await db.select().from(boardSources).where(eq(boardSources.id, before.id)))[0]!.token).toBe("wellhub");

    await reconcileBoardSources({ dryRun: false });
    const after = (await db.select().from(boardSources).where(eq(boardSources.id, before.id)))[0]!;
    expect(after.id).toBe(before.id);           // history and linked rows survive
    expect(after.token).toBe("gympass");
    expect(after.enabled).toBe(true);
    expect(after.lastError).toBeNull();
    expect((after.metadata as Record<string, unknown>).previousBoard).toEqual({ provider: "greenhouse", token: "wellhub" });
  });

  it("is idempotent", async () => {
    const second = await reconcileBoardSources({ dryRun: false });
    expect(second.migrated.some((m) => m.includes("greenhouse/wellhub"))).toBe(false);
  });

  it("demotes an unsupported board instead of leaving a 404ing list_api source", async () => {
    const db = await getDb();
    const netflix = row("lever", "netflix", "Netflix");
    await db.insert(boardSources).values(netflix);
    await reconcileBoardSources({ dryRun: false });
    const after = (await db.select().from(boardSources).where(eq(boardSources.id, netflix.id)))[0]!;
    expect(after.capability).toBe("manual_watch");
    expect(after.enabled).toBe(false);
    expect(after.notes).toContain("Eightfold");
  });

  it("never collides with an existing destination row", async () => {
    const db = await getDb();
    await db.insert(boardSources).values(row("ashby", "temporal", "Temporal", { lastError: null }));
    const stale = row("greenhouse", "temporaltechnologies", "Temporal");
    await db.insert(boardSources).values(stale);
    const r = await reconcileBoardSources({ dryRun: false });
    expect(r.conflicts.join()).toContain("ashby/temporal already exists");
    const after = (await db.select().from(boardSources).where(eq(boardSources.id, stale.id)))[0]!;
    expect(after.enabled).toBe(false);                     // stale row stops being scanned
    expect(after.capability).toBe("manual_watch");
    expect((await db.select().from(boardSources).where(and(eq(boardSources.provider, "ashby"), eq(boardSources.token, "temporal")))).length).toBe(1);
  });

  it("separates a transient abort from a board that is actually gone", () => {
    expect(boardErrorKind("HTTP 404 Not Found")).toBe("missing");
    expect(boardErrorKind("aborted")).toBe("transient");
    expect(boardErrorKind("ETIMEDOUT")).toBe("transient");
    expect(boardErrorKind("HTTP 503")).toBe("transient");
    expect(boardErrorKind(null)).toBe("none");
  });

  it("every migration and demotion is a distinct, verified entry", () => {
    const keys = BOARD_MIGRATIONS.map((m) => `${m.from.provider}/${m.from.token}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const m of BOARD_MIGRATIONS) {
      expect(m.verified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(m.jobsAtVerification).toBeGreaterThan(0);      // proven by a live read, not a guess
    }
    for (const u of UNSUPPORTED_BOARDS) expect(u.reason).toMatch(/Verified \d{4}-\d{2}-\d{2}/);
  });
});
