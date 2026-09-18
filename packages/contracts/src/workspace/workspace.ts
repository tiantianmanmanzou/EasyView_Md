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
}

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

/** Filesystem/URI adapter implemented by each host. */
export interface WorkspaceGateway {
  listChildren(rootId: string, relativePath: string): Promise<WorkspaceEntry[]>;
  create(rootId: string, request: WorkspaceCreateRequest): Promise<WorkspaceEntry>;
  rename(rootId: string, request: WorkspaceRenameRequest): Promise<WorkspaceEntry>;
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

export * from './workspace-tree-icons';
