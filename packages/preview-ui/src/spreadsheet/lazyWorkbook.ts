import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { OpcPackage } from '@easyview/ooxml-core/opc';
import {
  cellRef,
  parseSharedStrings,
  parseSheetCells,
  rewriteWorksheetXml,
  XlsxWorkbook,
  type XlsxCell,
} from '@easyview/ooxml-xlsx';
import { worksheetToXsSheet, validateSheetXml, pxToExcelColumnWidth, pxToExcelRowPoints } from './xSpreadsheetBridge';
import { appendXsStyle, cellXfNumFmtId } from './stylesWrite';
import type { XsCell, XsCellStyle, XsSheetData } from './xSpreadsheetTypes';
import { tPreview } from '../preview.i18n';

/** One element: either self-closing, or open…close. The self-closing branch must win first, or a
 * `<xf …/>` swallows every sibling up to the next `</xf>` (that corrupted saved cell styles). */
const element = (tag: string) => `<${tag}\\b(?:[^>]*?\\/>|[^>]*?[^/>]>[\\s\\S]*?<\\/${tag}>|>[\\s\\S]*?<\\/${tag}>)`;
const tags = (xml: string, tag: string) => [...xml.matchAll(new RegExp(element(tag), 'g'))].map(match => match[0]);
const attr = (xml: string, key: string) => new RegExp(`\\b${key}="([^"]*)"`).exec(xml)?.[1] ?? '';
const decode = (text: string) => text.replace(/&#x([\da-f]+);|&#(\d+);|&(amp|lt|gt|quot|apos);/gi, (_, hex, dec, named) => hex || dec ? String.fromCodePoint(parseInt(hex || dec, hex ? 16 : 10)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named as string] ?? ''));
const section = (xml: string, name: string) => new RegExp(element(name)).exec(xml)?.[0] ?? '';
interface SheetInfo { id: string; name: string; path: string; element: string }
interface Loaded { baseline: XsSheetData }

/** Keep original ZIP entries compressed. ExcelJS has no random-sheet load API;
 * feed it an archive containing only the requested worksheet plus global tables.
 * Other worksheets are never inflated or decoded, including during save. */
export class LazyWorkbook {
  private loaded = new Map<number, Loaded>();
  readonly metrics = { decodedSheets: 0, decodedSheetBytes: 0 };
  private constructor(private zip: JSZip, readonly sheets: SheetInfo[], readonly active: number, private workbookXml: string) {}
  static async open(bytes: ArrayBuffer): Promise<LazyWorkbook> {
    const zip = await JSZip.loadAsync(bytes);
    let expanded = 0;
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const size = (entry as unknown as { _data: { uncompressedSize: number } })._data.uncompressedSize;
      if (!Number.isSafeInteger(size) || size < 0 || (expanded += size) > 128 * 1024 * 1024 || (/^xl\/worksheets\/[^/]+\.xml$/.test(entry.name) && size > 32 * 1024 * 1024)) throw new Error(tPreview('spreadsheet.tooComplex'));
    }
    const xml = await zip.file('xl/workbook.xml')!.async('string');
    const rels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
    const relationships = new Map(tags(rels, 'Relationship').map(rel => [attr(rel, 'Id'), attr(rel, 'Target')]));
    const sheets = tags(xml, 'sheet').map(element => {
      const target = relationships.get(attr(element, 'r:id'));
      if (!target) throw new Error('Missing worksheet relationship');
      const path = decodeURIComponent(new URL(target, 'https://xlsx.invalid/xl/').pathname.slice(1));
      return { id: attr(element, 'sheetId'), name: decode(attr(element, 'name')), path, element };
    });
    if (!sheets.length || sheets.length > 32) throw new Error(tPreview('spreadsheet.tooComplex'));
    const active = Math.min(sheets.length - 1, Number(attr(section(xml, 'bookViews'), 'activeTab')) || 0);
    return new LazyWorkbook(zip, sheets, active, xml);
  }
  async load(index: number): Promise<XsSheetData> {
    if (this.loaded.has(index)) return structuredClone(this.loaded.get(index)!.baseline);
    const workbook = await this.decode(index);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error('Worksheet could not be decoded');
    const baseline = worksheetToXsSheet(sheet, workbook);
    this.loaded.set(index, { baseline });
    return structuredClone(baseline);
  }
  private async decode(index: number): Promise<ExcelJS.Workbook> {
    const info = this.sheets[index];
    if (!info) throw new Error('Unknown worksheet');
    const xml = await this.zip.file(info.path)!.async('string');
    validateSheetXml(xml);
    this.metrics.decodedSheets++; this.metrics.decodedSheetBytes += xml.length;
    const subset = new JSZip();
    // Share JSZipObject entries; generateAsync copies compressed entries without
    // inflating them. Exclude every other worksheet before ExcelJS sees bytes.
    for (const [name, entry] of Object.entries(this.zip.files)) {
      if (name.startsWith('xl/worksheets/') && name !== info.path && name !== info.path.replace('worksheets/', 'worksheets/_rels/') + '.rels') continue;
      subset.files[name] = entry;
    }
    subset.file('xl/workbook.xml', this.workbookXml.replace(section(this.workbookXml, 'sheets'), `<sheets>${info.element}</sheets>`).replace(/activeTab="\d+"/g, 'activeTab="0"'));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await subset.generateAsync({ type: 'arraybuffer' }));
    return workbook;
  }
  async save(changes: Array<{ index: number; data: XsSheetData }>): Promise<Uint8Array> {
    const pending = changes.filter(({ index, data }) => {
      const loaded = this.loaded.get(index);
      if (!loaded) throw new Error('Cannot save an unloaded worksheet');
      return editablePayload(data) !== editablePayload(loaded.baseline);
    });
    if (!pending.length) {
      return this.zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    }
    // Text/formula-only edits go through ooxml-xlsx. Style / merge / freeze / filter /
    // size changes use precise XML section updates (no ExcelJS writeBuffer).
    if (pending.every(({ index, data }) => valueOnlyChange(this.loaded.get(index)!.baseline, data))) {
      return this.saveValuesWithOoxml(pending);
    }
    return this.saveStructuralWithXml(pending);
  }

  /** Precise sheetData rewrite for cell text/formula diffs; untouched zip parts stay intact. */
  private async saveValuesWithOoxml(changes: Array<{ index: number; data: XsSheetData }>): Promise<Uint8Array> {
    const pkg = await OpcPackage.open(await this.zip.generateAsync({ type: 'uint8array' }));
    const book = await XlsxWorkbook.open(pkg);
    for (const { index, data } of changes) {
      const baseline = this.loaded.get(index)!.baseline;
      const sheetName = this.sheets[index].name;
      const keys = new Set<string>();
      const collect = (sheet: XsSheetData) => {
        const rows = sheet.rows ?? { len: 0 };
        for (const key of Object.keys(rows)) {
          if (key === 'len') continue;
          const cells = (rows as unknown as Record<string, { cells?: Record<string, XsCell> }>)[key]?.cells ?? {};
          for (const ci of Object.keys(cells)) keys.add(`${key}:${ci}`);
        }
      };
      collect(baseline);
      collect(data);
      for (const key of keys) {
        const [riText, ciText] = key.split(':');
        const ri = Number(riText);
        const ci = Number(ciText);
        const before = cellText(baseline, ri, ci);
        const after = cellText(data, ri, ci);
        if (before === after) continue;
        const ref = cellRef(ci + 1, ri + 1);
        if (after.startsWith('=')) await book.setCell(sheetName, ref, null, after);
        else await book.setCell(sheetName, ref, after === '' ? null : coerceScalar(after));
      }
    }
    await book.flush();
    return pkg.save();
  }

  /** Style / merge / freeze / filter / size save via XML surgery (no ExcelJS writeBuffer). */
  private async saveStructuralWithXml(changes: Array<{ index: number; data: XsSheetData }>): Promise<Uint8Array> {
    const output = new JSZip();
    Object.assign(output.files, this.zip.files);
    let stylesXml = output.file('xl/styles.xml')
      ? await output.file('xl/styles.xml')!.async('string')
      : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font/></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>';
    const sharedStrings = output.file('xl/sharedStrings.xml')
      ? parseSharedStrings(await output.file('xl/sharedStrings.xml')!.async('string'))
      : [];

    for (const { index, data } of changes) {
      const baseline = this.loaded.get(index)!.baseline;
      const path = this.sheets[index].path;
      let sheetXml = await this.zip.file(path)!.async('string');
      const cells = parseSheetCells(sheetXml, sharedStrings);
      const styleCache = new Map<string, number>();

      const resolveStyle = (
        xs: XsCellStyle | undefined,
        preserveNumFmtId = 0,
      ): number | undefined => {
        if (!xs || Object.keys(xs).length === 0) {
          // Clearing editor style still keeps the prior number format, like ExcelJS.
          if (!preserveNumFmtId) return undefined;
          const key = `__numfmt__:${preserveNumFmtId}`;
          const cached = styleCache.get(key);
          if (cached !== undefined) return cached;
          const appended = appendXsStyle(stylesXml, {}, preserveNumFmtId);
          stylesXml = appended.xml;
          styleCache.set(key, appended.xfIndex);
          return appended.xfIndex;
        }
        const key = `${JSON.stringify(xs)}|${preserveNumFmtId}`;
        const cached = styleCache.get(key);
        if (cached !== undefined) return cached;
        const appended = appendXsStyle(stylesXml, xs, preserveNumFmtId);
        stylesXml = appended.xml;
        styleCache.set(key, appended.xfIndex);
        return appended.xfIndex;
      };

      const xsStyleOf = (sheet: XsSheetData, cell?: XsCell): XsCellStyle | undefined =>
        cell?.style === undefined ? undefined : sheet.styles?.[cell.style];

      const rowKeys = new Set(
        [...Object.keys(baseline.rows ?? {}), ...Object.keys(data.rows ?? {})].filter((key) => key !== 'len'),
      );
      const rowProps = new Map<number, { height?: number }>();

      // Preserve existing custom row heights from the sheet XML, then overlay editor heights.
      for (const match of sheetXml.matchAll(/<row\b([^>]*)>/g)) {
        const rowAttr = match[1];
        const r = Number(/\br="(\d+)"/.exec(rowAttr)?.[1] ?? 0);
        const ht = /\bht="([^"]*)"/.exec(rowAttr)?.[1];
        if (r > 0 && ht && /\bcustomHeight="1"/.test(rowAttr)) {
          rowProps.set(r, { height: Number(ht) });
        }
      }

      for (const rowKey of rowKeys) {
        const ri = Number(rowKey);
        const beforeRow = baseline.rows?.[ri];
        const afterRow = data.rows?.[ri];
        if (beforeRow?.height !== afterRow?.height) {
          if (typeof afterRow?.height === 'number' && afterRow.height > 0) {
            rowProps.set(ri + 1, { height: pxToExcelRowPoints(afterRow.height) });
          } else {
            rowProps.delete(ri + 1);
          }
        }
        const cellKeys = new Set([
          ...Object.keys(beforeRow?.cells ?? {}),
          ...Object.keys(afterRow?.cells ?? {}),
        ]);
        for (const colKey of cellKeys) {
          const ci = Number(colKey);
          const beforeCell = beforeRow?.cells?.[ci];
          const afterCell = afterRow?.cells?.[ci];
          if (JSON.stringify(beforeCell) === JSON.stringify(afterCell)) continue;
          const ref = cellRef(ci + 1, ri + 1);
          const previous = cells.get(ref);
          if (!afterCell) {
            cells.delete(ref);
            continue;
          }
          const next: XlsxCell = {
            value: null,
            style: previous?.style,
            formula: previous?.formula,
            cached: previous?.cached,
          };
          const text = afterCell.text ?? '';
          if (beforeCell?.text !== afterCell.text) {
            if (text.startsWith('=')) {
              next.formula = text.slice(1);
              next.value = text;
              next.cached = undefined;
            } else {
              next.formula = undefined;
              next.cached = undefined;
              next.value = text === '' ? null : coerceScalar(text);
            }
          } else if (previous?.formula) {
            next.formula = previous.formula;
            next.value = previous.value;
            next.cached = previous.cached;
          } else {
            next.value = previous?.value ?? (text === '' ? null : coerceScalar(text));
          }
          const beforeStyle = xsStyleOf(baseline, beforeCell);
          const afterStyle = xsStyleOf(data, afterCell);
          if (JSON.stringify(beforeStyle) !== JSON.stringify(afterStyle)) {
            const preserveNumFmt = cellXfNumFmtId(stylesXml, previous?.style);
            next.style = resolveStyle(afterStyle, afterStyle?.format ? 0 : preserveNumFmt);
          }
          if (
            (next.value === null || next.value === '') &&
            !next.formula &&
            next.style === undefined
          ) {
            cells.delete(ref);
          } else {
            cells.set(ref, next);
          }
        }
      }

      sheetXml = rewriteWorksheetXml(sheetXml, cells, rowProps);
      sheetXml = patchCols(sheetXml, baseline, data);
      sheetXml = patchMerges(sheetXml, data);
      sheetXml = patchFreeze(sheetXml, data);
      sheetXml = patchAutoFilter(sheetXml, data);
      output.file(path, sheetXml);
    }
    output.file('xl/styles.xml', stylesXml);
    return output.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  }
}

