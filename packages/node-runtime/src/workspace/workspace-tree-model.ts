import {
  createWorkspaceNodeId,
  type WorkspaceEntry,
  type WorkspaceGateway,
  type WorkspacePathChange,
  type WorkspacePathReference,
  type WorkspaceTreeSortMode,
  WorkspaceOperationError,
} from '@easyview/contracts';
import {
  getWorkspaceAncestorPaths,
  normalizeWorkspaceRelativePath,
  parentWorkspaceRelativePath,
  validateWorkspaceEntryName,
} from './workspace-path';
import { sortWorkspaceEntries } from './workspace-tree-order';

export interface WorkspaceTreeSortProvider {
  getSortMode(): WorkspaceTreeSortMode;
  getOrderNames(parentRelativePath: string): readonly string[];
}

export interface WorkspaceTreeModelOptions {
  /** Optional bound for the number of lazily loaded directory snapshots. */
  maxCachedDirectories?: number;
  sortProvider?: WorkspaceTreeSortProvider;
}

function cacheKey(rootId: string, relativePath: string): string {
  return `${rootId}\0${relativePath}`;
}

/** Shared lazy tree state used by Desktop and VS Code host adapters. */
export class WorkspaceTreeModel {
  private readonly childCache = new Map<string, Promise<readonly WorkspaceEntry[]>>();
  private readonly nodes = new Map<string, WorkspaceEntry>();
  private readonly maxCachedDirectories?: number;
  private sortProvider?: WorkspaceTreeSortProvider;

  constructor(
    private readonly gateway: WorkspaceGateway,
    options: WorkspaceTreeModelOptions = {},
  ) {
    this.maxCachedDirectories = options.maxCachedDirectories;
    this.sortProvider = options.sortProvider;
  }

  setSortProvider(provider: WorkspaceTreeSortProvider | undefined): void {
    this.sortProvider = provider;
  }

  listChildren(rootId: string, relativePath = ''): Promise<readonly WorkspaceEntry[]> {
    const directoryPath = normalizeWorkspaceRelativePath(relativePath);
    const knownNode = this.nodes.get(cacheKey(rootId, directoryPath));
    if (knownNode && knownNode.kind !== 'directory') {
      const code = knownNode.kind === 'symlink' ? 'SYMLINK_NOT_TRAVERSABLE' : 'NOT_DIRECTORY';
      return Promise.reject(
        new WorkspaceOperationError(code, `Workspace entry is not a traversable directory: ${directoryPath}`),
      );
    }

    const key = cacheKey(rootId, directoryPath);
    const cached = this.childCache.get(key);
    if (cached) return cached;

    const loading = this.loadChildren(rootId, directoryPath).catch((error) => {
      this.childCache.delete(key);
      throw error;
    });
    this.childCache.set(key, loading);
    this.evictIfNeeded(key);
    return loading;
  }

  refresh(rootId: string, relativePath = ''): Promise<readonly WorkspaceEntry[]> {
    const directoryPath = normalizeWorkspaceRelativePath(relativePath);
    this.invalidateDirectory(rootId, directoryPath);
    return this.listChildren(rootId, directoryPath);
  }

  getCachedNode(rootId: string, relativePath: string): WorkspaceEntry | undefined {
    return this.nodes.get(cacheKey(rootId, normalizeWorkspaceRelativePath(relativePath)));
  }

  getAncestorPaths(relativePath: string): string[] {
    return getWorkspaceAncestorPaths(relativePath);
  }

  getNodeId(rootId: string, relativePath: string): string {
    return createWorkspaceNodeId(rootId, normalizeWorkspaceRelativePath(relativePath));
  }

  getCachedDirectoryCount(): number {
    return this.childCache.size;
  }

  invalidateDirectory(rootId: string, relativePath = ''): WorkspacePathReference {
    const directoryPath = normalizeWorkspaceRelativePath(relativePath);
    this.childCache.delete(cacheKey(rootId, directoryPath));
    return { rootId, relativePath: directoryPath };
  }

  invalidatePath(rootId: string, relativePath: string): WorkspacePathReference[] {
    const normalized = normalizeWorkspaceRelativePath(relativePath);
    const invalidated = new Map<string, WorkspacePathReference>();
    const parent = this.invalidateDirectory(rootId, parentWorkspaceRelativePath(normalized));
    invalidated.set(cacheKey(parent.rootId, parent.relativePath), parent);
    if (normalized) {
      const direct = this.invalidateDirectory(rootId, normalized);
      invalidated.set(cacheKey(direct.rootId, direct.relativePath), direct);
      this.removeNodeSubtree(rootId, normalized);
    }
    return [...invalidated.values()];
  }

