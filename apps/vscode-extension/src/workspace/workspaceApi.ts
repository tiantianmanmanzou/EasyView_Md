import path from 'node:path';
import * as vscode from 'vscode';
import {
  createWorkspaceNodeId,
  WorkspaceOperationError,
  type WorkspaceCreateRequest,
  type WorkspaceDeleteRequest,
  type WorkspaceEntry,
  type WorkspaceEntryKind,
  type WorkspaceGateway,
  type WorkspaceRenameRequest,
} from '@easyview/contracts';
import {
  joinWorkspaceRelativePath,
  validateWorkspaceEntryName as validateSharedWorkspaceEntryName,
  WorkspaceFileOperationService,
  WorkspaceTreeModel,
} from '@easyview/node-runtime';

export type { WorkspaceCreateRequest, WorkspaceEntry, WorkspaceEntryKind };

export interface VscodeWorkspaceEntry extends WorkspaceEntry {
  uri: vscode.Uri;
  writable: boolean;
}

/**
 * VS Code URI/WorkspaceEdit adapter for the shared workspace contracts.
 * All host-specific behavior is isolated here; the TreeView only consumes the
 * shared WorkspaceTreeModel and WorkspaceFileOperationService through the
 * WorkspaceTreeService facade below.
 */
export class VscodeWorkspaceGateway implements WorkspaceGateway {
  private readonly roots = new Map<string, vscode.Uri>();

  registerRoot(root: vscode.Uri): string {
    const rootId = workspaceRootId(root);
    this.roots.set(rootId, root);
    return rootId;
  }

  clearRoots(): void {
    this.roots.clear();
  }

  uriFor(rootId: string, relativePath: string): vscode.Uri {
    const root = this.roots.get(rootId);
    if (!root) throw new WorkspaceOperationError('ROOT_NOT_FOUND', 'Workspace root is not registered.');
    return relativePath ? vscode.Uri.joinPath(root, ...relativePath.split('/')) : root;
  }

  async listChildren(rootId: string, relativePath: string): Promise<WorkspaceEntry[]> {
    const directory = this.uriFor(rootId, relativePath);
    const entries = await vscode.workspace.fs.readDirectory(directory);
    return entries.map(([name, fileType]) => {
      const childRelativePath = joinWorkspaceRelativePath(relativePath, name);
      return {
        id: createWorkspaceNodeId(rootId, childRelativePath),
        rootId,
        name,
        relativePath: childRelativePath,
        kind: fileTypeToEntryKind(fileType),
      };
    });
  }

  async create(rootId: string, request: WorkspaceCreateRequest): Promise<WorkspaceEntry> {
    validateSharedWorkspaceEntryName(request.name);
    const relativePath = joinWorkspaceRelativePath(request.parentRelativePath, request.name);
    const target = this.uriFor(rootId, relativePath);
    if (request.kind === 'directory') {
      await vscode.workspace.fs.createDirectory(target);
    } else {
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(target, { overwrite: false, ignoreIfExists: false });
      if (!await vscode.workspace.applyEdit(edit)) {
        throw new WorkspaceOperationError('IO_ERROR', `Unable to create ${request.name}.`);
      }
    }
    return {
      id: createWorkspaceNodeId(rootId, relativePath),
      rootId,
      name: request.name,
      relativePath,
      kind: request.kind,
    };
  }

  async rename(rootId: string, request: WorkspaceRenameRequest): Promise<WorkspaceEntry> {
    validateSharedWorkspaceEntryName(request.newName);
    const source = this.uriFor(rootId, request.relativePath);
    const parentRelativePath = request.relativePath.includes('/')
      ? request.relativePath.slice(0, request.relativePath.lastIndexOf('/'))
      : '';
    const relativePath = joinWorkspaceRelativePath(parentRelativePath, request.newName);
    const target = this.uriFor(rootId, relativePath);
    const sourceStat = await vscode.workspace.fs.stat(source);
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(source, target, { overwrite: false, ignoreIfExists: false });
    if (!await vscode.workspace.applyEdit(edit)) {
      throw new WorkspaceOperationError('IO_ERROR', `Unable to rename ${workspaceBasename(source)}.`);
    }
    return {
      id: createWorkspaceNodeId(rootId, relativePath),
      rootId,
      name: request.newName,
      relativePath,
      kind: fileTypeToEntryKind(sourceStat.type),
    };
  }

