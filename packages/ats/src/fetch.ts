import { extractSalaryRaw, isCraftMatch } from "@job-scout/shared";
import {
  detectAts,
  externalIdentityFromDetect,
  isPlaceholderAtsDetection,
  isPlaceholderJobId,
} from "./detect.js";
import type { AtsJob, BoardJobSummary, DetectedAts } from "./types.js";
import { parseApplicationQuestions } from "./application-form.js";

const UA =
  process.env.ATS_USER_AGENT ||
  "job-scout/2 (local; no apply)";

async function fetchText(
  url: string,
  opts?: { accept?: string },
): Promise<{ status: number; body: string; ok: boolean }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    let res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: opts?.accept || "application/json, text/html;q=0.9,*/*;q=0.8",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 800));
      res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Accept: opts?.accept || "application/json, text/html;q=0.9,*/*;q=0.8",
        },
        signal: ctrl.signal,
        redirect: "follow",
      });
    }
    const body = await res.text();
    return { status: res.status, body, ok: res.ok };
  } finally {
    clearTimeout(t);
  }
}

/** Decode common HTML entities (incl. double-escaped Greenhouse bodies). */
export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * HTML → plain text for JD storage/diff.
 * Decodes entities first so double-escaped markup (`&lt;div…`) becomes stripable tags.
 */
export function stripHtml(html: string): string {
  let s = decodeHtmlEntities(html);
  // Second pass if still entity-wrapped after partial decode
  if (/&lt;|&gt;|&amp;|&quot;/.test(s)) s = decodeHtmlEntities(s);
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ");
  s = decodeHtmlEntities(s);
  return s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function extractJsonLdJob(html: string): Partial<AtsJob> | null {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const data = JSON.parse(m[1]);
      const nodes = Array.isArray(data) ? data : data["@graph"] ? data["@graph"] : [data];
      for (const n of nodes) {
        if (n && (n["@type"] === "JobPosting" || n["@type"]?.includes?.("JobPosting"))) {
          const salary =
            n.baseSalary?.value?.value ||
            n.baseSalary?.value ||
            n.baseSalary?.minValue ||
            null;
          const salaryMax = n.baseSalary?.value?.maxValue || n.baseSalary?.maxValue;
          let salaryRaw: string | undefined;
          if (salary || salaryMax) {
            const cur = n.baseSalary?.currency || "USD";
            salaryRaw = salaryMax
              ? `${cur} ${salary}–${salaryMax}`
              : `${cur} ${salary}`;
          }
          return {
            title: n.title || n.name,
            descriptionText: n.description ? stripHtml(String(n.description)) : undefined,
            descriptionHtml: typeof n.description === "string" ? n.description : undefined,
            locationRaw:
              n.jobLocation?.address?.addressLocality ||
              n.jobLocation?.name ||
              (typeof n.jobLocation === "string" ? n.jobLocation : undefined) ||
              n.applicantLocationRequirements?.name,
            salaryRaw,
            employmentType: Array.isArray(n.employmentType)
              ? n.employmentType.join(", ")
              : n.employmentType,
            company: n.hiringOrganization?.name,
          };
        }
      }
    } catch {
      /* continue */
    }
  }
  return null;
}

function salaryFromGhContent(html: string): string | undefined {
  return extractSalaryRaw(stripHtml(html));
}