  invalidate(rootId: string, relativePaths: readonly string[]): WorkspacePathReference[] {
    const invalidated = new Map<string, WorkspacePathReference>();
    for (const relativePath of relativePaths) {
      for (const target of this.invalidatePath(rootId, relativePath)) {
        invalidated.set(cacheKey(target.rootId, target.relativePath), target);
      }
    }
    return [...invalidated.values()];
  }

  invalidateChanges(changes: readonly WorkspacePathChange[]): WorkspacePathReference[] {
    const invalidated = new Map<string, WorkspacePathReference>();
    for (const change of changes) {
      for (const target of this.invalidatePath(change.rootId, change.relativePath)) {
        invalidated.set(cacheKey(target.rootId, target.relativePath), target);
      }
      if (change.previousRelativePath !== undefined) {
        for (const target of this.invalidatePath(change.rootId, change.previousRelativePath)) {
          invalidated.set(cacheKey(target.rootId, target.relativePath), target);
        }
      }
    }
    return [...invalidated.values()];
  }

  invalidateAll(rootId?: string): void {
    if (rootId === undefined) {
      this.clear();
      return;
    }
    this.clearRoot(rootId);
  }

  clearRoot(rootId: string): void {
    const prefix = `${rootId}\0`;
    for (const key of this.childCache.keys()) {
      if (key.startsWith(prefix)) this.childCache.delete(key);
    }
    for (const key of this.nodes.keys()) {
      if (key.startsWith(prefix)) this.nodes.delete(key);
    }
  }

  clear(): void {
    this.childCache.clear();
    this.nodes.clear();
  }

  private async loadChildren(rootId: string, directoryPath: string): Promise<readonly WorkspaceEntry[]> {
    const entries = await this.gateway.listChildren(rootId, directoryPath);
    const normalizedEntries = entries.map((entry) => this.normalizeGatewayEntry(rootId, directoryPath, entry));
    const sortMode = this.sortProvider?.getSortMode() ?? 'name';
    const orderNames = this.sortProvider?.getOrderNames(directoryPath) ?? [];
    const sorted = sortWorkspaceEntries(normalizedEntries, sortMode, orderNames);
    for (const entry of sorted) {
      this.nodes.set(cacheKey(rootId, entry.relativePath), entry);
    }
    return Object.freeze(sorted);
  }

  private normalizeGatewayEntry(
    rootId: string,
    parentRelativePath: string,
    entry: WorkspaceEntry,
  ): WorkspaceEntry {
    if (entry.rootId !== rootId) {
      throw new WorkspaceOperationError('INVALID_GATEWAY_RESPONSE', 'Gateway returned an entry for another root');
    }
    validateWorkspaceEntryName(entry.name);
    const relativePath = normalizeWorkspaceRelativePath(entry.relativePath);
    if (
      parentWorkspaceRelativePath(relativePath) !== parentRelativePath
      || relativePath.split('/').at(-1) !== entry.name
    ) {
      throw new WorkspaceOperationError(
        'INVALID_GATEWAY_RESPONSE',
        'Gateway returned an entry outside the requested directory',
      );
    }
    return {
      ...entry,
      id: createWorkspaceNodeId(rootId, relativePath),
      rootId,
      relativePath,
    };
  }

  private removeNodeSubtree(rootId: string, relativePath: string): void {
    const rootKey = cacheKey(rootId, relativePath);
    const childPrefix = `${rootKey}/`;
    for (const key of this.nodes.keys()) {
      if (key === rootKey || key.startsWith(childPrefix)) this.nodes.delete(key);
    }
    for (const key of this.childCache.keys()) {
      if (key === rootKey || key.startsWith(childPrefix)) this.childCache.delete(key);
    }
  }

  private evictIfNeeded(protectedKey: string): void {
    if (!this.maxCachedDirectories || this.childCache.size <= this.maxCachedDirectories) return;
    for (const key of this.childCache.keys()) {
      if (key === protectedKey) continue;
      this.childCache.delete(key);
      if (this.childCache.size <= this.maxCachedDirectories) return;
    }
  }
}
