import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createWorkspaceNodeId,
  isWorkspaceOperationError,
  type WorkspaceCreateRequest,
  type WorkspaceDeleteRequest,
  type WorkspaceEntry,
  type WorkspaceMoveRequest,
  type WorkspaceRenameRequest,
  type WorkspaceTreeSortMode,
  WorkspaceOperationError,
} from '@easyview/contracts';
import {
  LocalWorkspaceGateway,
  normalizeWorkspaceRelativePath,
  parentWorkspaceRelativePath,
  WORKSPACE_TREE_ORDER_RELATIVE_PATH,
  WorkspaceFileOperationService,
  WorkspaceTreeModel,
  WorkspaceTreeOrderState,
} from '@easyview/node-runtime';
import type { WorkspaceCopyRequest, WorkspaceResourcePaths } from '../../../contracts/workspace';

/** Stable single-root id for the Desktop host (one folder window). */
export const DESKTOP_WORKSPACE_ROOT_ID = 'desktop';

/**
 * Desktop adapter over the shared workspace core.
 * Host-only concerns stay here: trash via Electron, copy/paste, absolute path helpers.
 */
export class DesktopWorkspaceCore {
  private readonly gateway: LocalWorkspaceGateway;
  private readonly orderState = new WorkspaceTreeOrderState();
  private readonly model: WorkspaceTreeModel;
  private readonly operations: WorkspaceFileOperationService;
  private boundRootPath: string | null = null;
  private persistTimer: NodeJS.Timeout | undefined;

  constructor(trash?: (absolutePath: string) => Promise<void>) {
    this.gateway = new LocalWorkspaceGateway([], {
      trash: trash
        ? async (request) => {
          await trash(request.absolutePath);
        }
        : undefined,
    });
    this.model = new WorkspaceTreeModel(this.gateway, { sortProvider: this.orderState });
    this.operations = new WorkspaceFileOperationService(this.gateway, this.model, this.orderState);
  }

  get rootId(): string {
    return DESKTOP_WORKSPACE_ROOT_ID;
  }

  getRootPath(): string | null {
    return this.boundRootPath;
  }

  getSortMode(): WorkspaceTreeSortMode {
    return this.orderState.getSortMode();
  }

  async bindRoot(selectedPath: string): Promise<string> {
    const stat = await fs.stat(selectedPath);
    if (!stat.isDirectory()) {
      throw new WorkspaceOperationError('NOT_DIRECTORY', '所选路径不是文件夹');
    }
    const rootPath = await fs.realpath(selectedPath);
    this.model.clear();
    this.gateway.registerRoot({
      id: DESKTOP_WORKSPACE_ROOT_ID,
      rootPath,
      name: path.basename(rootPath),
    });
    this.boundRootPath = rootPath;
    await this.loadOrderConfig();
    return rootPath;
  }

  clear(): void {
    this.model.clear();
    this.gateway.unregisterRoot(DESKTOP_WORKSPACE_ROOT_ID);
    this.boundRootPath = null;
    this.orderState.replaceConfig({
      version: 1,
      sortMode: 'name',
      showCreatedAt: false,
      showUpdatedAt: false,
      showDotEntries: true,
      showTimestampHover: true,
      orders: {},
    });
  }

  async listChildren(relativePath = ''): Promise<WorkspaceEntry[]> {
    this.requireRoot();
    const entries = await this.model.listChildren(DESKTOP_WORKSPACE_ROOT_ID, relativePath);
    return entries.map((entry) => ({ ...entry }));
  }

  async setSortMode(sortMode: WorkspaceTreeSortMode): Promise<WorkspaceTreeSortMode> {
    this.requireRoot();
    this.orderState.setSortMode(sortMode);
    this.model.invalidateAll(DESKTOP_WORKSPACE_ROOT_ID);
    await this.persistOrderConfig();
    return sortMode;
  }

  getShowCreatedAt(): boolean {
    return this.orderState.getShowCreatedAt();
  }

  getShowUpdatedAt(): boolean {
    return this.orderState.getShowUpdatedAt();
  }

  getShowDotEntries(): boolean {
    return this.orderState.getShowDotEntries();
  }

  getShowTimestampHover(): boolean {
    return this.orderState.getShowTimestampHover();
  }

  getShowTimestamps(): boolean {
    return this.orderState.getShowTimestamps();
  }

  async setShowCreatedAt(showCreatedAt: boolean): Promise<boolean> {
    this.requireRoot();
    this.orderState.setShowCreatedAt(showCreatedAt);
    await this.persistOrderConfig();
    return showCreatedAt === true;
  }

  async setShowUpdatedAt(showUpdatedAt: boolean): Promise<boolean> {
    this.requireRoot();
    this.orderState.setShowUpdatedAt(showUpdatedAt);
    await this.persistOrderConfig();
    return showUpdatedAt === true;
  }

