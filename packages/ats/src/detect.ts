import type { AtsProvider, DetectedAts } from "./types.js";

export type { DetectedAts };

/** Placeholder / seed job ids that never resolve to a real posting. */
export function isPlaceholderJobId(
  provider: AtsProvider | string,
  jobId?: string | null,
): boolean {
  if (!jobId) return true;
  const id = jobId.trim();
  if (!id) return true;
  if (/^example$/i.test(id)) return true;
  if (/^(null|undefined|0|none|tbd|todo|placeholder)$/i.test(id)) return true;
  if (/0{4}-0{4}-0{4}-0{12}/i.test(id)) return true;
  // Seed UUIDs with zero middle segments (…-0000-0000-0000-…)
  if (/[0-9a-f]{8}-0{4}-0{4}-0{4}-[0-9a-f]{12}/i.test(id)) return true;
  if (provider === "greenhouse" && !/^\d+$/.test(id)) return true;
  if (provider === "ashby" && !/^[0-9a-f-]{30,}$/i.test(id)) return true;
  return false;
}

/** Mis-imported Greenhouse board path segments (not company tokens). */
const GH_BAD_TOKENS = new Set([
  "careers",
  "boards",
  "jobs",
  "job-boards",
  "embed",
  "example",
  "www",
]);

export function isPlaceholderAtsDetection(d: DetectedAts): boolean {
  if (d.placeholder) return true;
  if (d.provider === "unknown") return false;
  if (d.provider === "greenhouse" && d.boardToken && GH_BAD_TOKENS.has(d.boardToken.toLowerCase())) {
    return true;
  }
  if (d.jobId && isPlaceholderJobId(d.provider, d.jobId)) return true;
  if (/\/jobs?\/example\b/i.test(d.url)) return true;
  if (/\/example(\/|$|\?)/i.test(d.url)) return true;
  return false;
}

const GENERIC_BOARD_LABELS = new Set(["jobs", "careers", "boards", "www", "job", "apply"]);

export function genericBoardLabel(token: string | undefined): boolean {
  return GENERIC_BOARD_LABELS.has((token || "").toLowerCase());
}

export type GreenhouseBoardRef = { company: string; token: string; careersUrl?: string | null };

/** Pick the greenhouse board behind a vanity careers URL. Ambiguous matches stay unresolved. */
export function greenhouseBoardToken(
  boards: GreenhouseBoardRef[],
  opts: { companyName?: string | null; url?: string | null },
): string | null {
  const company = (opts.companyName || "").trim().toLowerCase();
  const byName = company
    ? boards.filter((board) => board.token && board.company.trim().toLowerCase() === company)
    : [];
  if (byName.length === 1) return byName[0]!.token;
  let host = "";
  try {
    host = new URL(opts.url || "").hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    host = "";
  }
  if (!host) return null;
  const byHost = boards.filter((board) => {
    if (!board.token || !board.careersUrl) return false;
    try {
      const careers = new URL(board.careersUrl).hostname.toLowerCase().replace(/^www\./, "");
      return Boolean(careers) && (host === careers || host.endsWith(`.${careers}`));
    } catch {
      return false;
    }
  });
  return byHost.length === 1 ? byHost[0]!.token : null;
}

/** A careers vanity URL can carry a long page of nav and JSON while the board API has the JD. */
export function greenhouseListingNeedsBoardFetch(
  job: { boardToken?: string | null } | null | undefined,
  board: { provider: string; token?: string | null; jobId?: string | null },
): boolean {
  if (board.provider !== "greenhouse" || !board.jobId || !board.token) return false;
  return job?.boardToken !== board.token;
}