function patchCols(sheetXml: string, before: XsSheetData, after: XsSheetData): string {
  const colKeys = new Set(
    [...Object.keys(before.cols ?? {}), ...Object.keys(after.cols ?? {})].filter((key) => key !== 'len'),
  );
  let changed = false;
  for (const key of colKeys) {
    const ci = Number(key);
    if (before.cols?.[ci]?.width !== after.cols?.[ci]?.width) {
      changed = true;
      break;
    }
  }
  if (!changed) return sheetXml;
  const widths = new Map<number, number>();
  const existing = section(sheetXml, 'cols');
  if (existing) {
    for (const col of tags(existing, 'col')) {
      const min = Number(attr(col, 'min'));
      const max = Number(attr(col, 'max'));
      const width = Number(attr(col, 'width'));
      if (!Number.isFinite(min) || !Number.isFinite(width)) continue;
      for (let c = min; c <= (Number.isFinite(max) ? max : min); c += 1) widths.set(c, width);
    }
  }
  for (const key of colKeys) {
    const ci = Number(key);
    const width = after.cols?.[ci]?.width;
    if (typeof width === 'number' && width > 0) widths.set(ci + 1, pxToExcelColumnWidth(width));
    else widths.delete(ci + 1);
  }
  if (!widths.size) {
    return existing ? sheetXml.replace(existing, '') : sheetXml;
  }
  const colsXml = `<cols>${[...widths.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([c, w]) => `<col min="${c}" max="${c}" width="${w}" customWidth="1"/>`)
    .join('')}</cols>`;
  return existing ? sheetXml.replace(existing, colsXml) : sheetXml.replace('<sheetData', `${colsXml}<sheetData`);
}

