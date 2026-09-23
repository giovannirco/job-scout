import { describe, expect, it } from "vitest";
import { discoveryQueuedMessage } from "./discovery-toast.js";

describe("discovery queued message", () => {
  it("explains a click when every board was scanned recently", () => {
    expect(discoveryQueuedMessage({ enqueued: 0 })).toBe("No boards are due. Discovery already ran recently.");
  });

  it("counts the boards that were actually queued", () => {
    expect(discoveryQueuedMessage({ enqueued: 1 })).toBe("Discovery queued for 1 board");
    expect(discoveryQueuedMessage({ enqueued: 4 })).toBe("Discovery queued for 4 boards");
  });
});
