import type { CraftFamily, GeoClass, MatchLabel, Workplace } from "./types.js";

const TITLE_RE =
  /\b(platform|devops|sre|site\s*reliability|reliability\s*engineer|infrastructure|infra|cloud\s*platform|production\s*engineer|observability|telemetry|release\s*engineer|gitops|developer\s*experience|devex|engineering\s*productivity|ai\s*platform|ai\s*infrastructure|ml\s*infra|mlops|platform\s*engineer|internal\s*developer|kubernetes|k8s|compute\s*infra|systems\s*engineer|cloud\s*engineer|devops\s*engineer|staff\s*engineer.*infra|network\s*engineer|security\s*engineer.*infra|platform\s*sre|infra(structure)?\s*sre)\b/i;

const NOISE_RE =
  /\b(account\s*executive|account\s*director|sales\s*director|enterprise\s*account|business\s*development|bdr\b|sdr\b|recruiter|talent\s*acquisition|sourcer|customer\s*success|support\s*engineer|technical\s*support|brand\s*designer|product\s*designer|ux\s*researcher|product\s*manager|program\s*manager|project\s*manager|technical\s*program\s*manager|\btpm\b|legal|counsel|attorney|finance\s*manager|accountant|marketing|copywriter|content\s*writer|people\s*ops|\bhr\b|office\s*manager|workplace\s*operations|mobile\s*software|react\s*native|ios\s*engineer|android\s*engineer|decision\s*scientist|data\s*scientist|public\s*relations|\bpr\b\s*associate|communications)\b/i;

const GEO_HARD_RE =
  /(?:\b(united\s*states|usa|u\.s\.|america)\s*only\b|\bremote\s*[-–—]?\s*usa?\b|\bremote\s*us\s*only\b|\bus\s*remote\s*only\b|\bus\s+only\b|\bcanada\s*only\b|\b(uk|united\s*kingdom)\s*only\b|\b(eu|emea|europe)\s*only\b|\bindia\s*only\b|\b(lisbon|london|dublin|berlin|amsterdam|vilnius|kaunas|tokyo|singapore|sydney|toronto|chicago|geneva)\b|\bhybrid\b.*\b(san\s*francisco|new\s*york|seattle|london|tokyo)\b|\bon[\s-]*site\b|\boffice\s*based\b)/i;

const GEO_FRIENDLY_RE =
  /(?:\bbrazil\b|\bbrasil\b|\blatam\b|\blatin\s*america\b|\bamericas\b|\bworldwide\b|\banywhere\b|\bglobal\b|\bwork\s*from\s*anywhere\b|\bfully\s*remote\b|\bremote\s*[-–—]?\s*brazil\b)/i;

const GEO_AMBIGUOUS_MARKERS = /\bremote\b|\bremoto\b|\bdistributed\b|\bremote[\s-]*first\b|^all$/i;

const BRAZIL_PLACE = /\b(brazil|brasil|s[aã]o paulo|sao paulo|rio de janeiro|belo horizonte|curitiba|porto alegre|recife|florian[oó]polis|bras[ií]lia)\b/i;
const FOREIGN_REGION = /\b(namer|north america|united states|us|usa|canada|uk|eu|emea|europe|apac|apj|india|united kingdom|england|scotland|wales|netherlands|argentina|chile|colombia|peru|uruguay|paraguay|mexico|bolivia|ecuador|turkey|t[uü]rkiye|spain|ireland|greece|portugal|poland|romania|australia|norway|israel|switzerland|germany|france|italy|hungary|japan|sweden|denmark|finland|belgium|austria|czechia|czech republic|south africa|new zealand|south korea|korea|taiwan|hong kong|singapore)\b/i;

