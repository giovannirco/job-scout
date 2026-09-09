import { isShellJobTitle } from "./listing-title.js";

export const CLIP_TEXT_MAX = 80_000;

export type ClipSnapshotInput = {
  url: string;
  title?: string;
  text?: string;
};

export type ParsedClipListing = {
  url: string;
  title: string;
  company?: string;
  descriptionText: string;
};

export function clipBookmarklet(origin: string): string {
  if (!origin) throw new Error("origin required");
  const base = origin.replace(/\/+$/, "");
  const action = JSON.stringify(`${base}/clip`);
  return `javascript:void((function(){var f=document.createElement('form');f.method='POST';f.action=${action};f.target='_blank';function h(n,v){var i=document.createElement('input');i.type='hidden';i.name=n;i.value=v;f.appendChild(i)}h('url',location.href);h('title',document.title);h('text',(document.body&&document.body.innerText||'').slice(0,${CLIP_TEXT_MAX}));document.documentElement.appendChild(f);f.submit()})())`;
}

const SITE_SUFFIX =
  /\s*(?:[|·•]|[-–—])\s*(LinkedIn|Indeed(?:\.com)?|Glassdoor|ZipRecruiter)\s*$/i;

export function parseClipListing(input: ClipSnapshotInput): ParsedClipListing {
  const url = (input.url || "").trim();
  const descriptionText = String(input.text || "").slice(0, CLIP_TEXT_MAX);
  const parsed = parseTitleCompany(input.title || "", descriptionText);
  return { url, title: parsed.title, company: parsed.company, descriptionText };
}

function parseTitleCompany(rawTitle: string, text: string): { title: string; company?: string } {
  let t = rawTitle.trim().replace(SITE_SUFFIX, "").trim();
  t = t.replace(SITE_SUFFIX, "").trim();

  const atIdx = t.toLowerCase().lastIndexOf(" at ");
  if (atIdx >= 3) {
    const title = t.slice(0, atIdx).trim();
    const company = cleanCompany(t.slice(atIdx + 4));
    if (title.length >= 3 && company && !isSiteName(company)) return { title, company };
  }

  const pipe = t
    .split(/\s*[|·•]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (pipe.length >= 2) {
    const company = cleanCompany(pipe[pipe.length - 1]!);
    const title = pipe.slice(0, -1).join(" | ");
    if (company && title.length >= 3 && !isSiteName(company)) return { title, company };
  }

  const dash = t.match(/^(.*)\s+[-–—]\s+(.+)$/);
  if (dash) {
    const title = dash[1]!.trim();
    const company = cleanCompany(dash[2]!);
    if (title.length >= 3 && company && !isSiteName(company) && company.length <= 80 && !looksLikeLocation(company)) {
      return { title, company };
    }
  }

  let title = t;
  if (!title || isSiteName(title) || isShellJobTitle(title)) {
    const first = firstMeaningfulLine(text);
    if (first) title = first;
  }
  return { title: title || "" };
}

function cleanCompany(s: string): string {
  return s.replace(SITE_SUFFIX, "").replace(/\s+/g, " ").trim();
}

function isSiteName(s: string): boolean {
  return /^(linkedin|indeed(?:\.com)?|glassdoor|ziprecruiter|jobs?|careers?)$/i.test(s.trim());
}

function looksLikeLocation(s: string): boolean {
  return /^(remote|hybrid|on-?site|worldwide|usa|uk|latam)\b/i.test(s) || /,\s*[A-Z]{2}$/.test(s);
}

function firstMeaningfulLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (s.length >= 3 && s.length <= 140 && !isSiteName(s) && !isShellJobTitle(s)) return s;
  }
  return "";
}
