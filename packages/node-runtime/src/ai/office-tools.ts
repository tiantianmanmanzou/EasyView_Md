/**
 * Agent-mode tools for the currently opened Office file (.xlsx / .docx).
 *
 * The tools take no path argument: they are hard-bound to the file the user has
 * open, so the model cannot read or write any other Office file. Writes require
 * an explicit user decision through `confirmEdit`; a rejected or unanswered
 * proposal never touches disk. For DOCX, confirmed edits write body text
 * (not tracked revisions); the user may exclude individual items first.
 */

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import {
  XLSX_DEFAULT_PREVIEW_ROWS,
  XLSX_MAX_OPS,
  XLSX_MAX_PREVIEW_ROWS,
  commitXlsxProposal,
  inspectXlsxFile,
  isXlsxPath,
  planXlsxEdit,
  xlsxSheetOpSchema,
  type XlsxCommitRecord,
  type XlsxDiff,
  type XlsxProposal,
} from './xlsx-edit';
import {
  DOCX_DEFAULT_PREVIEW_PARAS,
  DOCX_MAX_OPS,
  DOCX_MAX_PREVIEW_PARAS,
  commitDocxProposal,
  docxOpSchema,
  inspectDocxFile,
  isDocxPath,
  planDocxEdit,
  type DocxCommitRecord,
  type DocxDiff,
  type DocxItemDecision,
  type DocxProposal,
  type DocxResolution,
} from './docx-edit';
import { tAi } from './ai.i18n';
import type { OfficeBackupStore } from './office-backups';

export type OfficeDocumentKind = 'xlsx' | 'docx';

export interface OfficeEditDecision {
  accepted: boolean;
  reason?: string;
  /** DOCX: ignored for writes (always body); kept for older UI payloads. */
  resolution?: DocxResolution;
  /** DOCX only: per-change accept/reject; missing entries default to accept. */
  itemDecisions?: DocxItemDecision[];
}

export type OfficeCommitRecord = XlsxCommitRecord | DocxCommitRecord;

export type OfficeProposalView =
  | { kind: 'xlsx'; id: string; fileName: string; diff: XlsxDiff }
  | { kind: 'docx'; id: string; fileName: string; diff: DocxDiff };

export interface ActiveOfficeDocument {
  kind: OfficeDocumentKind;
  /** Absolute path of the opened file. */
  filePath: string;
  /** Keeps the pre-edit file restorable for undo. */
  backups: OfficeBackupStore;
  /** Shows the diff to the user and resolves once they press Apply or Reject. */
  confirmEdit: (proposal: OfficeProposalView) => Promise<OfficeEditDecision>;
  /** Called after a successful write so the host can refresh the preview and offer undo. */
  onCommitted?: (record: OfficeCommitRecord, proposalId: string) => void | Promise<void>;
}

/** Maps a file path to the Office kind that Agent mode can edit, if any. */
export function officeDocumentKind(filePath: string): OfficeDocumentKind | null {
  if (isXlsxPath(filePath)) return 'xlsx';
  if (isDocxPath(filePath)) return 'docx';
  return null;
}

export function createOfficeAgentTools(document: ActiveOfficeDocument): ToolSet {
  const fileName = document.filePath.split(/[\\/]/).pop() ?? document.filePath;

  if (document.kind === 'xlsx') {
    if (!isXlsxPath(document.filePath)) throw new Error(tAi('xlsx.notXlsx'));
    return {
      inspect_workbook: tool({
        description: tAi('xlsx.inspect.description'),
        inputSchema: z.object({
          maxRows: z.number().int().min(0).max(XLSX_MAX_PREVIEW_ROWS).optional().describe(tAi('xlsx.inspect.maxRows')),
        }),
        execute: async ({ maxRows }) => inspectXlsxFile(document.filePath, maxRows ?? XLSX_DEFAULT_PREVIEW_ROWS),
      }),
      apply_sheet_ops: tool({
        description: tAi('xlsx.apply.description', { max: XLSX_MAX_OPS }),
        inputSchema: z.object({
          fingerprint: z.string().min(1).describe(tAi('xlsx.apply.fingerprint')),
          ops: z.array(xlsxSheetOpSchema).min(1).max(XLSX_MAX_OPS),
        }),
        execute: async ({ fingerprint, ops }) => {
          const proposal = await planXlsxEdit(document.filePath, fingerprint, ops);
          if (proposal.diff.changes.length === 0 && proposal.diff.structural.length === 0) {
            return { status: 'no-change' as const };
          }
          const decision = await document.confirmEdit({
            kind: 'xlsx',
            id: proposal.id,
            fileName,
            diff: proposal.diff,
          });
          if (!decision.accepted) {
            return { status: 'rejected' as const, reason: decision.reason ?? tAi('xlsx.rejected') };
          }
          const record = await commitXlsxProposal(proposal, document.backups);
          await document.onCommitted?.(record, proposal.id);
          return {
            status: 'applied' as const,
            changedCells: proposal.diff.changes.length,
            newFingerprint: record.writtenFingerprint,
          };
        },
      }),
    };
  }

  if (document.kind !== 'docx' || !isDocxPath(document.filePath)) {
    throw new Error(tAi('docx.notDocx'));
  }

  return {
    inspect_document: tool({
      description: tAi('docx.inspect.description'),
      inputSchema: z.object({
        maxParagraphs: z
          .number()
          .int()
          .min(0)
          .max(DOCX_MAX_PREVIEW_PARAS)
          .optional()
          .describe(tAi('docx.inspect.maxParagraphs')),
      }),
      execute: async ({ maxParagraphs }) =>
        inspectDocxFile(document.filePath, maxParagraphs ?? DOCX_DEFAULT_PREVIEW_PARAS),
    }),
    apply_docx_ops: tool({
      description: tAi('docx.apply.description', { max: DOCX_MAX_OPS }),
      inputSchema: z.object({
        fingerprint: z.string().min(1).describe(tAi('docx.apply.fingerprint')),
        ops: z.array(docxOpSchema).min(1).max(DOCX_MAX_OPS),
      }),
      execute: async ({ fingerprint, ops }) => {
        const proposal: DocxProposal = await planDocxEdit(document.filePath, fingerprint, ops);
        if (proposal.diff.changes.length === 0 && proposal.diff.comments.length === 0) {
          return { status: 'no-change' as const };
        }
        const decision = await document.confirmEdit({
          kind: 'docx',
          id: proposal.id,
          fileName,
          diff: proposal.diff,
        });
        if (!decision.accepted) {
          return { status: 'rejected' as const, reason: decision.reason ?? tAi('docx.rejected') };
        }
        const record = await commitDocxProposal(proposal, document.backups, {
          // Body-only: resolution is ignored; kept on the wire for older UIs.
          resolution: 'accept-all',
          itemDecisions: decision.itemDecisions,
        });
        await document.onCommitted?.(record, proposal.id);
        return {
          status: 'applied' as const,
          resolution: 'accept-all' as const,
          changes: proposal.diff.total,
          comments: proposal.diff.comments.length,
          newFingerprint: record.writtenFingerprint,
        };
      },
    }),
  };
}
