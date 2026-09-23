/** A profile city we can use as a work-authorization market. Empty means do not filter. */
export function homeMarket(profileLocation = ""): "us" | null {
  const s = profileLocation.trim().toLowerCase();
  if (!s) return null;
  if (/\b(united states|u\.s\.a?\.?|usa|austin|texas)\b/.test(s)) return "us";
  if (/,\s*(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|dc)\b/.test(s)) return "us";
  return null;
}

const OPEN_TO_US = /\b(worldwide|anywhere|global|distributed|americas|north america)\b/i;
const US_PLACE = /\b(united states|u\.s\.a?\.?|usa|\bus\b|austin|texas|north america|americas|\bna\b)\b/i;
const FOREIGN_PLACE = /\b(united kingdom|\buk\b|england|ireland|germany|france|spain|portugal|poland|netherlands|sweden|norway|denmark|finland|switzerland|austria|belgium|italy|greece|romania|hungary|czech|canada|mexico|brazil|brasil|australia|singapore|india|japan|israel|apac|emea|europe|\beu\b|latam|latin america)\b/i;

/**
 * True when a US-based profile cannot take this location.
 * "Remote" and "Remote - USA" stay. "Remote, Poland" does not.
 * A country list that includes the US stays. No profile location means no filter.
 */
export function missesHomeMarket(listingLocation = "", profileLocation = ""): boolean {
  if (homeMarket(profileLocation) !== "us") return false;
  const loc = listingLocation.trim();
  if (!loc) return false;
  if (OPEN_TO_US.test(loc) || US_PLACE.test(loc)) return false;
  return FOREIGN_PLACE.test(loc);
}

/** A place restriction that matches the profile, so the chip should not read as a block. */
export function fitsHomeMarket(geo: string | null | undefined, listingLocation: string | null | undefined, profileLocation: string | null | undefined): boolean {
  if (geo !== "hard_geo" || !homeMarket(profileLocation || "")) return false;
  const loc = (listingLocation || "").trim();
  if (!loc) return false;
  return !missesHomeMarket(loc, profileLocation || "");
}
