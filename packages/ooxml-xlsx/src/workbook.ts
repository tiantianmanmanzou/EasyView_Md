/**
 * In-memory xlsx workbook over OpcPackage: load sheets lazily, mutate cells,
 * flush dirty worksheets as precise sheetData rewrites.
 */

import type { OpcPackage } from '@easyview/ooxml-core/opc';
import { EMPTY_SHEET_XML, sanitizeSheetName } from './emptyWorkbook';
import { shiftFormulaRows } from './formulaShift';
import { cellRef, columnLetter, parseCellRef } from './refs';
import { parseSharedStrings } from './sharedStrings';
import {
  parseSheetCells,
  rewriteWorksheetXml,
  summarizeUsedRange,
  type XlsxCell,
  type XlsxCellValue,
} from './sheetXml';

const element = (tag: string) =>
  `<${tag}\\b(?:[^>]*?\\/>|[^>]*?[^/>]>[\\s\\S]*?<\\/${tag}>|>[\\s\\S]*?<\\/${tag}>)`;
const tags = (xml: string, tag: string) => [...xml.matchAll(new RegExp(element(tag), 'g'))].map((m) => m[0]);
const attr = (xml: string, key: string) => new RegExp(`\\b${key}="([^"]*)"`).exec(xml)?.[1] ?? '';
const decode = (text: string) =>
  text.replace(/&#x([\da-f]+);|&#(\d+);|&(amp|lt|gt|quot|apos);/gi, (_, hex, dec, named) =>
    hex || dec
      ? String.fromCodePoint(parseInt(hex || dec, hex ? 16 : 10))
      : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named as string] ?? ''),
  );
const encode = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export interface SheetInfo {
  id: string;
  name: string;
  path: string;
  relationshipId: string;
}

interface LoadedSheet {
  originalXml: string;
  cells: Map<string, XlsxCell>;
  dirty: boolean;
}

export class XlsxWorkbook {
  private sharedStrings: string[] | null = null;
  private readonly loaded = new Map<number, LoadedSheet>();
  private formulasTouched = false;
  private structureDirty = false;
  private constructor(
    readonly pkg: OpcPackage,
    readonly sheets: SheetInfo[],
  ) {}

  static async open(pkg: OpcPackage): Promise<XlsxWorkbook> {
    const workbookXml = await pkg.readPartText('xl/workbook.xml');
    const relsXml = await pkg.readPartText('xl/_rels/workbook.xml.rels');
    const relationships = new Map(
      tags(relsXml, 'Relationship').map((rel) => [attr(rel, 'Id'), attr(rel, 'Target')]),
    );
    const sheets = tags(workbookXml, 'sheet').map((elementXml) => {
      const rid = attr(elementXml, 'r:id');
      const target = relationships.get(rid);
      if (!target) throw new Error(`Missing worksheet relationship for ${rid}`);
      const path = decodeURIComponent(new URL(target, 'https://xlsx.invalid/xl/').pathname.slice(1));
      return {
        id: attr(elementXml, 'sheetId'),
        name: decode(attr(elementXml, 'name')),
        path,
        relationshipId: rid,
      };
    });
    if (!sheets.length) throw new Error('Workbook has no sheets');
    return new XlsxWorkbook(pkg, sheets);
  }

  sheetIndex(name: string): number {
    const index = this.sheets.findIndex((sheet) => sheet.name === name);
    if (index < 0) {
      throw new Error(
        `Sheet "${name}" not found. Available: ${this.sheets.map((sheet) => sheet.name).join(', ')}`,
      );
    }
    return index;
  }

  private async ensureSharedStrings(): Promise<string[]> {
    if (this.sharedStrings) return this.sharedStrings;
    if (!this.pkg.hasPart('xl/sharedStrings.xml')) {
      this.sharedStrings = [];
      return this.sharedStrings;
    }
    this.sharedStrings = parseSharedStrings(await this.pkg.readPartText('xl/sharedStrings.xml'));
    return this.sharedStrings;
  }

