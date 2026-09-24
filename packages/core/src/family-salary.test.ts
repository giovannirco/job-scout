import { describe, expect, it } from "vitest";
import { familySalaryBand, familySalaryBands } from "./position-groups.js";

const row = (salaryMin: number | null, salaryMax: number | null, salaryCurrency: string | null, salaryPeriod = "year") =>
  ({ salaryMin, salaryMax, salaryCurrency, salaryPeriod });

describe("family salary band", () => {
  it("spans the countries that posted a band in one currency", () => {
    expect(familySalaryBand([
      row(61100, 96600, "EUR"),
      row(55800, 88300, "EUR"),
      row(67000, 106000, "EUR"),
      row(null, null, null),
    ])).toEqual({ salaryMin: 55800, salaryMax: 106000, salaryCurrency: "EUR", salaryPeriod: "year", familySalarySpan: true });
  });

  it("leaves mixed currencies on the posting you open and names every band", () => {
    const mixed = [row(163000, 220000, "USD"), row(128770, 178540, "GBP")];
    expect(familySalaryBand(mixed)).toBeNull();
    expect(familySalaryBands(mixed)).toEqual([
      { salaryMin: 163000, salaryMax: 220000, salaryCurrency: "USD", salaryPeriod: "year" },
      { salaryMin: 128770, salaryMax: 178540, salaryCurrency: "GBP", salaryPeriod: "year" },
    ]);
  });

  it("keeps hourly, monthly and yearly values in separate bands", () => {
    const mixed = [row(50, 70, "USD", "hour"), row(5000, 7000, "USD", "month"), row(150000, 180000, "USD")];
    expect(familySalaryBand(mixed)).toBeNull();
    expect(familySalaryBands(mixed)).toEqual(mixed);
  });

  it("does not invent a span from one number", () => {
    expect(familySalaryBand([row(140000, 180000, "USD"), row(null, null, null)])).toBeNull();
  });
});
