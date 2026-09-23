/** A profile city we can use as a work-authorization market. Empty means do not filter. */
export function homeMarket(profileLocation = ""): "us" | "br" | null {
  const s = profileLocation.trim().toLowerCase();
  if (!s) return null;
  if (/\b(brazil|brasil|s[aã]o paulo|sao paulo)\b/.test(s)) return "br";
  if (/\b(united states|u\.s\.a?\.?|usa|austin|texas)\b/.test(s)) return "us";
  if (/,\s*(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|dc)\b/.test(s)) return "us";
  return null;
}

const OPEN_TO_US = /\b(worldwide|anywhere|global|distributed|americas|north america)\b/i;
const US_PLACE = /\b(united states|u\.s\.a?\.?|usa|\bus\b|austin|texas|north america|americas|\bna\b)\b/i;
const FOREIGN_PLACE = /\b(united kingdom|\buk\b|england|ireland|germany|france|spain|portugal|poland|netherlands|sweden|norway|denmark|finland|switzerland|austria|belgium|italy|greece|romania|hungary|czech|canada|ontario|mexico|brazil|brasil|sao paulo|s[aã]o paulo|australia|singapore|india|japan|israel|apac|apj|emea|middle east|europe|\beu\b|latam|latin america|lugano|bucharest)\b/i;

/**
 * True when a US-based profile cannot take this location.
 * "Remote" and "Remote - USA" stay. "Remote, Poland" does not.
 * A country list that includes the US stays. No profile location means no filter.
 */
const OPEN_TO_BR = /\b(worldwide|anywhere|global|distributed|americas|latam|latin america|brazil|brasil)\b/i;
const US_ONLY_PLACE = /\b(us only|usa only|united states|\busa\b|\bus\b)\b/i;

export function missesHomeMarket(listingLocation = "", profileLocation = ""): boolean {
  const market = homeMarket(profileLocation);
  const loc = listingLocation.trim();
  if (!market || !loc) return false;
  if (market === "us") {
    if (OPEN_TO_US.test(loc) || US_PLACE.test(loc)) return false;
    return FOREIGN_PLACE.test(loc);
  }
  if (OPEN_TO_BR.test(loc)) return false;
  if (/\b(remote|remoto)\b/i.test(loc) && !FOREIGN_PLACE.test(loc) && !US_ONLY_PLACE.test(loc)) return false;
  if (US_ONLY_PLACE.test(loc) || FOREIGN_PLACE.test(loc)) return true;
  return false;
}

/** A place restriction that matches the profile, so the chip should not read as a block. */
export function fitsHomeMarket(geo: string | null | undefined, listingLocation: string | null | undefined, profileLocation: string | null | undefined): boolean {
  if (geo !== "hard_geo" || !homeMarket(profileLocation || "")) return false;
  const loc = (listingLocation || "").trim();
  if (!loc) return false;
  return !missesHomeMarket(loc, profileLocation || "");
}

/** The profile city appears as its own word in the listing location. */
export function namesProfileCity(listingLocation: string, profileLocation: string): boolean {
  const city = profileLocation.split(",")[0]?.trim() || "";
  if (city.length < 4) return false;
  const escaped = city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(listingLocation);
}

/**
 * Home chip and home filter. A hard geo that fits still counts.
 * So does a listing that names the profile city, even when other places make the class ambiguous.
 * A location that is only "Remote" does not.
 */
export function listedAtHome(geo: string | null | undefined, listingLocation: string | null | undefined, profileLocation: string | null | undefined): boolean {
  if (fitsHomeMarket(geo, listingLocation, profileLocation)) return true;
  if (!homeMarket(profileLocation || "")) return false;
  const loc = (listingLocation || "").trim();
  if (!loc || /^remote$/i.test(loc)) return false;
  return namesProfileCity(loc, profileLocation || "");
}
