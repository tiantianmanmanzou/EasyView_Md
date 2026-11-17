/**
 * Excel (.xlsx) editing core for AI Agent mode.
 *
 * Every edit is staged in memory first: callers get a cell-level diff and a
 * proposal; only `commitXlsxProposal` touches disk, after re-checking the
 * fingerprint, keeping the original restorable, and writing atomically. `undoXlsxCommit`
 * restores the backup as long as the file was not changed after the commit.
 *
 * Production write path uses @easyview/ooxml-xlsx (precise sheetData rewrite via
 * OpcPackage) — not ExcelJS — so untouched zip parts (charts/drawings) stay intact.
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { OpcPackage } from '@easyview/ooxml-core';
import {
  applySheetOp,
  parseRange,
  rangeOpCells,
  refSortKey,
  XlsxWorkbook,
  type XlsxCellValue as OoxmlCellValue,
  type XlsxSheetOp as OoxmlSheetOp,
} from '@easyview/ooxml-xlsx';
import { z } from 'zod';
import { writeFileAtomically } from '../filesystem/file-write';
import { readOfficeBackup, type OfficeBackupRef, type OfficeBackupStore } from './office-backups';
import { tAi } from './ai.i18n';

export { parseRange, rangeOpCells } from '@easyview/ooxml-xlsx';

export const XLSX_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Max ops in one apply_sheet_ops call. Prefer range ops for big batches: they are far shorter for the model to emit. */
export const XLSX_MAX_OPS = 30_000;
/** Max cells a single call may touch through range ops (setRange / transformRange / replaceWhere). */
export const XLSX_MAX_RANGE_CELLS = 500_000;
export const XLSX_MAX_DIFF_ENTRIES = 1000;
export const XLSX_DEFAULT_PREVIEW_ROWS = 20;
export const XLSX_MAX_PREVIEW_ROWS = 200;
export const XLSX_MAX_PREVIEW_COLUMNS = 50;
export const XLSX_OPERATION_TIMEOUT_MS = 120_000;

const CELL_REF = /^[A-Z]{1,3}[1-9][0-9]{0,6}$/;
const RANGE_REF = /^[A-Z]{1,3}[1-9][0-9]{0,6}(:[A-Z]{1,3}[1-9][0-9]{0,6})?$/;
const COLUMN_REF = /^[A-Z]{1,3}$/;
const cellValueSchema = z.union([z.string().max(32_767), z.number().finite(), z.boolean(), z.null()]);
const sheetName = z.string().min(1).max(31);

export const xlsxSheetOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('setCell'),
    sheet: sheetName,
    ref: z.string().regex(CELL_REF),
    value: cellValueSchema.optional(),
    formula: z.string().min(1).max(8192).optional(),
  }).refine((op) => (op.value === undefined) !== (op.formula === undefined), { message: 'setCell needs exactly one of value or formula' }),
  z.object({
    op: z.literal('insertRows'),
    sheet: sheetName,
    at: z.number().int().min(1).max(1_048_576),
    rows: z.array(z.array(cellValueSchema).max(XLSX_MAX_PREVIEW_COLUMNS * 10)).min(1).max(500),
  }),
  z.object({
    op: z.literal('deleteRows'),
    sheet: sheetName,
    at: z.number().int().min(1).max(1_048_576),
    count: z.number().int().min(1).max(500),
  }),
  z.object({
    op: z.literal('setRange'),
    sheet: sheetName,
    range: z.string().regex(RANGE_REF),
    value: cellValueSchema.optional(),
    values: z.array(z.array(cellValueSchema)).min(1).optional(),
    formula: z.string().min(1).max(8192).optional(),
  })
    .refine((op) => [op.value, op.values, op.formula].filter((item) => item !== undefined).length === 1, { message: 'setRange needs exactly one of value, values or formula' })
    .refine((op) => {
      if (op.values === undefined) return true;
      const r = parseRange(op.range);
      return op.values.length === r.bottom - r.top + 1 && op.values.every((line) => line.length === r.right - r.left + 1);
    }, { message: 'setRange values must be a row-major grid with exactly the same rows and columns as range' })
    .refine((op) => !(typeof op.value === 'string' && /[\n\t]/.test(op.value) && parseRange(op.range).cells > 1), {
      message: 'setRange value is copied into every cell; to fill different data per cell use values (2D grid), and to append rows use insertRows',
    }),
  z.object({
    op: z.literal('transformRange'),
    sheet: sheetName,
    range: z.string().regex(RANGE_REF),
    transform: z.enum(['multiply', 'add', 'round', 'replaceText', 'prefix', 'suffix', 'clear']),
    number: z.number().finite().optional(),
    digits: z.number().int().min(0).max(10).optional(),
    find: z.string().min(1).max(1000).optional(),
    text: z.string().max(1000).optional(),
  }).refine((op) => {
    if (op.transform === 'multiply' || op.transform === 'add') return op.number !== undefined;
    if (op.transform === 'replaceText') return op.find !== undefined && op.text !== undefined;
    if (op.transform === 'prefix' || op.transform === 'suffix') return op.text !== undefined;
    return true;
  }, { message: 'transformRange is missing the argument its transform needs' }),
  z.object({
    op: z.literal('replaceWhere'),
    sheet: sheetName,
    matchColumn: z.string().regex(COLUMN_REF),
    equals: cellValueSchema,
    setColumn: z.string().regex(COLUMN_REF),
    value: cellValueSchema.optional(),
    formula: z.string().min(1).max(8192).optional(),
    fromRow: z.number().int().min(1).max(1_048_576).optional(),
    toRow: z.number().int().min(1).max(1_048_576).optional(),
  }).refine((op) => (op.value === undefined) !== (op.formula === undefined), { message: 'replaceWhere needs exactly one of value or formula' }),
  z.object({
    op: z.literal('setStyle'),
    sheet: sheetName,
    ref: z.string().regex(CELL_REF),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    fillColor: z.string().regex(/^#?[0-9A-Fa-f]{6}$/).optional(),
    numFmt: z.string().min(1).max(100).optional(),
  }),
  z.object({
    op: z.literal('addSheet'),
    name: sheetName,
  }),
  z.object({
    op: z.literal('deleteSheet'),
    sheet: sheetName,
  }),
  z.object({
    op: z.literal('renameSheet'),
    sheet: sheetName,
    newName: sheetName,
  }),
]);
export const xlsxSheetOpsSchema = z.array(xlsxSheetOpSchema).min(1).max(XLSX_MAX_OPS);
export type XlsxSheetOp = z.infer<typeof xlsxSheetOpSchema>;

