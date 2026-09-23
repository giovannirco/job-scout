export type WireFoldRow = {
  kind: string;
  title: string;
  company: string | null;
  positionTitle: string | null;
};

/** Collapse a burst of the same event for the same role. A different row in between starts a new line. */
export function foldWire<T extends WireFoldRow>(rows: T[]): { row: T; count: number }[] {
  const out: { row: T; count: number }[] = [];
  for (const row of rows) {
    const prev = out[out.length - 1];
    if (prev && sameBurst(prev.row, row)) prev.count += 1;
    else out.push({ row, count: 1 });
  }
  return out;
}

function sameBurst(a: WireFoldRow, b: WireFoldRow): boolean {
  return a.kind === b.kind
    && a.title === b.title
    && (a.company || "") === (b.company || "")
    && (a.positionTitle || "") === (b.positionTitle || "");
}
