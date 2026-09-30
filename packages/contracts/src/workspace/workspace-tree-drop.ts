import type { WorkspaceEntryKind } from './workspace';
import { parentOfWorkspaceViewRelativePath } from './workspace-tree-view';

/** Drop placement relative to a tree row (Desktop / Webview shared). */
export type WorkspaceTreeDropMode = 'before' | 'into';

/**
 * Resolve insert-before vs nest-into from pointer Y within a row.
 * Directory top ~30% → before; otherwise into. Non-directories always before.
 */
export function resolveWorkspaceTreeDropMode(
  kind: WorkspaceEntryKind,
  clientY: number,
  rowTop: number,
  rowHeight: number,
): WorkspaceTreeDropMode {
  if (kind !== 'directory') return 'before';
  const ratio = rowHeight <= 0 ? 0.5 : (clientY - rowTop) / rowHeight;
  return ratio < 0.3 ? 'before' : 'into';
}

/** Parent directory that should receive an external drop (OS Finder / Explorer files). */
export function workspaceTreeDropParentRelativePath(
  target: { kind: string; relativePath: string } | null,
  mode: WorkspaceTreeDropMode,
): string {
  if (!target) return '';
  if (mode === 'into' && target.kind === 'directory') return target.relativePath;
  return parentOfWorkspaceViewRelativePath(target.relativePath);
}

const EXTERNAL_WORKSPACE_DRAG_TYPES = [
  'Files',
  'text/uri-list',
  'application/vnd.code.uri-list',
  'DownloadURL',
  'application/x-moz-file',
] as const;

export function isExternalWorkspaceFileDrag(
  dataTransfer: { types: ArrayLike<string> } | null | undefined,
  hasInternalDrag: boolean,
): boolean {
  if (hasInternalDrag || !dataTransfer) return false;
  const types = Array.from(dataTransfer.types);
  return EXTERNAL_WORKSPACE_DRAG_TYPES.some((type) => types.includes(type));
}

export function parseWorkspaceDropUriList(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export function filePathToWorkspaceDropUri(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(normalized)) return `file:///${normalized}`;
  if (normalized.startsWith('//')) return `file:${normalized}`;
  if (normalized.startsWith('/')) return `file://${normalized}`;
  return filePath;
}

export function parseWorkspaceDropPlainPath(value: string): { path?: string; uri?: string } {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed || trimmed.startsWith('#')) return {};
  if (
    trimmed.startsWith('/')
    || /^[a-zA-Z]:[\\/]/.test(trimmed)
    || trimmed.startsWith('\\\\')
  ) {
    return { path: trimmed, uri: filePathToWorkspaceDropUri(trimmed) };
  }
  if (/^file:/i.test(trimmed)) return { uri: trimmed };
  return {};
}

function parseDownloadUrlLines(value: string): string[] {
  return parseWorkspaceDropUriList(value).flatMap((line) => {
    const parts = line.split(':');
    if (parts.length < 3) return [];
    const uri = parts.slice(2).join(':');
    return /^file:/i.test(uri) ? [uri] : [];
  });
}

export interface WorkspaceExternalDropContentItem {
  kind: 'file' | 'directory';
  relativePath: string;
  bytes?: Uint8Array;
}

export interface WorkspaceExternalDropSources {
  sourcePaths: string[];
  sourceUris: string[];
  items: WorkspaceExternalDropContentItem[];
}

export interface WorkspaceDropFileLike {
  name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  path?: unknown;
}

export interface WorkspaceDropItemLike {
  webkitGetAsEntry?: () => FileSystemEntryLike | null;
}

export interface WorkspaceDropTransferLike {
  types: ArrayLike<string>;
  getData(type: string): string;
  files: ArrayLike<WorkspaceDropFileLike>;
  items?: ArrayLike<WorkspaceDropItemLike>;
}