export async function fetchGreenhouseJob(
  token: string,
  jobId: string,
): Promise<AtsJob> {
  // Seed / non-numeric job paths must not hit the API or invent a title
  if (isPlaceholderJobId("greenhouse", jobId) || /^(careers|boards|jobs|example)$/i.test(token)) {
    return {
      provider: "greenhouse",
      boardToken: token,
      jobId,
      externalIdentity: `greenhouse:${token}:${jobId}`,
      title: "",
      url: `https://job-boards.greenhouse.io/${token}/jobs/${jobId}`,
      listingStatus: "open",
      rawPayload: { skipped: "placeholder_or_bad_token", token, jobId },
    };
  }
  // questions=true captures form prompts for application_qa later
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs/${encodeURIComponent(jobId)}?questions=true`;
  const { status, body, ok } = await fetchText(url);
  if (status === 404) {
    return {
      provider: "greenhouse",
      boardToken: token,
      jobId,
      externalIdentity: `greenhouse:${token}:${jobId}`,
      title: "",
      url: `https://job-boards.greenhouse.io/${token}/jobs/${jobId}`,
      listingStatus: "closed",
      rawPayload: { status, httpStatus: 404 },
    };
  }
  if (!ok) {
    throw new Error(`greenhouse job fetch failed: ${status}`);
  }
  const data = JSON.parse(body) as {
    id: number;
    title: string;
    absolute_url?: string;
    location?: { name?: string };
    content?: string;
    updated_at?: string;
    first_published?: string;
    company_name?: string;
    requisition_id?: string;
    departments?: Array<{ name?: string }>;
    offices?: Array<{ name?: string; location?: string | null }>;
    questions?: Array<{ label?: string; description?: string; required?: boolean }>;
    metadata?: unknown;
  };
  const html = data.content || "";
  const text = stripHtml(html);
  const questions = (data.questions || [])
    .map((q) => q.label || q.description || "")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 40);
  return {
    provider: "greenhouse",
    boardToken: token,
    jobId: String(data.id || jobId),
    externalIdentity: `greenhouse:${token}:${data.id || jobId}`,
    title: data.title || "",
    company: data.company_name,
    url: data.absolute_url || `https://job-boards.greenhouse.io/${token}/jobs/${jobId}`,
    applyUrl: data.absolute_url,
    locationRaw: data.location?.name,
    descriptionHtml: html,
    descriptionText: text,
    salaryRaw: salaryFromGhContent(html),
    departments: (data.departments || []).map((d) => d.name || "").filter(Boolean),
    offices: (data.offices || [])
      .map((o) => o.name || o.location || "")
      .filter(Boolean),
    requisitionId: data.requisition_id,
    postedAt: data.first_published,
    updatedAt: data.updated_at,
    questions,
    listingStatus: "open",
    rawPayload: {
      provider: "greenhouse",
      httpStatus: status,
      api: data as unknown as Record<string, unknown>,
    },
  };
}