  async loadSheet(index: number): Promise<LoadedSheet> {
    const cached = this.loaded.get(index);
    if (cached) return cached;
    const info = this.sheets[index];
    if (!info) throw new Error(`Unknown sheet index ${index}`);
    const originalXml = await this.pkg.readPartText(info.path);
    const shared = await this.ensureSharedStrings();
    const cells = parseSheetCells(originalXml, shared);
    const loaded: LoadedSheet = { originalXml, cells, dirty: false };
    this.loaded.set(index, loaded);
    return loaded;
  }

  async getCell(sheetName: string, ref: string): Promise<XlsxCellValue> {
    const sheet = await this.loadSheet(this.sheetIndex(sheetName));
    return sheet.cells.get(ref)?.value ?? null;
  }

  async setCell(sheetName: string, ref: string, value: XlsxCellValue, formula?: string): Promise<void> {
    const sheet = await this.loadSheet(this.sheetIndex(sheetName));
    const previous = sheet.cells.get(ref);
    if (formula !== undefined) {
      const normalized = formula.replace(/^=/, '');
      sheet.cells.set(ref, { value: `=${normalized}`, formula: normalized, style: previous?.style });
      this.formulasTouched = true;
    } else if (typeof value === 'string' && value.startsWith('=')) {
      sheet.cells.set(ref, { value, formula: value.slice(1), style: previous?.style });
      this.formulasTouched = true;
    } else if (value === null || value === '') {
      if (previous?.style !== undefined) sheet.cells.set(ref, { value: null, style: previous.style });
      else sheet.cells.delete(ref);
    } else {
      sheet.cells.set(ref, { value, style: previous?.style });
    }
    sheet.dirty = true;
  }

  async sheetGrid(sheetName: string): Promise<Map<string, XlsxCellValue>> {
    const sheet = await this.loadSheet(this.sheetIndex(sheetName));
    const grid = new Map<string, XlsxCellValue>();
    for (const [ref, cell] of sheet.cells) {
      if (cell.value !== null && cell.value !== '') grid.set(ref, cell.value);
    }
    return grid;
  }

  async summarizeSheet(
    sheetName: string,
    maxRows: number,
    maxColumns: number,
  ): Promise<{
    name: string;
    usedRange: string | null;
    rowCount: number;
    columnCount: number;
    headers: XlsxCellValue[];
    rows: Array<{ row: number; values: XlsxCellValue[] }>;
  }> {
    const sheet = await this.loadSheet(this.sheetIndex(sheetName));
    const usedRange = summarizeUsedRange(sheet.cells);
    let rowCount = 0;
    let columnCount = 0;
    for (const ref of sheet.cells.keys()) {
      const { col, row } = parseCellRef(ref);
      rowCount = Math.max(rowCount, row);
      columnCount = Math.max(columnCount, col);
    }
    const width = Math.min(columnCount, maxColumns);
    const readRow = (rowNumber: number): XlsxCellValue[] =>
      Array.from({ length: width }, (_, i) => sheet.cells.get(cellRef(i + 1, rowNumber))?.value ?? null);
    const rows: Array<{ row: number; values: XlsxCellValue[] }> = [];
    for (let r = 2; r <= rowCount && rows.length < maxRows; r += 1) {
      rows.push({ row: r, values: readRow(r) });
    }
    return {
      name: sheetName,
      usedRange,
      rowCount,
      columnCount,
      headers: rowCount ? readRow(1) : [],
      rows,
    };
  }

  /** Shift cells for insert/delete rows, and cascade A1 formula row refs. */
  async spliceRows(sheetName: string, at: number, deleteCount: number, inserted: XlsxCellValue[][]): Promise<void> {
    const sheet = await this.loadSheet(this.sheetIndex(sheetName));
    const next = new Map<string, XlsxCell>();
    const rewrite = (cell: XlsxCell): XlsxCell => {
      if (!cell.formula) return cell;
      const formula = shiftFormulaRows(cell.formula, at, deleteCount, inserted.length);
      if (formula === cell.formula) return cell;
      this.formulasTouched = true;
      return {
        ...cell,
        formula,
        value: formula.startsWith('=') ? formula : `=${formula}`,
        cached: undefined,
      };
    };
    for (const [ref, cell] of sheet.cells) {
      const { col, row } = parseCellRef(ref);
      if (row < at) {
        next.set(ref, rewrite(cell));
        continue;
      }
      if (row < at + deleteCount) continue;
      const shifted = row - deleteCount + inserted.length;
      next.set(cellRef(col, shifted), rewrite(cell));
    }
    for (let i = 0; i < inserted.length; i += 1) {
      const rowValues = inserted[i];
      for (let c = 0; c < rowValues.length; c += 1) {
        const value = rowValues[c];
        if (value === null || value === '') continue;
        next.set(cellRef(c + 1, at + i), { value });
      }
    }
    sheet.cells = next;
    sheet.dirty = true;
  }

