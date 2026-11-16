/**
 * PowerPoint (.pptx) editing core for AI Agent mode.
 * Inspect → plan → user confirm → commit with fingerprint + backup.
 * Writes go through @easyview/ooxml-pptx (precise slide XML updates).
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { OpcPackage } from '@easyview/ooxml-core/opc';
import { applySlideOp, PptxPresentation, type PptxSlideOp } from '@easyview/ooxml-pptx';
import { writeFileAtomically } from '../filesystem/file-write';
import { readOfficeBackup, type OfficeBackupRef, type OfficeBackupStore } from './office-backups';
import { fingerprintBytes, undoXlsxCommit } from './xlsx-edit';
import { tAi } from './ai.i18n';

export const PPTX_MAX_FILE_BYTES = 40 * 1024 * 1024;
export const PPTX_MAX_OPS = 200;
export const PPTX_MAX_DIFF_ENTRIES = 200;
export const PPTX_DEFAULT_PREVIEW_SLIDES = 20;
export const PPTX_MAX_PREVIEW_SLIDES = 100;
export const PPTX_OPERATION_TIMEOUT_MS = 120_000;

export const pptxSlideOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('setShapeText'),
    slideIndex: z.number().int().min(0).max(10_000),
    shapeId: z.number().int().min(1).max(1_000_000),
    text: z.string().max(8_000),
  }),
  z.object({
    op: z.literal('replaceText'),
    slideIndex: z.number().int().min(0).max(10_000),
    search: z.string().min(1).max(2_000),
    replaceWith: z.string().max(2_000),
  }),
]);

export const pptxOpsSchema = z.array(pptxSlideOpSchema).min(1).max(PPTX_MAX_OPS);
export type PptxOp = z.infer<typeof pptxSlideOpSchema>;

export interface PptxDiffChange {
  slideIndex: number;
  shapeId: number;
  shapeName: string;
  before: string;
  after: string;
}

export interface PptxDiff {
  changes: PptxDiffChange[];
  total: number;
  truncated: boolean;
  structural: string[];
}

export interface PptxInspection {
  fileName: string;
  fingerprint: string;
  slideCount: number;
  preview: string;
}

export interface PptxProposal {
  id: string;
  filePath: string;
  baseFingerprint: string;
  ops: PptxOp[];
  diff: PptxDiff;
}

export interface PptxCommitRecord {
  filePath: string;
  backup: OfficeBackupRef;
  writtenFingerprint: string;
}

export function isPptxPath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.pptx' || ext === '.potx';
}

async function readPptxBytes(filePath: string): Promise<Buffer> {
  if (!isPptxPath(filePath)) throw new Error(tAi('pptx.notPptx'));
  const stat = await fs.lstat(filePath);
  if (!stat.isFile()) throw new Error(tAi('tools.notRegularFile'));
  if (stat.size > PPTX_MAX_FILE_BYTES) {
    throw new Error(tAi('tools.fileTooLarge', { size: stat.size, max: PPTX_MAX_FILE_BYTES }));
  }
  return fs.readFile(filePath);
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(tAi('pptx.timeout'))), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function openPresentation(bytes: Buffer): Promise<{ pkg: OpcPackage; deck: PptxPresentation }> {
  const pkg = await OpcPackage.open(bytes);
  const deck = await PptxPresentation.open(pkg);
  return { pkg, deck };
}

async function buildDiff(filePath: string, ops: PptxOp[]): Promise<PptxDiff> {
  const bytes = await readPptxBytes(filePath);
  const { deck } = await openPresentation(bytes);
  const beforeShapes = new Map<string, { shapeId: number; name: string; text: string }>();
  for (let i = 0; i < deck.slides.length; i += 1) {
    for (const shape of await deck.listShapes(i)) {
      beforeShapes.set(`${i}:${shape.shapeId}`, {
        shapeId: shape.shapeId,
        name: shape.name,
        text: shape.text,
      });
    }
  }

  for (const op of ops) {
    await applySlideOp(deck, op as PptxSlideOp);
  }

  const changes: PptxDiffChange[] = [];
  let total = 0;
  let truncated = false;
  for (let i = 0; i < deck.slides.length; i += 1) {
    for (const shape of await deck.listShapes(i)) {
      const key = `${i}:${shape.shapeId}`;
      const before = beforeShapes.get(key)?.text ?? '';
      if (before === shape.text) continue;
      total += 1;
      if (changes.length >= PPTX_MAX_DIFF_ENTRIES) {
        truncated = true;
        continue;
      }
      changes.push({
        slideIndex: i,
        shapeId: shape.shapeId,
        shapeName: shape.name || `shape ${shape.shapeId}`,
        before,
        after: shape.text,
      });
    }
  }
  return {
    changes,
    total,
    truncated,
    structural: [],
  };
}

async function applyOps(filePath: string, ops: PptxOp[]): Promise<Buffer> {
  const bytes = await readPptxBytes(filePath);
  const { pkg, deck } = await openPresentation(bytes);
  for (const op of ops) {
    await applySlideOp(deck, op as PptxSlideOp);
  }
  await deck.flush();
  return Buffer.from(await pkg.save());
}

export async function inspectPptxFile(
  filePath: string,
  maxSlides = PPTX_DEFAULT_PREVIEW_SLIDES,
): Promise<PptxInspection> {
  const bytes = await readPptxBytes(filePath);
  const { deck } = await openPresentation(bytes);
  const limit = Math.max(0, Math.min(PPTX_MAX_PREVIEW_SLIDES, Math.floor(maxSlides)));
  const summary = await deck.summarize(limit);
  const lines: string[] = [];
  for (const slide of summary.slides) {
    const texts = slide.shapes
      .map((shape) => shape.text.trim())
      .filter(Boolean)
      .slice(0, 8);
    lines.push(`[${slide.index}] ${texts.join(' | ') || '(empty)'}`);
  }
  return {
    fileName: path.basename(filePath),
    fingerprint: fingerprintBytes(bytes),
    slideCount: summary.slideCount,
    preview: lines.join('\n'),
  };
}

export async function planPptxEdit(
  filePath: string,
  expectedFingerprint: string,
  rawOps: unknown,
  timeoutMs = PPTX_OPERATION_TIMEOUT_MS,
): Promise<PptxProposal> {
  const ops = pptxOpsSchema.parse(rawOps);
  return withTimeout(
    (async () => {
      const bytes = await readPptxBytes(filePath);
      const baseFingerprint = fingerprintBytes(bytes);
      if (baseFingerprint !== expectedFingerprint) throw new Error(tAi('pptx.fingerprintStale'));
      const diff = await buildDiff(filePath, ops);
      return {
        id: randomUUID(),
        filePath,
        baseFingerprint,
        ops,
        diff,
      };
    })(),
    timeoutMs,
  );
}

export async function commitPptxProposal(
  proposal: PptxProposal,
  backups: OfficeBackupStore,
  now: Date = new Date(),
): Promise<PptxCommitRecord> {
  const current = await readPptxBytes(proposal.filePath);
  if (fingerprintBytes(current) !== proposal.baseFingerprint) {
    throw new Error(tAi('pptx.fingerprintStale'));
  }
  const buffer = await applyOps(proposal.filePath, proposal.ops);
  const backup = await backups.save(proposal.filePath, current, proposal.id, now);
  await writeFileAtomically(proposal.filePath, buffer);
  return {
    filePath: proposal.filePath,
    backup,
    writtenFingerprint: fingerprintBytes(buffer),
  };
}

export async function undoPptxCommit(record: PptxCommitRecord): Promise<void> {
  const current = await readPptxBytes(record.filePath);
  if (fingerprintBytes(current) !== record.writtenFingerprint) {
    throw new Error(tAi('pptx.undoStale'));
  }
  await writeFileAtomically(record.filePath, await readOfficeBackup(record.backup));
}