  async setShowDotEntries(showDotEntries: boolean): Promise<boolean> {
    this.requireRoot();
    this.orderState.setShowDotEntries(showDotEntries);
    await this.persistOrderConfig();
    return showDotEntries !== false;
  }

  async setShowTimestampHover(showTimestampHover: boolean): Promise<boolean> {
    this.requireRoot();
    this.orderState.setShowTimestampHover(showTimestampHover);
    await this.persistOrderConfig();
    return showTimestampHover !== false;
  }

  async reorder(
    parentRelativePath: string,
    movedName: string,
    siblingNames: readonly string[],
    beforeName?: string,
  ): Promise<void> {
    this.requireRoot();
    this.orderState.reorder(parentRelativePath, movedName, siblingNames, beforeName);
    this.model.invalidateDirectory(DESKTOP_WORKSPACE_ROOT_ID, parentRelativePath);
    await this.persistOrderConfig();
  }

  async create(request: WorkspaceCreateRequest): Promise<WorkspaceEntry> {
    this.requireRoot();
    const entry = await this.operations.create(DESKTOP_WORKSPACE_ROOT_ID, request);
    this.schedulePersistOrderConfig();
    return entry;
  }

  async rename(request: WorkspaceRenameRequest): Promise<WorkspaceEntry> {
    this.requireRoot();
    const entry = await this.operations.rename(DESKTOP_WORKSPACE_ROOT_ID, request);
    this.schedulePersistOrderConfig();
    return entry;
  }

  async move(request: WorkspaceMoveRequest): Promise<WorkspaceEntry> {
    this.requireRoot();
    const entry = await this.operations.move(DESKTOP_WORKSPACE_ROOT_ID, request);
    this.schedulePersistOrderConfig();
    return entry;
  }

  async delete(request: WorkspaceDeleteRequest): Promise<void> {
    this.requireRoot();
    await this.operations.delete(DESKTOP_WORKSPACE_ROOT_ID, {
      relativePath: request.relativePath,
      options: {
        useTrash: request.options?.useTrash ?? true,
        recursive: request.options?.recursive ?? true,
      },
    });
    this.schedulePersistOrderConfig();
  }

  /** Desktop clipboard paste — not part of the shared mutation facade. */
  async copy(request: WorkspaceCopyRequest): Promise<WorkspaceEntry> {
    const root = this.requireRoot();
    const sourceRelativePath = normalizeWorkspaceRelativePath(request.sourceRelativePath);
    const targetParentRelativePath = normalizeWorkspaceRelativePath(request.targetParentRelativePath);
    if (!sourceRelativePath) {
      throw new WorkspaceOperationError('INVALID_PATH', '不能复制工作区根目录');
    }

    const sourcePath = this.resolveAbsolutePath(sourceRelativePath);
    const parentPath = this.resolveAbsolutePath(targetParentRelativePath);
    const sourceStat = await fs.lstat(sourcePath);
    if (sourceStat.isSymbolicLink()) {
      throw new WorkspaceOperationError('SYMLINK_NOT_TRAVERSABLE', '暂不支持复制符号链接');
    }

    const parentStat = await fs.lstat(parentPath);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new WorkspaceOperationError('NOT_DIRECTORY', '目标目录不可用');
    }
    const realParent = await fs.realpath(parentPath);
    this.ensureWithinRoot(root, realParent);

    if (sourceStat.isDirectory()) {
      const realSource = await fs.realpath(sourcePath);
      if (realParent === realSource || realParent.startsWith(`${realSource}${path.sep}`)) {
        throw new WorkspaceOperationError('INVALID_PATH', '不能粘贴到自身或其子目录中');
      }
    }

    const targetPath = await uniqueCopyTargetPath(realParent, path.basename(sourcePath), sourceStat.isDirectory());
    this.ensureWithinRoot(root, targetPath);
    await fs.cp(sourcePath, targetPath, { recursive: true, errorOnExist: true, force: false });

