/**
 * Word (.docx) editing core for AI Agent mode.
 *
 * Inspect → plan (in-memory) → user confirm → commit with fingerprint re-check
 * + backup. Ops replace/insert/delete paragraph text and optional comments.
 * Confirmed edits always write **body text** (not tracked revisions).
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { OpcPackage } from '@easyview/ooxml-core/opc';
import { DocxDocument, type DocxBodyOp } from '@easyview/ooxml-docx';
import { writeFileAtomically } from '../filesystem/file-write';
import { readOfficeBackup, type OfficeBackupRef, type OfficeBackupStore } from './office-backups';
import { fingerprintBytes, undoXlsxCommit } from './xlsx-edit';
import { tAi } from './ai.i18n';

export const DOCX_MAX_FILE_BYTES = 40 * 1024 * 1024;
export const DOCX_MAX_OPS = 200;
export const DOCX_MAX_DIFF_ENTRIES = 200;
export const DOCX_DEFAULT_PREVIEW_PARAS = 80;
export const DOCX_MAX_PREVIEW_PARAS = 200;
export const DOCX_OPERATION_TIMEOUT_MS = 120_000;

const paragraphIndex = z.number().int().min(0).max(100_000);

/** Body text replace/insert/delete fields. `suggest_change` kept as a deprecated alias. */
const replaceTextFields = {
  paragraphIndex,
  /** Non-empty: phrase to replace/delete. Empty string: insert `replaceWith` at end of paragraph. */
  search: z.string().max(2_000),
  /** Non-empty: replacement/insertion. Empty string: delete `search`. */
  replaceWith: z.string().max(2_000),
};

export const docxOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add_comment'),
    paragraphIndex,
    text: z.string().min(1).max(4_000),
    search: z.string().min(1).max(500).optional(),
  }),
  z.object({ op: z.literal('replace_text'), ...replaceTextFields }),
  z.object({ op: z.literal('suggest_change'), ...replaceTextFields }),
]);

export const docxOpsSchema = z.array(docxOpSchema).min(1).max(DOCX_MAX_OPS);
export type DocxOp = z.infer<typeof docxOpSchema>;

/** @deprecated Always body; kept for message wire compatibility. */
export type DocxResolution = 'tracked' | 'accept-all';

export interface DocxItemDecision {
  /** Matches `DocxDiffChange.index`. */
  index: number;
  /** false = drop this change from the write. */
  accept: boolean;
}

export interface DocxDiffChange {
  index: number;
  paragraphIndex: number;
  search: string;
  replaceWith: string;
  before: string;
  after: string;
}

export interface DocxDiffComment {
  paragraphIndex: number;
  text: string;
  search?: string;
}

export interface DocxDiff {
  changes: DocxDiffChange[];
  comments: DocxDiffComment[];
  total: number;
  truncated: boolean;
  /** Human-readable notes (comment summaries, skipped ops, etc.). */
  structural: string[];
}

export interface DocxInspection {
  fileName: string;
  fingerprint: string;
  paragraphCount: number;
  /** LLM-friendly preview: `[index] text` lines, truncated. */
  preview: string;
}

export interface DocxProposal {
  id: string;
  filePath: string;
  baseFingerprint: string;
  ops: DocxOp[];
  diff: DocxDiff;
}

export interface DocxCommitRecord {
  filePath: string;
  backup: OfficeBackupRef;
  writtenFingerprint: string;
}

export function isDocxPath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.docx' || ext === '.dotx';
}

async function readDocxBytes(filePath: string): Promise<Buffer> {
  if (!isDocxPath(filePath)) throw new Error(tAi('docx.notDocx'));
  const stat = await fs.lstat(filePath);
  if (!stat.isFile()) throw new Error(tAi('tools.notRegularFile'));
  if (stat.size > DOCX_MAX_FILE_BYTES) {
    throw new Error(tAi('tools.fileTooLarge', { size: stat.size, max: DOCX_MAX_FILE_BYTES }));
  }
  return fs.readFile(filePath);
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(tAi('docx.timeout'))), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function isTextOp(op: DocxOp): op is Extract<DocxOp, { search: string; replaceWith: string }> {
  return op.op === 'replace_text' || op.op === 'suggest_change';
}

function buildDiff(ops: DocxOp[]): DocxDiff {
  const changes: DocxDiffChange[] = [];
  const comments: DocxDiffComment[] = [];
  const structural: string[] = [];
  let changeIndex = 0;
  for (const op of ops) {
    if (op.op === 'add_comment') {
      comments.push({
        paragraphIndex: op.paragraphIndex,
        text: op.text,
        search: op.search,
      });
      structural.push(
        tAi('docx.diff.comment', {
          para: op.paragraphIndex,
          text: op.text.length > 80 ? `${op.text.slice(0, 80)}…` : op.text,
        }),
      );
      continue;
    }
    if (changes.length >= DOCX_MAX_DIFF_ENTRIES) continue;
    const before = op.search === '' ? '∅' : op.search;
    const after = op.replaceWith === '' ? '∅' : op.replaceWith;
    changes.push({
      index: changeIndex,
      paragraphIndex: op.paragraphIndex,
      search: op.search,
      replaceWith: op.replaceWith,
      before,
      after,
    });
    changeIndex += 1;
  }
  const totalChanges = ops.filter(isTextOp).length;
  return {
    changes,
    comments,
    total: totalChanges,
    truncated: totalChanges > changes.length,
    structural,
  };
}

