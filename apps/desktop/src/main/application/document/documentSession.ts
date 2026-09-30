import type { FSWatcher } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { EditorUiStatePayload } from '@easyview/contracts';
import { DesktopDocumentAdapter } from './desktopDocumentAdapter';
import { DocumentSyncSession } from '@easyview/editor-sync';
import { hashContent } from '@easyview/editor-sync';

export interface DocumentExternalConflict {
  contentHash: string | null;
  content: string;
}

export interface DocumentSession {
  tabId: string;
  filePath: string | null;
  fileName: string;
  content: string;
  rawContent: string;
  diskContent: string;
  /** Hash of the last known raw bytes on disk (load or successful save). */
  diskContentHash: string | null;
  lineEnding: '\n' | '\r\n';
  diskMtimeMs: number | null;
  dirty: boolean;
  watcher?: FSWatcher;
  externalConflict: DocumentExternalConflict | null;
  readonly documentId: string;
  readonly documentAdapter: DesktopDocumentAdapter;
  readonly sync: DocumentSyncSession;
  uiState?: EditorUiStatePayload;
}

export function filePathKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? resolved.toLocaleLowerCase()
    : resolved;
}

export function createDocumentSession(input: {
  tabId: string;
  filePath: string | null;
  fileName: string;
  raw: string;
  mtimeMs?: number | null;
}): DocumentSession {
  const adapter = new DesktopDocumentAdapter(input.raw);
  // A document identity survives Save As and rename. File paths are mutable
  // locations and must only be used for de-duplication and persistence.
  const documentId = randomUUID();
  return {
    tabId: input.tabId,
    filePath: input.filePath,
    fileName: input.fileName,
    content: adapter.content,
    rawContent: input.raw,
    diskContent: adapter.content,
    diskContentHash: input.filePath ? hashContent(input.raw) : null,
    lineEnding: adapter.lineEnding,
    diskMtimeMs: input.mtimeMs ?? null,
    dirty: false,
    externalConflict: null,
    documentId,
    documentAdapter: adapter,
    sync: new DocumentSyncSession({ documentId, initialContent: adapter.content }),
  };
}

export function createEmptySession(): DocumentSession {
  return createDocumentSession({
    tabId: '',
    filePath: null,
    fileName: 'Untitled.md',
    raw: '',
  });
}