export type XlsxCellValue = string | number | boolean | null;

export interface XlsxSheetSummary {
  name: string;
  usedRange: string | null;
  rowCount: number;
  columnCount: number;
  headers: XlsxCellValue[];
  rows: Array<{ row: number; values: XlsxCellValue[] }>;
}

export interface XlsxInspection {
  fileName: string;
  fingerprint: string;
  sheets: XlsxSheetSummary[];
}

export interface XlsxCellChange {
  sheet: string;
  ref: string;
  before: XlsxCellValue;
  after: XlsxCellValue;
}

export interface XlsxDiff {
  changes: XlsxCellChange[];
  total: number;
  truncated: boolean;
  structural: string[];
}

export interface XlsxProposal {
  id: string;
  filePath: string;
  baseFingerprint: string;
  nextFingerprint: string;
  buffer: Buffer;
  diff: XlsxDiff;
  ops: XlsxSheetOp[];
}

export interface XlsxCommitRecord {
  filePath: string;
  backup: OfficeBackupRef;
  writtenFingerprint: string;
}

export function fingerprintBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

export function isXlsxPath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.xlsx';
}

async function readXlsxBytes(filePath: string): Promise<Buffer> {
  if (!isXlsxPath(filePath)) throw new Error(tAi('xlsx.notXlsx'));
  const stat = await fs.lstat(filePath);
  if (!stat.isFile()) throw new Error(tAi('tools.notRegularFile'));
  if (stat.size > XLSX_MAX_FILE_BYTES) throw new Error(tAi('tools.fileTooLarge', { size: stat.size, max: XLSX_MAX_FILE_BYTES }));
  return fs.readFile(filePath);
}

export function diffWorkbookGrids(
  before: Map<string, Map<string, XlsxCellValue>>,
  after: Map<string, Map<string, XlsxCellValue>>,
): { changes: XlsxCellChange[]; total: number; truncated: boolean } {
  const changes: XlsxCellChange[] = [];
  let total = 0;
  const sheets = new Set([...before.keys(), ...after.keys()]);
  for (const sheet of sheets) {
    const a = before.get(sheet) ?? new Map<string, XlsxCellValue>();
    const b = after.get(sheet) ?? new Map<string, XlsxCellValue>();
    const changed: Array<{ key: number; ref: string; before: XlsxCellValue; after: XlsxCellValue }> = [];
    const visit = (ref: string) => {
      const prev = a.get(ref) ?? null;
      const next = b.get(ref) ?? null;
      if (prev !== next) changed.push({ key: refSortKey(ref), ref, before: prev, after: next });
    };
    for (const ref of a.keys()) visit(ref);
    for (const ref of b.keys()) if (!a.has(ref)) visit(ref);
    total += changed.length;
    if (changes.length >= XLSX_MAX_DIFF_ENTRIES) continue;
    changed.sort((left, right) => left.key - right.key);
    for (const item of changed) {
      if (changes.length >= XLSX_MAX_DIFF_ENTRIES) break;
      changes.push({ sheet, ref: item.ref, before: item.before, after: item.after });
    }
  }
  return { changes, total, truncated: total > changes.length };
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(tAi('xlsx.timeout'))), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