function postingDate(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export async function listGreenhouseBoard(
  token: string,
  company: string,
): Promise<{ jobs: BoardJobSummary[]; total: number }> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=false`;
  const { status, body, ok } = await fetchText(url);
  if (!ok) throw new Error(`greenhouse board ${token}: ${status}`);
  const data = JSON.parse(body) as {
    jobs?: Array<{
      id: number;
      title: string;
      absolute_url?: string;
      first_published?: string;
      location?: { name?: string };
    }>;
  };
  const jobs = (data.jobs || []).map((j) => ({
    provider: "greenhouse",
    boardToken: token,
    jobId: String(j.id),
    externalIdentity: `greenhouse:${token}:${j.id}`,
    title: j.title,
    url: j.absolute_url,
    postedAt: postingDate(j.first_published),
    locationRaw: j.location?.name,
    company,
  }));
  return { jobs, total: jobs.length };
}

type AshbyLocation = string | { location?: string; locationName?: string; name?: string } | null | undefined;

function ashbyLocationText(value: AshbyLocation): string | undefined {
  if (typeof value === "string") {
    const t = value.trim();
    return t && t !== "[object Object]" ? t : undefined;
  }
  if (value && typeof value === "object") {
    for (const key of ["location", "locationName", "name"] as const) {
      const t = value[key];
      if (typeof t === "string" && t.trim()) return t.trim();
    }
  }
  return undefined;
}

function joinAshbyLocations(primary: AshbyLocation, secondary?: AshbyLocation[] | null): string | undefined {
  const parts = [ashbyLocationText(primary), ...(secondary || []).map(ashbyLocationText)].filter(
    (p): p is string => Boolean(p),
  );
  return parts.length ? [...new Set(parts)].join(" · ") : undefined;
}

export async function fetchAshbyJob(org: string, jobId: string, opts: { render?: HtmlRenderer } = {}): Promise<AtsJob> {
  const pageUrl = `https://jobs.ashbyhq.com/${org}/${jobId}`;
  // Ashby posting API (public)
  const apiUrl = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}?includeCompensation=true`;
  try {
    const { ok, body, status } = await fetchText(apiUrl);
    if (ok) {
      const data = JSON.parse(body) as {
        jobs?: Array<{
          id: string;
          title: string;
          jobUrl?: string;
          location?: string;
          descriptionHtml?: string;
          descriptionPlain?: string;
          isListed?: boolean;
          compensation?: { compensationTier?: Array<{ title?: string }> };
        }>;
      };
      const job = (data.jobs || []).find((j) => j.id === jobId) as
        | {
            id: string;
            title: string;
            jobUrl?: string;
            applyUrl?: string;
            location?: AshbyLocation;
            descriptionHtml?: string;
            descriptionPlain?: string;
            isListed?: boolean;
            isRemote?: boolean;
            employmentType?: string;
            workplaceType?: string;
            department?: string;
            team?: string;
            publishedAt?: string;
            secondaryLocations?: AshbyLocation[];
            compensation?: {
              compensationTiers?: Array<{
                title?: string;
                componentDescriptions?: Array<{ currencyCode?: string; minValue?: number; maxValue?: number }>;
              }>;
            };
          }
        | undefined;
      if (job) {
        const tier = job.compensation?.compensationTiers?.[0];
        const comp = tier?.componentDescriptions?.[0];
        let salaryRaw: string | undefined;
        if (comp && (comp.minValue || comp.maxValue)) {
          const cur = comp.currencyCode || "USD";
          salaryRaw =
            comp.minValue && comp.maxValue
              ? `${cur} ${comp.minValue}–${comp.maxValue}`
              : `${cur} ${comp.minValue || comp.maxValue}`;
        }
        const locationsJoined = joinAshbyLocations(job.location, job.secondaryLocations);
        const applyUrl = job.applyUrl || job.jobUrl || pageUrl;
        let questions: string[] | undefined;
        try {
          const form = await fetchText(applyUrl, { accept: "text/html" });
          if (form.ok) {
            const parsed = parseApplicationQuestions(form.body);
            if (parsed.length) questions = parsed.map((p) => (p.required ? `${p.question}*` : p.question));
          }
        } catch {
          /* SPA shell */
        }
        if (!questions?.length && opts.render) {
          try {
            const rendered = await opts.render(applyUrl);
            const html = rendered?.html;
            if (html) {
              const parsed = parseApplicationQuestions(html);
              if (parsed.length) questions = parsed.map((p) => (p.required ? `${p.question}*` : p.question));
            }
          } catch {
            /* harvest stays empty; Forms shows retry copy */
          }
        }
        return {
          provider: "ashby",
          boardToken: org,
          jobId,
          externalIdentity: `ashby:${org}:${jobId}`,
          title: job.title || "",
          url: job.jobUrl || pageUrl,
          applyUrl,
          locationRaw: locationsJoined,
          descriptionHtml: job.descriptionHtml,
          descriptionText: job.descriptionPlain || stripHtml(job.descriptionHtml || ""),
          salaryRaw,
          employmentType: job.employmentType,
          workplaceType: job.workplaceType || (job.isRemote ? "remote" : undefined),
          isRemote: job.isRemote,
          departments: [job.department, job.team].filter(Boolean) as string[],
          postedAt: job.publishedAt,
          listingStatus: job.isListed === false ? "closed" : "open",
          questions,
          formHarvestError: questions?.length ? undefined : "could not fetch form",
          rawPayload: {
            provider: "ashby",
            httpStatus: status,
            apiJob: job as unknown as Record<string, unknown>,
          },
        };
      }
    } else if (status === 404) {
      /* fall through */
    }
  } catch {
    /* fall through to HTML */
  }

  // Zero / example UUIDs are seed placeholders — do not scrape board index
  if (isPlaceholderJobId("ashby", jobId)) {
    return {
      provider: "ashby",
      boardToken: org,
      jobId,
      externalIdentity: `ashby:${org}:${jobId}`,
      title: "",
      url: pageUrl,
      listingStatus: "open",
      rawPayload: { skipped: "placeholder_job_id" },
    };
  }

  const page = await fetchText(pageUrl, { accept: "text/html" });
  if (page.status === 404) {
    return {
      provider: "ashby",
      boardToken: org,
      jobId,
      externalIdentity: `ashby:${org}:${jobId}`,
      title: "",
      url: pageUrl,
      listingStatus: "closed",
    };
  }
  const ld = extractJsonLdJob(page.body);
  const titleMatch = page.body.match(/<title>([^<]+)<\/title>/i);
  const rawTitle =
    ld?.title || titleMatch?.[1]?.replace(/\s*\|.*/, "").trim() || "";
  const shell =
    !rawTitle ||
    /^(jobs?|careers?|openings?)$/i.test(rawTitle) ||
    /^current\s+openings?\b/i.test(rawTitle) ||
    /\bopenings?\s+at\b/i.test(rawTitle);
  return {
    provider: "ashby",
    boardToken: org,
    jobId,
    externalIdentity: `ashby:${org}:${jobId}`,
    title: shell ? "" : rawTitle,
    url: pageUrl,
    locationRaw: ld?.locationRaw,
    descriptionText: ld?.descriptionText,
    descriptionHtml: ld?.descriptionHtml,
    salaryRaw: ld?.salaryRaw,
    listingStatus: "open",
    company: ld?.company,
    rawPayload: { source: "html", shellTitle: shell || undefined },
  };
}

export async function listAshbyBoard(
  token: string,
  company: string,
): Promise<{ jobs: BoardJobSummary[]; total: number }> {
  const apiUrl = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`;
  const { ok, body, status } = await fetchText(apiUrl);
  if (!ok) throw new Error(`ashby board ${token}: ${status}`);
  const data = JSON.parse(body) as {
    jobs?: Array<{
      id: string;
      title: string;
      jobUrl?: string;
      publishedAt?: string;
      location?: AshbyLocation;
      secondaryLocations?: AshbyLocation[];
    }>;
  };
  const jobs = (data.jobs || []).map((j) => ({
    provider: "ashby",
    boardToken: token,
    jobId: j.id,
    externalIdentity: `ashby:${token}:${j.id}`,
    title: j.title,
    url: j.jobUrl,
    postedAt: postingDate(j.publishedAt),
    locationRaw: joinAshbyLocations(j.location, j.secondaryLocations),
    company,
  }));
  return { jobs, total: jobs.length };
}

