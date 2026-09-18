import type {
  WorkspaceCreateRequest,
  WorkspaceDeleteRequest,
  WorkspaceEntry,
  WorkspaceGateway,
  WorkspacePathChange,
  WorkspacePathReference,
  WorkspaceRenameRequest,
} from '@easyview/contracts';
import { WorkspaceOperationError } from '@easyview/contracts';
import { WorkspaceTreeModel } from './workspace-tree-model';
import {
  normalizeWorkspaceRelativePath,
  parentWorkspaceRelativePath,
  validateWorkspaceEntryName,
} from './workspace-path';

/** Shared mutation facade that keeps host adapters aligned on validation and cache invalidation. */
export class WorkspaceFileOperationService {
  constructor(
    private readonly gateway: WorkspaceGateway,
    private readonly treeModel: WorkspaceTreeModel = new WorkspaceTreeModel(gateway),
  ) {}

  get model(): WorkspaceTreeModel {
    return this.treeModel;
  }

  async create(rootId: string, request: WorkspaceCreateRequest): Promise<WorkspaceEntry> {
    const parentRelativePath = normalizeWorkspaceRelativePath(request.parentRelativePath);
    validateWorkspaceEntryName(request.name);
    const created = await this.gateway.create(rootId, { ...request, parentRelativePath });
    this.treeModel.invalidateDirectory(rootId, parentRelativePath);
    return created;
  }

  async rename(rootId: string, request: WorkspaceRenameRequest): Promise<WorkspaceEntry> {
    const relativePath = normalizeWorkspaceRelativePath(request.relativePath);
    if (!relativePath) throw new WorkspaceOperationError('INVALID_PATH', 'Workspace root cannot be renamed');
    validateWorkspaceEntryName(request.newName);
    const renamed = await this.gateway.rename(rootId, { relativePath, newName: request.newName });
    this.treeModel.invalidatePath(rootId, relativePath);
    this.treeModel.invalidatePath(rootId, renamed.relativePath);
    return renamed;
  }

  async delete(rootId: string, request: WorkspaceDeleteRequest): Promise<void> {
    const relativePath = normalizeWorkspaceRelativePath(request.relativePath);
    if (!relativePath) throw new WorkspaceOperationError('INVALID_PATH', 'Workspace root cannot be deleted');
    await this.gateway.delete(rootId, { ...request, relativePath });
    this.treeModel.invalidatePath(rootId, relativePath);
  }

  applyExternalChanges(changes: readonly WorkspacePathChange[]): WorkspacePathReference[] {
    return this.treeModel.invalidateChanges(changes);
  }

  getParentPath(relativePath: string): string {
    return parentWorkspaceRelativePath(relativePath);
  }
}