function filterOps(ops: DocxOp[], itemDecisions?: DocxItemDecision[]): DocxOp[] {
  if (!itemDecisions || itemDecisions.length === 0) return ops;
  const rejected = new Set(itemDecisions.filter((d) => !d.accept).map((d) => d.index));
  if (rejected.size === 0) return ops;
  let changeIndex = 0;
  return ops.filter((op) => {
    if (!isTextOp(op)) return true;
    const index = changeIndex;
    changeIndex += 1;
    return !rejected.has(index);
  });
}

async function openDocument(bytes: Buffer): Promise<{ pkg: OpcPackage; document: DocxDocument }> {
  const pkg = await OpcPackage.open(bytes);
  const document = await DocxDocument.open(pkg, tAi('docx.author'));
  return { pkg, document };
}

async function applyOpsToDocument(
  filePath: string,
  ops: DocxOp[],
): Promise<{ buffer: Buffer; appliedChanges: number; appliedComments: number }> {
  const bytes = await readDocxBytes(filePath);
  const { pkg, document } = await openDocument(bytes);
  const errors: string[] = [];
  const bodyOps: DocxBodyOp[] = [];

  for (const op of ops) {
    if (op.op === 'add_comment') {
      bodyOps.push(op);
      continue;
    }
    if (op.search === '' && op.replaceWith === '') {
      errors.push(tAi('docx.emptyChange', { para: op.paragraphIndex }));
      continue;
    }
    bodyOps.push(op);
  }

  const { changes, comments } = await document.applyBodyOps(bodyOps);
  if (changes === 0 && comments === 0) {
    throw new Error(errors.join('; ') || tAi('docx.applyFailed'));
  }
  await document.flush();
  return {
    buffer: Buffer.from(await pkg.save()),
    appliedChanges: changes,
    appliedComments: comments,
  };
}

/** Inspect the open DOCX: fingerprint + numbered paragraph preview for the model. */
export async function inspectDocxFile(
  filePath: string,
  maxParagraphs = DOCX_DEFAULT_PREVIEW_PARAS,
): Promise<DocxInspection> {
  const bytes = await readDocxBytes(filePath);
  const { document } = await openDocument(bytes);
  const limit = Math.max(0, Math.min(DOCX_MAX_PREVIEW_PARAS, Math.floor(maxParagraphs)));
  const { paragraphCount, preview } = await document.previewText(limit);
  return {
    fileName: path.basename(filePath),
    fingerprint: fingerprintBytes(bytes),
    paragraphCount,
    preview,
  };
}

/** Stage ops in memory and return a proposal; nothing is written. */
export async function planDocxEdit(
  filePath: string,
  expectedFingerprint: string,
  rawOps: unknown,
  timeoutMs = DOCX_OPERATION_TIMEOUT_MS,
): Promise<DocxProposal> {
  const ops = docxOpsSchema.parse(rawOps);
  return withTimeout(
    (async () => {
      const bytes = await readDocxBytes(filePath);
      const baseFingerprint = fingerprintBytes(bytes);
      if (baseFingerprint !== expectedFingerprint) throw new Error(tAi('docx.fingerprintStale'));
      // Validate ops against the live document so the model gets actionable errors
      // before the user sees a confirm card.
      const dryRun = await applyOpsToDocument(filePath, ops);
      if (dryRun.appliedChanges === 0 && dryRun.appliedComments === 0) {
        throw new Error(tAi('docx.noEffect'));
      }
      return {
        id: randomUUID(),
        filePath,
        baseFingerprint,
        ops,
        diff: buildDiff(ops),
      };
    })(),
    timeoutMs,
  );
}

/**
 * Writes an accepted proposal. Re-checks fingerprint, saves a backup, then
 * applies filtered ops into the document body and writes atomically.
 */
export async function commitDocxProposal(
  proposal: DocxProposal,
  backups: OfficeBackupStore,
  decision: { resolution?: DocxResolution; itemDecisions?: DocxItemDecision[] } = {},
  now: Date = new Date(),
): Promise<DocxCommitRecord> {
  const current = await readDocxBytes(proposal.filePath);
  if (fingerprintBytes(current) !== proposal.baseFingerprint) {
    throw new Error(tAi('docx.fingerprintStale'));
  }
  const ops = filterOps(proposal.ops, decision.itemDecisions);
  if (ops.length === 0) throw new Error(tAi('docx.noEffect'));
  // Body-only write: resolution is ignored (tracked path removed).
  void decision.resolution;
  const { buffer } = await applyOpsToDocument(proposal.filePath, ops);
  const backup = await backups.save(proposal.filePath, current, proposal.id, now);
  await writeFileAtomically(proposal.filePath, buffer);
  return {
    filePath: proposal.filePath,
    backup,
    writtenFingerprint: fingerprintBytes(buffer),
  };
}

/** Restores the backup unless the file was changed after the commit. */
export async function undoDocxCommit(record: DocxCommitRecord): Promise<void> {
  const current = await readDocxBytes(record.filePath);
  if (fingerprintBytes(current) !== record.writtenFingerprint) {
    throw new Error(tAi('docx.undoStale'));
  }
  await writeFileAtomically(record.filePath, await readOfficeBackup(record.backup));
}

/** Shared undo entry used by AiChatHost for both xlsx and docx commits. */
export async function undoOfficeCommit(record: {
  filePath: string;
  backup: OfficeBackupRef;
  writtenFingerprint: string;
}): Promise<void> {
  if (isDocxPath(record.filePath)) {
    await undoDocxCommit(record);
    return;
  }
  await undoXlsxCommit(record);
}