export async function fetchLeverJob(company: string, jobId: string): Promise<AtsJob> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(company)}/${encodeURIComponent(jobId)}`;
  const { status, body, ok } = await fetchText(url);
  if (status === 404) {
    return {
      provider: "lever",
      boardToken: company,
      jobId,
      externalIdentity: `lever:${company}:${jobId}`,
      title: "",
      url: `https://jobs.lever.co/${company}/${jobId}`,
      listingStatus: "closed",
    };
  }
  if (!ok) throw new Error(`lever job fetch failed: ${status}`);
  const data = JSON.parse(body) as {
    id: string;
    text: string;
    hostedUrl?: string;
    categories?: {
      location?: string;
      commitment?: string;
      team?: string;
      department?: string;
    };
    descriptionPlain?: string;
    description?: string;
    lists?: Array<{ text?: string; content?: string }>;
  };
  const lists = (data.lists || []) as Array<{ text?: string; content?: string }>;
  const listBlobs = lists
    .map((l) => [l.text, l.content ? stripHtml(l.content) : ""].filter(Boolean).join("\n"))
    .filter(Boolean);
  const descriptionText =
    data.descriptionPlain ||
    [stripHtml(data.description || ""), ...listBlobs].filter(Boolean).join("\n\n");
  return {
    provider: "lever",
    boardToken: company,
    jobId: data.id || jobId,
    externalIdentity: `lever:${company}:${data.id || jobId}`,
    title: data.text || "",
    url: data.hostedUrl || `https://jobs.lever.co/${company}/${jobId}`,
    applyUrl: data.hostedUrl,
    locationRaw: data.categories?.location,
    employmentType: data.categories?.commitment,
    descriptionText,
    descriptionHtml: data.description,
    departments: data.categories
      ? [data.categories.team, data.categories.department].filter(Boolean) as string[]
      : undefined,
    listingStatus: "open",
    rawPayload: {
      provider: "lever",
      api: data as unknown as Record<string, unknown>,
    },
  };
}