  async delete(rootId: string, request: WorkspaceDeleteRequest): Promise<void> {
    const target = this.uriFor(rootId, request.relativePath);
    const useTrash = request.options?.useTrash ?? true;
    const recursive = request.options?.recursive ?? true;
    try {
      await vscode.workspace.fs.delete(target, { recursive, useTrash });
    } catch (error) {
      throw new WorkspaceOperationError(
        'IO_ERROR',
        `Unable to delete ${workspaceBasename(target)}.`,
        { cause: error },
      );
    }
  }

  async copy(
    rootId: string,
    sourceRelativePath: string,
    targetParentRelativePath: string,
  ): Promise<WorkspaceEntry> {
    const source = this.uriFor(rootId, sourceRelativePath);
    const parent = this.uriFor(rootId, targetParentRelativePath);
    const sourceStat = await vscode.workspace.fs.stat(source);
    if ((sourceStat.type & vscode.FileType.SymbolicLink) !== 0) {
      throw new WorkspaceOperationError('SYMLINK_NOT_TRAVERSABLE', 'Copying symbolic links is not supported.');
    }
    const isDirectory = (sourceStat.type & vscode.FileType.Directory) !== 0;
    if (isDirectory) {
      const sourcePath = normalizeUriPath(source.path);
      const parentPath = normalizeUriPath(parent.path);
      if (parentPath === sourcePath || parentPath.startsWith(`${sourcePath}/`)) {
        throw new WorkspaceOperationError('INVALID_PATH', 'Cannot paste a folder into itself or its descendants.');
      }
    }
    const target = await uniqueCopyTargetUri(parent, workspaceBasename(source), isDirectory);
    try {
      await vscode.workspace.fs.copy(source, target, { overwrite: false });
    } catch (error) {
      throw new WorkspaceOperationError(
        'IO_ERROR',
        `Unable to paste ${workspaceBasename(source)}.`,
        { cause: error },
      );
    }
    const relativePath = joinWorkspaceRelativePath(
      targetParentRelativePath,
      workspaceBasename(target),
    );
    return {
      id: createWorkspaceNodeId(rootId, relativePath),
      rootId,
      relativePath,
      name: workspaceBasename(target),
      kind: isDirectory ? 'directory' : 'file',
    };
  }
}

export class WorkspaceTreeService {
  private readonly gateway = new VscodeWorkspaceGateway();
  private readonly model = new WorkspaceTreeModel(this.gateway);
  private readonly operations = new WorkspaceFileOperationService(this.gateway, this.model);

  setRoot(root: vscode.Uri | undefined): void {
    this.gateway.clearRoots();
    this.model.clear();
    if (root) this.gateway.registerRoot(root);
  }

  async readChildren(root: vscode.Uri, relativePath: string): Promise<VscodeWorkspaceEntry[]> {
    const rootId = this.gateway.registerRoot(root);
    const entries = await this.model.listChildren(rootId, relativePath);
    const writable = vscode.workspace.fs.isWritableFileSystem(root.scheme) !== false;
    return entries.map((entry) => ({
      ...entry,
      uri: this.gateway.uriFor(rootId, entry.relativePath),
      writable,
    }));
  }

  invalidate(root: vscode.Uri, relativePaths: readonly string[]): void {
    this.model.invalidate(this.gateway.registerRoot(root), relativePaths);
  }

  invalidateAll(root?: vscode.Uri): void {
    this.model.invalidateAll(root ? this.gateway.registerRoot(root) : undefined);
  }

  async rename(root: vscode.Uri, relativePath: string, newName: string): Promise<VscodeWorkspaceEntry> {
    const rootId = this.gateway.registerRoot(root);
    const entry = await this.operations.rename(rootId, { relativePath, newName });
    return {
      ...entry,
      uri: this.gateway.uriFor(rootId, entry.relativePath),
      writable: vscode.workspace.fs.isWritableFileSystem(root.scheme) !== false,
    };
  }