// Cities the board list names without "only" or "onsite". A single named place is a restriction.
const HARD_CITY =
  /\b(seattle|san francisco|\bsf\b|new york|\bnyc\b|bay area|palo alto|bangalore|bengaluru|melbourne|boston|austin|los angeles|mountain view|redmond|bellevue|london|dublin|berlin|amsterdam|lisbon|tokyo|sydney|toronto|chicago|geneva|vilnius|kaunas|lugano|sao paulo|s[aã]o paulo)\b/i;

const US_STATE_ABBR = new Set(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(
    " ",
  ),
);

const FRIENDLY_PLACE = /\b(latam|latin america|americas|worldwide|anywhere|global)\b/i;

const GEO_EXCLUSIVITY_RE = /\b(only|must\s+reside|must\s+be\s+located|must\s+live)\b/i;

const CORE_ENG_RE =
  /\b(software\s*engineer|sre|devops|site\s*reliability|platform\s*engineer|infrastructure\s*engineer|reliability\s*engineer)\b/i;

const HARD_NOISE_DOMINANT_RE =
  /\b(account\s*executive|sales|recruiter|talent|customer\s*success|brand\s*designer|product\s*manager)\b/i;

export function normalizeTitle(title: string): string {
  return (title || "").replace(/\s+/g, " ").trim();
}

export function isNoiseTitle(title: string): boolean {
  const t = normalizeTitle(title);
  return Boolean(t && NOISE_RE.test(t));
}

export function isCraftMatch(title: string): boolean {
  const t = normalizeTitle(title);
  if (!t) return false;
  if (NOISE_RE.test(t) && !TITLE_RE.test(t)) return false;
  if (NOISE_RE.test(t) && TITLE_RE.test(t)) {
    if (CORE_ENG_RE.test(t)) {
      return !HARD_NOISE_DOMINANT_RE.test(t);
    }
    return false;
  }
  return TITLE_RE.test(t);
}

export function titleInteresting(title: string): boolean {
  return isCraftMatch(title);
}

export function craftFamily(title: string): CraftFamily {
  const t = normalizeTitle(title).toLowerCase();
  if (!t) return "unknown";
  if (isNoiseTitle(t) && !isCraftMatch(t)) return "noise";
  // AI infra before generic platform (e.g. "AI Platform Engineer")
  if (/\b(ai\s*platform|ai\s*infrastructure|mlops|ml\s*infra)\b/i.test(t)) return "ai_infra";
  if (/\b(sre|site\s*reliability|reliability\s*engineer)\b/i.test(t)) return "sre";
  if (
    /\b(platform\s*engineer|cloud\s*platform|internal\s*developer|devex|developer\s*experience|engineering\s*productivity)\b/i.test(
      t,
    )
  ) {
    return "platform";
  }
  if (/\b(devops)\b/i.test(t)) return "devops";
  if (/\b(observability|telemetry)\b/i.test(t)) return "observability";
  if (/\b(infrastructure|infra|kubernetes|k8s|compute|bare\s*metal|network\s*engineer)\b/i.test(t))
    return "infra";
  if (/\b(release\s*engineer|gitops)\b/i.test(t)) return "release";
  if (isCraftMatch(t)) return "platform_adjacent";
  return "other";
}

export function locationSegments(location = ""): string[] {
  return location
    .split(/\s*[·•;|/]\s*|,\s*/)
    .map((p) => p.replace(GEO_EXCLUSIVITY_RE, "").trim())
    .filter((p) => p && !/^(remote|hybrid|onsite|on-site|distributed)$/i.test(p));
}

export function isTzOverlapLocation(location = ""): boolean {
  if (GEO_EXCLUSIVITY_RE.test(location)) return false;
  return locationSegments(location).length >= 3;
}

function segmentIsUsState(segment: string): boolean {
  const s = segment.trim();
  return US_STATE_ABBR.has(s);
}

function specificPlace(location: string): boolean {
  return FOREIGN_REGION.test(location) || HARD_CITY.test(location) || locationSegments(location).some(segmentIsUsState);
}