function filePathOf(file: WorkspaceDropFileLike): string | undefined {
  const value = file.path;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Collect OS-dragged files. Electron usually has `File.path`; VS Code webviews
 * typically only have File / FileSystemEntry contents.
 */
function collectWorkspaceDropTextRefs(dataTransfer: WorkspaceDropTransferLike): { sourcePaths: string[]; sourceUris: string[] } {
  const sourcePaths: string[] = [];
  const sourceUris: string[] = [];
  const rawValues = [
    ...parseWorkspaceDropUriList(dataTransfer.getData('text/uri-list') || ''),
    ...parseWorkspaceDropUriList(dataTransfer.getData('application/vnd.code.uri-list') || ''),
    ...parseDownloadUrlLines(dataTransfer.getData('DownloadURL') || ''),
    ...parseWorkspaceDropUriList(dataTransfer.getData('text/plain') || ''),
  ];
  for (const value of rawValues) {
    const parsed = parseWorkspaceDropPlainPath(value);
    if (parsed.path) sourcePaths.push(parsed.path);
    if (parsed.uri) sourceUris.push(parsed.uri);
  }
  return {
    sourcePaths: uniqueStrings(sourcePaths),
    sourceUris: uniqueStrings(sourceUris),
  };
}

export async function collectWorkspaceExternalDropSources(
  dataTransfer: WorkspaceDropTransferLike,
): Promise<WorkspaceExternalDropSources> {
  const fromFiles = uniqueStrings(Array.from(dataTransfer.files, (file) => filePathOf(file) ?? ''));
  const fromText = collectWorkspaceDropTextRefs(dataTransfer);
  const sourcePaths = uniqueStrings([...fromFiles, ...fromText.sourcePaths]);
  const sourceUris = uniqueStrings([
    ...fromText.sourceUris,
    ...fromFiles.map((filePath) => filePathToWorkspaceDropUri(filePath)),
  ]);
  if (sourcePaths.length > 0 || sourceUris.length > 0) {
    return { sourcePaths, sourceUris, items: [] };
  }

  const items: WorkspaceExternalDropContentItem[] = [];
  const transferItems = Array.from(dataTransfer.items ?? []);
  let walked = false;
  for (const item of transferItems) {
    const entry = getAsFileSystemEntry(item);
    if (!entry) continue;
    walked = true;
    await walkFileSystemEntry(entry, '', items);
  }
  if (!walked) {
    for (const file of Array.from(dataTransfer.files)) {
      items.push({
        kind: 'file',
        relativePath: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
    }
  }
  return { sourcePaths: [], sourceUris, items };
}

interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?(success: (file: WorkspaceDropFileLike) => void, error?: (error: unknown) => void): void;
  createReader?(): { readEntries(success: (entries: FileSystemEntryLike[]) => void, error?: (error: unknown) => void): void };
}

function getAsFileSystemEntry(item: WorkspaceDropItemLike): FileSystemEntryLike | null {
  return item.webkitGetAsEntry?.() ?? null;
}

async function walkFileSystemEntry(
  entry: FileSystemEntryLike,
  parentRelativePath: string,
  items: WorkspaceExternalDropContentItem[],
): Promise<void> {
  const relativePath = parentRelativePath ? `${parentRelativePath}/${entry.name}` : entry.name;
  if (entry.isDirectory && entry.createReader) {
    items.push({ kind: 'directory', relativePath });
    const reader = entry.createReader();
    for (const child of await readAllDirectoryEntries(reader)) {
      await walkFileSystemEntry(child, relativePath, items);
    }
    return;
  }
  if (!entry.file) return;
  const file = await new Promise<WorkspaceDropFileLike>((resolve, reject) => {
    entry.file!(resolve, reject);
  });
  items.push({
    kind: 'file',
    relativePath,
    bytes: new Uint8Array(await file.arrayBuffer()),
  });
}

async function readAllDirectoryEntries(
  reader: { readEntries(success: (entries: FileSystemEntryLike[]) => void, error?: (error: unknown) => void): void },
): Promise<FileSystemEntryLike[]> {
  const all: FileSystemEntryLike[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntryLike[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) break;
    all.push(...batch);
  }
  return all;
}
