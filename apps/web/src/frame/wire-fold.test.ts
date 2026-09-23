import { describe, expect, it } from "vitest";
import { foldWire } from "./wire-fold.js";

const created = (positionTitle: string, company = "Elastic") => ({
  kind: "created",
  title: "Created from scan:greenhouse",
  company,
  positionTitle,
});

describe("wire fold", () => {
  it("collapses a burst of the same role into one line", () => {
    const folded = foldWire([
      created("Principal Software Engineer"),
      created("Principal Software Engineer"),
      created("Principal Software Engineer"),
    ]);
    expect(folded).toHaveLength(1);
    expect(folded[0]?.count).toBe(3);
  });

  it("keeps a different role, and a later repeat after a gap, as their own lines", () => {
    const folded = foldWire([
      created("Principal Software Engineer"),
      created("Senior Java Engineer"),
      created("Principal Software Engineer"),
    ]);
    expect(folded.map((f) => [f.row.positionTitle, f.count])).toEqual([
      ["Principal Software Engineer", 1],
      ["Senior Java Engineer", 1],
      ["Principal Software Engineer", 1],
    ]);
  });

  it("does not merge the same title at two companies", () => {
    const folded = foldWire([
      created("Software Engineer", "Elastic"),
      created("Software Engineer", "Stripe"),
    ]);
    expect(folded).toHaveLength(2);
  });
});
