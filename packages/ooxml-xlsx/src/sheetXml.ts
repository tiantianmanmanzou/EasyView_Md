/**
 * Parse and rewrite worksheet sheetData while leaving drawings / merges / etc. intact.
 */

import { replaceFirstElementByName } from '@easyview/ooxml-core';
import { cellRef, columnLetter, parseCellRef } from './refs';

export type XlsxCellValue = string | number | boolean | null;

export interface XlsxCell {
  value: XlsxCellValue;
  /** Formula without leading '='. */
  formula?: string;
  /** Original style index from the sheet, if any. */
  style?: number;
}

const ROW_RE = /<row\b[^>]*>[\s\S]*?<\/row>/g;
const CELL_RE = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
const ATTR_RE = /\b([a-zA-Z:]+)="([^"]*)"/g;

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of raw.matchAll(ATTR_RE)) out[match[1]] = match[2];
  return out;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([\da-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function encodeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readInlineString(inner: string): string {
  const parts: string[] = [];
  for (const match of inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
    parts.push(decodeXmlEntities(match[1]));
  }
  return parts.join('');
}

/** Parse sheetData cells into an A1 → cell map. */
export function parseSheetCells(sheetXml: string, sharedStrings: readonly string[]): Map<string, XlsxCell> {
  const cells = new Map<string, XlsxCell>();
  const sheetData = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(sheetXml)?.[1] ?? '';
  for (const rowXml of sheetData.matchAll(ROW_RE)) {
    for (const cellMatch of rowXml[0].matchAll(CELL_RE)) {
      const attrRaw = cellMatch[1] ?? cellMatch[3] ?? '';
      const inner = cellMatch[2] ?? '';
      const a = attrs(attrRaw);
      const ref = a.r;
      if (!ref) continue;
      const style = a.s !== undefined ? Number(a.s) : undefined;
      const type = a.t;
      const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(inner)?.[1];
      if (formula !== undefined) {
        cells.set(ref, {
          value: `=${decodeXmlEntities(formula)}`,
          formula: decodeXmlEntities(formula),
          style: Number.isFinite(style) ? style : undefined,
        });
        continue;
      }
      if (type === 'inlineStr') {
        cells.set(ref, { value: readInlineString(inner), style: Number.isFinite(style) ? style : undefined });
        continue;
      }
      const rawV = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      if (rawV === undefined) {
        if (style !== undefined && Number.isFinite(style)) cells.set(ref, { value: null, style });
        continue;
      }
      const v = decodeXmlEntities(rawV);
      if (type === 's') {
        const index = Number(v);
        cells.set(ref, {
          value: sharedStrings[index] ?? '',
          style: Number.isFinite(style) ? style : undefined,
        });
        continue;
      }
      if (type === 'b') {
        cells.set(ref, { value: v === '1' || v === 'true', style: Number.isFinite(style) ? style : undefined });
        continue;
      }
      if (type === 'str' || type === 'e') {
        cells.set(ref, { value: v, style: Number.isFinite(style) ? style : undefined });
        continue;
      }
      const num = Number(v);
      cells.set(ref, {
        value: Number.isFinite(num) && v.trim() !== '' ? num : v,
        style: Number.isFinite(style) ? style : undefined,
      });
    }
  }
  return cells;
}

function serializeCell(ref: string, cell: XlsxCell): string {
  const styleAttr = cell.style !== undefined ? ` s="${cell.style}"` : '';
  if (cell.formula) {
    const formula = encodeXmlText(cell.formula.replace(/^=/, ''));
    return `<c r="${ref}"${styleAttr}><f>${formula}</f></c>`;
  }
  const value = cell.value;
  if (value === null || value === undefined || value === '') {
    return styleAttr ? `<c r="${ref}"${styleAttr}/>` : '';
  }
  if (typeof value === 'boolean') {
    return `<c r="${ref}"${styleAttr} t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"${styleAttr} t="n"><v>${value}</v></c>`;
  }
  const text = String(value);
  if (text.startsWith('=') && !cell.formula) {
    return `<c r="${ref}"${styleAttr}><f>${encodeXmlText(text.slice(1))}</f></c>`;
  }
  // Prefer inlineStr so sharedStrings.xml stays byte-identical for untouched books.
  return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t>${encodeXmlText(text)}</t></is></c>`;
}

function usedBounds(cells: Map<string, XlsxCell>): { top: number; left: number; bottom: number; right: number } | null {
  let top = Infinity;
  let left = Infinity;
  let bottom = 0;
  let right = 0;
  for (const [ref, cell] of cells) {
    if (cell.value === null && !cell.formula && cell.style === undefined) continue;
    const { col, row } = parseCellRef(ref);
    top = Math.min(top, row);
    left = Math.min(left, col);
    bottom = Math.max(bottom, row);
    right = Math.max(right, col);
  }
  if (!Number.isFinite(top)) return null;
  return { top, left, bottom, right };
}

export function buildSheetDataXml(cells: Map<string, XlsxCell>): string {
  const byRow = new Map<number, Array<[string, XlsxCell]>>();
  for (const [ref, cell] of cells) {
    if (cell.value === null && !cell.formula && cell.style === undefined) continue;
    if (cell.value === '' && !cell.formula) continue;
    const { row } = parseCellRef(ref);
    const list = byRow.get(row) ?? [];
    list.push([ref, cell]);
    byRow.set(row, list);
  }
  const rows = [...byRow.keys()].sort((a, b) => a - b);
  const parts: string[] = ['<sheetData>'];
  for (const row of rows) {
    const entries = byRow.get(row)!;
    entries.sort((a, b) => parseCellRef(a[0]).col - parseCellRef(b[0]).col);
    parts.push(`<row r="${row}">`);
    for (const [ref, cell] of entries) {
      const xml = serializeCell(ref, cell);
      if (xml) parts.push(xml);
    }
    parts.push('</row>');
  }
  parts.push('</sheetData>');
  return parts.join('');
}

/** Replace sheetData (and dimension when present) from the cell map; keep other worksheet nodes. */
export function rewriteWorksheetXml(originalXml: string, cells: Map<string, XlsxCell>): string {
  const sheetData = buildSheetDataXml(cells);
  let xml = new TextDecoder('utf-8').decode(
    replaceFirstElementByName(new TextEncoder().encode(originalXml), 'sheetData', sheetData),
  );
  const bounds = usedBounds(cells);
  if (bounds) {
    const ref = `${cellRef(bounds.left, bounds.top)}:${cellRef(bounds.right, bounds.bottom)}`;
    if (/<dimension\b/.test(xml)) {
      xml = xml.replace(/<dimension\b[^>]*\/>/, `<dimension ref="${ref}"/>`);
    }
  }
  return xml;
}

export function summarizeUsedRange(cells: Map<string, XlsxCell>): string | null {
  const bounds = usedBounds(cells);
  if (!bounds) return null;
  return `${columnLetter(bounds.left)}${bounds.top}:${columnLetter(bounds.right)}${bounds.bottom}`;
}
