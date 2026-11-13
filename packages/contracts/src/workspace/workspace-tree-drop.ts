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

/** Row geometry shared by the Desktop and Webview list trees (`padding-inline-start: 8 + depth * 16`). */
export const WORKSPACE_TREE_ROW_BASE_INDENT = 8;
export const WORKSPACE_TREE_ROW_INDENT = 16;

/** Where the pointer sits inside a row: the gap above it, the folder itself, or the gap below it. */
export type WorkspaceTreeRowDropZone = 'above' | 'into' | 'below';

export function resolveWorkspaceTreeRowDropZone(
  kind: WorkspaceEntryKind,
  clientY: number,
  rowTop: number,
  rowHeight: number,
): WorkspaceTreeRowDropZone {
  const ratio = rowHeight <= 0 ? 0.5 : (clientY - rowTop) / rowHeight;
  if (kind !== 'directory') return ratio < 0.5 ? 'above' : 'below';
  if (ratio < 0.25) return 'above';
  return ratio > 0.75 ? 'below' : 'into';
}

/** Tree depth the pointer points at, from its X offset to the row's left edge. */
export function workspaceTreeDepthFromPointer(offsetX: number): number {
  // Switch depth at the middle of each level's chevron.
  return Math.floor((offsetX - WORKSPACE_TREE_ROW_BASE_INDENT - WORKSPACE_TREE_ROW_INDENT / 2) / WORKSPACE_TREE_ROW_INDENT);
}

/** X offset (from the row's left edge) where a drop line at `depth` starts: under that level's icon. */
export function workspaceTreeDropLineOffset(depth: number): number {
  return WORKSPACE_TREE_ROW_BASE_INDENT + (depth + 1) * WORKSPACE_TREE_ROW_INDENT;
}

/** A sibling slot in `parentRelativePath`; `afterName` set means "right after that sibling". */
export interface WorkspaceTreeGapPlacement {
  depth: number;
  parentRelativePath: string;
  beforeName?: string;
  afterName?: string;
}

export type WorkspaceTreeDropTarget =
  | { kind: 'into'; relativePath: string }
  | {
      kind: 'gap';
      placement: WorkspaceTreeGapPlacement;
      /** Row whose edge hosts the indicator line. */
      lineRowIndex: number;
      lineEdge: 'top' | 'bottom';
    };

function depthOf(relativePath: string): number {
  return relativePath.split('/').length - 1;
}

/**
 * Resolve the slot between two visible rows. Below the last child of a nested
 * folder the gap is shared by several levels (from `next`'s depth up to
 * `previous`'s depth); `preferredDepth` (from the pointer X) picks one.
 */
export function resolveWorkspaceTreeGapPlacement(
  previous: string | null,
  next: string | null,
  preferredDepth: number,
): WorkspaceTreeGapPlacement {
  const minDepth = next ? depthOf(next) : 0;
  const maxDepth = previous ? Math.max(minDepth, depthOf(previous)) : minDepth;
  const depth = Math.max(minDepth, Math.min(maxDepth, preferredDepth));
  if (next && depth === depthOf(next)) {
    return { depth, parentRelativePath: parentOfWorkspaceViewRelativePath(next), beforeName: next.split('/').at(-1)! };
  }
  if (!previous) return { depth: 0, parentRelativePath: '' };
  const segments = previous.split('/');
  return { depth, parentRelativePath: segments.slice(0, depth).join('/'), afterName: segments[depth] };
}

/** Resolve an internal/external drop over `rows[index]`; `null` when the drop is not allowed. */
export function resolveWorkspaceTreeDropTarget(input: {
  rows: ReadonlyArray<{ relativePath: string; kind: WorkspaceEntryKind }>;
  index: number;
  zone: WorkspaceTreeRowDropZone;
  pointerDepth: number;
  draggedRelativePaths?: readonly string[];
}): WorkspaceTreeDropTarget | null {
  const { rows, index, zone, draggedRelativePaths = [] } = input;
  const row = rows[index];
  if (!row) return null;
  const insideDragged = (path: string) => draggedRelativePaths
    .some((dragged) => path === dragged || path.startsWith(`${dragged}/`));
  if (zone === 'into') {
    if (row.kind !== 'directory' || insideDragged(row.relativePath)) return null;
    return { kind: 'into', relativePath: row.relativePath };
  }
  const previous = zone === 'above' ? rows[index - 1]?.relativePath ?? null : row.relativePath;
  const next = zone === 'above' ? row.relativePath : rows[index + 1]?.relativePath ?? null;
  const placement = resolveWorkspaceTreeGapPlacement(previous, next, input.pointerDepth);
  if (placement.parentRelativePath && insideDragged(placement.parentRelativePath)) return null;
  return { kind: 'gap', placement, lineRowIndex: index, lineEdge: zone === 'above' ? 'top' : 'bottom' };
}

/**
 * Paths an internal tree drag carries: the whole selection (on-screen order, items
 * inside a selected folder folded into it) when the grabbed row is selected, else just that row.
 */
export function resolveWorkspaceTreeDragSources(
  orderedSelection: readonly string[],
  grabbedRelativePath: string,
): string[] {
  if (!orderedSelection.includes(grabbedRelativePath)) return [grabbedRelativePath];
  return orderedSelection.filter((path) => !orderedSelection.some((other) => path.startsWith(`${other}/`)));
}

/** Name to pass as `beforeName` when reordering `siblingNames` into `placement`. */
export function workspaceTreeGapBeforeName(
  placement: WorkspaceTreeGapPlacement,
  siblingNames: readonly string[],
): string | undefined {
  if (placement.beforeName !== undefined) return placement.beforeName;
  if (placement.afterName === undefined) return undefined;
  const index = siblingNames.indexOf(placement.afterName);
  return index >= 0 ? siblingNames[index + 1] : undefined;
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