  async maxRow(sheetName: string): Promise<number> {
    const sheet = await this.loadSheet(this.sheetIndex(sheetName));
    let max = 0;
    for (const ref of sheet.cells.keys()) max = Math.max(max, parseCellRef(ref).row);
    return max;
  }

  /** Rename a worksheet in workbook.xml (path unchanged). */
  renameSheet(oldName: string, newName: string): string {
    const index = this.sheetIndex(oldName);
    const next = this.uniqueSheetName(newName);
    this.sheets[index] = { ...this.sheets[index], name: next };
    this.structureDirty = true;
    return next;
  }

  /** Append an empty worksheet; returns the final unique name. */
  async addSheet(name: string): Promise<string> {
    const finalName = this.uniqueSheetName(name);
    const path = this.nextWorksheetPath();
    const relationshipId = await this.nextRelationshipId();
    const sheetId = String(Math.max(0, ...this.sheets.map((sheet) => Number(sheet.id) || 0)) + 1);
    this.pkg.writePartText(path, EMPTY_SHEET_XML);
    this.sheets.push({ id: sheetId, name: finalName, path, relationshipId });
    this.structureDirty = true;
    return finalName;
  }

  /** Delete a worksheet (refuses to remove the last sheet). */
  async deleteSheet(name: string): Promise<void> {
    if (this.sheets.length <= 1) throw new Error('Cannot delete the last worksheet');
    const index = this.sheetIndex(name);
    const [removed] = this.sheets.splice(index, 1);
    this.pkg.deletePart(removed.path);
    // Sheet indices shifted; drop cached loads to avoid stale index mapping.
    this.loaded.clear();
    this.structureDirty = true;
  }

  private uniqueSheetName(name: string): string {
    const base = sanitizeSheetName(name);
    const taken = new Set(this.sheets.map((sheet) => sheet.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    let n = 1;
    while (true) {
      const suffix = `_${n++}`;
      const candidate = `${base.slice(0, Math.max(1, 31 - suffix.length))}${suffix}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  private nextWorksheetPath(): string {
    let n = this.sheets.length + 1;
    while (this.pkg.hasPart(`xl/worksheets/sheet${n}.xml`) || this.sheets.some((sheet) => sheet.path === `xl/worksheets/sheet${n}.xml`)) {
      n += 1;
    }
    return `xl/worksheets/sheet${n}.xml`;
  }

  private async nextRelationshipId(): Promise<string> {
    const used = new Set(this.sheets.map((sheet) => sheet.relationshipId));
    if (this.pkg.hasPart('xl/_rels/workbook.xml.rels')) {
      const relsXml = await this.pkg.readPartText('xl/_rels/workbook.xml.rels');
      for (const rel of tags(relsXml, 'Relationship')) {
        const id = attr(rel, 'Id');
        if (id) used.add(id);
      }
    }
    let n = 1;
    while (used.has(`rId${n}`)) n += 1;
    return `rId${n}`;
  }

  /** Write dirty worksheets / workbook structure back into the OPC package. */
  async flush(): Promise<string[]> {
    const dirty: string[] = [];
    for (const [index, sheet] of this.loaded) {
      if (!sheet.dirty) continue;
      const info = this.sheets[index];
      const xml = rewriteWorksheetXml(sheet.originalXml, sheet.cells);
      this.pkg.writePartText(info.path, xml);
      sheet.originalXml = xml;
      sheet.dirty = false;
      dirty.push(info.path);
    }
    if (this.structureDirty) {
      dirty.push(...(await this.flushWorkbookStructure()));
      this.structureDirty = false;
    } else if (dirty.length && this.formulasTouched && this.pkg.hasPart('xl/workbook.xml')) {
      const touched = await this.ensureFullCalcOnLoad();
      if (touched) dirty.push('xl/workbook.xml');
    }
    return dirty;
  }

  private async flushWorkbookStructure(): Promise<string[]> {
    const dirty: string[] = [];
    const workbookXml = await this.pkg.readPartText('xl/workbook.xml');
    const sheetElements = this.sheets
      .map(
        (sheet) =>
          `<sheet name="${encode(sheet.name)}" sheetId="${sheet.id}" r:id="${sheet.relationshipId}"/>`,
      )
      .join('');
    let nextWorkbook = workbookXml.replace(
      /<sheets\b[^>]*>[\s\S]*?<\/sheets>/,
      `<sheets>${sheetElements}</sheets>`,
    );
    if (this.formulasTouched && !/fullCalcOnLoad="1"/.test(nextWorkbook)) {
      if (/<calcPr\b[^>]*\/>/.test(nextWorkbook)) {
        nextWorkbook = nextWorkbook.replace(/<calcPr\b([^>]*)\/>/, (_full, attrs: string) => {
          if (/fullCalcOnLoad=/.test(attrs)) {
            return `<calcPr${attrs.replace(/fullCalcOnLoad="[^"]*"/, 'fullCalcOnLoad="1"')}/>`;
          }
          return `<calcPr${attrs} fullCalcOnLoad="1"/>`;
        });
      } else if (/<calcPr\b/.test(nextWorkbook)) {
        nextWorkbook = nextWorkbook.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1" ');
      } else {
        nextWorkbook = nextWorkbook.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
      }
    }
    this.pkg.writePartText('xl/workbook.xml', nextWorkbook);
    dirty.push('xl/workbook.xml');