/** Three or more places, and not only cities, is a country list rather than one office. */
function isCountryList(location: string): boolean {
  if (!isTzOverlapLocation(location)) return false;
  const segs = locationSegments(location);
  if (!segs.length) return false;
  if (segs.some((s) => HARD_CITY.test(s))) return false;
  const cityOrState = segs.filter((s) => HARD_CITY.test(s) || segmentIsUsState(s)).length;
  return cityOrState < segs.length;
}

/** A single city, country, or office list. Remote wording and country lists are not offices. */
export function isNamedOffice(location = ""): boolean {
  const loc = location.trim();
  if (!loc || FRIENDLY_PLACE.test(loc)) return false;
  if (/\b(remote|remoto|hybrid|on[\s-]*site|worldwide|global|anywhere|distributed)\b/i.test(loc)) return false;
  if (isCountryList(loc)) return false;
  return specificPlace(loc);
}

export function geoClass(
  location = "",
  workplace = "",
  extra = "",
): GeoClass {
  const blob = [location, workplace, extra].filter(Boolean).join(" | ");
  if (!blob.trim()) return "unknown";
  // A remote modality or continent abbreviation is not work authorization.
  if (GEO_EXCLUSIVITY_RE.test(blob) && FOREIGN_REGION.test(blob) && !BRAZIL_PLACE.test(blob)) return "hard_geo";
  if (BRAZIL_PLACE.test(location)) return "brazil_friendly";
  if (/\b(amer|samer|south america)\b/i.test(blob)) return "worldwideish";
  // One country or city is a place restriction. A friendly token (LATAM, worldwide) still wins.
  if (specificPlace(location) && !isTzOverlapLocation(location) && !FRIENDLY_PLACE.test(location)) return "hard_geo";
  // Hard geo can appear with "remote" — check hard before ambiguous, but after brazil/worldwide friendly
  if (GEO_FRIENDLY_RE.test(blob)) {
    return /brazil|brasil|latam|latin\s*america/i.test(blob)
      ? "brazil_friendly"
      : "worldwideish";
  }
  if (GEO_EXCLUSIVITY_RE.test(blob)) return "hard_geo";
  if (isTzOverlapLocation(location)) {
    if (GEO_AMBIGUOUS_MARKERS.test(blob)) return "ambiguous_remote";
    // Several offices and no remote marker: still a place, not "we could not tell".
    if (specificPlace(location) && !FRIENDLY_PLACE.test(location) && !BRAZIL_PLACE.test(location)) return "hard_geo";
    return "unknown";
  }
  if (GEO_HARD_RE.test(blob)) return "hard_geo";
  if (GEO_AMBIGUOUS_MARKERS.test(blob)) return "ambiguous_remote";
  return "unknown";
}

export function isCompanyNameLocation(location: string, company: string): boolean {
  const loc = (location || "").trim().toLowerCase();
  const co = (company || "").trim().toLowerCase();
  if (!loc || !co) return false;
  if (loc === co) return true;
  if (co.startsWith(loc) && loc.length >= 4) return true;
  if (loc.startsWith(co) && co.length >= 4) return true;
  return false;
}

export function workplaceOf(
  workplaceType?: string | null,
  isRemote?: boolean | null,
  location = "",
): Workplace {
  const wt = (workplaceType || "").trim().toLowerCase();
  const loc = (location || "").toLowerCase();
  const blob = `${wt} ${isRemote ? "remote" : ""} ${loc}`;
  if (/\bhybrid\b/.test(blob)) return "hybrid";
  if (/(on[\s-]*site|office based|in-office|in office)/.test(blob) && !/\bremote\b/.test(blob)) return "onsite";
  if (wt === "remote" || isRemote === true) return "remote";
  if (/\b(remote|remoto|home[-\s]?based)\b/.test(blob)) return "remote";
  if (/\b(worldwide|anywhere|global)\b/.test(loc)) return "remote";
  return "unknown";
}