export async function listLeverBoard(
  token: string,
  company: string,
): Promise<{ jobs: BoardJobSummary[]; total: number }> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`;
  const { ok, body, status } = await fetchText(url);
  if (!ok) throw new Error(`lever board ${token}: ${status}`);
  const data = JSON.parse(body) as Array<{
    id: string;
    text: string;
    hostedUrl?: string;
    createdAt?: number;
    categories?: { location?: string };
  }>;
  const jobs = (Array.isArray(data) ? data : []).map((j) => ({
    provider: "lever",
    boardToken: token,
    jobId: j.id,
    externalIdentity: `lever:${token}:${j.id}`,
    title: j.text,
    url: j.hostedUrl,
    postedAt: postingDate(j.createdAt),
    locationRaw: j.categories?.location,
    company,
  }));
  return { jobs, total: jobs.length };
}

function isHtmlShellTitle(t: string): boolean {
  const s = t.trim();
  if (!s) return true;
  if (/^(jobs?|careers?|openings?|opportunities)$/i.test(s)) return true;
  if (/^current\s+openings?\b/i.test(s)) return true;
  if (/\bopenings?\s+at\b/i.test(s)) return true;
  if (/\b(jobs?|careers?)\s+at\b/i.test(s)) return true;
  if (/^all\s+(open\s+)?(jobs?|roles?)\b/i.test(s)) return true;
  if (/^we['']?re\s+hiring\b/i.test(s)) return true;
  if (/^closed(\s+role)?$/i.test(s)) return true;
  return false;
}

/** Optional JS renderer (Steel Browser in production). Returns rendered HTML or null when unavailable. */
export type HtmlRenderer = (url: string) => Promise<{ html: string | null; title?: string | null } | null>;

/** A generic fetch that found neither a title nor a description — the page is a JS shell. */
export function isShellResult(job: AtsJob): boolean {
  const rp = (job.rawPayload || {}) as { shellOnly?: boolean; source?: string };
  if (rp.source !== "html") return false;
  return Boolean(rp.shellOnly) || !(job.descriptionText && job.descriptionText.length >= 200);
}

export async function fetchGenericUrl(url: string, opts: { render?: HtmlRenderer } = {}): Promise<AtsJob> {
  const { status, body, ok } = await fetchText(url, { accept: "text/html" });
  if (status === 404) {
    return {
      provider: "unknown",
      title: "",
      url,
      listingStatus: "closed",
    };
  }
  if (!ok) throw new Error(`url fetch failed: ${status}`);
  const plain = extractFromHtml(url, body, status);
  // Workday embeds the posting state in the shell — no render needed to know it's gone.
  if (/\.myworkdayjobs\.com\//i.test(url) && /postingAvailable:\s*false/.test(body)) {
    return { ...plain, listingStatus: "closed", rawPayload: { ...(plain.rawPayload || {}), closedReason: "workday_posting_unavailable" } };
  }
  if (!opts.render || !isShellResult(plain)) return plain;
  // JS shell (Workday, SPA career pages): render in the browser plane and extract again.
  try {
    const rendered = await opts.render(url);
    if (rendered?.html) {
      // Workday answers 200 + the careers landing page for a posting that no longer exists.
      if (/\.myworkdayjobs\.com\//i.test(url) && !/jobPosting(Header|Description)/.test(rendered.html)) {
        return {
          ...plain,
          listingStatus: "closed",
          rawPayload: { ...(plain.rawPayload || {}), renderedBy: "steel", closedReason: "workday_redirect_home" },
        };
      }
      const viaBrowser = extractFromHtml(url, rendered.html, status);
      if (!isShellResult(viaBrowser) || (viaBrowser.title && !plain.title)) {
        return { ...viaBrowser, rawPayload: { ...(viaBrowser.rawPayload || {}), source: "html", renderedBy: "steel" } };
      }
    }
  } catch (e) {
    return { ...plain, rawPayload: { ...(plain.rawPayload || {}), renderError: e instanceof Error ? e.message : String(e) } };
  }
  return plain;
}

function extractFromHtml(url: string, body: string, status: number): AtsJob {
  const ld = extractJsonLdJob(body);
  const titleMatch = body.match(/<title>([^<]+)<\/title>/i);
  const h1 = body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const candidates = [
    ld?.title,
    h1 ? stripHtml(h1[1]) : null,
    titleMatch?.[1]?.replace(/\s*\|.*/, "").trim(),
  ].filter((x): x is string => Boolean(x && String(x).trim()));
  const picked = candidates.find((c) => !isHtmlShellTitle(c)) || "";
  const det = detectAts(url);
  return {
    provider: det.provider === "unknown" ? "other" : det.provider,
    boardToken: det.boardToken,
    jobId: det.jobId,
    externalIdentity: externalIdentityFromDetect(det),
    title: picked,
    url,
    locationRaw: ld?.locationRaw,
    descriptionText:
      ld?.descriptionText ||
      (picked ? stripHtml(body).slice(0, 12000) : undefined),
    descriptionHtml: ld?.descriptionHtml,
    salaryRaw: ld?.salaryRaw,
    employmentType: ld?.employmentType,
    company: ld?.company,
    listingStatus: "open",
    rawPayload: {
      source: "html",
      shellOnly: !picked || undefined,
      detected: det,
      jsonLd: ld || null,
      titleCandidates: candidates,
      httpStatus: status,
      htmlExcerpt: body.slice(0, 4000),
    },
  };
}

function skippedPlaceholder(detected: DetectedAts, url: string): AtsJob {
  return {
    provider: detected.provider,
    boardToken: detected.boardToken,
    jobId: detected.jobId,
    externalIdentity: externalIdentityFromDetect(detected),
    title: "",
    url,
    listingStatus: "open",
    rawPayload: {
      skipped: "placeholder_detection",
      detected,
    },
  };
}

/**
 * Fetch a single job from any supported ATS or generic career URL.
 * Always returns structured fields + rawPayload for CRM storage.
 * Placeholder seed URLs skip network (empty title — caller keeps prior title).
 */
export async function fetchJobFromUrl(url: string, opts: { render?: HtmlRenderer } = {}): Promise<AtsJob> {
  const detected = detectAts(url);

  if (isPlaceholderAtsDetection(detected)) {
    return skippedPlaceholder(detected, url);
  }

  if (detected.provider === "greenhouse" && detected.boardToken && detected.jobId) {
    return fetchGreenhouseJob(detected.boardToken, detected.jobId);
  }
  if (detected.provider === "ashby" && detected.boardToken && detected.jobId) {
    return fetchAshbyJob(detected.boardToken, detected.jobId, { render: opts.render });
  }
  if (detected.provider === "lever" && detected.boardToken && detected.jobId) {
    return fetchLeverJob(detected.boardToken, detected.jobId);
  }

  // Workday / SmartRecruiters / Workable / LinkedIn / etc. → HTML + JSON-LD,
  // falling back to a rendered page when the plain fetch is a JS shell.
  const generic = await fetchGenericUrl(url, opts);
  return {
    ...generic,
    provider: detected.provider !== "unknown" ? detected.provider : generic.provider,
    boardToken: detected.boardToken || generic.boardToken,
    jobId: detected.jobId || generic.jobId,
    externalIdentity:
      externalIdentityFromDetect(detected) || generic.externalIdentity,
    rawPayload: {
      ...(generic.rawPayload || {}),
      detected,
    },
  };
}

const REMOTEOK_API = "https://remoteok.com/api";
const REMOTEOK_CRAFT_TAGS = new Set([
  "devops",
  "sre",
  "platform",
  "infra",
  "infrastructure",
  "observability",
  "kubernetes",
  "k8s",
]);
const REMOTEOK_TITLE_GATED_TAGS = new Set(["sys admin", "sysadmin", "infosec"]);

type RemoteOkRow = {
  id?: string | number;
  slug?: string;
  position?: string;
  company?: string;
  location?: string;
  url?: string;
  tags?: unknown;
  date?: string;
};

function remoteOkTags(row: RemoteOkRow): string[] {
  if (!Array.isArray(row.tags)) return [];
  return row.tags
    .map((t) => String(t || "").toLowerCase().replace(/^#/, "").trim())
    .filter(Boolean);
}

function isRemoteOkCraft(title: string, tags: string[]): boolean {
  if (isCraftMatch(title)) return true;
  if (tags.some((t) => REMOTEOK_CRAFT_TAGS.has(t))) return true;
  return tags.some((t) => REMOTEOK_TITLE_GATED_TAGS.has(t)) && isCraftMatch(title);
}

export async function listRemoteOk(
  token: string,
  company: string,
): Promise<{ jobs: BoardJobSummary[]; total: number }> {
  const { status, body, ok } = await fetchText(REMOTEOK_API);
  if (!ok) throw new Error(`remoteok board: ${status}`);
  const data = JSON.parse(body) as unknown;
  if (!Array.isArray(data)) throw new Error("remoteok board: unexpected payload");
  const boardToken = token || "remoteok";
  const jobs: BoardJobSummary[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as RemoteOkRow;
    const jobId = row.id == null ? "" : String(row.id).trim();
    const title = String(row.position || "").trim();
    if (!jobId || !title) continue;
    const tags = remoteOkTags(row);
    if (!isRemoteOkCraft(title, tags)) continue;
    const url =
      typeof row.url === "string" && /^https?:\/\//i.test(row.url)
        ? row.url
        : row.slug
          ? `https://remoteok.com/remote-jobs/${row.slug}`
          : undefined;
    jobs.push({
      provider: "remoteok",
      boardToken,
      jobId,
      externalIdentity: `remoteok:${jobId}`,
      postedAt: postingDate(row.date),
      title,
      url,
      locationRaw: typeof row.location === "string" ? row.location : undefined,
      company: String(row.company || company || "").trim() || company,
    });
  }
  return { jobs, total: jobs.length };
}

