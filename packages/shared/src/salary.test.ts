import { describe, expect, it } from "vitest";
import { parseSalary, salaryPeriodGuard } from "./salary.js";

describe("parseSalary", () => {
  it("parses USD k bands", () => {
    const s = parseSalary("$129–304k");
    expect(s.min).toBe(129000);
    expect(s.max).toBe(304000);
    expect(s.currency).toBe("USD");
  });

  it("parses full USD ranges", () => {
    const s = parseSalary("$200,000 – $250,000 USD");
    expect(s.min).toBe(200000);
    expect(s.max).toBe(250000);
  });

  it("parses BRL", () => {
    const s = parseSalary("BRL 422.5–485k");
    expect(s.currency).toBe("BRL");
    expect(s.min).toBeGreaterThan(400000);
  });

  it("parses monthly", () => {
    const s = parseSalary("$4–5k/mo");
    expect(s.period).toBe("month");
    expect(s.min).toBe(4000);
  });

  it("returns nulls when unknown", () => {
    const s = parseSalary("");
    expect(s.min).toBeNull();
    expect(s.raw).toBeNull();
  });
});

describe("salaryPeriodGuard", () => {
  it("annualizes posted monthly without inventing an offer", () => {
    const s = parseSalary("$4–5k/mo");
    const g = salaryPeriodGuard(s);
    expect(g.period).toBe("month");
    expect(g.warnMonthly).toBe(true);
    expect(g.yearlyMin).toBe(48000);
    expect(g.yearlyMax).toBe(60000);
  });

  it("flags year figures that look monthly", () => {
    const g = salaryPeriodGuard({ min: 8000, max: 8000, period: "year", raw: "8000" });
    expect(g.warnLooksMonthly).toBe(true);
    expect(g.warnMonthly).toBe(false);
  });

  it("does not flag typical yearly k bands", () => {
    const g = salaryPeriodGuard(parseSalary("$129–304k"));
    expect(g.warnMonthly).toBe(false);
    expect(g.warnLooksMonthly).toBe(false);
    expect(g.periodLabel).toBe("/yr");
  });
});
