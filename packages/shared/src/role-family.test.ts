import { describe, expect, it } from "vitest";
import {
  cleanPositionTitle,
  groupPositionsByRoleFamily,
  isShellArchiveable,
  roleFamilyKey,
} from "./role-family.js";

describe("roleFamilyKey", () => {
  it("groups observability staff PE variants", () => {
    const a = roleFamilyKey("Staff Platform Engineer | Observability");
    const b = roleFamilyKey("Staff Platform Engineer - Observability");
    const c = roleFamilyKey("Staff Platform Engineer Observability");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("keeps service mesh separate from observability", () => {
    const a = roleFamilyKey("Staff Platform Engineer - Service Mesh");
    const b = roleFamilyKey("Staff Platform Engineer | Observability");
    expect(a).not.toBe(b);
  });
});

describe("groupPositionsByRoleFamily", () => {
  it("clusters wellhub-style shells", () => {
    const groups = groupPositionsByRoleFamily([
      { id: "1", title: "Staff Platform Engineer | Observability", status: "applied", fitScore: 70 },
      { id: "2", title: "Staff Platform Engineer - Observability", status: "research", fitScore: 59 },
      { id: "3", title: "Staff Platform Engineer - Service Mesh", status: "research", fitScore: 59 },
    ]);
    expect(groups).toHaveLength(2);
    const obs = groups.find((g) => g.items.length === 2);
    expect(obs?.items[0].status).toBe("applied");
  });
});

describe("shell helpers", () => {
  it("cleanPositionTitle strips trailing backslash", () => {
    expect(cleanPositionTitle("Staff Platform Engineer \\")).toBe("Staff Platform Engineer");
  });

  it("isShellArchiveable protects applied pipeline", () => {
    expect(isShellArchiveable("research")).toBe(true);
    expect(isShellArchiveable("idea")).toBe(true);
    expect(isShellArchiveable("applied")).toBe(false);
    expect(isShellArchiveable("screen")).toBe(false);
  });
});