function isRemoteOkBoard(provider: string, token: string): boolean {
  if (provider === "remoteok") return true;
  return provider === "market" && token.toLowerCase() === "remoteok";
}

const WWR_RSS = "https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss";

function rssField(block: string, tag: string): string {
  const cdata = block.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, "i"),
  );
  if (cdata?.[1] != null) return decodeHtmlEntities(cdata[1]).replace(/\s+/g, " ").trim();
  const plain = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  if (plain?.[1] == null) return "";
  return decodeHtmlEntities(plain[1]).replace(/\s+/g, " ").trim();
}

function splitWwrTitle(raw: string): { company: string; title: string } {
  const t = raw.replace(/\s+/g, " ").trim();
  const idx = t.indexOf(": ");
  if (idx > 0 && idx < t.length - 2) {
    return { company: t.slice(0, idx).trim(), title: t.slice(idx + 2).trim() };
  }
  return { company: "", title: t };
}

function wwrJobId(link: string): string {
  try {
    const slug = new URL(link).pathname.split("/").filter(Boolean).pop() || "";
    return slug || link;
  } catch {
    return link;
  }
}

export async function listWeWorkRemotely(
  token: string,
  company: string,
): Promise<{ jobs: BoardJobSummary[]; total: number }> {
  const { status, body, ok } = await fetchText(WWR_RSS, {
    accept: "application/rss+xml, application/xml, text/xml;q=0.9,*/*;q=0.8",
  });
  if (!ok) throw new Error(`weworkremotely board: ${status}`);
  const boardToken = token || "weworkremotely";
  const jobs: BoardJobSummary[] = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(body))) {
    const block = m[1];
    const rawTitle = rssField(block, "title");
    const link = rssField(block, "link") || rssField(block, "guid");
    if (!rawTitle || !link) continue;
    const parsed = splitWwrTitle(rawTitle);
    const title = parsed.title || rawTitle;
    if (!isCraftMatch(title)) continue;
    const jobId = wwrJobId(link);
    jobs.push({
      provider: "weworkremotely",
      boardToken,
      jobId,
      externalIdentity: `weworkremotely:${jobId}`,
      postedAt: postingDate(rssField(block, "pubDate")),
      title,
      url: /^https?:\/\//i.test(link) ? link : undefined,
      locationRaw: rssField(block, "region") || undefined,
      company: parsed.company || company,
    });
  }
  return { jobs, total: jobs.length };
}