  async delete(root: vscode.Uri, relativePath: string): Promise<void> {
    await this.operations.delete(this.gateway.registerRoot(root), {
      relativePath,
      options: { useTrash: true, recursive: true },
    });
  }

  async copy(
    root: vscode.Uri,
    sourceRelativePath: string,
    targetParentRelativePath: string,
  ): Promise<VscodeWorkspaceEntry> {
    const rootId = this.gateway.registerRoot(root);
    const entry = await this.gateway.copy(rootId, sourceRelativePath, targetParentRelativePath);
    this.model.invalidateDirectory(rootId, targetParentRelativePath);
    return {
      ...entry,
      uri: this.gateway.uriFor(rootId, entry.relativePath),
      writable: vscode.workspace.fs.isWritableFileSystem(root.scheme) !== false,
    };
  }

  async create(
    root: vscode.Uri,
    request: WorkspaceCreateRequest,
  ): Promise<VscodeWorkspaceEntry> {
    const rootId = this.gateway.registerRoot(root);
    const entry = await this.operations.create(rootId, request);
    return {
      ...entry,
      uri: this.gateway.uriFor(rootId, entry.relativePath),
      writable: vscode.workspace.fs.isWritableFileSystem(root.scheme) !== false,
    };
  }
}

export function validateWorkspaceEntryName(name: string): string | undefined {
  try {
    validateSharedWorkspaceEntryName(name);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'The file name is not valid.';
  }
}

export function workspaceRelativePath(root: vscode.Uri, resource: vscode.Uri): string | undefined {
  if (root.scheme !== resource.scheme || root.authority !== resource.authority) return undefined;

  const relativePath = path.posix.relative(normalizeUriPath(root.path), normalizeUriPath(resource.path));
  if (relativePath === '') return '';
  if (relativePath === '..' || relativePath.startsWith('../') || path.posix.isAbsolute(relativePath)) {
    return undefined;
  }
  return relativePath;
}

export function workspaceParentUri(resource: vscode.Uri): vscode.Uri {
  const parentPath = path.posix.dirname(normalizeUriPath(resource.path));
  return resource.with({ path: parentPath, query: '', fragment: '' });
}

export function workspaceBasename(resource: vscode.Uri): string {
  return path.posix.basename(normalizeUriPath(resource.path));
}

/** Pick an unused default name under parent, e.g. untitled.md / untitled 2.md, New Folder / New Folder 2. */
export async function uniqueWorkspaceCreateName(
  parent: vscode.Uri,
  kind: 'file' | 'directory',
): Promise<string> {
  const baseName = kind === 'directory' ? 'New Folder' : 'untitled.md';
  const extension = kind === 'directory' ? '' : path.posix.extname(baseName);
  const stem = kind === 'directory' ? baseName : path.posix.basename(baseName, extension);
  let index = 0;
  while (true) {
    const name = index === 0 ? baseName : `${stem} ${index + 1}${extension}`;
    const candidate = vscode.Uri.joinPath(parent, name);
    try {
      await vscode.workspace.fs.stat(candidate);
      index += 1;
    } catch {
      return name;
    }
  }
}

function workspaceRootId(root: vscode.Uri): string {
  return root.toString(true);
}

function fileTypeToEntryKind(fileType: vscode.FileType): WorkspaceEntryKind {
  if ((fileType & vscode.FileType.SymbolicLink) !== 0) return 'symlink';
  if ((fileType & vscode.FileType.Directory) !== 0) return 'directory';
  return 'file';
}

function normalizeUriPath(uriPath: string): string {
  const normalized = path.posix.normalize(uriPath);
  return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
}

async function uniqueCopyTargetUri(
  parent: vscode.Uri,
  baseName: string,
  isDirectory: boolean,
): Promise<vscode.Uri> {
  const extension = isDirectory ? '' : path.posix.extname(baseName);
  const stem = isDirectory ? baseName : path.posix.basename(baseName, extension);
  let index = 0;
  while (true) {
    const name = index === 0
      ? baseName
      : index === 1
        ? `${stem} copy${extension}`
        : `${stem} copy ${index}${extension}`;
    const candidate = vscode.Uri.joinPath(parent, name);
    try {
      await vscode.workspace.fs.stat(candidate);
      index += 1;
    } catch {
      return candidate;
    }
  }
}
