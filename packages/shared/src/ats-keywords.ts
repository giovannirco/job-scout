/** Core stack terms the candidate claims; used to tag checklist items as "stack". */
export const STACK_KEYWORDS: readonly string[] = Object.freeze([
  "kubernetes",
  "k8s",
  "aws",
  "eks",
  "terraform",
  "gitops",
  "argo",
  "prometheus",
  "grafana",
  "datadog",
  "typescript",
  "python",
  "platform",
  "observability",
  "mcp",
]);

/** Extra tech/role tokens beyond scout stackKeywords (resume-ats-optimizer frame). */
export const ATS_KEYWORD_CATALOG: readonly string[] = Object.freeze(
  Array.from(
    new Set(
      [
        ...STACK_KEYWORDS,
        "kubernetes",
        "k8s",
        "docker",
        "helm",
        "aws",
        "gcp",
        "azure",
        "eks",
        "gke",
        "aks",
        "terraform",
        "pulumi",
        "cloudformation",
        "ansible",
        "gitops",
        "argo",
        "argocd",
        "flux",
        "prometheus",
        "grafana",
        "datadog",
        "opentelemetry",
        "otel",
        "jaeger",
        "loki",
        "elasticsearch",
        "splunk",
        "new relic",
        "pagerduty",
        "opsgenie",
        "on-call",
        "oncall",
        "incident",
        "postmortem",
        "slo",
        "sla",
        "error budget",
        "observability",
        "tracing",
        "metrics",
        "logging",
        "typescript",
        "javascript",
        "python",
        "golang",
        "rust",
        "java",
        "ruby",
        "node.js",
        "nodejs",
        "go",
        "kafka",
        "rabbitmq",
        "redis",
        "postgres",
        "postgresql",
        "mysql",
        "mongodb",
        "cassandra",
        "clickhouse",
        "ci/cd",
        "cicd",
        "github actions",
        "gitlab ci",
        "jenkins",
        "circleci",
        "bazel",
        "nix",
        "linux",
        "bash",
        "sre",
        "site reliability",
        "devops",
        "platform engineering",
        "infrastructure as code",
        "service mesh",
        "istio",
        "linkerd",
        "envoy",
        "nginx",
        "vault",
        "secrets management",
        "iam",
        "oauth",
        "oidc",
        "rbac",
        "zero trust",
        "security",
        "mlops",
        "llm",
        "gpu",
        "mcp",
        "airflow",
        "temporal",
        "spark",
        "flink",
        "kubernetes operators",
        "chaos engineering",
        "capacity planning",
        "cost optimization",
        "finops",
      ]
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ).sort((a, b) => b.length - a.length),
);

export type AtsKeywordSource = "jd" | "ats_question" | "tech_tag" | "stack";

export type AtsKeywordItem = {
  term: string;
  inJd: boolean;
  inMaterials: boolean;
  source: AtsKeywordSource;
};

export type AtsKeywordChecklist = {
  items: AtsKeywordItem[];
  /** Share of JD-present terms also present in materials/resume (0–100). */
  coveragePct: number;
  jdHitCount: number;
  materialsHitCount: number;
  missing: string[];
  present: string[];
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive presence with word-ish boundaries. */
export function termInText(term: string, text: string): boolean {
  const t = (term || "").trim().toLowerCase();
  const blob = (text || "").toLowerCase();
  if (!t || !blob) return false;
  if (t.includes(" ") || t.includes("/") || t.includes("-") || t.includes(".")) {
    return blob.includes(t);
  }
  const re = new RegExp(`(?:^|[^a-z0-9_+#])${escapeRegExp(t)}(?:[^a-z0-9_+#]|$)`, "i");
  return re.test(blob);
}

export function normalizeKeywordBlob(...parts: Array<string | null | undefined>): string {
  return parts
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .join("\n")
    .toLowerCase();
}

/**
 * Build ATS keyword checklist: JD (+ questions/tags) tokens vs materials/resume.
 * Only catalogs terms found in the JD side — never invents metrics or fake skills.
 */
export function buildAtsKeywordChecklist(input: {
  jdText?: string | null;
  atsQuestions?: string[] | null;
  techTags?: string[] | null;
  materialsText?: string | null;
  extraCatalog?: string[] | null;
}): AtsKeywordChecklist {
  const catalog = Array.from(
    new Set(
      [...ATS_KEYWORD_CATALOG, ...(input.extraCatalog || []).map((s) => s.toLowerCase().trim())]
        .filter(Boolean)
        .sort((a, b) => b.length - a.length),
    ),
  );

  const jdBlob = normalizeKeywordBlob(
    input.jdText,
    ...(input.atsQuestions || []),
    ...(input.techTags || []),
  );
  const matBlob = normalizeKeywordBlob(input.materialsText);

  const found = new Map<string, AtsKeywordItem>();

  for (const term of catalog) {
    if (!termInText(term, jdBlob)) continue;
    let source: AtsKeywordSource = "jd";
    if ((input.techTags || []).some((t) => termInText(term, t))) source = "tech_tag";
    else if ((input.atsQuestions || []).some((q) => termInText(term, q))) source = "ats_question";
    else if (STACK_KEYWORDS.some((k) => k.toLowerCase() === term))
      source = "stack";
    found.set(term, {
      term,
      inJd: true,
      inMaterials: termInText(term, matBlob),
      source,
    });
  }

  const rawItems = Array.from(found.values());
  const items = rawItems
    .filter(
      (a) =>
        !rawItems.some(
          (b) => b.term !== a.term && b.term.includes(a.term) && b.term.length > a.term.length,
        ),
    )
    .sort((a, b) => a.term.localeCompare(b.term));
  const jdHitCount = items.length;
  const materialsHitCount = items.filter((i) => i.inMaterials).length;
  const present = items.filter((i) => i.inMaterials).map((i) => i.term);
  const missing = items.filter((i) => !i.inMaterials).map((i) => i.term);
  const coveragePct =
    jdHitCount === 0 ? 0 : Math.round((materialsHitCount / jdHitCount) * 100);

  return {
    items,
    coveragePct,
    jdHitCount,
    materialsHitCount,
    missing,
    present,
  };
}
