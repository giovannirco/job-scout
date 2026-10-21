import { coreEnv } from "./env.js";
import { log as rootLog } from "@job-scout/shared";

const log = rootLog.child({ scope: "threat-intel" });
const RDAP_TIMEOUT = 4_000;
const DAY_MS = 86_400_000;

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ThreatRiskLevel = "safe" | "low" | "medium" | "high" | "critical";

export type DomainInfo = {
  domain: string;
  registeredAt?: string;
  ageDays?: number;
  registrar?: string;
  rdapAvailable: boolean;
};

/**
 * Structured verdict only. Inbound outreach is untrusted input, so flags are
 * fixed strings from this module and the raw sender/message is never echoed.
 */
export type ThreatEvaluation = {
  normalizedDomain?: string;
  registeredDomain?: string;
  riskLevel: ThreatRiskLevel;
  isThreat: boolean;
  /** 0 (clean) to 1 (dangerous). */
  score: number;
  flags: string[];
  recommendations: string[];
  domainInfo?: DomainInfo;
};

/**
 * Built-in blocklist ships empty on purpose: naming people or domains in
 * public source goes stale and can defame. Operators add their own domains
 * through THREAT_BLOCKLIST_DOMAINS (comma-separated).
 */
export const DEFAULT_THREAT_BLOCKLIST: readonly string[] = [];

export const FREE_EMAIL_PROVIDERS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com",
  "proton.me", "protonmail.com", "icloud.com", "zoho.com", "aol.com", "gmx.com", "mail.com",
]);

/** Common two-label public suffixes. Small on purpose; avoids a PSL dependency. */
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk",
  "com.br", "net.br", "org.br",
  "com.au", "net.au", "org.au",
  "co.nz", "co.jp", "co.za", "co.in", "co.kr",
  "com.mx", "com.ar", "com.cn", "com.tr", "com.sg", "com.hk",
]);

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Lowercase hostname from an email, URL or bare domain. Null for IPs and single-label hosts. */
export function extractDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (s.includes("@") && !s.includes("/")) s = s.slice(s.lastIndexOf("@") + 1);
  else {
    try {
      s = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(s) ? s : `https://${s}`).hostname;
    } catch {
      return null;
    }
  }
  s = s.replace(/\.$/, "").replace(/^www\./, "");
  return HOST_RE.test(s) ? s : null;
}

/** Registrable domain: last two labels, or three under a known multi-part suffix. */
export function registeredDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const n = MULTI_PART_SUFFIXES.has(labels.slice(-2).join(".")) ? 3 : 2;
  return labels.slice(-n).join(".");
}

/** Dot-boundary match: blocking example.net catches mail.example.net but not badexample.net. */
export function matchesBlocklist(domain: string, list: readonly string[]): string | null {
  const d = domain.toLowerCase();
  for (const raw of list) {
    const p = raw.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
    if (p && (d === p || d.endsWith(`.${p}`))) return p;
  }
  return null;
}

/** Registration age from rdap.org. Network or parse failure returns rdapAvailable=false; never throws. */
export async function queryDomainRdap(
  domain: string,
  opts: { fetchFn?: FetchFn; timeoutMs?: number; now?: number } = {},
): Promise<DomainInfo> {
  const info: DomainInfo = { domain, rdapAvailable: false };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? RDAP_TIMEOUT);
  try {
    const res = await (opts.fetchFn ?? fetch)(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      headers: { Accept: "application/rdap+json, application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      log.debug("rdap.not_ok", { domain, status: res.status });
      return info;
    }
    const data = (await res.json()) as {
      events?: { eventAction?: string; eventDate?: string }[];
      entities?: { roles?: string[]; vcardArray?: unknown }[];
    };
    info.rdapAvailable = true;
    const reg = (data.events ?? []).find((e) => e.eventAction === "registration");
    const t = reg?.eventDate ? Date.parse(reg.eventDate) : NaN;
    if (!Number.isNaN(t)) {
      info.registeredAt = new Date(t).toISOString();
      info.ageDays = Math.max(0, Math.floor(((opts.now ?? Date.now()) - t) / DAY_MS));
    }
    const registrar = (data.entities ?? []).find((e) => e.roles?.includes("registrar"));
    const vcard = Array.isArray(registrar?.vcardArray) ? (registrar.vcardArray[1] as unknown) : undefined;
    const fn = Array.isArray(vcard) ? vcard.find((v) => Array.isArray(v) && v[0] === "fn") : undefined;
    if (Array.isArray(fn) && typeof fn[3] === "string") info.registrar = fn[3].slice(0, 120);
    return info;
  } catch (err) {
    log.debug("rdap.failed", { domain, err: err instanceof Error ? err.message : String(err) });
    return { domain, rdapAvailable: false };
  } finally {
    clearTimeout(timer);
  }
}

type ContentSignal = { label: string; weight: number; re: RegExp };

/**
 * Lures seen in fake-interview malware campaigns. Ordinary take-home wording
 * (clone, npm install, npm test) is not a signal on its own.
 */
