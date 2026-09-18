import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  createWorkspaceNodeId,
  isWorkspaceOperationError,
  type WorkspaceCreateRequest,
  type WorkspaceDeleteRequest,
  type WorkspaceEntry,
  type WorkspaceEntryKind,
  type WorkspaceGateway,
  type WorkspaceRenameRequest,
  type WorkspaceRootDescriptor,
  WorkspaceOperationError,
} from '@easyview/contracts';
import {
  joinWorkspaceRelativePath,
  normalizeWorkspaceRelativePath,
  parentWorkspaceRelativePath,
  validateWorkspaceEntryName,
} from './workspace-path';

export interface LocalWorkspaceRootRegistration {
  id: string;
  rootPath: string;
  name?: string;
}

export interface LocalWorkspaceTrashRequest {
  rootId: string;
  rootPath: string;
  relativePath: string;
  absolutePath: string;
}

export type LocalWorkspaceTrashHandler = (request: LocalWorkspaceTrashRequest) => Promise<void>;

export interface LocalWorkspaceGatewayOptions {
  trash?: LocalWorkspaceTrashHandler;
}

interface ResolvedLocalWorkspaceRoot {
  id: string;
  name: string;
  rootPath: string;
}

export class LocalWorkspaceGateway implements WorkspaceGateway {
  private readonly roots = new Map<string, LocalWorkspaceRootRegistration>();
  private readonly resolvedRoots = new Map<string, Promise<ResolvedLocalWorkspaceRoot>>();
  private readonly trash?: LocalWorkspaceTrashHandler;

  constructor(
    roots: readonly LocalWorkspaceRootRegistration[] = [],
    options: LocalWorkspaceGatewayOptions = {},
  ) {
    this.trash = options.trash;
    for (const root of roots) this.registerRoot(root);
  }

  registerRoot(root: LocalWorkspaceRootRegistration): void {
    if (!root.id || !root.rootPath) {
      throw new WorkspaceOperationError('INVALID_PATH', 'Workspace root id and path are required');
    }
    this.roots.set(root.id, { ...root });
    this.resolvedRoots.delete(root.id);
  }

  unregisterRoot(rootId: string): void {
    this.roots.delete(rootId);
    this.resolvedRoots.delete(rootId);
  }

  async listRoots(): Promise<WorkspaceRootDescriptor[]> {
    return Promise.all(
      [...this.roots.keys()].map(async (rootId) => {
        const root = await this.resolveRoot(rootId);
        return { id: root.id, name: root.name };
      }),
    );
  }

  async listChildren(rootId: string, relativePath: string): Promise<WorkspaceEntry[]> {
    return this.withFilesystemErrors(async () => {
      const root = await this.resolveRoot(rootId);
      const normalizedPath = normalizeWorkspaceRelativePath(relativePath);
      const realDirectoryPath = await this.resolveTraversableDirectory(root, normalizedPath);
      const entries = await fs.readdir(realDirectoryPath, { withFileTypes: true });
      return entries.map((entry) => {
        const entryRelativePath = normalizeWorkspaceRelativePath(
          path.relative(root.rootPath, path.join(realDirectoryPath, entry.name)),
        );
        return this.toEntry(
          root.id,
          entryRelativePath,
          entry.name,
          entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file',
        );
      });
    }, `Unable to list workspace directory: ${relativePath}`);
  }

  async create(rootId: string, request: WorkspaceCreateRequest): Promise<WorkspaceEntry> {
    return this.withFilesystemErrors(async () => {
      validateWorkspaceEntryName(request.name);
      const root = await this.resolveRoot(rootId);
      const parentRelativePath = normalizeWorkspaceRelativePath(request.parentRelativePath);
      const realParentPath = await this.resolveTraversableDirectory(root, parentRelativePath);
      const targetPath = path.join(realParentPath, request.name);
      this.ensureWithinRoot(root.rootPath, targetPath);
      await this.assertMissing(targetPath);

      if (request.kind === 'directory') {
        await fs.mkdir(targetPath);
      } else {
        await fs.writeFile(targetPath, '', { flag: 'wx' });
      }

      const relativePath = joinWorkspaceRelativePath(parentRelativePath, request.name);
      return this.toEntry(root.id, relativePath, request.name, request.kind);
    }, `Unable to create workspace entry: ${request.name}`);
  }

  async rename(rootId: string, request: WorkspaceRenameRequest): Promise<WorkspaceEntry> {
    return this.withFilesystemErrors(async () => {
      validateWorkspaceEntryName(request.newName);
      const relativePath = normalizeWorkspaceRelativePath(request.relativePath);
      if (!relativePath) throw new WorkspaceOperationError('INVALID_PATH', 'Workspace root cannot be renamed');

      const root = await this.resolveRoot(rootId);
      const parentRelativePath = parentWorkspaceRelativePath(relativePath);
      const realParentPath = await this.resolveTraversableDirectory(root, parentRelativePath);
      const sourcePath = path.join(realParentPath, path.basename(relativePath));
      this.ensureWithinRoot(root.rootPath, sourcePath);
      const sourceStat = await fs.lstat(sourcePath);
      const targetPath = path.join(realParentPath, request.newName);
      this.ensureWithinRoot(root.rootPath, targetPath);
      // Case-only renames on case-insensitive volumes point at the same entry.
      if (!sameFilesystemEntry(sourcePath, targetPath)) await this.assertMissing(targetPath);
      await fs.rename(sourcePath, targetPath);

      const renamedRelativePath = joinWorkspaceRelativePath(parentRelativePath, request.newName);
      return this.toEntry(
        root.id,
        renamedRelativePath,
        request.newName,
        this.kindFromStat(sourceStat),
      );
    }, `Unable to rename workspace entry: ${request.relativePath}`);
  }

