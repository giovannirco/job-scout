/**
 * HTML entity decoding shared by ATS ingestion (stripHtml) and the JD churn check
 * (isCosmeticTextChange), so a body stored before entity decoding compares equal to the
 * same body decoded.
 */

/** HTML 4 Latin-1 entity names, in code-point order from U+00A0 (accented letters in pt/es/fr JDs). */
const LATIN1_ENTITY_NAMES = (
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml"
).split(" ");

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ...LATIN1_ENTITY_NAMES.map((name, i): [string, string] => [name, name === "shy" ? "" : String.fromCharCode(0xa0 + i)]),
  ["euro", "€"], ["trade", "™"], ["bull", "•"], ["OElig", "Œ"], ["oelig", "œ"], ["Scaron", "Š"], ["scaron", "š"],
  ["sbquo", "‚"], ["bdquo", "„"], ["lsaquo", "‹"], ["rsaquo", "›"], ["dagger", "†"], ["permil", "‰"],
]);

function fromCodePoint(code: number, fallback: string): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}

/** Decode common HTML entities (incl. double-escaped Greenhouse bodies and named Latin-1 letters). */
export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&hellip;/gi, "…")
    .replace(/&rsquo;/gi, "’")
    .replace(/&lsquo;/gi, "‘")
    .replace(/&rdquo;/gi, "”")
    .replace(/&ldquo;/gi, "“")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n: string) => fromCodePoint(Number(n), m))
    .replace(/&#x([0-9a-f]+);/gi, (m, h: string) => fromCodePoint(parseInt(h, 16), m))
    // Case-sensitive: &Agrave; and &agrave; differ. lt/gt/amp are not in the map and stay last.
    .replace(/&([A-Za-z][A-Za-z0-9]{1,7});/g, (m, name: string) => NAMED_ENTITIES.get(name) ?? m)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
