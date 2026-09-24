import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { closeDb, getDb, positions } from "@job-scout/db";
import { bootstrap, upsertFromJob } from "@job-scout/core";
import { workQueue } from "./work-queue.js";
import { RESULT_CAP, text } from "./result.js";
const dir = mkdtempSync(join(tmpdir(), "job-scout-mcp-"));

describe("work queue pagination", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL; process.env.PGLITE_DATA_DIR = dir;
    await bootstrap({ seedBoards: false });
    for (let n = 0; n < 23; n++) {
      const { position } = await upsertFromJob({ provider: "greenhouse", boardToken: "synthetic", jobId: String(n),
        company: "Example Engineering", title: `Platform Engineer ${n}`, url: `https://boards.greenhouse.io/synthetic/jobs/${n}`, locationRaw: "Remote", descriptionText: "Synthetic job", listingStatus: "open" });
      await (await getDb()).update(positions).set({ status: "triaged", triageVerdict: "pass", triageScore: 4.5, updatedAt: new Date("2026-01-01T00:00:00Z"),
        triagedAt: new Date(), triageJson: { oneLiner: "Synthetic explanation ".repeat(500), profileHash: "old" } }).where(eq(positions.id, position.id));
    }
  });
  afterAll(async () => { await closeDb(); rmSync(dir, { recursive: true, force: true }); });
  it("returns useful default lanes below the result cap even with large explanations", async () => {
    const result = text(await workQueue());
    expect(result.isError).toBe(false);
    expect(Buffer.byteLength(result.content[0].text)).toBeLessThan(RESULT_CAP);
    const data = JSON.parse(result.content[0].text);
    expect(data.decide).toHaveLength(20);
    expect(data.decide[0]).toMatchObject({ triageStale: true, summaryShortened: true });
    expect(data.pagination.decide).toMatchObject({ total: 23, nextPage: 2 });
    expect(data.applied).toEqual([]);
  });
  it("reads the remaining lane without repeats or unrelated lanes", async () => {
    const first = await workQueue({ lane: "decide" });
    const second = await workQueue({ lane: "decide", page: 2 });
    const a = JSON.parse(text(first).content[0].text), b = JSON.parse(text(second).content[0].text);
    expect(b.decide).toHaveLength(3);
    expect(b.pagination.decide.nextPage).toBeNull();
    expect(b.applied).toBeUndefined();
    expect(new Set([...a.decide, ...b.decide].map(p => p.id)).size).toBe(23);
  });
});
