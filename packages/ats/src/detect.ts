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
    // https://apply.workable.com/{account}/j/{shortcode}/   (a job)
    // https://apply.workable.com/{account}/                  (the account's board)
    // https://{account}.workable.com/j/{shortcode}           (legacy hosted page)
    if (host === "workable.com" || host.endsWith(".workable.com")) {
      const parts = path.split("/").filter(Boolean);
      const legacy = host !== "apply.workable.com" && !/^(www|jobs)\./.test(host);
      const account = legacy ? host.split(".")[0] : parts[0] && !/^(api|j)$/i.test(parts[0]) ? parts[0] : undefined;
      m = path.match(/\/j(?:obs)?\/([A-Za-z0-9]{4,})(?:\/|$)/);
      return {
        provider: "workable",
        boardToken: account,
        jobId: m?.[1],
        url,
        confidence: account && m ? "high" : "medium",
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

    // ── Recruitee ───────────────────────────────────────────────────────────
    // https://{company}.recruitee.com/o/{offer-slug}
    if (host.endsWith(".recruitee.com") && !/^(www|app|api|careers)\./.test(host)) {
      const company = host.split(".")[0];
      m = path.match(/\/o\/([^/?#]+)/i);
      return {
        provider: "recruitee",
        boardToken: company,
        jobId: m?.[1],
        url,
        confidence: m ? "high" : "medium",
      };
    }

    // ── InHire ──────────────────────────────────────────────────────────────
    // https://{tenant}.inhire.app/vagas/{uuid}[/{slug}]
    if (host.endsWith(".inhire.app") && !/^(api|api-dev|files|www|app)\./.test(host)) {
      const tenant = host.split(".")[0];
      m = path.match(/\/vagas\/([0-9a-f-]{36})/i);
      return {
        provider: "inhire",
        boardToken: tenant,
        jobId: m?.[1],
        url,
        confidence: m ? "high" : "medium",
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

/** Providers job-scout can scan as a board (listBoard). */
const SCANNABLE_BOARDS = new Set(["greenhouse", "ashby", "lever", "bamboohr"]);

const CAREERS_ROOT_RE = /^\/(?:[a-z]{2}(?:[-_][a-z]{2})?\/)?(?:careers?|jobs?|openings|open-positions|positions|vacancies|vagas|carreiras|trabalhe-conosco|join-us|work-with-us|jobs-at-[a-z0-9-]+)\/?$/i;
const JOB_QUERY_KEYS = ["gh_jid", "jobid", "job_id", "job", "jid", "jk", "vjk", "id", "req", "requisitionid", "token", "currentjobid", "position", "posting", "opening", "vacancy", "ashby_jid"];

export type BoardIndexUrl = {
  provider: string;
  boardToken?: string;
  /** True when job-scout can scan this board (suggest adding it as a board source). */
  scannable: boolean;
};

/**
 * A URL that addresses a careers board / index page, not one posting:
 * an ATS account root (boards.greenhouse.io/acme, jobs.ashbyhq.com/acme,
 * jobs.lever.co/acme, apply.workable.com/acme/) or a bare /careers or /jobs page.
 * Narrow on purpose: anything carrying a job id is never an index.
 */
export function boardIndexUrl(url: string): BoardIndexUrl | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  const keys = [...u.searchParams.keys()].map((k) => k.toLowerCase());
  if (keys.some((k) => JOB_QUERY_KEYS.includes(k))) return null;
  // SPA careers pages route single postings in the fragment (/careers#/job/123).
  if (/\d{3,}|[0-9a-f]{8}-/i.test(u.hash)) return null;
  const root = (provider: string, token: string | undefined): BoardIndexUrl | null =>
    token ? { provider, boardToken: token, scannable: SCANNABLE_BOARDS.has(provider) } : null;
  if (/(^|\.)greenhouse\.io$/.test(host) && parts.length === 1 && !GH_BAD_TOKENS.has(parts[0]!.toLowerCase())) return root("greenhouse", parts[0]);
  if (host === "jobs.ashbyhq.com" && parts.length === 1) return root("ashby", parts[0]);
  if (/^jobs(\.eu)?\.lever\.co$/.test(host) && parts.length === 1) return root("lever", parts[0]);
  if (host === "apply.workable.com" && parts.length === 1 && parts[0] !== "api") return root("workable", parts[0]);
  if (host === "jobs.smartrecruiters.com" && parts.length === 1) return root("smartrecruiters", parts[0]);
  if (host.endsWith(".bamboohr.com") && (parts.length === 0 || (parts.length === 1 && /^(careers|jobs)$/i.test(parts[0]!)))) return root("bamboohr", host.split(".")[0]);
  if (host.endsWith(".inhire.app") && (parts.length === 0 || (parts.length === 1 && /^vagas$/i.test(parts[0]!)))) return root("inhire", host.split(".")[0]);
  if (CAREERS_ROOT_RE.test(u.pathname)) return { provider: "unknown", scannable: false };
  return null;
}
