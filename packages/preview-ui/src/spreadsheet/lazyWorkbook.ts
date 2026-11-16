import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { OpcPackage } from '@easyview/ooxml-core/opc';
import { cellRef, XlsxWorkbook } from '@easyview/ooxml-xlsx';
import { worksheetToXsSheet, applyXsStyleToCell, validateSheetXml, pxToExcelColumnWidth, pxToExcelRowPoints } from './xSpreadsheetBridge';
import type { XsCell, XsSheetData } from './xSpreadsheetTypes';
import { tPreview } from '../preview.i18n';

/** One element: either self-closing, or open…close. The self-closing branch must win first, or a
 * `<xf …/>` swallows every sibling up to the next `</xf>` (that corrupted saved cell styles). */
const element = (tag: string) => `<${tag}\\b(?:[^>]*?\\/>|[^>]*?[^/>]>[\\s\\S]*?<\\/${tag}>|>[\\s\\S]*?<\\/${tag}>)`;
const tags = (xml: string, tag: string) => [...xml.matchAll(new RegExp(element(tag), 'g'))].map(match => match[0]);
const attr = (xml: string, key: string) => new RegExp(`\\b${key}="([^"]*)"`).exec(xml)?.[1] ?? '';
const decode = (text: string) => text.replace(/&#x([\da-f]+);|&#(\d+);|&(amp|lt|gt|quot|apos);/gi, (_, hex, dec, named) => hex || dec ? String.fromCodePoint(parseInt(hex || dec, hex ? 16 : 10)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named as string] ?? ''));
const section = (xml: string, name: string) => new RegExp(element(name)).exec(xml)?.[0] ?? '';
function replaceSection(xml: string, name: string, value: string, before = '</worksheet>'): string {
  const old = section(xml, name);
  return old ? xml.replace(old, value) : xml.replace(before, `${value}${before}`);
}
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
    // Text/formula-only edits go through ooxml-xlsx (no ExcelJS writeBuffer). Style /
    // merge / freeze / filter / size changes still use the ExcelJS section-merge path.
    if (pending.every(({ index, data }) => valueOnlyChange(this.loaded.get(index)!.baseline, data))) {
      return this.saveValuesWithOoxml(pending);
    }
    return this.saveWithExcelJs(pending);
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

  private async saveWithExcelJs(changes: Array<{ index: number; data: XsSheetData }>): Promise<Uint8Array> {
    // Clone the archive so a failed/overlapping save never changes our baseline.
    const output = new JSZip();
    Object.assign(output.files, this.zip.files);
    for (const { index, data } of changes) {
      const loaded = this.loaded.get(index)!;
      const workbook = await this.decode(index);
      const worksheet = workbook.worksheets[0];
      applyChanges(worksheet, loaded.baseline, data);
      const generated = await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
      let xml = await generated.file(`xl/worksheets/sheet${worksheet.id}.xml`)!.async('string');
      const styleMap = await mergeStyles(output, await generated.file('xl/styles.xml')!.async('string'));
      xml = xml.replace(/\bs="(\d+)"/g, (_, id) => `s="${styleMap[Number(id)]}"`);
      const strings = generated.file('xl/sharedStrings.xml');
      if (strings) {
        const old = output.file('xl/sharedStrings.xml');
        const previous = old ? await old.async('string') : '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"></sst>';
        const offset = tags(previous, 'si').length;
        const added = tags(await strings.async('string'), 'si');
        const all = [...tags(previous, 'si'), ...added];
        output.file('xl/sharedStrings.xml', previous.replace(section(previous, 'sst'), `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${all.length}" uniqueCount="${all.length}">${all.join('')}</sst>`));
        xml = xml.replace(/<c\b[^>]*\bt="s"[^>]*>[\s\S]*?<\/c>/g, cell => cell.replace(/<v>(\d+)<\/v>/, (_, id) => `<v>${Number(id) + offset}</v>`));
        if (!old) await ensureSharedStringsRelationship(output);
      }
      const path = this.sheets[index].path;
      let original = await this.zip.file(path)!.async('string');
      // Preserve worksheet extras and relationships (drawings, validations,
      // conditional formats, print settings, VBA, external links) verbatim.
      for (const name of ['sheetViews', 'dimension', 'cols', 'sheetData', 'autoFilter', 'mergeCells']) {
        const before = name === 'cols' ? '<sheetData' : name === 'sheetViews' ? (/<sheetFormatPr\b/.test(original) ? '<sheetFormatPr' : '<cols') : '</worksheet>';
        const value = section(xml, name);
        const old = section(original, name);
        if (old) original = original.replace(old, value);
        else if (value) {
          const anchor = name === 'mergeCells' || name === 'autoFilter' ? /<(?:phoneticPr|conditionalFormatting|dataValidations|hyperlinks|printOptions|pageMargins|pageSetup|headerFooter|rowBreaks|colBreaks|customProperties|cellWatches|ignoredErrors|smartTags|drawing|legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b|<\/worksheet>/.exec(original)?.index : undefined;
          original = anchor === undefined ? original.replace(before, `${value}${before}`) : original.slice(0, anchor) + value + original.slice(anchor);
        }
      }
      output.file(path, original);
    }
    return output.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  }
}
function applyChanges(sheet: ExcelJS.Worksheet, before: XsSheetData, after: XsSheetData): void {
  const rows = new Set([...Object.keys(before.rows ?? {}), ...Object.keys(after.rows ?? {})].filter(key => key !== 'len'));
  for (const row of rows) {
    const ri = Number(row); const old = before.rows?.[ri]; const next = after.rows?.[ri];
    if (old?.height !== next?.height) sheet.getRow(ri + 1).height = typeof next?.height === 'number' ? pxToExcelRowPoints(next.height) : 15;
    const cells = new Set([...Object.keys(old?.cells ?? {}), ...Object.keys(next?.cells ?? {})]);
    for (const column of cells) {
      const ci = Number(column), a = old?.cells?.[ci], b = next?.cells?.[ci];
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      const cell = sheet.getCell(ri + 1, ci + 1);
      if (a?.text !== b?.text) {
        const text = b?.text ?? '';
        cell.value = text.startsWith('=') ? { formula: text.slice(1) } : text;
      }
      const style = (data: XsSheetData, value?: XsCell) => value?.style === undefined ? undefined : data.styles?.[value.style];
      if (JSON.stringify(style(before, a)) !== JSON.stringify(style(after, b))) {
        cell.style = { numFmt: cell.numFmt, protection: cell.protection }; const value = style(after, b); if (value) applyXsStyleToCell(value, cell);
      }
    }
  }
  for (const column of new Set([...Object.keys(before.cols ?? {}), ...Object.keys(after.cols ?? {})])) {
    if (column === 'len') continue;
    const ci = Number(column); if (before.cols?.[ci]?.width !== after.cols?.[ci]?.width) {
      const width = after.cols?.[ci]?.width;
      sheet.getColumn(ci + 1).width = typeof width === 'number' ? pxToExcelColumnWidth(width) : 10;
    }
  }
  if (freezeRef(before) !== freezeRef(after)) {
    const ref = parseCellRef(freezeRef(after));
    sheet.views = ref && (ref.ri > 0 || ref.ci > 0) ? [{ state: 'frozen', xSplit: ref.ci, ySplit: ref.ri }] : [{ state: 'normal' }];
  }
  if (filterRef(before) !== filterRef(after)) {
    const ref = filterRef(after);
    sheet.autoFilter = ref ?? (undefined as unknown as string);
  }
  if (JSON.stringify(before.merges) !== JSON.stringify(after.merges)) {
    for (const range of before.merges ?? []) sheet.unMergeCells(range);
    for (const range of after.merges ?? []) sheet.mergeCells(range);
  }
}
async function ensureSharedStringsRelationship(zip: JSZip): Promise<void> {
  const path = 'xl/_rels/workbook.xml.rels';
  const rels = await zip.file(path)!.async('string');
  zip.file(path, rels.replace('</Relationships>', '<Relationship Id="rIdEasyViewStrings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>'));
  const types = await zip.file('[Content_Types].xml')!.async('string');
  zip.file('[Content_Types].xml', types.replace('</Types>', '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'));
}
async function mergeStyles(zip: JSZip, generated: string): Promise<number[]> {
  let original = await zip.file('xl/styles.xml')!.async('string');
  const maps: Record<string, number[]> = {};
  for (const [name, tag] of [['numFmts', 'numFmt'], ['fonts', 'font'], ['fills', 'fill'], ['borders', 'border'], ['cellStyleXfs', 'xf'], ['cellXfs', 'xf']]) {
    const existing = tags(section(original, name), tag);
    const values = tags(section(generated, name), tag);
    const mapping: number[] = [];
    for (let i = 0; i < values.length; i++) {
      let value = values[i];
      if (tag === 'xf') for (const [attribute, table] of [['fontId', 'fonts'], ['fillId', 'fills'], ['borderId', 'borders'], ['numFmtId', 'numFmts'], ['xfId', 'cellStyleXfs']]) value = value.replace(new RegExp(`\\b${attribute}="(\\d+)"`), (_, id) => `${attribute}="${maps[table]?.[Number(id)] ?? Number(id)}"`);
      if (name === 'numFmts') {
        const id = Number(attr(value, 'numFmtId'));
        const found = existing.find(entry => attr(entry, 'formatCode') === attr(value, 'formatCode'));
        const target = found ? Number(attr(found, 'numFmtId')) : Math.max(163, ...existing.map(entry => Number(attr(entry, 'numFmtId')))) + 1;
        mapping[id] = target; if (!found) existing.push(value.replace(/numFmtId="\d+"/, `numFmtId="${target}"`));
      } else {
        let target = existing.indexOf(value); if (target < 0) { target = existing.length; existing.push(value); } mapping[i] = target;
      }
    }
    maps[name] = mapping;
    const value = `<${name} count="${existing.length}">${existing.join('')}</${name}>`;
    original = replaceSection(original, name, value, name === 'numFmts' ? '<fonts' : '</styleSheet>');
  }
  zip.file('xl/styles.xml', original);
  return maps.cellXfs;
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
