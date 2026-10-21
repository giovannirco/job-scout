import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { AtsJob } from "@job-scout/ats";

const dataDir = path.join(process.cwd(), ".data", "pglite-interview-brief-test");

function job(over: Partial<AtsJob> = {}): AtsJob {
  return {
    provider: "greenhouse",
    boardToken: "acme",
    jobId: "brief-1",
    externalIdentity: "greenhouse:acme:brief-1",
    title: "Senior Platform Engineer",
    company: "Acme Example",
    url: "https://jobs.ashbyhq.com/acme-example/brief-1",
    locationRaw: "Remote",
    descriptionText: "Build Kubernetes operators and GitHub Actions. Not an operational support role. " + "x".repeat(200),
    salaryRaw: "$100,000 - $120,000",
    listingStatus: "open",
    ...over,
  };
}

describe("interview_brief", () => {
  let positionId: string;

  beforeAll(async () => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.env.PGLITE_DATA_DIR = dataDir;
    delete process.env.DATABASE_URL;
    const { coreEnv } = await import("./env.js");
    coreEnv.openaiApiKey = "test-only";
    const { bootstrap } = await import("./bootstrap.js");
    await bootstrap({ seedBoards: false });
    const { updateSettings } = await import("./settings.js");
    await updateSettings({
      llm: {
        operations: {
          interview_brief: { model: "test-model", enabled: true, dailyCap: 0 },
          evaluate: { model: "test-model", enabled: true, dailyCap: 0 },
        },
      },
    });
    const { upsertFromJob } = await import("./positions.js");
    positionId = (await upsertFromJob(job(), { source: "test" })).position.id;
  });

  afterAll(async () => {
    const { closeDb } = await import("@job-scout/db");
    await closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("writes an AI brief from transcript + JD", async () => {
    const llm = await import("./llm.js");
    vi.spyOn(llm, "getLlmClient").mockReturnValue({
      chatDocument: async () => ({
        content: "",
        markdown: "## 1. What happened\nThe recruiter moved the candidate forward.\n",
        sections: {},
        data: {
          headline: "Advanced to the hiring manager round after a platform screen.",
          outcomeGuess: "advanced",
          jdFitScore: 3.6,
          jdHits: ["GitHub Actions", "Kubernetes"],
          jdMisses: ["operator-from-scratch"],
          companyFit: "Platform focus matched.",
          strengths: ["honest gaps"],
          misses: ["rushed the pay question"],
          signals: ["sounds like a good fit for the team"],
          compensationNotes: "$110k base + equity",
          nextRoundPrep: ["walk through a past migration"],
          questionsToAsk: ["What does the platform team own?"],
        },
        model: "test-model",
        tokensIn: 10,
        tokensOut: 20,
        latencyMs: 5,
        finishReason: "stop",
        raw: {},
      }),
    } as unknown as ReturnType<typeof llm.getLlmClient>);

    const { addInterview, getInterview } = await import("./interviews.js");
    const round = await addInterview(positionId, {
      stage: "screen",
      interviewerName: "Ada Example",
      transcriptMarkdown: "Ada: sounds like a good fit\nSam: CI moved to GitHub Actions and Argo CD",
      skipBrief: true,
    });
    const { runInterviewBrief } = await import("./interview-brief.js");
    const out = await runInterviewBrief(positionId, round.id);
    expect(out.summary.outcomeGuess).toBe("advanced");
    expect(out.summary.jdFitScore).toBe(3.6);
    const stored = await getInterview(positionId, round.id);
    expect(stored?.aiBriefMarkdown).toContain("What happened");
    expect(stored?.aiBriefModel).toBe("test-model");
    expect((stored?.aiBriefJson as { headline?: string } | null)?.headline).toContain("hiring manager round");
  });
});
