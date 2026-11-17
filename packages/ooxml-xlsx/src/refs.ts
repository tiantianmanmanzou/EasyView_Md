/** A1 / range helpers shared by the xlsx adapter and AI ops. */

export function columnLetter(index: number): string {
  let result = '';
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

export function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function parseCellRef(ref: string): { col: number; row: number } {
  const match = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!match) throw new Error(`Invalid cell ref: ${ref}`);
  return { col: columnNumber(match[1]), row: Number(match[2]) };
}

export function cellRef(col: number, row: number): string {
  return `${columnLetter(col)}${row}`;
}

export function parseRange(range: string): {
  top: number;
  left: number;
  bottom: number;
  right: number;
  cells: number;
} {
  const [start, end = start] = range.split(':');
  const a = parseCellRef(start);
  const b = parseCellRef(end);
  const top = Math.min(a.row, b.row);
  const bottom = Math.max(a.row, b.row);
  const left = Math.min(a.col, b.col);
  const right = Math.max(a.col, b.col);
  return { top, left, bottom, right, cells: (bottom - top + 1) * (right - left + 1) };
}

export function refSortKey(ref: string): number {
  const { col, row } = parseCellRef(ref);
  return row * 20_000 + col;
}
