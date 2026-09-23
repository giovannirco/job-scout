import { describe, expect, it } from "vitest";
import { applyProfileToGate, titleExcludesFromNorthStar } from "./profile-gate.js";
import { gateListing } from "./gate.js";
import { DEFAULT_GATE } from "./settings.js";

describe("profile gate", () => {
  it("excludes infrastructure titles only when the north star rejects them", () => {
    expect(titleExcludesFromNorthStar("I write services, not infrastructure platforms.")).toEqual([
      "infrastructure", "infra", "kubernetes", "k8s", "devops", "sre", "site reliability",
      "linux", "embedded", "kernel", "compiler", "openstack", "ceph",
    ]);
    expect(titleExcludesFromNorthStar("Remote Java backend.")).toEqual([
      "frontend", "front-end", "front end", "data engineer", "data engineering",
      "l3 support", "solutions engineer", "quality engineer",
    ]);
    const gate = applyProfileToGate(
      { ...DEFAULT_GATE, titleInclude: ["software engineer", "backend engineer"], titleExclude: ["manager"] },
      { northStar: "I write services, not infrastructure platforms." },
    );
    expect(gateListing({ title: "Software Engineer - Infrastructure", locationRaw: "Remote" }, gate).reason).toBe("title_exclude:infrastructure");
    expect(gateListing({ title: "Senior Software Engineer, Kubernetes", locationRaw: "Remote" }, gate).reason).toBe("title_exclude:kubernetes");
    expect(gateListing({ title: "Staff Backend Engineer, Core DevOps", locationRaw: "Remote" }, gate).reason).toBe("title_exclude:devops");
    expect(gateListing({ title: "Software Engineer, Backend", locationRaw: "Remote" }, gate).pass).toBe(true);
    const mina = applyProfileToGate(
      { ...DEFAULT_GATE, titleInclude: ["java engineer", "software engineer", "backend engineer"], titleExclude: ["manager", "junior"] },
      { northStar: "Remote Java backend roles. I write services, not infrastructure platforms." },
    );
    expect(gateListing({ title: "Senior Software Engineer, Frontend", locationRaw: "Remote" }, mina).reason).toBe("title_exclude:frontend");
    expect(gateListing({ title: "Staff Software Engineer (SRE)", locationRaw: "Remote" }, mina).reason).toBe("title_exclude:sre");
    expect(gateListing({ title: "Senior Software Engineer, Data Engineering Platform", locationRaw: "Remote" }, mina).reason).toBe("title_exclude:data engineer");
    expect(gateListing({ title: "Senior Java Engineer", locationRaw: "Remote" }, mina).pass).toBe(true);
    expect(gateListing({ title: "Software Engineer - L3 Support", locationRaw: "Remote" }, mina).reason).toBe("title_exclude:l3 support");
    expect(gateListing({ title: "Software Engineer - Solutions Engineering", locationRaw: "Remote" }, mina).reason).toBe("title_exclude:solutions engineer");
    expect(gateListing({ title: "Senior Software Engineer, Quality Engineering", locationRaw: "Remote" }, mina).reason).toBe("title_exclude:quality engineer");
    expect(gateListing({ title: "Security Software Engineer", locationRaw: "Remote" }, mina).pass).toBe(true);
    expect(gateListing({ title: "Embedded Linux Senior Software Engineer", locationRaw: "Remote" }, mina).reason).toBe("title_exclude:linux");
    expect(gateListing({ title: "System Software Engineer - GCC/LLVM compiler", locationRaw: "Remote" }, mina).reason).toBe("title_exclude:compiler");
    expect(gateListing({ title: "Software Developer (Backend SaaS)", locationRaw: "Remote" }, mina).pass).toBe(true);
    const both = applyProfileToGate(DEFAULT_GATE, { northStar: "Frontend and backend product work." });
    expect(gateListing({ title: "Senior Software Engineer, Frontend", locationRaw: "Remote", workplaceType: "remote" }, { ...both, titleInclude: ["software engineer"] }).pass).toBe(true);
  });

  it("keeps a US-only remote role when the profile is in the US", () => {
    const gate = applyProfileToGate(DEFAULT_GATE, { home: "Austin, TX" });
    const v = gateListing({ title: "Site Reliability Engineer", locationRaw: "Remote - US only" }, gate);
    expect(v.pass).toBe(true);
  });

  it("does not age-filter a job the board is still listing", () => {
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
    const gate = applyProfileToGate(
      { ...DEFAULT_GATE, titleInclude: ["java engineer"] },
      { listedNow: true },
    );
    const aged = { ...DEFAULT_GATE, titleInclude: ["java engineer"] };
    expect(gateListing({ title: "Senior Java Engineer", locationRaw: "Remote", postedAt: old }, gate).pass).toBe(true);
    expect(gateListing({ title: "Senior Java Engineer", locationRaw: "Remote", postedAt: old }, aged).reason).toMatch(/^stale:/);
  });
});
