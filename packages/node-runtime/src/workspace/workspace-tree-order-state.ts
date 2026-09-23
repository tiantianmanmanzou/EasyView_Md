import type { WorkspaceTreeSortMode } from '@easyview/contracts';
import type { WorkspaceTreeSortProvider } from './workspace-tree-model';
import {
  applyEntryCreated,
  applyEntryDeleted,
  applyEntryRenamed,
  DEFAULT_WORKSPACE_TREE_ORDER_CONFIG,
  parseWorkspaceTreeOrderConfig,
  reorderNames,
  serializeWorkspaceTreeOrderConfig,
  type WorkspaceTreeOrderConfig,
} from './workspace-tree-order';
import { normalizeWorkspaceRelativePath } from './workspace-path';

/** In-memory tree-order config used as the shared sort provider. */
export class WorkspaceTreeOrderState implements WorkspaceTreeSortProvider {
  private config: WorkspaceTreeOrderConfig = {
    ...DEFAULT_WORKSPACE_TREE_ORDER_CONFIG,
    orders: {},
  };

  getConfig(): WorkspaceTreeOrderConfig {
    return {
      version: this.config.version,
      sortMode: this.config.sortMode,
      showCreatedAt: this.config.showCreatedAt,
      showUpdatedAt: this.config.showUpdatedAt,
      showDotEntries: this.config.showDotEntries,
      showTimestampHover: this.config.showTimestampHover,
      orders: { ...this.config.orders },
    };
  }

  getSortMode(): WorkspaceTreeSortMode {
    return this.config.sortMode;
  }

  getShowCreatedAt(): boolean {
    return this.config.showCreatedAt === true;
  }

  getShowUpdatedAt(): boolean {
    return this.config.showUpdatedAt === true;
  }

  getShowDotEntries(): boolean {
    return this.config.showDotEntries !== false;
  }

  getShowTimestampHover(): boolean {
    return this.config.showTimestampHover !== false;
  }

  /** True when either timestamp column is enabled. */
  getShowTimestamps(): boolean {
    return this.getShowCreatedAt() || this.getShowUpdatedAt();
  }

  getOrderNames(parentRelativePath: string): readonly string[] {
    const parent = normalizeWorkspaceRelativePath(parentRelativePath);
    return this.config.orders[parent] ?? [];
  }

  replaceConfig(config: WorkspaceTreeOrderConfig): void {
    this.config = {
      version: config.version,
      sortMode: config.sortMode,
      showCreatedAt: config.showCreatedAt === true,
      showUpdatedAt: config.showUpdatedAt === true,
      showDotEntries: config.showDotEntries !== false,
      showTimestampHover: config.showTimestampHover !== false,
      orders: { ...config.orders },
    };
  }

  loadFromJson(raw: string | null | undefined): void {
    if (!raw?.trim()) {
      this.replaceConfig({ ...DEFAULT_WORKSPACE_TREE_ORDER_CONFIG, orders: {} });
      return;
    }
    this.replaceConfig(parseWorkspaceTreeOrderConfig(JSON.parse(raw) as unknown));
  }

  toJson(): string {
    return serializeWorkspaceTreeOrderConfig(this.config);
  }

  setSortMode(sortMode: WorkspaceTreeSortMode): WorkspaceTreeOrderConfig {
    this.config = { ...this.config, sortMode };
    return this.getConfig();
  }

  setShowCreatedAt(showCreatedAt: boolean): WorkspaceTreeOrderConfig {
    this.config = { ...this.config, showCreatedAt: showCreatedAt === true };
    return this.getConfig();
  }

  setShowUpdatedAt(showUpdatedAt: boolean): WorkspaceTreeOrderConfig {
    this.config = { ...this.config, showUpdatedAt: showUpdatedAt === true };
    return this.getConfig();
  }

  setShowDotEntries(showDotEntries: boolean): WorkspaceTreeOrderConfig {
    this.config = { ...this.config, showDotEntries: showDotEntries !== false };
    return this.getConfig();
  }

  setShowTimestampHover(showTimestampHover: boolean): WorkspaceTreeOrderConfig {
    this.config = { ...this.config, showTimestampHover: showTimestampHover !== false };
    return this.getConfig();
  }

  reorder(
    parentRelativePath: string,
    movedName: string,
    siblingNames: readonly string[],
    beforeName?: string,
  ): WorkspaceTreeOrderConfig {
    const parent = normalizeWorkspaceRelativePath(parentRelativePath);
    const current = this.config.orders[parent] ?? [];
    const nextNames = reorderNames(current, siblingNames, movedName, beforeName);
    this.config = {
      ...this.config,
      sortMode: 'custom',
      orders: { ...this.config.orders, [parent]: nextNames },
    };
    return this.getConfig();
  }

  noteCreated(relativePath: string): void {
    this.config = applyEntryCreated(this.config, relativePath);
  }

  noteRenamed(previousRelativePath: string, nextRelativePath: string): void {
    this.config = applyEntryRenamed(this.config, previousRelativePath, nextRelativePath);
  }

  noteDeleted(relativePath: string): void {
    this.config = applyEntryDeleted(this.config, relativePath);
  }
}
