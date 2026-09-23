import { describe, expect, it } from "vitest";
import { countFunnel, emptyStatusCounts } from "./funnel.js";

describe("countFunnel", () => {
  const now = new Date("2026-09-04T12:00:00.000Z");
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

  it("counts current status for positions first seen in the last 30d plus applied this week", () => {
    const r = countFunnel(
      [
        { status: "review", firstSeenAt: daysAgo(5), appliedAt: null },
        { status: "applied", firstSeenAt: daysAgo(40), appliedAt: daysAgo(2) },
        { status: "archived", firstSeenAt: daysAgo(1), appliedAt: daysAgo(20) },
        { status: "triaged", firstSeenAt: null, appliedAt: null },
        { status: "interview", firstSeenAt: daysAgo(10), appliedAt: daysAgo(12) },
        { status: "offer", firstSeenAt: daysAgo(3), appliedAt: daysAgo(8) },
      ],
      now,
    );
    expect(r.last30d.review).toBe(1);
    expect(r.last30d.applied).toBe(0);
    expect(r.last30d.archived).toBe(1);
    expect(r.last30d.triaged).toBe(0);
    expect(r.last30d.interview).toBe(1);
    expect(r.last30d.offer).toBe(1);
    expect(r.appliedThisWeek).toBe(1);
  });

  it("starts every known status at zero", () => {
    const z = emptyStatusCounts();
    expect(z.triaged).toBe(0);
    expect(z.review).toBe(0);
    expect(z.applied).toBe(0);
    expect(z.interview).toBe(0);
    expect(z.offer).toBe(0);
    expect(z.archived).toBe(0);
    expect(countFunnel([], now).last30d).toEqual(z);
    expect(countFunnel([], now).appliedThisWeek).toBe(0);
  });

  it("ignores unknown statuses in the 30d bucket", () => {
    const r = countFunnel([{ status: "nope", firstSeenAt: daysAgo(1), appliedAt: daysAgo(1) }], now);
    expect(r.last30d.applied).toBe(0);
    expect(r.appliedThisWeek).toBe(1);
  });
});