    const relsPath = 'xl/_rels/workbook.xml.rels';
    const relsXml = await this.pkg.readPartText(relsPath);
    const otherRels = tags(relsXml, 'Relationship').filter(
      (rel) => !/Type="[^"]*\/worksheet"/.test(rel),
    );
    const sheetRels = this.sheets.map((sheet) => {
      const target = sheet.path.startsWith('xl/') ? sheet.path.slice('xl/'.length) : sheet.path;
      return `<Relationship Id="${sheet.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}"/>`;
    });
    this.pkg.writePartText(
      relsPath,
      relsXml.replace(
        /<Relationships\b[^>]*>[\s\S]*?<\/Relationships>/,
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${[...sheetRels, ...otherRels].join('')}</Relationships>`,
      ),
    );
    dirty.push(relsPath);

    const contentTypesPath = '[Content_Types].xml';
    if (this.pkg.hasPart(contentTypesPath)) {
      const typesXml = await this.pkg.readPartText(contentTypesPath);
      const withoutSheets = typesXml.replace(
        /<Override\b[^>]*PartName="\/xl\/worksheets\/[^"]+"[^>]*\/>/g,
        '',
      );
      const overrides = this.sheets
        .map(
          (sheet) =>
            `<Override PartName="/${sheet.path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join('');
      const nextTypes = withoutSheets.includes('</Types>')
        ? withoutSheets.replace('</Types>', `${overrides}</Types>`)
        : `${withoutSheets}${overrides}`;
      this.pkg.writePartText(contentTypesPath, nextTypes);
      dirty.push(contentTypesPath);
    }
    return dirty;
  }

  private async ensureFullCalcOnLoad(): Promise<boolean> {
    const xml = await this.pkg.readPartText('xl/workbook.xml');
    if (/fullCalcOnLoad="1"/.test(xml)) return false;
    let next = xml;
    if (/<calcPr\b[^>]*\/>/.test(xml)) {
      next = xml.replace(/<calcPr\b([^>]*)\/>/, (_full, attrs: string) => {
        if (/fullCalcOnLoad=/.test(attrs)) {
          return `<calcPr${attrs.replace(/fullCalcOnLoad="[^"]*"/, 'fullCalcOnLoad="1"')}/>`;
        }
        return `<calcPr${attrs} fullCalcOnLoad="1"/>`;
      });
    } else if (/<calcPr\b/.test(xml)) {
      next = xml.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1" ');
    } else {
      next = xml.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
    }
    if (next === xml) return false;
    this.pkg.writePartText('xl/workbook.xml', next);
    return true;
  }
}

export function usedColumnLetter(columnCount: number): string {
  return columnLetter(Math.max(1, columnCount));
}
