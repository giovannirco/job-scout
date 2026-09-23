import { describe, expect, it } from "vitest";
import { todayTitle, unscoredStage } from "./today-title.js";

describe("today title", () => {
  it("names the filings when nothing is scored", () => {
    expect(todayTitle({ needs: 0, untriaged: 109, llmConfigured: false })).toBe("109 filings, none scored");
    expect(todayTitle({ needs: 0, untriaged: 1, llmConfigured: false })).toBe("1 filing, none scored");
  });

  it("keeps the decision count when a model has work waiting", () => {
    expect(todayTitle({ needs: 2, untriaged: 10, llmConfigured: true })).toBe("2 things need you");
    expect(todayTitle({ needs: 1, untriaged: 0, llmConfigured: false })).toBe("1 thing needs you");
  });

  it("stays quiet when there is nothing filed and nothing to decide", () => {
    expect(todayTitle({ needs: 0, untriaged: 0, llmConfigured: false })).toBe("Nothing needs you right now");
    expect(todayTitle({ needs: 0, untriaged: 4, llmConfigured: true })).toBe("Nothing needs you right now");
  });

  it("treats a stage with no verdicts as one unscored pile", () => {
    expect(unscoredStage(132, 132)).toBe(true);
    expect(unscoredStage(40, 12)).toBe(false);
    expect(unscoredStage(0, 0)).toBe(false);
  });
});
