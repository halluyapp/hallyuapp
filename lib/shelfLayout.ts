/** Pure shelf layout helpers (no React, no SVG): safe to unit test. */

export interface ShelfSpine {
  id: string;
  title: string;
  width: number;
  color: string;
  selected?: boolean;
}

const GAP = 2;

/** Packs spines into lines that fit the measured width. */
export function packSpines(spines: ShelfSpine[], maxWidth: number): ShelfSpine[][] {
  const lines: ShelfSpine[][] = [];
  let line: ShelfSpine[] = [];
  let used = 0;
  for (const s of spines) {
    const needed = (line.length ? GAP : 0) + s.width;
    if (line.length && used + needed > maxWidth) {
      lines.push(line);
      line = [];
      used = 0;
    }
    used += (line.length ? GAP : 0) + s.width;
    line.push(s);
  }
  if (line.length) lines.push(line);
  return lines;
}