  async delete(rootId: string, request: WorkspaceDeleteRequest): Promise<void> {
    await this.withFilesystemErrors(async () => {
      const relativePath = normalizeWorkspaceRelativePath(request.relativePath);
      if (!relativePath) throw new WorkspaceOperationError('INVALID_PATH', 'Workspace root cannot be deleted');

      const root = await this.resolveRoot(rootId);
      const parentRelativePath = parentWorkspaceRelativePath(relativePath);
      const realParentPath = await this.resolveTraversableDirectory(root, parentRelativePath);
      const targetPath = path.join(realParentPath, path.basename(relativePath));
      this.ensureWithinRoot(root.rootPath, targetPath);
      const targetStat = await fs.lstat(targetPath);

      if (request.options?.useTrash) {
        if (!this.trash) {
          throw new WorkspaceOperationError('TRASH_UNAVAILABLE', 'No workspace trash handler is configured');
        }
        await this.trash({
          rootId: root.id,
          rootPath: root.rootPath,
          relativePath,
          absolutePath: targetPath,
        });
        return;
      }

      if (targetStat.isDirectory() && !targetStat.isSymbolicLink()) {
        if (request.options?.recursive) {
          await fs.rm(targetPath, { recursive: true, force: false });
        } else {
          await fs.rmdir(targetPath);
        }
      } else {
        await fs.unlink(targetPath);
      }
    }, `Unable to delete workspace entry: ${request.relativePath}`);
  }

  private async resolveRoot(rootId: string): Promise<ResolvedLocalWorkspaceRoot> {
    const cached = this.resolvedRoots.get(rootId);
    if (cached) return cached;

    const registration = this.roots.get(rootId);
    if (!registration) throw new WorkspaceOperationError('ROOT_NOT_FOUND', `Unknown workspace root: ${rootId}`);

    const resolving = this.withFilesystemErrors(async () => {
      const stat = await fs.stat(registration.rootPath);
      if (!stat.isDirectory()) {
        throw new WorkspaceOperationError('NOT_DIRECTORY', `Workspace root is not a directory: ${registration.rootPath}`);
      }
      const rootPath = await fs.realpath(registration.rootPath);
      return {
        id: registration.id,
        name: registration.name ?? path.basename(rootPath),
        rootPath,
      };
    }, `Unable to resolve workspace root: ${registration.rootPath}`).catch((error) => {
      this.resolvedRoots.delete(rootId);
      throw error;
    });

    this.resolvedRoots.set(rootId, resolving);
    return resolving;
  }

  private async resolveTraversableDirectory(
    root: ResolvedLocalWorkspaceRoot,
    relativePath: string,
  ): Promise<string> {
    const normalizedPath = normalizeWorkspaceRelativePath(relativePath);
    let currentPath = root.rootPath;
    for (const segment of normalizedPath ? normalizedPath.split('/') : []) {
      currentPath = path.join(currentPath, segment);
      const segmentStat = await fs.lstat(currentPath);
      if (segmentStat.isSymbolicLink()) {
        throw new WorkspaceOperationError(
          'SYMLINK_NOT_TRAVERSABLE',
          `Symbolic links are leaf nodes: ${normalizedPath}`,
        );
      }
      if (!segmentStat.isDirectory()) {
        throw new WorkspaceOperationError('NOT_DIRECTORY', `Workspace entry is not a directory: ${normalizedPath}`);
      }
    }
    const realDirectoryPath = await fs.realpath(currentPath);
    this.ensureWithinRoot(root.rootPath, realDirectoryPath);
    return realDirectoryPath;
  }

  private ensureWithinRoot(rootPath: string, candidatePath: string): void {
    const root = path.resolve(rootPath);
    const candidate = path.resolve(candidatePath);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
      throw new WorkspaceOperationError('ROOT_ESCAPE', 'Workspace path cannot escape the root');
    }
  }

  private async assertMissing(targetPath: string): Promise<void> {
    try {
      await fs.lstat(targetPath);
      throw new WorkspaceOperationError('ALREADY_EXISTS', 'A file or directory with the same name already exists');
    } catch (error) {
      if (isWorkspaceOperationError(error)) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private kindFromStat(stat: Awaited<ReturnType<typeof fs.lstat>>): WorkspaceEntryKind {
    if (stat.isSymbolicLink()) return 'symlink';
    return stat.isDirectory() ? 'directory' : 'file';
  }

  private toEntry(
    rootId: string,
    relativePath: string,
    name: string,
    kind: WorkspaceEntryKind,
  ): WorkspaceEntry {
    return {
      id: createWorkspaceNodeId(rootId, relativePath),
      rootId,
      relativePath,
      name,
      kind,
    };
  }

  private async withFilesystemErrors<T>(operation: () => Promise<T>, message: string): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (isWorkspaceOperationError(error)) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new WorkspaceOperationError('NOT_FOUND', message, { cause: error });
      if (code === 'EEXIST') throw new WorkspaceOperationError('ALREADY_EXISTS', message, { cause: error });
      if (code === 'ENOTDIR') throw new WorkspaceOperationError('NOT_DIRECTORY', message, { cause: error });
      if (code === 'ENOTEMPTY') throw new WorkspaceOperationError('DIRECTORY_NOT_EMPTY', message, { cause: error });
      if (code === 'EACCES' || code === 'EPERM') {
        throw new WorkspaceOperationError('PERMISSION_DENIED', message, { cause: error });
      }
      throw new WorkspaceOperationError('IO_ERROR', message, { cause: error });
    }
  }
}

function sameFilesystemEntry(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return resolvedLeft.toLocaleLowerCase() === resolvedRight.toLocaleLowerCase();
  }
  return resolvedLeft === resolvedRight;
}
