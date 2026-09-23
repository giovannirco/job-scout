import { describe, expect, it } from "vitest";
import { discoveryQueuedMessage, promoteMessage } from "./discovery-toast.js";

describe("discovery queued message", () => {
  it("explains a click when every board was scanned recently", () => {
    expect(discoveryQueuedMessage({ enqueued: 0 })).toBe("No boards are due. Discovery already ran recently.");
  });

  it("does not claim triage ran when no job was queued", () => {
    expect(promoteMessage({ created: true, triageJobId: null })).toBe("Promoted");
    expect(promoteMessage({ created: true, triageJobId: "job_1" })).toBe("Promoted — triage queued");
  });

  it("names a revive and an existing position", () => {
    expect(promoteMessage({ revived: true })).toBe("Revived — back in the pipeline");
    expect(promoteMessage({})).toBe("Already in the pipeline");
  });

  it("counts the boards that were actually queued", () => {
    expect(discoveryQueuedMessage({ enqueued: 1 })).toBe("Discovery queued for 1 board");
    expect(discoveryQueuedMessage({ enqueued: 4 })).toBe("Discovery queued for 4 boards");
  });
});