function isWeWorkRemotelyBoard(provider: string, token: string): boolean {
  if (provider === "weworkremotely") return true;
  return provider === "market" && token.toLowerCase() === "weworkremotely";
}

const REMOTIVE_API = "https://remotive.com/api/remote-jobs?category=software-dev";

type RemotiveRow = {
  id?: string | number;
  url?: string;
  title?: string;
  company_name?: string;
  candidate_required_location?: string;
  publication_date?: string;
};

export async function listRemotive(
  token: string,
  company: string,
): Promise<{ jobs: BoardJobSummary[]; total: number }> {
  const { status, body, ok } = await fetchText(REMOTIVE_API);
  if (!ok) throw new Error(`remotive board: ${status}`);
  const data = JSON.parse(body) as { jobs?: unknown };
  if (!Array.isArray(data.jobs)) throw new Error("remotive board: unexpected payload");
  const boardToken = token || "remotive";
  const jobs: BoardJobSummary[] = [];
  for (const raw of data.jobs) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as RemotiveRow;
    const jobId = row.id == null ? "" : String(row.id).trim();
    const title = String(row.title || "").trim();
    if (!jobId || !title) continue;
    if (!isCraftMatch(title)) continue;
    jobs.push({
      provider: "remotive",
      boardToken,
      jobId,
      externalIdentity: `remotive:${jobId}`,
      title,
      url: typeof row.url === "string" && /^https?:\/\//i.test(row.url) ? row.url : undefined,
      locationRaw: typeof row.candidate_required_location === "string" ? row.candidate_required_location : undefined,
      postedAt: postingDate(row.publication_date),
      company: String(row.company_name || company || "").trim() || company,
    });
  }
  return { jobs, total: jobs.length };
}

function isRemotiveBoard(provider: string, token: string): boolean {
  if (provider === "remotive") return true;
  return provider === "market" && token.toLowerCase() === "remotive";
}

export async function listBoard(
  provider: string,
  token: string,
  company: string,
): Promise<{ jobs: BoardJobSummary[]; total: number }> {
  if (provider === "greenhouse") return listGreenhouseBoard(token, company);
  if (provider === "ashby") return listAshbyBoard(token, company);
  if (provider === "lever") return listLeverBoard(token, company);
  if (isRemoteOkBoard(provider, token)) return listRemoteOk(token, company);
  if (isWeWorkRemotelyBoard(provider, token)) return listWeWorkRemotely(token, company);
  if (isRemotiveBoard(provider, token)) return listRemotive(token, company);
  throw new Error(`unsupported board provider: ${provider}`);
}
