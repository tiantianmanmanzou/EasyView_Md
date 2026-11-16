/**
 * Decode one worksheet XML (+ styles.xml) into x-spreadsheet sheet data without ExcelJS.
 */

import { parseCellRef, parseSheetCells, parseSharedStrings } from '@easyview/ooxml-xlsx';
import type { XsCell, XsCellStyle, XsSheetData } from './xSpreadsheetTypes';
import { excelColumnWidthToPx, excelRowPointsToPx } from './xSpreadsheetBridge';

const DEFAULT_ROWS = 100;
const DEFAULT_COLS = 26;

const element = (tag: string) =>
  `<${tag}\\b(?:[^>]*?\\/>|[^>]*?[^/>]>[\\s\\S]*?<\\/${tag}>|>[\\s\\S]*?<\\/${tag}>)`;
const tags = (xml: string, tag: string) => [...xml.matchAll(new RegExp(element(tag), 'g'))].map((m) => m[0]);
const attr = (xml: string, key: string) => new RegExp(`\\b${key}="([^"]*)"`).exec(xml)?.[1] ?? '';
const section = (xml: string, name: string) => new RegExp(element(name)).exec(xml)?.[0] ?? '';
const decode = (text: string) =>
  text.replace(/&#x([\da-f]+);|&#(\d+);|&(amp|lt|gt|quot|apos);/gi, (_, hex, dec, named) =>
    hex || dec
      ? String.fromCodePoint(parseInt(hex || dec, hex ? 16 : 10))
      : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named as string] ?? ''),
  );

const XS_NUMBER_FORMATS: Record<string, string> = {
  normal: 'General',
  text: '@',
  number: '#,##0.00',
  percent: '0.00%',
  rmb: '"￥"#,##0.00',
  usd: '"$"#,##0.00',
  eur: '"€"#,##0.00',
  date: 'yyyy-mm-dd',
  time: 'hh:mm:ss',
  datetime: 'yyyy-mm-dd hh:mm:ss',
  duration: '[h]:mm:ss',
};

function columnLetters(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function parseA1Range(range: string): { sri: number; sci: number; eri: number; eci: number } | null {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(range.trim());
  if (!match) return null;
  const col = (letters: string) => {
    let value = 0;
    for (const ch of letters.toUpperCase()) value = value * 26 + (ch.charCodeAt(0) - 64);
    return value - 1;
  };
  return {
    sci: col(match[1]),
    sri: Number(match[2]) - 1,
    eci: col(match[3]),
    eri: Number(match[4]) - 1,
  };
}

function argbToCss(rgb: string | undefined): string | undefined {
  if (!rgb) return undefined;
  const hex = rgb.length === 8 ? rgb.slice(2) : rgb;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  return `#${hex.toLowerCase()}`;
}

function fontToXs(fontXml: string): Partial<XsCellStyle> {
  const style: XsCellStyle = {};
  const bold = /<b\b/.test(fontXml);
  const italic = /<i\b/.test(fontXml);
  const strike = /<strike\b/.test(fontXml);
  const underline = /<u\b/.test(fontXml);
  const size = Number(attr(tags(fontXml, 'sz')[0] ?? '', 'val'));
  const name = attr(tags(fontXml, 'name')[0] ?? '', 'val');
  const color = argbToCss(attr(tags(fontXml, 'color')[0] ?? '', 'rgb'));
  if (bold || italic || size || name) {
    style.font = { bold, italic };
    if (Number.isFinite(size) && size > 0) style.font.size = size;
    if (name) style.font.name = name;
  }
  if (strike) style.strike = true;
  if (underline) style.underline = true;
  if (color) style.color = color;
  return style;
}

function fillToXs(fillXml: string): Partial<XsCellStyle> {
  const fg = tags(fillXml, 'fgColor')[0] ?? '';
  const color = argbToCss(attr(fg, 'rgb'));
  return color ? { bgcolor: color } : {};
}

function borderToXs(borderXml: string): Partial<XsCellStyle> {
  const border: NonNullable<XsCellStyle['border']> = {};
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const edge = tags(borderXml, side)[0];
    if (!edge) continue;
    const styleName = attr(edge, 'style');
    if (!styleName) continue;
    const color = argbToCss(attr(tags(edge, 'color')[0] ?? '', 'rgb')) || '#000000';
    border[side] = [styleName, color];
  }
  return Object.keys(border).length ? { border } : {};
}

