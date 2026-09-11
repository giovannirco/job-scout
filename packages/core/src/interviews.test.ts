import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { AtsJob } from "@job-scout/ats";

const dataDir = path.join(process.cwd(), ".data", "pglite-interviews-test");

function job(over: Partial<AtsJob> = {}): AtsJob {
  return {
    provider: "greenhouse",
    boardToken: "acme",
    jobId: "iv-1",
    externalIdentity: "greenhouse:acme:iv-1",
    title: "Senior Platform Engineer",
    company: "Acme",
    url: "https://boards.greenhouse.io/acme/jobs/iv-1",
    locationRaw: "Remote - LATAM",
    descriptionText: "We run Kubernetes on EKS with Terraform and Argo CD. " + "x".repeat(300),
    listingStatus: "open",
    ...over,
  };
}

describe("interviews corpus", () => {
  let positionId: string;

  beforeAll(async () => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.env.PGLITE_DATA_DIR = dataDir;
    delete process.env.DATABASE_URL;
    const { bootstrap } = await import("./bootstrap.js");
    await bootstrap({ seedBoards: false });
    const { upsertFromJob } = await import("./positions.js");
    positionId = (await upsertFromJob(job(), { source: "test" })).position.id;
  });

  afterAll(async () => {
    const { closeDb } = await import("@job-scout/db");
    await closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("stores transcript, process fields, and does not queue a brief without transcript", async () => {
    const { addInterview, listInterviews } = await import("./interviews.js");
    const row = await addInterview(positionId, {
      stage: "screen",
      title: "TA screen — Ryan",
      interviewerName: "Ryan Zubal",
      interviewerRole: "Talent Sourcing Manager",
      occurredAt: "2026-09-11T14:00:00.000Z",
      durationSeconds: 1951,
      status: "completed",
      outcome: "advanced",
      notes: "advanced to HM",
      skipBrief: true,
    });
    expect(row.briefJobId).toBeNull();
    expect(row.interviewerName).toBe("Ryan Zubal");
    expect(row.outcome).toBe("advanced");
    expect(row.durationSeconds).toBe(1951);
    const listed = await listInterviews(positionId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.title).toBe("TA screen — Ryan");
    expect(listed[0]?.transcriptChars).toBe(0);
    expect("transcriptMarkdown" in (listed[0] ?? {})).toBe(false);
  });

  it("rejects a bad outcome", async () => {
    const { addInterview } = await import("./interviews.js");
    await expect(addInterview(positionId, { outcome: "won" })).rejects.toThrow(/outcome/);
  });

  it("patches a transcript and queues a brief unless skipped", async () => {
    const { addInterview, patchInterview, getInterview } = await import("./interviews.js");
    const created = await addInterview(positionId, { stage: "hiring_manager", skipBrief: true });
    const patched = await patchInterview(positionId, created.id, {
      transcriptMarkdown: "**Ryan** hello\n**Alex** hi",
      transcriptSource: "whisper",
      reviewMarkdown: "## Verdict\nadvanced",
      sourcePath: "interviews/acme/meetings/interview-1.md",
    });
    expect(patched?.briefJobId).toBeTruthy();
    expect(patched?.transcriptSource).toBe("whisper");
    const got = await getInterview(positionId, created.id);
    expect(got?.sourcePath).toContain("interview-1.md");
    expect(got?.transcriptMarkdown).toContain("Ryan");
    const { listInterviews } = await import("./interviews.js");
    const listed = await listInterviews(positionId);
    const slim = listed.find((r) => r.id === created.id);
    expect(slim?.transcriptChars).toBeGreaterThan(0);
    expect("transcriptMarkdown" in (slim ?? {})).toBe(false);
  });

  it("lists every round on the desk and live processes after a status bump", async () => {
    const { addInterview, listAllInterviews, listProcesses } = await import("./interviews.js");
    const { patchPosition } = await import("./positions.js");
    await addInterview(positionId, {
      stage: "screen",
      title: "desk round",
      interviewerName: "Ada",
      status: "completed",
      occurredAt: "2026-09-01T12:00:00.000Z",
      skipBrief: true,
    });
    const all = await listAllInterviews({ q: "Ada" });
    expect(all.some((r) => r.interviewerName === "Ada" && r.companyName === "Acme")).toBe(true);
    await patchPosition(positionId, { status: "interview" }, "test");
    const processes = await listProcesses();
    const mine = processes.find((p) => p.id === positionId);
    expect(mine?.status).toBe("interview");
    expect(mine?.roundCount).toBeGreaterThanOrEqual(1);
    expect(mine?.company.name).toBe("Acme");
  });
});