export function detectAts(url: string): DetectedAts {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname;
    const ghJid = u.searchParams.get("gh_jid");

    // ── Greenhouse ──────────────────────────────────────────────────────────
    // https://boards.greenhouse.io/{token}/jobs/{id}
    // https://job-boards.greenhouse.io/{token}/jobs/{id}
    let m = path.match(/\/([^/]+)\/jobs\/(\d+)/);
    if ((host.includes("greenhouse.io") || host.includes("greenhouse.com")) && m) {
      const token = m[1];
      const jobId = m[2];
      const bad = GH_BAD_TOKENS.has(token.toLowerCase());
      return {
        provider: "greenhouse",
        boardToken: token,
        jobId,
        url,
        placeholder: bad || isPlaceholderJobId("greenhouse", jobId),
        confidence: bad ? "low" : "high",
      };
    }
    // Non-numeric job path (…/jobs/example)
    m = path.match(/\/([^/]+)\/jobs\/([^/?#]+)/);
    if ((host.includes("greenhouse.io") || host.includes("greenhouse.com")) && m) {
      return {
        provider: "greenhouse",
        boardToken: m[1],
        jobId: m[2],
        url,
        placeholder: true,
        confidence: "low",
      };
    }
    if (ghJid && /^\d+$/.test(ghJid)) {
      const tokenGuess = host.replace(/^www\./, "").split(".")[0];
      const generic = genericBoardLabel(tokenGuess);
      return {
        provider: "greenhouse",
        boardToken: generic ? undefined : tokenGuess,
        jobId: ghJid,
        url,
        confidence: generic ? "low" : "medium",
      };
    }
    m = path.match(/\/jobs\/(\d+)/);
    if (m && (host.includes("greenhouse") || u.searchParams.has("gh_jid"))) {
      return {
        provider: "greenhouse",
        boardToken: host.replace(/^www\./, "").split(".")[0],
        jobId: m[1],
        url,
        confidence: "medium",
      };
    }
    const embedFor = u.searchParams.get("for");
    const embedToken = u.searchParams.get("token");
    if (host.includes("greenhouse") && embedFor && embedToken) {
      return {
        provider: "greenhouse",
        boardToken: embedFor,
        jobId: embedToken,
        url,
        placeholder: isPlaceholderJobId("greenhouse", embedToken),
        confidence: "medium",
      };
    }

    // ── Ashby ───────────────────────────────────────────────────────────────
    // https://jobs.ashbyhq.com/{org}/{uuid}
    m = path.match(
      /^\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    );
    if (host.includes("ashbyhq.com") && m) {
      const jobId = m[2];
      return {
        provider: "ashby",
        boardToken: m[1],
        jobId,
        url,
        placeholder: isPlaceholderJobId("ashby", jobId),
        confidence: "high",
      };
    }
    m = path.match(/^\/([^/]+)\/([^/?#]+)/);
    if (host.includes("ashbyhq.com") && m) {
      return {
        provider: "ashby",
        boardToken: m[1],
        jobId: m[2],
        url,
        placeholder: isPlaceholderJobId("ashby", m[2]),
        confidence: "medium",
      };
    }

    // ── Lever ───────────────────────────────────────────────────────────────
    // https://jobs.lever.co/{company}/{id}
    m = path.match(/^\/([^/]+)\/([0-9a-f-]{8,})/i);
    if (host.includes("lever.co") && m) {
      return {
        provider: "lever",
        boardToken: m[1],
        jobId: m[2],
        url,
        placeholder: isPlaceholderJobId("lever", m[2]),
        confidence: "high",
      };
    }
    if (host.includes("lever.co")) {
      const parts = path.split("/").filter(Boolean);
      return {
        provider: "lever",
        boardToken: parts[0],
        jobId: parts[1],
        url,
        placeholder: !parts[1] || isPlaceholderJobId("lever", parts[1]),
        confidence: "medium",
      };
    }

    // ── Workday ─────────────────────────────────────────────────────────────
    // https://{tenant}.wdN.myworkdayjobs.com/{site}/job/…_REQ123
    if (host.includes("myworkdayjobs.com") || host.includes("workdayjobs.com")) {
      const tenant = host.split(".")[0];
      const wd =
        path.match(/_([A-Z0-9]{4,})\//i) ||
        path.match(/(R-\d+|REQ\d+|JR\d+|REF\d+\w*)/i) ||
        path.match(/\/job\/([^/]+)/i);
      return {
        provider: "workday",
        boardToken: tenant,
        jobId: wd ? wd[1] : undefined,
        url,
        confidence: wd ? "high" : "medium",
      };
    }

    // ── SmartRecruiters ─────────────────────────────────────────────────────
    // https://jobs.smartrecruiters.com/{company}/{id}
    if (host.includes("smartrecruiters.com")) {
      const parts = path.split("/").filter(Boolean);
      return {
        provider: "smartrecruiters",
        boardToken: parts[0],
        jobId: parts[1],
        url,
        confidence: parts[1] ? "high" : "medium",
      };
    }

    // ── Workable ────────────────────────────────────────────────────────────
    // https://apply.workable.com/{company}/j/{id}/
    if (host.includes("workable.com")) {
      m = path.match(/\/([^/]+)\/j\/([^/]+)/i) || path.match(/\/([^/]+)\/([^/]+)/);
      return {
        provider: "workable",
        boardToken: m?.[1],
        jobId: m?.[2],
        url,
        confidence: m?.[2] ? "high" : "medium",
      };
    }

    // ── Teamtailor ──────────────────────────────────────────────────────────
    if (host.includes("teamtailor.com")) {
      const parts = path.split("/").filter(Boolean);
      return {
        provider: "teamtailor",
        boardToken: host.split(".")[0],
        jobId: parts[parts.length - 1],
        url,
        confidence: "medium",
      };
    }

    // ── Rippling ────────────────────────────────────────────────────────────
    if (host.includes("rippling.com") || host.includes("ats.rippling.com")) {
      const parts = path.split("/").filter(Boolean);
      return {
        provider: "rippling",
        boardToken: parts[0],
        jobId: parts[parts.length - 1],
        url,
        confidence: "medium",
      };
    }

    // ── BambooHR ────────────────────────────────────────────────────────────
    if (host.includes("bamboohr.com")) {
      const subdomain = host.split(".")[0];
      m = path.match(/\/careers\/(\d+)(?:\/|$)/i) || path.match(/\/jobs\/view\.php\?id=(\d+)/i) || path.match(/[?&]id=(\d+)/);
      const idFromQuery = u.searchParams.get("id");
      return {
        provider: "bamboohr",
        boardToken: subdomain,
        jobId: m?.[1] || idFromQuery || undefined,
        url,
        confidence: "medium",
      };
    }

    // ── LinkedIn ────────────────────────────────────────────────────────────
    if (host.includes("linkedin.com")) {
      m = path.match(/\/jobs\/view\/(\d+)/i) || path.match(/currentJobId=(\d+)/);
      const currentJobId = u.searchParams.get("currentJobId");
      return {
        provider: "linkedin",
        jobId: m?.[1] || currentJobId || undefined,
        url,
        confidence: m || currentJobId ? "high" : "low",
      };
    }

    // ── Indeed ──────────────────────────────────────────────────────────────
    if (host.includes("indeed.com")) {
      const jk = u.searchParams.get("jk") || u.searchParams.get("vjk");
      m = path.match(/\/viewjob/i);
      return {
        provider: "indeed",
        jobId: jk || undefined,
        url,
        confidence: jk ? "high" : "low",
      };
    }

    // Known ATS hosts without a full parse
    if (host.includes("greenhouse") || host.includes("ashby") || host.includes("lever")) {
      return { provider: "other", url, confidence: "low" };
    }
    return { provider: "unknown", url, confidence: "low" };
  } catch {
    return { provider: "unknown", url, confidence: "low" };
  }
}

export function extractUrls(text: string): string[] {
  const re = /https?:\/\/[^\s<>"')\]]+/gi;
  const found = text.match(re) || [];
  return [...new Set(found.map((u) => u.replace(/[.,;]+$/, "")))];
}

/** Build external identity for CRM dedupe. */
export function externalIdentityFromDetect(d: DetectedAts): string | undefined {
  if (!d.provider || d.provider === "unknown") return undefined;
  if (d.boardToken && d.jobId) return `${d.provider}:${d.boardToken}:${d.jobId}`;
  if (d.jobId) return `${d.provider}:${d.jobId}`;
  return undefined;
}
