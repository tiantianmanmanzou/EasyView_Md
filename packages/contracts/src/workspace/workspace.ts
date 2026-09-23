/** Platform-neutral contracts for workspace trees and file operations. */

export type WorkspaceEntryKind = 'directory' | 'file' | 'symlink';

export interface WorkspaceRootDescriptor {
  /** Stable host-provided identity. */
  id: string;
  name: string;
}

export interface WorkspaceEntry {
  /** Stable for a root/path pair across refreshes. */
  id: string;
  rootId: string;
  /** Slash-separated path relative to the workspace root; root itself is ''. */
  relativePath: string;
  name: string;
  kind: WorkspaceEntryKind;
  /** Creation time in milliseconds since epoch when the host can provide it. */
  createdAt?: number;
  /** Last modification time in milliseconds since epoch when the host can provide it. */
  updatedAt?: number;
}

/** How the workspace tree orders siblings within each directory. */
export type WorkspaceTreeSortMode = 'name' | 'created' | 'custom';

export interface WorkspacePathReference {
  rootId: string;
  relativePath: string;
}

export type WorkspacePathChangeKind = 'created' | 'changed' | 'deleted' | 'renamed';

export interface WorkspacePathChange extends WorkspacePathReference {
  kind: WorkspacePathChangeKind;
  /** Previous path for rename events. */
  previousRelativePath?: string;
}

export interface WorkspaceCreateRequest {
  parentRelativePath: string;
  name: string;
  kind: Exclude<WorkspaceEntryKind, 'symlink'>;
}

export interface WorkspaceRenameRequest {
  relativePath: string;
  newName: string;
}

export interface WorkspaceDeleteOptions {
  /** Ask the gateway to use a host-provided trash implementation. */
  useTrash?: boolean;
  /** Required for permanently deleting non-empty directories. */
  recursive?: boolean;
}

export interface WorkspaceDeleteRequest {
  relativePath: string;
  options?: WorkspaceDeleteOptions;
}

export interface WorkspaceMoveRequest {
  relativePath: string;
  targetParentRelativePath: string;
  /** Defaults to the source basename when omitted. */
  newName?: string;
}

/** Filesystem/URI adapter implemented by each host. */
export interface WorkspaceGateway {
  listChildren(rootId: string, relativePath: string): Promise<WorkspaceEntry[]>;
  create(rootId: string, request: WorkspaceCreateRequest): Promise<WorkspaceEntry>;
  rename(rootId: string, request: WorkspaceRenameRequest): Promise<WorkspaceEntry>;
  move(rootId: string, request: WorkspaceMoveRequest): Promise<WorkspaceEntry>;
  delete(rootId: string, request: WorkspaceDeleteRequest): Promise<void>;
}

export type WorkspaceErrorCode =
  | 'INVALID_NAME'
  | 'INVALID_PATH'
  | 'INVALID_GATEWAY_RESPONSE'
  | 'ROOT_NOT_FOUND'
  | 'ROOT_ESCAPE'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'NOT_DIRECTORY'
  | 'DIRECTORY_NOT_EMPTY'
  | 'SYMLINK_NOT_TRAVERSABLE'
  | 'PERMISSION_DENIED'
  | 'TRASH_UNAVAILABLE'
  | 'IO_ERROR';

export class WorkspaceOperationError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WorkspaceOperationError';
    this.code = code;
  }
}

export function isWorkspaceOperationError(error: unknown): error is WorkspaceOperationError {
  return error instanceof WorkspaceOperationError;
}

/** Deterministic identity used by both Desktop and VS Code tree adapters. */
export function createWorkspaceNodeId(rootId: string, relativePath: string): string {
  const normalizedPath = relativePath
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.')
    .join('/');
  return `workspace:${encodeURIComponent(rootId)}:${encodeURIComponent(normalizedPath)}`;
}

/** Format epoch ms as local `YYYY-MM-DD HH:mm:ss`. */
export function formatWorkspaceTimestamp(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return undefined;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export type WorkspaceTimestampKind = 'created' | 'updated';

export interface WorkspaceEntryTimestampPart {
  kind: WorkspaceTimestampKind;
  value: string;
}

export interface WorkspaceEntryTimestampDisplay {
  parts: WorkspaceEntryTimestampPart[];
  title: string;
}

export function describeWorkspaceEntryTimestamps(
  entry: Pick<WorkspaceEntry, 'createdAt' | 'updatedAt'>,
  options: { showCreatedAt?: boolean; showUpdatedAt?: boolean } = {},
): WorkspaceEntryTimestampDisplay | undefined {
  const created = formatWorkspaceTimestamp(entry.createdAt);
  const updated = formatWorkspaceTimestamp(entry.updatedAt);
  const titleLines: string[] = [];
  if (created) titleLines.push(`Created ${created}`);
  if (updated) titleLines.push(`Updated ${updated}`);
  if (titleLines.length === 0) return undefined;

  const parts: WorkspaceEntryTimestampPart[] = [];
  if (options.showCreatedAt === true && created) parts.push({ kind: 'created', value: created });
  if (options.showUpdatedAt === true && updated) parts.push({ kind: 'updated', value: updated });
  return { parts, title: titleLines.join('\n') };
}

export function formatWorkspaceEntryTimestamps(
  entry: Pick<WorkspaceEntry, 'createdAt' | 'updatedAt'>,
  options: { showCreatedAt?: boolean; showUpdatedAt?: boolean } = {},
): string | undefined {
  const display = describeWorkspaceEntryTimestamps(entry, options);
  if (!display || display.parts.length === 0) return undefined;
  return display.parts
    .map((part) => `${part.kind === 'created' ? 'Created' : 'Updated'} ${part.value}`)
    .join(' · ');
}

/** Whether a workspace entry name is a "dot" (hidden) name like `.git`. */
export function isWorkspaceDotEntryName(name: string): boolean {
  return name.startsWith('.');
}

/** Filter sibling entries according to showDotEntries. */
export function filterWorkspaceEntriesByDotVisibility<T extends { name: string }>(
  entries: readonly T[],
  showDotEntries: boolean,
): T[] {
  if (showDotEntries !== false) return [...entries];
  return entries.filter((entry) => !isWorkspaceDotEntryName(entry.name));
}

export * from './workspace-tree-icons';
export * from './workspace-tree-drop';
