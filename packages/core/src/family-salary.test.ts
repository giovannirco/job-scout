import { describe, expect, it } from "vitest";
import { familySalaryBand, familySalaryBands } from "./position-groups.js";

const row = (salaryMin: number | null, salaryMax: number | null, salaryCurrency: string | null) =>
  ({ salaryMin, salaryMax, salaryCurrency });

describe("family salary band", () => {
  it("spans the countries that posted a band in one currency", () => {
    expect(familySalaryBand([
      row(61100, 96600, "EUR"),
      row(55800, 88300, "EUR"),
      row(67000, 106000, "EUR"),
      row(null, null, null),
    ])).toEqual({ salaryMin: 55800, salaryMax: 106000, salaryCurrency: "EUR", familySalarySpan: true });
  });

  it("leaves mixed currencies on the posting you open and names every band", () => {
    const mixed = [row(163000, 220000, "USD"), row(128770, 178540, "GBP")];
    expect(familySalaryBand(mixed)).toBeNull();
    expect(familySalaryBands(mixed)).toEqual([
      { salaryMin: 163000, salaryMax: 220000, salaryCurrency: "USD" },
      { salaryMin: 128770, salaryMax: 178540, salaryCurrency: "GBP" },
    ]);
  });

  it("does not invent a span from one number", () => {
    expect(familySalaryBand([row(140000, 180000, "USD"), row(null, null, null)])).toBeNull();
  });
});