function patchMerges(sheetXml: string, data: XsSheetData): string {
  const merges = (data.merges ?? []).filter(Boolean);
  const existing = section(sheetXml, 'mergeCells');
  if (!merges.length) return existing ? sheetXml.replace(existing, '') : sheetXml;
  const mergeXml = `<mergeCells count="${merges.length}">${merges
    .map((range) => `<mergeCell ref="${range}"/>`)
    .join('')}</mergeCells>`;
  if (existing) return sheetXml.replace(existing, mergeXml);
  const anchor =
    /<(?:phoneticPr|conditionalFormatting|dataValidations|hyperlinks|printOptions|pageMargins|pageSetup|headerFooter|rowBreaks|colBreaks|customProperties|cellWatches|ignoredErrors|smartTags|drawing|legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b|<\/worksheet>/.exec(
      sheetXml,
    )?.index;
  return anchor === undefined
    ? sheetXml.replace('</worksheet>', `${mergeXml}</worksheet>`)
    : sheetXml.slice(0, anchor) + mergeXml + sheetXml.slice(anchor);
}

function patchFreeze(sheetXml: string, data: XsSheetData): string {
  const ref = parseCellRef(freezeRef(data));
  const frozen = !!(ref && (ref.ri > 0 || ref.ci > 0));
  const views = section(sheetXml, 'sheetViews');
  let view = views
    ? tags(views, 'sheetView')[0] ?? '<sheetView workbookViewId="0"/>'
    : '<sheetView workbookViewId="0"/>';
  view = view.replace(/<pane\b[^>]*\/>/g, '').replace(/<pane\b[^>]*>[\s\S]*?<\/pane>/g, '');
  view = view.replace(/\sstate="frozen"/g, '');
  // Drop selection nodes that reference panes we removed; ExcelJS re-adds what it needs.
  view = view.replace(/<selection\b[^>]*\/>/g, '').replace(/<selection\b[^>]*>[\s\S]*?<\/selection>/g, '');
  if (frozen) {
    const topLeft = cellRef(ref!.ci + 1, ref!.ri + 1);
    const pane = `<pane xSplit="${ref!.ci}" ySplit="${ref!.ri}" topLeftCell="${topLeft}" activePane="bottomRight" state="frozen"/><selection pane="bottomRight"/>`;
    if (/\/>\s*$/.test(view)) {
      view = view.replace(/\/>\s*$/, `>${pane}</sheetView>`);
    } else {
      view = view.replace(/<\/sheetView>/, `${pane}</sheetView>`);
    }
  }
  const next = `<sheetViews>${view}</sheetViews>`;
  if (views) return sheetXml.replace(views, next);
  // Insert before sheetFormatPr / cols / sheetData when the worksheet had no sheetViews.
  const anchor = /<(?:sheetFormatPr|cols|sheetData)\b/.exec(sheetXml)?.index;
  return anchor === undefined
    ? sheetXml.replace(/<worksheet\b[^>]*>/, (open) => `${open}${next}`)
    : sheetXml.slice(0, anchor) + next + sheetXml.slice(anchor);
}

function patchAutoFilter(sheetXml: string, data: XsSheetData): string {
  const ref = filterRef(data);
  const existing = section(sheetXml, 'autoFilter');
  if (!ref) return existing ? sheetXml.replace(existing, '') : sheetXml;
  const filterXml = `<autoFilter ref="${ref}"/>`;
  if (existing) return sheetXml.replace(existing, filterXml);
  const anchor =
    /<(?:mergeCells|phoneticPr|conditionalFormatting|dataValidations|hyperlinks|printOptions|pageMargins|pageSetup|headerFooter|rowBreaks|colBreaks|customProperties|cellWatches|ignoredErrors|smartTags|drawing|legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b|<\/worksheet>/.exec(
      sheetXml,
    )?.index;
  return anchor === undefined
    ? sheetXml.replace('</worksheet>', `${filterXml}</worksheet>`)
    : sheetXml.slice(0, anchor) + filterXml + sheetXml.slice(anchor);
}

/** Engine getData adds default freeze/autofilter/validation fields. Those
 * defaults must not turn merely visited worksheets into modified worksheets. */
function editablePayload(data: XsSheetData): string {
  const { len: _rows, ...rows } = data.rows ?? { len: 0 };
  const { len: _cols, ...cols } = data.cols ?? { len: 0 };
  return JSON.stringify([data.name, data.styles ?? [], data.merges ?? [], rows, cols, freezeRef(data), filterRef(data)]);
}

/** Structural fields only — cell text wiped — so we can detect value-only edits. */
function structuralPayload(data: XsSheetData): string {
  const clone = structuredClone(data);
  const rows = clone.rows ?? { len: 0 };
  for (const key of Object.keys(rows)) {
    if (key === 'len') continue;
    const row = (rows as unknown as Record<string, { cells?: Record<string, XsCell>; height?: number }>)[key];
    if (!row?.cells) continue;
    for (const cell of Object.values(row.cells)) cell.text = '';
  }
  return editablePayload(clone);
}

function valueOnlyChange(before: XsSheetData, after: XsSheetData): boolean {
  return structuralPayload(before) === structuralPayload(after);
}

function cellText(data: XsSheetData, ri: number, ci: number): string {
  return data.rows?.[ri]?.cells?.[ci]?.text ?? '';
}

function coerceScalar(text: string): string | number | boolean {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text.trim() !== '' && Number.isFinite(Number(text)) && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text.trim())) {
    return Number(text);
  }
  return text;
}
/** Normalised freeze / filter so engine defaults ('A1', empty filter) compare equal to "none". */
function freezeRef(data: XsSheetData): string {
  return typeof data.freeze === 'string' && data.freeze ? data.freeze.toUpperCase() : 'A1';
}
function filterRef(data: XsSheetData): string | null {
  const ref = (data.autofilter as { ref?: unknown } | undefined)?.ref;
  return typeof ref === 'string' && ref ? ref : null;
}
function parseCellRef(ref: string): { ri: number; ci: number } | null {
  const match = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!match) return null;
  let ci = 0;
  for (const ch of match[1]) ci = ci * 26 + ch.charCodeAt(0) - 64;
  return { ri: Number(match[2]) - 1, ci: ci - 1 };
}
