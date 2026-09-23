import type {
  WorkspaceCreateRequest,
  WorkspaceDeleteRequest,
  WorkspaceEntry,
  WorkspaceGateway,
  WorkspaceMoveRequest,
  WorkspacePathChange,
  WorkspacePathReference,
  WorkspaceRenameRequest,
} from '@easyview/contracts';
import { WorkspaceOperationError } from '@easyview/contracts';
import { WorkspaceTreeModel } from './workspace-tree-model';
import {
  joinWorkspaceRelativePath,
  normalizeWorkspaceRelativePath,
  parentWorkspaceRelativePath,
  validateWorkspaceEntryName,
} from './workspace-path';
import type { WorkspaceTreeOrderState } from './workspace-tree-order-state';

/** Shared mutation facade that keeps host adapters aligned on validation and cache invalidation. */
export class WorkspaceFileOperationService {
  constructor(
    private readonly gateway: WorkspaceGateway,
    private readonly treeModel: WorkspaceTreeModel = new WorkspaceTreeModel(gateway),
    private readonly orderState?: WorkspaceTreeOrderState,
  ) {}

  get model(): WorkspaceTreeModel {
    return this.treeModel;
  }

  async create(rootId: string, request: WorkspaceCreateRequest): Promise<WorkspaceEntry> {
    const parentRelativePath = normalizeWorkspaceRelativePath(request.parentRelativePath);
    validateWorkspaceEntryName(request.name);
    const created = await this.gateway.create(rootId, { ...request, parentRelativePath });
    this.orderState?.noteCreated(created.relativePath);
    this.treeModel.invalidateDirectory(rootId, parentRelativePath);
    return created;
  }

  async rename(rootId: string, request: WorkspaceRenameRequest): Promise<WorkspaceEntry> {
    const relativePath = normalizeWorkspaceRelativePath(request.relativePath);
    if (!relativePath) throw new WorkspaceOperationError('INVALID_PATH', 'Workspace root cannot be renamed');
    validateWorkspaceEntryName(request.newName);
    const renamed = await this.gateway.rename(rootId, { relativePath, newName: request.newName });
    this.orderState?.noteRenamed(relativePath, renamed.relativePath);
    this.treeModel.invalidatePath(rootId, relativePath);
    this.treeModel.invalidatePath(rootId, renamed.relativePath);
    return renamed;
  }

  async move(rootId: string, request: WorkspaceMoveRequest): Promise<WorkspaceEntry> {
    const relativePath = normalizeWorkspaceRelativePath(request.relativePath);
    if (!relativePath) throw new WorkspaceOperationError('INVALID_PATH', 'Workspace root cannot be moved');
    const targetParentRelativePath = normalizeWorkspaceRelativePath(request.targetParentRelativePath);
    if (request.newName !== undefined) validateWorkspaceEntryName(request.newName);

    const sourceParent = parentWorkspaceRelativePath(relativePath);
    const sourceName = relativePath.split('/').at(-1)!;
    const nextName = request.newName ?? sourceName;
    const nextRelativePath = joinWorkspaceRelativePath(targetParentRelativePath, nextName);

    if (relativePath === nextRelativePath) {
      const cached = this.treeModel.getCachedNode(rootId, relativePath);
      if (cached) return cached;
    }

    // Prevent moving a directory into itself or a descendant.
    if (
      targetParentRelativePath === relativePath
      || targetParentRelativePath.startsWith(`${relativePath}/`)
    ) {
      throw new WorkspaceOperationError('INVALID_PATH', 'Cannot move a folder into itself or its descendants');
    }

    if (sourceParent === targetParentRelativePath && nextName === sourceName) {
      throw new WorkspaceOperationError('INVALID_PATH', 'Move target is identical to the source');
    }

    const moved = await this.gateway.move(rootId, {
      relativePath,
      targetParentRelativePath,
      newName: request.newName,
    });
    this.orderState?.noteRenamed(relativePath, moved.relativePath);
    this.treeModel.invalidatePath(rootId, relativePath);
    this.treeModel.invalidatePath(rootId, moved.relativePath);
    return moved;
  }

  async delete(rootId: string, request: WorkspaceDeleteRequest): Promise<void> {
    const relativePath = normalizeWorkspaceRelativePath(request.relativePath);
    if (!relativePath) throw new WorkspaceOperationError('INVALID_PATH', 'Workspace root cannot be deleted');
    await this.gateway.delete(rootId, { ...request, relativePath });
    this.orderState?.noteDeleted(relativePath);
    this.treeModel.invalidatePath(rootId, relativePath);
  }

  applyExternalChanges(changes: readonly WorkspacePathChange[]): WorkspacePathReference[] {
    return this.treeModel.invalidateChanges(changes);
  }

  getParentPath(relativePath: string): string {
    return parentWorkspaceRelativePath(relativePath);
  }
}
