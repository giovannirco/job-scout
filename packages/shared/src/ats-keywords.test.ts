import { describe, expect, it } from "vitest";
import {
  buildAtsKeywordChecklist,
  termInText,
} from "./ats-keywords.js";

describe("termInText", () => {
  it("matches multi-word and path-like tokens", () => {
    expect(termInText("ci/cd", "we run CI/CD pipelines")).toBe(true);
    expect(termInText("site reliability", "Site Reliability Engineer")).toBe(true);
  });

  it("uses boundaries for short tokens", () => {
    expect(termInText("go", "experience with Go and Python")).toBe(true);
    expect(termInText("go", "ongoing platform work")).toBe(false);
    expect(termInText("aws", "aws eks")).toBe(true);
  });

  it("does not treat java as javascript or rust as trust", () => {
    expect(termInText("java", "strong JavaScript and TypeScript")).toBe(false);
    expect(termInText("javascript", "strong JavaScript and TypeScript")).toBe(true);
    expect(termInText("rust", "zero-trust IAM")).toBe(false);
    expect(termInText("rust", "production Rust services")).toBe(true);
  });
});

describe("buildAtsKeywordChecklist", () => {
  it("lists JD stack hits and coverage vs materials", () => {
    const r = buildAtsKeywordChecklist({
      jdText:
        "Senior SRE with Kubernetes, Terraform, AWS, Prometheus, Grafana, and on-call ownership. Python preferred.",
      materialsText: "Led Kubernetes platform on AWS with Terraform. Python automation.",
    });
    expect(r.jdHitCount).toBeGreaterThanOrEqual(5);
    expect(r.present).toEqual(expect.arrayContaining(["kubernetes", "terraform", "aws", "python"]));
    expect(r.missing).toEqual(expect.arrayContaining(["prometheus", "grafana"]));
    expect(r.coveragePct).toBeGreaterThan(0);
    expect(r.coveragePct).toBeLessThan(100);
  });

  it("includes ATS questions and tech tags", () => {
    const r = buildAtsKeywordChecklist({
      jdText: "Platform role",
      atsQuestions: ["Describe your GitOps experience with ArgoCD"],
      techTags: ["mcp"],
      materialsText: "Built MCP tools; GitOps with Argo CD",
    });
    const terms = r.items.map((i) => i.term);
    expect(terms.some((t) => t.includes("gitops") || t === "argo" || t === "argocd")).toBe(true);
    expect(terms).toContain("mcp");
    expect(r.materialsHitCount).toBeGreaterThan(0);
  });

  it("returns empty when no JD keywords match catalog", () => {
    const r = buildAtsKeywordChecklist({
      jdText: "Friendly culture and competitive benefits only.",
      materialsText: "Kubernetes everywhere",
    });
    expect(r.jdHitCount).toBe(0);
    expect(r.coveragePct).toBe(0);
    expect(r.items).toEqual([]);
  });

  it("does not invent java from javascript, and drops argo when argocd hit", () => {
    const r = buildAtsKeywordChecklist({
      jdText: "JavaScript/TypeScript frontend plus ArgoCD GitOps on AWS.",
      materialsText: "TypeScript and Argo CD on AWS",
    });
    const terms = r.items.map((i) => i.term);
    expect(terms).not.toContain("java");
    expect(terms).toContain("javascript");
    expect(terms).toContain("argocd");
    expect(terms).not.toContain("argo");
  });
});