async function gridsOf(workbook: XlsxWorkbook): Promise<Map<string, Map<string, XlsxCellValue>>> {
  const grids = new Map<string, Map<string, XlsxCellValue>>();
  for (const sheet of workbook.sheets) {
    grids.set(sheet.name, await workbook.sheetGrid(sheet.name) as Map<string, XlsxCellValue>);
  }
  return grids;
}

export async function inspectXlsxFile(filePath: string, maxRows = XLSX_DEFAULT_PREVIEW_ROWS): Promise<XlsxInspection> {
  const bytes = await readXlsxBytes(filePath);
  const workbook = await XlsxWorkbook.open(await OpcPackage.open(bytes));
  const limit = Math.max(0, Math.min(XLSX_MAX_PREVIEW_ROWS, Math.floor(maxRows)));
  const sheets: XlsxSheetSummary[] = [];
  for (const sheet of workbook.sheets) {
    sheets.push(await workbook.summarizeSheet(sheet.name, limit, XLSX_MAX_PREVIEW_COLUMNS));
  }
  return {
    fileName: path.basename(filePath),
    fingerprint: fingerprintBytes(bytes),
    sheets,
  };
}

/** Builds the edited workbook in memory and returns a proposal; nothing is written. */
export async function planXlsxEdit(
  filePath: string,
  expectedFingerprint: string,
  rawOps: unknown,
  timeoutMs = XLSX_OPERATION_TIMEOUT_MS,
): Promise<XlsxProposal> {
  const ops = xlsxSheetOpsSchema.parse(rawOps);
  const rangeCells = ops.reduce((sum, op) => sum + rangeOpCells(op as OoxmlSheetOp), 0);
  if (rangeCells > XLSX_MAX_RANGE_CELLS) throw new Error(tAi('xlsx.rangeTooLarge', { cells: rangeCells, max: XLSX_MAX_RANGE_CELLS }));
  return withTimeout((async () => {
    const bytes = await readXlsxBytes(filePath);
    const baseFingerprint = fingerprintBytes(bytes);
    if (baseFingerprint !== expectedFingerprint) throw new Error(tAi('xlsx.fingerprintStale'));

    const pkg = await OpcPackage.open(bytes);
    const workbook = await XlsxWorkbook.open(pkg);
    // Snapshot grids before mutating the same in-memory workbook.
    const before = new Map(
      [...(await gridsOf(workbook))].map(([name, grid]) => [name, new Map(grid)] as const),
    );
    const structural: string[] = [];
    for (const op of ops) {
      const note = await applySheetOp(workbook, op as OoxmlSheetOp);
      if (note) structural.push(note);
    }
    await workbook.flush();
    const after = await gridsOf(workbook);
    const { changes, total, truncated } = diffWorkbookGrids(before, after);
    const buffer = Buffer.from(await pkg.save());
    return {
      id: randomUUID(),
      filePath,
      baseFingerprint,
      nextFingerprint: fingerprintBytes(buffer),
      buffer,
      diff: { changes, total, truncated, structural },
      ops,
    };
  })(), timeoutMs);
}

/**
 * Writes an accepted proposal: re-checks the fingerprint, keeps the original
 * restorable through `backups` (Git snapshot or app-data copy), then writes atomically.
 */
export async function commitXlsxProposal(
  proposal: XlsxProposal,
  backups: OfficeBackupStore,
  now: Date = new Date(),
): Promise<XlsxCommitRecord> {
  const current = await readXlsxBytes(proposal.filePath);
  if (fingerprintBytes(current) !== proposal.baseFingerprint) throw new Error(tAi('xlsx.fingerprintStale'));
  const backup = await backups.save(proposal.filePath, current, proposal.id, now);
  await writeFileAtomically(proposal.filePath, proposal.buffer);
  return { filePath: proposal.filePath, backup, writtenFingerprint: proposal.nextFingerprint };
}

/** Restores the backup of a commit unless the file was changed after that commit. */
export async function undoXlsxCommit(record: XlsxCommitRecord): Promise<void> {
  const current = await readXlsxBytes(record.filePath);
  if (fingerprintBytes(current) !== record.writtenFingerprint) throw new Error(tAi('xlsx.undoStale'));
  await writeFileAtomically(record.filePath, await readOfficeBackup(record.backup));
}

// Silence unused-type import when tooling only sees re-exports.
export type { OoxmlCellValue };