export function classifyListing(input: {
  locationRaw?: string | null;
  workplaceType?: string | null;
  isRemote?: boolean | null;
  company?: string | null;
  title?: string | null;
}): {
  workplace: Workplace;
  geoClass: GeoClass;
  remoteClass: string;
  locationDiscarded: boolean;
  locationClean: string;
} {
  const company = input.company || "";
  const raw = (input.locationRaw || "").trim();
  const locationDiscarded = isCompanyNameLocation(raw, company);
  const locationClean = locationDiscarded ? "" : raw;
  let workplace = workplaceOf(input.workplaceType, input.isRemote, [locationClean, input.title || ""].filter(Boolean).join(" "));
  // A named city or country, with no remote or hybrid marker, is an office. A list of countries is not one office.
  if (workplace === "unknown" && isNamedOffice(locationClean)) workplace = "onsite";
  const workplaceBlob = workplace === "remote" ? "remote" : input.workplaceType || "";
  let g = geoClass(locationClean, workplaceBlob);
  const noPlace = !locationClean || /^\s*remote\s*$/i.test(locationClean);
  // Missing location cannot prove worldwide hiring eligibility.
  const rc = remoteClass(locationClean, workplaceBlob);
  return { workplace, geoClass: g, remoteClass: rc, locationDiscarded, locationClean };
}

export function listingClassifyNeeded(facts: {
  workplace: Workplace;
  geoClass: GeoClass;
  locationDiscarded: boolean;
}): boolean {
  return facts.workplace === "unknown" || facts.geoClass === "unknown" || facts.locationDiscarded;
}

const GEO_TIGHTENABLE = new Set<GeoClass>(["worldwideish", "unknown", "ambiguous_remote"]);

export function mergeListingClassify(
  det: { workplace: Workplace; geoClass: GeoClass; locationRaw?: string | null },
  llm: { workplace?: Workplace | null; geoClass?: GeoClass | null; geoNote?: string; evidence?: string },
): { workplace: Workplace; geoClass: GeoClass } {
  let geo = det.geoClass;
  if (det.geoClass !== "hard_geo" && llm.geoClass === "hard_geo" && GEO_TIGHTENABLE.has(det.geoClass)) {
    if (!isTzOverlapLocation(det.locationRaw || "")) {
      geo = "hard_geo";
    }
  }
  let workplace = det.workplace;
  if (workplace === "unknown" && llm.workplace && llm.workplace !== "unknown") {
    workplace = llm.workplace;
  }
  return { workplace, geoClass: geo };
}

export function remoteClass(
  location = "",
  workplace = "",
  extra = "",
): string {
  const blob = [location, workplace, extra].filter(Boolean).join(" ").toLowerCase();
  if (!blob.trim()) return "unknown";
  if (/brazil|brasil/.test(blob) && /remote|anywhere/.test(blob)) return "brazil";
  if (/latam|latin america/.test(blob)) return "latam";
  if (/worldwide|anywhere|global|work from anywhere|fully remote/.test(blob)) return "worldwide";
  if (/americas/.test(blob)) return "americas";
  if (/(us|usa|united states)\s*only|remote\s*us|\bus only\b/.test(blob)) return "us_only";
  if (/\beu only|europe only/.test(blob)) return "eu_only";
  if (/emea/.test(blob)) return "emea";
  if (/hybrid/.test(blob)) return "hybrid";
  if (/on[\s-]*site|office based/.test(blob)) return "onsite";
  if (/remote|distributed/.test(blob)) return "ambiguous_remote";
  return "unknown";
}

