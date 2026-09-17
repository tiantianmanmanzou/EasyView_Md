/**
 * Render ASCII diagrams as a single PNG for DOCX export.
 *
 * The renderer uses a terminal-cell grid: CJK/full-width characters occupy two
 * cells and ASCII/box-drawing characters occupy one cell. This keeps borders
 * aligned independently of the browser's fallback font metrics.
 */

import { extractAsciiSourcesFromMarkdown, normalizeAsciiSource } from './asciiSource';

export type AsciiPng = { base64: string; width: number; height: number };

export type AsciiDiagramImage = {
  source: string;
  pngBase64: string;
  width: number;
  height: number;
};

function isWideCharCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  );
}

function isWideChar(ch: string): boolean {
  return isWideCharCodePoint(ch.codePointAt(0) ?? 0);
}

function cellCount(line: string): number {
  let count = 0;
  for (const ch of Array.from(line)) count += isWideChar(ch) ? 2 : 1;
  return count;
}

const FONT_STACK = '"Menlo", "Consolas", "DejaVu Sans Mono", "SFMono-Regular", "Courier New", monospace';

export interface RenderAsciiOptions {
  fontPx?: number;
  padding?: number;
  bgColor?: string;
  fgColor?: string;
}

export function renderAsciiToPng(
  source: string,
  options: RenderAsciiOptions = {},
): AsciiPng | null {
  const lines = normalizeAsciiSource(source).split('\n');
  if (lines.length === 0 || lines.every((line) => line.length === 0)) return null;

  const fontPx = options.fontPx ?? 20;
  const padding = options.padding ?? 16;
  const bgColor = options.bgColor ?? '#ffffff';
  const fgColor = options.fgColor ?? '#1f2328';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.font = `${fontPx}px ${FONT_STACK}`;
  const cellW = ctx.measureText('0').width || fontPx * 0.6;
  const ascent = ctx.measureText('M').actualBoundingBoxAscent || 0;
  const descent = ctx.measureText('M').actualBoundingBoxDescent || 0;
  const lineH = Math.round((ascent + descent || fontPx) * 1.25);
  const maxCols = lines.reduce((max, line) => Math.max(max, cellCount(line)), 0);
  if (maxCols <= 0) return null;

  canvas.width = Math.ceil(maxCols * cellW) + padding * 2;
  canvas.height = Math.ceil(lines.length * lineH) + padding * 2;
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = fgColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  lines.forEach((line, row) => {
    let col = 0;
    const y = padding + Math.round((row + 0.5) * lineH);
    for (const ch of Array.from(line)) {
      const cells = isWideChar(ch) ? 2 : 1;
      ctx.fillText(ch, padding + (col + cells / 2) * cellW, y);
      col += cells;
    }
  });

  return {
    base64: canvas.toDataURL('image/png'),
    width: canvas.width,
    height: canvas.height,
  };
}

export async function collectAsciiPngs(
  markdown: string,
  options: RenderAsciiOptions = {},
): Promise<AsciiDiagramImage[]> {
  const result: AsciiDiagramImage[] = [];
  for (const source of extractAsciiSourcesFromMarkdown(markdown)) {
    const png = renderAsciiToPng(source, options);
    if (png) result.push({ source, pngBase64: png.base64, width: png.width, height: png.height });
  }
  return result;
}
