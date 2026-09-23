import { describe, expect, it } from "vitest";
import {
  classifyMateriality,
  contentHash,
  fieldDiffs,
  filterFormattingDiffs,
  isCleanRevision,
  defaultCleanRevCompare,
  isFormattingOnlyTextChange,
  normalizeDescription,
  stripMarkupForCompare,
  summarizeDiffs,
} from "./hash.js";

describe("contentHash", () => {
  it("is stable under whitespace normalize", () => {
    const a = contentHash({
      title: "Senior SRE",
      descriptionText: "Hello   world\n\n\nKubernetes",
      salaryRaw: "$100k",
      locationRaw: "Remote",
    });
    const b = contentHash({
      title: "Senior SRE",
      descriptionText: "hello world\n\nkubernetes",
      salaryRaw: "$100k",
      locationRaw: "Remote",
    });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("changes when title changes", () => {
    const a = contentHash({ title: "SRE", descriptionText: "x" });
    const b = contentHash({ title: "DevOps Consultant", descriptionText: "x" });
    expect(a).not.toBe(b);
  });
});

describe("materiality", () => {
  it("title change is material", () => {
    const diffs = fieldDiffs(
      { title: "SRE" },
      { title: "DevOps Consultant" },
      ["title"],
    );
    const m = classifyMateriality(diffs);
    expect(m.material).toBe(true);
    expect(m.change_kind).toBe("title");
  });

  it("noise_rebase force", () => {
    const m = classifyMateriality(
      [{ path: "description_text", before: "a", after: "a <!-- x -->" }],
      { forceKind: "noise_rebase" },
    );
    expect(m.material).toBe(false);
  });
});

describe("normalizeDescription", () => {
  it("collapses whitespace", () => {
    expect(normalizeDescription("  A   B  \n\n\n C ")).toBe("a b\n\nc");
  });
});

describe("formatting-only description (F-23)", () => {
  const escaped =
    "&lt;div class=&quot;content-intro&quot;&gt;&lt;h3&gt;Working At Bitso&lt;/h3&gt; &lt;p&gt;We are a diverse team&lt;/p&gt;&lt;/div&gt;";
  const clean = "Working At Bitso\nWe are a diverse team";

  it("stripMarkupForCompare equalizes entity HTML vs plain", () => {
    expect(stripMarkupForCompare(escaped)).toBe(stripMarkupForCompare(clean));
    expect(isFormattingOnlyTextChange(escaped, clean)).toBe(true);
  });

  it("classifyMateriality marks HTML cleanup as noise_rebase", () => {
    const m = classifyMateriality([
      { path: "description_text", before: escaped, after: clean },
    ]);
    expect(m.material).toBe(false);
    expect(m.change_kind).toBe("noise_rebase");
  });

  it("summarizeDiffs does not dump entity soup", () => {
    const s = summarizeDiffs([
      { path: "description_text", before: escaped, after: clean },
    ]);
    expect(s).toBe("description_text: formatting only");
    expect(s).not.toContain("&lt;");
  });

  it("filterFormattingDiffs drops pure formatting description rows", () => {
    const filtered = filterFormattingDiffs([
      { path: "description_text", before: escaped, after: clean },
      { path: "listing_status", before: "changed", after: "open" },
    ]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].path).toBe("listing_status");
  });

  it("real content change stays material", () => {
    const m = classifyMateriality([
      {
        path: "description_text",
        before: "Need Kubernetes experience",
        after: "Need Kubernetes and Terraform experience plus on-call",
      },
    ]);
    expect(m.material).toBe(true);
    expect(m.change_kind).toBe("content");
  });
});

describe("clean-rev compare default (F-29 / UX-8)", () => {
  it("isCleanRevision drops noise_rebase", () => {
    expect(isCleanRevision({ revision: 2, material: false, changeKind: "noise_rebase" })).toBe(
      false,
    );
    expect(isCleanRevision({ revision: 3, material: true, changeKind: "content" })).toBe(true);
    expect(isCleanRevision({ revision: 1, changeKind: "new" })).toBe(true);
  });

  it("picks last two clean revs, skipping noise in between", () => {
    const pair = defaultCleanRevCompare([
      { revision: 1, material: true, changeKind: "new" },
      { revision: 2, material: false, changeKind: "noise_rebase" },
      { revision: 3, material: false, changeKind: "noise_rebase" },
      { revision: 4, material: true, changeKind: "content" },
      { revision: 5, material: false, changeKind: "noise_rebase" },
    ]);
    expect(pair).toEqual({ from: 1, to: 4, mode: "clean" });
  });

  it("falls back to oldest→newest when no clean pair", () => {
    const pair = defaultCleanRevCompare([
      { revision: 1, material: false, changeKind: "noise_rebase" },
      { revision: 2, material: false, changeKind: "noise_rebase" },
    ]);
    expect(pair).toEqual({ from: 1, to: 2, mode: "fallback" });
  });

  it("returns null for fewer than 2 revs", () => {
    expect(defaultCleanRevCompare([{ revision: 1, material: true }])).toBeNull();
  });
});