export function quickScoreHint(
  title: string,
  location = "",
  workplace = "",
  company = "",
): number {
  if (!isCraftMatch(title)) {
    return isNoiseTitle(title) ? 15 : 35;
  }
  let score = 55;
  const fam = craftFamily(title);
  const familyBonus: Record<string, number> = {
    sre: 18,
    platform: 18,
    devops: 16,
    observability: 16,
    ai_infra: 14,
    infra: 12,
    release: 14,
    platform_adjacent: 8,
  };
  score += familyBonus[fam] ?? 0;

  const g = geoClass(location, workplace);
  const geoBonus: Record<string, number> = {
    brazil_friendly: 15,
    worldwideish: 12,
    ambiguous_remote: 0,
    unknown: -5,
    hard_geo: -40,
  };
  score += geoBonus[g] ?? 0;

  const tl = title.toLowerCase();
  if (/\b(junior|intern|graduate|apprentice|middle\b)/i.test(tl)) score -= 25;
  if (/\b(staff|principal|distinguished)\b/i.test(tl)) score -= 3;
  if (
    /\b(manager|director|head\s+of|vp\b)\b/i.test(tl) &&
    !/\b(engineering\s*manager.*player|player.?coach)\b/i.test(tl)
  ) {
    score -= 20;
  }

  const cl = (company || "").toLowerCase();
  if (
    ["crypto", "coin", "kraken", "bitso", "strike", "phantom", "ripple", "bitcoin", "braiins"].some(
      (x) => cl.includes(x),
    )
  ) {
    score += 3;
  }

  return Math.max(0, Math.min(100, score));
}

export type LaneResult = {
  craft_ok: boolean;
  noise: boolean;
  craft_family: CraftFamily;
  geo_class: GeoClass;
  score_hint: number;
  lanes: { raw: boolean; fit: boolean; curator_candidate: boolean };
};

export function canPageEvalRequest(input: {
  matchLabel: string;
  evalRequested: boolean;
}): boolean {
  return input.matchLabel === "match" && input.evalRequested === true;
}

export function firstSeenAtMs(row: {
  createdAt?: Date | string | null;
  firstSeenAt?: Date | string | null;
}): number {
  const raw = row.firstSeenAt ?? row.createdAt;
  if (!raw) return 0;
  const t = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  return Number.isNaN(t) ? 0 : t;
}

export function selectFirstSeenDigestRows<
  T extends {
    matchLabel?: string | null;
    createdAt?: Date | string | null;
    firstSeenAt?: Date | string | null;
  },
>(rows: T[], since: Date, label: "match" | "unmatched"): T[] {
  const sinceMs = since.getTime();
  return rows.filter((r) => r.matchLabel === label && firstSeenAtMs(r) >= sinceMs);
}

export function matchLabel(input: {
  title: string;
  location?: string;
  workplace?: string;
  extra?: string;
  geoClassStored?: string | null;
  override?: MatchLabel | null;
}): MatchLabel {
  if (input.override === "human_skip" || input.override === "match") {
    return input.override;
  }
  if (!isCraftMatch(input.title || "")) return "unmatched";
  const blob = [input.location, input.workplace, input.extra].filter(Boolean).join(" | ");
  const geo: GeoClass = blob.trim()
    ? geoClass(input.location || "", input.workplace || "", input.extra || "")
    : ((input.geoClassStored as GeoClass | undefined) || "unknown");
  if (geo === "hard_geo") return "hard_geo_maybe";
  if (geo === "unknown") return "geo_unknown";
  return "match";
}

export function laneForEvent(
  title: string,
  location = "",
  workplace = "",
  opts: { company?: string; event?: string } = {},
): LaneResult {
  const craft_ok = isCraftMatch(title);
  const noise = isNoiseTitle(title) && !craft_ok;
  const g = geoClass(location, workplace);
  const hint = quickScoreHint(title, location, workplace, opts.company ?? "");
  const fam = craftFamily(title);

  let fit = craft_ok && g !== "hard_geo";
  if (opts.event === "closed" && craft_ok) fit = true;

  const curator_candidate =
    fit &&
    hint >= 70 &&
    (g === "brazil_friendly" || g === "worldwideish" || g === "ambiguous_remote");

  return {
    craft_ok,
    noise,
    craft_family: fam,
    geo_class: g,
    score_hint: hint,
    lanes: { raw: true, fit, curator_candidate },
  };
}