function alignmentToXs(xfXml: string): Partial<XsCellStyle> {
  const alignment = tags(xfXml, 'alignment')[0];
  if (!alignment) return {};
  const style: XsCellStyle = {};
  const horizontal = attr(alignment, 'horizontal');
  const vertical = attr(alignment, 'vertical');
  if (horizontal === 'left' || horizontal === 'center' || horizontal === 'right') style.align = horizontal;
  if (vertical === 'top' || vertical === 'center' || vertical === 'bottom') {
    style.valign = vertical === 'center' ? 'middle' : vertical;
  }
  if (attr(alignment, 'wrapText') === '1' || attr(alignment, 'wrapText') === 'true') style.textwrap = true;
  return style;
}

function numFmtToXs(numFmtId: number, numFmts: Map<number, string>): Partial<XsCellStyle> {
  if (!numFmtId) return {};
  const code =
    numFmts.get(numFmtId) ??
    ({ 1: '0', 2: '0.00', 9: '0%', 10: '0.00%', 14: 'yyyy-mm-dd', 22: 'yyyy-mm-dd hh:mm:ss' } as Record<
      number,
      string
    >)[numFmtId];
  if (!code || code === 'General') return {};
  const format = Object.entries(XS_NUMBER_FORMATS).find(([, value]) => value === code)?.[0];
  return format ? { format } : {};
}

function buildStyleTable(stylesXml: string): XsCellStyle[] {
  const fonts = tags(section(stylesXml, 'fonts'), 'font');
  const fills = tags(section(stylesXml, 'fills'), 'fill');
  const borders = tags(section(stylesXml, 'borders'), 'border');
  const numFmts = new Map<number, string>();
  for (const entry of tags(section(stylesXml, 'numFmts') || '', 'numFmt')) {
    numFmts.set(Number(attr(entry, 'numFmtId')), decode(attr(entry, 'formatCode')));
  }
  const xfs = tags(section(stylesXml, 'cellXfs'), 'xf');
  return xfs.map((xf) => {
    const fontId = Number(attr(xf, 'fontId') || 0);
    const fillId = Number(attr(xf, 'fillId') || 0);
    const borderId = Number(attr(xf, 'borderId') || 0);
    const numFmtId = Number(attr(xf, 'numFmtId') || 0);
    const style: XsCellStyle = {
      ...fontToXs(fonts[fontId] ?? ''),
      ...fillToXs(fills[fillId] ?? ''),
      ...borderToXs(borders[borderId] ?? ''),
      ...alignmentToXs(xf),
      ...numFmtToXs(numFmtId, numFmts),
    };
    return style;
  });
}

function styleKey(style: XsCellStyle): string | null {
  if (!style || Object.keys(style).length === 0) return null;
  return JSON.stringify(style);
}

