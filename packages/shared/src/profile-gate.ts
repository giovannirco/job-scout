import type { GateConfig } from "./settings.js";
import { homeMarket } from "./home-geo.js";

/** A north star that rejects infrastructure also excludes those titles before any model runs. */
export function titleExcludesFromNorthStar(text = ""): string[] {
  if (!/\bnot\s+infrastructure\b/i.test(text)) return [];
  return ["infrastructure", "infra", "kubernetes", "k8s", "devops"];
}

/** Fold profile rules into the saved gate. Listed jobs are on the board now, so age does not apply. */
export function applyProfileToGate(
  gate: GateConfig,
  opts: { home?: string | null; northStar?: string | null; listedNow?: boolean } = {},
): GateConfig {
  let next = gate;
  if (opts.listedNow) next = { ...next, maxPostingAgeDays: 0 };
  const extra = titleExcludesFromNorthStar(opts.northStar || "");
  if (extra.length) {
    const have = new Set(next.titleExclude.map((term) => term.toLowerCase()));
    const add = extra.filter((term) => !have.has(term));
    if (add.length) next = { ...next, titleExclude: [...next.titleExclude, ...add] };
  }
  if (homeMarket(opts.home || "") === "us") {
    next = { ...next, geoBlock: next.geoBlock.filter((term) => !/^(us only|usa only)$/i.test(term.trim())) };
  }
  return next;
}