    const relativePath = normalizeWorkspaceRelativePath(path.relative(root, targetPath));
    this.orderState.noteCreated(relativePath);
    this.model.invalidateDirectory(DESKTOP_WORKSPACE_ROOT_ID, targetParentRelativePath);
    this.schedulePersistOrderConfig();
    return {
      id: createWorkspaceNodeId(DESKTOP_WORKSPACE_ROOT_ID, relativePath),
      rootId: DESKTOP_WORKSPACE_ROOT_ID,
      relativePath,
      name: path.basename(targetPath),
      kind: sourceStat.isDirectory() ? 'directory' : 'file',
    };
  }

  resourcePaths(relativePath: string): WorkspaceResourcePaths {
    const root = this.requireRoot();
    const normalized = normalizeWorkspaceRelativePath(relativePath);
    const absolutePath = this.resolveAbsolutePath(normalized);
    return {
      resourceUri: pathToFileURL(absolutePath).href,
      absolutePath,
      relativePath: normalized,
    };
  }

  resolveAbsolutePath(relativePath: string): string {
    const root = this.requireRoot();
    const normalized = normalizeWorkspaceRelativePath(relativePath);
    const absolutePath = normalized
      ? path.resolve(root, ...normalized.split('/'))
      : path.resolve(root);
    this.ensureWithinRoot(root, absolutePath);
    return absolutePath;
  }

  /**
   * Invalidate shared tree caches after filesystem watcher events.
   * Returns directory relative paths the renderer should refresh, or null for full reload.
   */
  invalidateFromWatcher(relativePaths: string[] | null): string[] | null {
    if (!this.boundRootPath) return relativePaths;
    if (relativePaths === null) {
      this.model.invalidateAll(DESKTOP_WORKSPACE_ROOT_ID);
      return null;
    }
    const normalized = relativePaths.map((value) => normalizeWorkspaceRelativePath(value.replace(/\\/g, '/')));
    if (normalized.some((value) => value === WORKSPACE_TREE_ORDER_RELATIVE_PATH || value === '.easyview')) {
      void this.loadOrderConfig();
    }
    return this.model.invalidate(DESKTOP_WORKSPACE_ROOT_ID, normalized).map((entry) => entry.relativePath);
  }

  parentRelativePath(relativePath: string): string {
    return parentWorkspaceRelativePath(relativePath);
  }

  private async loadOrderConfig(): Promise<void> {
    const root = this.boundRootPath;
    if (!root) return;
    const configPath = path.join(root, ...WORKSPACE_TREE_ORDER_RELATIVE_PATH.split('/'));
    try {
      const raw = await fs.readFile(configPath, 'utf8');
      this.orderState.loadFromJson(raw);
    } catch {
      this.orderState.replaceConfig({
        version: 1,
        sortMode: 'name',
        showCreatedAt: false,
        showUpdatedAt: false,
        showDotEntries: true,
        showTimestampHover: true,
        orders: {},
      });
    }
    this.model.invalidateAll(DESKTOP_WORKSPACE_ROOT_ID);
  }

  private schedulePersistOrderConfig(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persistOrderConfig();
    }, 120);
  }

  private async persistOrderConfig(): Promise<void> {
    const root = this.boundRootPath;
    if (!root) return;
    const easyviewDir = path.join(root, '.easyview');
    const configPath = path.join(root, ...WORKSPACE_TREE_ORDER_RELATIVE_PATH.split('/'));
    await fs.mkdir(easyviewDir, { recursive: true });
    await fs.writeFile(configPath, this.orderState.toJson(), 'utf8');
  }

  private requireRoot(): string {
    if (!this.boundRootPath) {
      throw new WorkspaceOperationError('ROOT_NOT_FOUND', '尚未打开工作区');
    }
    return this.boundRootPath;
  }

  private ensureWithinRoot(rootPath: string, candidatePath: string): void {
    const root = path.resolve(rootPath);
    const candidate = path.resolve(candidatePath);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
      throw new WorkspaceOperationError('ROOT_ESCAPE', '路径不能超出工作区根目录');
    }
  }
}

export function desktopWorkspaceErrorMessage(error: unknown): string {
  if (isWorkspaceOperationError(error)) {
    switch (error.code) {
      case 'ALREADY_EXISTS':
        return '同名文件或文件夹已存在';
      case 'ROOT_ESCAPE':
        return '路径不能超出工作区根目录';
      case 'INVALID_NAME':
        return '名称不能为空且不能包含路径分隔符';
      case 'INVALID_PATH':
        return error.message.includes('自身') ? error.message : '工作区路径无效';
      case 'NOT_DIRECTORY':
        return error.message.includes('所选') ? error.message : '目录节点不可读取';
      case 'SYMLINK_NOT_TRAVERSABLE':
        return error.message.includes('复制') ? error.message : '目录节点不可读取';
      case 'ROOT_NOT_FOUND':
        return '尚未打开工作区';
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : '工作区操作失败';
}

async function uniqueCopyTargetPath(parentPath: string, baseName: string, isDirectory: boolean): Promise<string> {
  const extension = isDirectory ? '' : path.extname(baseName);
  const stem = isDirectory ? baseName : path.basename(baseName, extension);
  let index = 0;
  while (true) {
    const name = index === 0
      ? baseName
      : index === 1
        ? `${stem} copy${extension}`
        : `${stem} copy ${index}${extension}`;
    const candidate = path.join(parentPath, name);
    try {
      await fs.lstat(candidate);
      index += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate;
      throw error;
    }
  }
}