export function sheetXmlToXsSheet(
  sheetXml: string,
  stylesXml: string,
  sharedStringsXml: string | null,
  sheetName: string,
): XsSheetData {
  const shared = sharedStringsXml ? parseSharedStrings(sharedStringsXml) : [];
  const cells = parseSheetCells(sheetXml, shared);
  const styleTable = stylesXml ? buildStyleTable(stylesXml) : [];
  const styles: XsCellStyle[] = [];
  const styleIndex = new Map<string, number>();

  const rows: NonNullable<XsSheetData['rows']> = { len: DEFAULT_ROWS };
  const cols: NonNullable<XsSheetData['cols']> = { len: DEFAULT_COLS };

  for (const col of tags(section(sheetXml, 'cols'), 'col')) {
    const min = Number(attr(col, 'min'));
    const max = Number(attr(col, 'max') || min);
    const width = Number(attr(col, 'width'));
    if (!Number.isFinite(min) || !Number.isFinite(width) || width <= 0) continue;
    for (let c = min; c <= max; c += 1) {
      cols[c - 1] = { width: excelColumnWidthToPx(width) };
      cols.len = Math.max(cols.len, c);
    }
  }

  for (const match of sheetXml.matchAll(/<row\b([^>]*)>/g)) {
    const rowAttr = match[1];
    const r = Number(/\br="(\d+)"/.exec(rowAttr)?.[1] ?? 0);
    const ht = /\bht="([^"]*)"/.exec(rowAttr)?.[1];
    if (r > 0 && ht && /\bcustomHeight="1"/.test(rowAttr)) {
      const ri = r - 1;
      rows[ri] = { ...(rows[ri] ?? { cells: {} }), height: excelRowPointsToPx(Number(ht)) };
      rows.len = Math.max(rows.len, r);
    }
  }

  for (const [ref, cell] of cells) {
    const { col, row } = parseCellRef(ref);
    const ri = row - 1;
    const ci = col - 1;
    rows.len = Math.max(rows.len, row);
    cols.len = Math.max(cols.len, col);
    // Prefer cached formula result for display (matches ExcelJS cellToText).
    let text = '';
    if (cell.formula) {
      text =
        cell.cached !== undefined && cell.cached !== ''
          ? cell.cached
          : `=${cell.formula}`;
    } else if (cell.value === null || cell.value === undefined) {
      text = '';
    } else {
      text = String(cell.value);
    }

    let style: number | undefined;
    if (cell.style !== undefined && styleTable[cell.style]) {
      const xs = styleTable[cell.style];
      const key = styleKey(xs);
      if (key) {
        const existing = styleIndex.get(key);
        if (existing !== undefined) style = existing;
        else {
          style = styles.length;
          styles.push(xs);
          styleIndex.set(key, style);
        }
      }
    }
    if (!text && style === undefined) continue;
    const rowData = rows[ri] ?? { cells: {} };
    const nextCells = { ...(rowData.cells ?? {}), [ci]: style === undefined ? { text } : { text, style } };
    rows[ri] = { ...rowData, cells: nextCells };
  }

  const merges: string[] = [];
  for (const merge of tags(section(sheetXml, 'mergeCells'), 'mergeCell')) {
    const ref = attr(merge, 'ref');
    if (parseA1Range(ref)) merges.push(ref);
  }
  for (const range of merges) {
    const parsed = parseA1Range(range);
    if (!parsed) continue;
    const { sri, sci, eri, eci } = parsed;
    const row = rows[sri] ?? { cells: {} };
    const cell = row.cells?.[sci] ?? { text: '' };
    cell.merge = [eri - sri, eci - sci];
    row.cells = { ...row.cells, [sci]: cell };
    rows[sri] = row;
  }

  const view = tags(section(sheetXml, 'sheetViews'), 'sheetView')[0] ?? '';
  const pane = tags(view, 'pane')[0] ?? '';
  const xSplit = Number(attr(pane, 'xSplit') || 0);
  const ySplit = Number(attr(pane, 'ySplit') || 0);
  const freeze =
    attr(pane, 'state') === 'frozen' && (xSplit > 0 || ySplit > 0)
      ? `${columnLetters(xSplit)}${ySplit + 1}`
      : undefined;

  const filter = attr(tags(section(sheetXml, 'autoFilter'), 'autoFilter')[0] ?? section(sheetXml, 'autoFilter'), 'ref');

  const formatPr = tags(sheetXml, 'sheetFormatPr')[0] ?? '';
  const defaultRowHeight = Number(attr(formatPr, 'defaultRowHeight'));
  const defaultColWidth = Number(attr(formatPr, 'defaultColWidth'));
  // Excel's default row is 15pt (20px). Always surface a row height so the grid
  // hit-testing matches ExcelJS decode (toolbar/e2e clicks assume ~20px rows).
  const defaultRowPx = excelRowPointsToPx(
    Number.isFinite(defaultRowHeight) && defaultRowHeight > 0 ? defaultRowHeight : 15,
  );
  const defaultColPx =
    Number.isFinite(defaultColWidth) && defaultColWidth > 0
      ? excelColumnWidthToPx(defaultColWidth)
      : undefined;

  // Expand a header-only autoFilter down to the last data row (ExcelJS parity).
  let filterRef = filter || undefined;
  if (filterRef) {
    const parsed = parseA1Range(filterRef);
    if (parsed) {
      let last = parsed.eri;
      for (const [key, row] of Object.entries(rows)) {
        if (key === 'len') continue;
        const ri = Number(key);
        if (!Number.isFinite(ri) || ri <= parsed.sri) continue;
        const rowCells = (row as { cells?: Record<number, XsCell> } | undefined)?.cells;
        if (!rowCells) continue;
        for (let ci = parsed.sci; ci <= parsed.eci; ci += 1) {
          const text = rowCells[ci]?.text;
          if (typeof text === 'string' && text.trim() !== '') {
            last = Math.max(last, ri);
            break;
          }
        }
      }
      if (last !== parsed.eri) {
        filterRef = `${columnLetters(parsed.sci)}${parsed.sri + 1}:${columnLetters(parsed.eci)}${last + 1}`;
      }
    }
  }

  return {
    name: sheetName,
    ...(freeze ? { freeze } : {}),
    ...(filterRef ? { autofilter: { ref: filterRef, filters: [] } } : {}),
    defaultRowPx,
    ...(defaultColPx ? { defaultColPx } : {}),
    styles,
    merges,
    cols,
    rows,
  };
}