const CONTENT_SIGNALS: ContentSignal[] = [
  { label: "Asks to download or run an installer (.dmg/.pkg/.exe/.msi)", weight: 0.25, re: /\.(dmg|pkg|exe|msi|scr)\b/ },
  { label: "Asks to install or update meeting software from a link", weight: 0.25, re: /\b(update|install|download)\b[^.\n]{0,40}\b(zoom|teams|webex|meeting|video call)\b[^.\n]{0,30}\b(client|app|plugin|driver|update|fix)\b/ },
  { label: "Pipes a remote script into a shell", weight: 0.3, re: /\b(curl|wget)\b[^\n|]{0,200}\|\s*(sudo\s+)?(ba|z)?sh\b/ },
  { label: "Asks to disable antivirus or OS protections", weight: 0.3, re: /\b(disable|turn off)\b[^.\n]{0,30}\b(antivirus|defender|gatekeeper|firewall|security software)\b/ },
  { label: "Asks for wallet seed phrase or private key", weight: 0.3, re: /\b(seed phrase|recovery phrase|private key|mnemonic)\b/ },
  { label: "Asks to run code before any human interview", weight: 0.1, re: /\b(before|prior to)\b[^.\n]{0,30}\b(call|interview|meeting)\b[^.\n]{0,40}\b(run|execute|start)\b|\b(run|execute|start)\b[^.\n]{0,40}\b(before|prior to)\b[^.\n]{0,20}\b(call|interview|meeting)\b/ },
];

export const CONTENT_SCORE_CAP = 0.4;

/** Content heuristics. Combined score is capped so text alone cannot reach "high". */
export function analyzeOutreachText(text: string): { flags: string[]; score: number } {
  const lower = text.slice(0, 20_000).toLowerCase();
  const hits = CONTENT_SIGNALS.filter((s) => s.re.test(lower));
  const score = Math.min(CONTENT_SCORE_CAP, hits.reduce((n, s) => n + s.weight, 0));
  return { flags: hits.map((s) => s.label), score: Math.round(score * 100) / 100 };
}

function riskOf(score: number): ThreatRiskLevel {
  if (score >= 0.75) return "critical";
  if (score >= 0.5) return "high";
  if (score >= 0.3) return "medium";
  if (score > 0.05) return "low";
  return "safe";
}

/** Screen inbound recruiter outreach: operator blocklist, domain age (RDAP), free-mail sender, content lures. */
export async function evaluateRecruiterThreat(
  input: { domainOrEmail: string; messageText?: string },
  opts: { fetchFn?: FetchFn; skipRdap?: boolean; blocklist?: readonly string[]; now?: number } = {},
): Promise<ThreatEvaluation> {
  const domain = extractDomain(input.domainOrEmail);
  const root = domain ? registeredDomain(domain) : undefined;
  const flags: string[] = [];
  const recommendations: string[] = [];
  let score = 0;

  const blocklist = opts.blocklist ?? [...DEFAULT_THREAT_BLOCKLIST, ...coreEnv.threatBlocklistDomains];
  if (domain && matchesBlocklist(domain, blocklist)) {
    return {
      normalizedDomain: domain,
      registeredDomain: root,
      riskLevel: "critical",
      isThreat: true,
      score: 1,
      flags: ["Sender domain is on the operator blocklist"],
      recommendations: ["Do not reply, open links or run code from this sender."],
    };
  }

  if (!domain) flags.push("No valid sender domain could be parsed");

  const freeMail = !!domain && FREE_EMAIL_PROVIDERS.has(domain);
  if (freeMail) {
    score += 0.15;
    flags.push("Recruiter writes from a free email provider");
    recommendations.push("Confirm the recruiter on the company's own site or careers page.");
  }

  let domainInfo: DomainInfo | undefined;
  if (root && !freeMail && !opts.skipRdap) {
    domainInfo = await queryDomainRdap(root, { fetchFn: opts.fetchFn, now: opts.now });
    const age = domainInfo.ageDays;
    if (age != null && age < 30) {
      score += 0.5;
      flags.push(`Sender domain was registered ${age} days ago`);
      recommendations.push("Treat as a likely throwaway domain. Do not run any code it sends.");
    } else if (age != null && age < 180) {
      score += 0.25;
      flags.push(`Sender domain is less than six months old (${age} days)`);
      recommendations.push("Verify the company independently before engaging.");
    } else if (!domainInfo.rdapAvailable) {
      flags.push("Domain age unavailable (RDAP lookup failed)");
    }
  }

  if (input.messageText) {
    const content = analyzeOutreachText(input.messageText);
    flags.push(...content.flags);
    score += content.score;
    if (content.flags.length) recommendations.push("Run any take-home only in a disposable VM or container, never on your main machine.");
  }

  score = Math.min(1, Math.round(score * 100) / 100);
  const riskLevel = riskOf(score);
  if (!recommendations.length) recommendations.push("No strong indicators found. Standard verification applies.");

  return {
    normalizedDomain: domain ?? undefined,
    registeredDomain: root,
    riskLevel,
    isThreat: score >= 0.5,
    score,
    flags,
    recommendations,
    domainInfo,
  };
}
