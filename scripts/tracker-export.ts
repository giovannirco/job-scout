import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TrackerRow } from "../packages/core/src/career-ops.js";

/** Read the existing career-ops table/TSV without changing its format or source files. */
export function trackerExport(file: string) {
  const source = readFileSync(file, "utf8");
  if (file.endsWith(".json")) {
    const data = JSON.parse(source);
    return (Array.isArray(data) ? data : data.rows).map((r: unknown) => TrackerRow.parse(r));
  }
  const markdown = !file.endsWith(".tsv");
  const split = (line: string) => markdown
    ? line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map(s => s.trim().replace(/\\\|/g, "|"))
    : line.split("\t").map(s => s.trim());
  const lines = source.split(/\r?\n/).filter(l => markdown ? /^\|/.test(l) : l.trim());
  const header = split(lines.shift() || "").map(s => s.toLowerCase());
  return lines.filter(l => !/^\|?\s*:?-{3}/.test(l)).map(line => {
    const cells = split(line);
    const value = (...keys: string[]) => cells[header.findIndex(h => keys.includes(h))] || "";
    const reportCell = value("report", "reportpath");
    const reportPath = reportCell.match(/\]\(([^)]+)\)/)?.[1] || (markdown ? "" : reportCell);
    const reportFile = reportPath ? resolve(dirname(file), reportPath) : undefined;
    // The client owns this filesystem. The server must not probe arbitrary local paths.
    const reportExists = reportFile ? existsSync(reportFile) : undefined;
    const report = reportExists ? readFileSync(reportFile!, "utf8") : "";
    const reportUrl = report.match(/^\s*\*{0,2}(?:URL|Posting|Job URL):\*{0,2}\s*(?:\[[^\]]*\]\()?<?(https?:\/\/[^\s)>]+)/im)?.[1];
    const rawScore = value("score").split("/")[0];
    const date = value("updatedat", "updated_at");
    return TrackerRow.parse({
      trackerId: value("#", "id", "trackerid"), company: value("company"), title: value("role", "title"),
      status: value("status") || undefined, score: rawScore && Number.isFinite(Number(rawScore)) ? Number(rawScore) : undefined,
      url: value("url") || reportUrl || undefined, reportPath: reportFile, reportExists,
      updatedAt: date || undefined,
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: pnpm exec tsx scripts/tracker-export.ts <applications.md|tracker.tsv|tracker.json>");
  console.log(JSON.stringify({ rows: trackerExport(file), dryRun: true }, null, 2));
}
