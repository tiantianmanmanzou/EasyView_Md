import type { WorkspaceEntry, WorkspaceTreeSortMode } from '@easyview/contracts';
import { WorkspaceOperationError } from '@easyview/contracts';
import {
  compareWorkspaceEntriesByName,
  normalizeWorkspaceRelativePath,
  parentWorkspaceRelativePath,
} from './workspace-path';

export const WORKSPACE_TREE_ORDER_RELATIVE_PATH = '.easyview/tree-order.json';
export const WORKSPACE_TREE_ORDER_VERSION = 1;

export interface WorkspaceTreeOrderConfig {
  version: number;
  sortMode: WorkspaceTreeSortMode;
  /** Show creation time beside tree entries. */
  showCreatedAt: boolean;
  /** Show last-modified time beside tree entries. */
  showUpdatedAt: boolean;
  /** When false, hide entries whose name starts with `.`. Default true. */
  showDotEntries: boolean;
  /** When false, hide created/updated time on row hover. Default true. */
  showTimestampHover: boolean;
  /** Parent relative path → ordered entry names within that directory. */
  orders: Record<string, string[]>;
}

export const DEFAULT_WORKSPACE_TREE_ORDER_CONFIG: WorkspaceTreeOrderConfig = {
  version: WORKSPACE_TREE_ORDER_VERSION,
  sortMode: 'name',
  showCreatedAt: false,
  showUpdatedAt: false,
  showDotEntries: true,
  showTimestampHover: true,
  orders: {},
};

const SORT_MODES = new Set<WorkspaceTreeSortMode>(['name', 'created', 'custom']);

export function parseWorkspaceTreeOrderConfig(raw: unknown): WorkspaceTreeOrderConfig {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WorkspaceOperationError('INVALID_PATH', 'Workspace tree-order config must be an object');
  }
  const value = raw as Record<string, unknown>;
  const sortMode = value.sortMode;
  if (typeof sortMode !== 'string' || !SORT_MODES.has(sortMode as WorkspaceTreeSortMode)) {
    throw new WorkspaceOperationError('INVALID_PATH', 'Workspace tree-order sortMode is invalid');
  }

  const ordersRaw = value.orders;
  const orders: Record<string, string[]> = {};
  if (ordersRaw != null) {
    if (typeof ordersRaw !== 'object' || Array.isArray(ordersRaw)) {
      throw new WorkspaceOperationError('INVALID_PATH', 'Workspace tree-order orders must be an object');
    }
    for (const [key, names] of Object.entries(ordersRaw as Record<string, unknown>)) {
      const parent = normalizeWorkspaceRelativePath(key);
      if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || !name)) {
        throw new WorkspaceOperationError('INVALID_PATH', `Workspace tree-order names are invalid for: ${key}`);
      }
      orders[parent] = [...new Set(names as string[])];
    }
  }

  return {
    version: typeof value.version === 'number' ? value.version : WORKSPACE_TREE_ORDER_VERSION,
    sortMode: sortMode as WorkspaceTreeSortMode,
    showCreatedAt: value.showCreatedAt === true || (value.showCreatedAt === undefined && value.showTimestamps === true),
    showUpdatedAt: value.showUpdatedAt === true || (value.showUpdatedAt === undefined && value.showTimestamps === true),
    // Absent key → show (legacy configs); explicit false hides.
    showDotEntries: value.showDotEntries !== false,
    showTimestampHover: value.showTimestampHover !== false,
    orders,
  };
}

export function serializeWorkspaceTreeOrderConfig(config: WorkspaceTreeOrderConfig): string {
  return `${JSON.stringify({
    version: WORKSPACE_TREE_ORDER_VERSION,
    sortMode: config.sortMode,
    showCreatedAt: config.showCreatedAt === true,
    showUpdatedAt: config.showUpdatedAt === true,
    showDotEntries: config.showDotEntries !== false,
    showTimestampHover: config.showTimestampHover !== false,
    orders: config.orders,
  }, null, 2)}\n`;
}

export function sortWorkspaceEntries(
  entries: readonly WorkspaceEntry[],
  sortMode: WorkspaceTreeSortMode,
  orderNames: readonly string[] = [],
): WorkspaceEntry[] {
  const sorted = [...entries];
  if (sortMode === 'created') {
    sorted.sort(compareWorkspaceEntriesByCreated);
    return sorted;
  }
  if (sortMode === 'custom') {
    const index = new Map(orderNames.map((name, position) => [name, position]));
    sorted.sort((left, right) => {
      const leftDirectory = left.kind === 'directory';
      const rightDirectory = right.kind === 'directory';
      if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
      const leftIndex = index.get(left.name);
      const rightIndex = index.get(right.name);
      if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex;
      if (leftIndex !== undefined) return -1;
      if (rightIndex !== undefined) return 1;
      return compareWorkspaceEntriesByName(left, right);
    });
    return sorted;
  }
  sorted.sort(compareWorkspaceEntriesByName);
  return sorted;
}

function compareWorkspaceEntriesByCreated(left: WorkspaceEntry, right: WorkspaceEntry): number {
  const leftDirectory = left.kind === 'directory';
  const rightDirectory = right.kind === 'directory';
  if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
  const leftCreated = left.createdAt;
  const rightCreated = right.createdAt;
  if (leftCreated !== undefined && rightCreated !== undefined && leftCreated !== rightCreated) {
    return leftCreated - rightCreated;
  }
  if (leftCreated !== undefined && rightCreated === undefined) return -1;
  if (leftCreated === undefined && rightCreated !== undefined) return 1;
  return compareWorkspaceEntriesByName(left, right);
}

/** Reorder a name list so `movedName` lands before `beforeName` (or at the end). */
export function reorderNames(
  currentNames: readonly string[],
  allSiblingNames: readonly string[],
  movedName: string,
  beforeName?: string,
): string[] {
  const base = mergeOrderNames(currentNames, allSiblingNames.filter((name) => name !== movedName));
  const without = base.filter((name) => name !== movedName);
  if (beforeName && without.includes(beforeName)) {
    const index = without.indexOf(beforeName);
    without.splice(index, 0, movedName);
    return without;
  }
  without.push(movedName);
  return without;
}

export function mergeOrderNames(
  configuredNames: readonly string[],
  siblingNames: readonly string[],
): string[] {
  const siblingSet = new Set(siblingNames);
  const ordered = configuredNames.filter((name) => siblingSet.has(name));
  const remaining = siblingNames
    .filter((name) => !ordered.includes(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));
  return [...ordered, ...remaining];
}

export function applyEntryRenamed(
  config: WorkspaceTreeOrderConfig,
  previousRelativePath: string,
  nextRelativePath: string,
): WorkspaceTreeOrderConfig {
  const previous = normalizeWorkspaceRelativePath(previousRelativePath);
  const next = normalizeWorkspaceRelativePath(nextRelativePath);
  if (!previous || previous === next) return config;

  const previousParent = parentWorkspaceRelativePath(previous);
  const nextParent = parentWorkspaceRelativePath(next);
  const previousName = previous.split('/').at(-1)!;
  const nextName = next.split('/').at(-1)!;

  const orders = { ...config.orders };

  if (previousParent === nextParent) {
    const names = orders[previousParent];
    if (names) {
      orders[previousParent] = names.map((name) => (name === previousName ? nextName : name));
    }
  } else {
    const sourceNames = orders[previousParent];
    if (sourceNames) {
      const filtered = sourceNames.filter((name) => name !== previousName);
      if (filtered.length === 0) delete orders[previousParent];
      else orders[previousParent] = filtered;
    }
    const targetNames = orders[nextParent] ? [...orders[nextParent]] : [];
    if (!targetNames.includes(nextName)) targetNames.push(nextName);
    orders[nextParent] = targetNames;
  }

  remapDescendantOrderKeys(orders, previous, next);
  return { ...config, orders };
}

export function applyEntryDeleted(
  config: WorkspaceTreeOrderConfig,
  relativePath: string,
): WorkspaceTreeOrderConfig {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  if (!normalized) return config;
  const parent = parentWorkspaceRelativePath(normalized);
  const name = normalized.split('/').at(-1)!;
  const orders = { ...config.orders };
  const names = orders[parent];
  if (names) {
    const filtered = names.filter((entry) => entry !== name);
    if (filtered.length === 0) delete orders[parent];
    else orders[parent] = filtered;
  }
  for (const key of Object.keys(orders)) {
    if (key === normalized || key.startsWith(`${normalized}/`)) delete orders[key];
  }
  return { ...config, orders };
}

export function applyEntryCreated(
  config: WorkspaceTreeOrderConfig,
  relativePath: string,
): WorkspaceTreeOrderConfig {
  if (config.sortMode !== 'custom') return config;
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  if (!normalized) return config;
  const parent = parentWorkspaceRelativePath(normalized);
  const name = normalized.split('/').at(-1)!;
  const orders = { ...config.orders };
  const names = orders[parent] ? [...orders[parent]] : [];
  if (!names.includes(name)) names.push(name);
  orders[parent] = names;
  return { ...config, orders };
}

function remapDescendantOrderKeys(
  orders: Record<string, string[]>,
  previousPrefix: string,
  nextPrefix: string,
): void {
  for (const key of Object.keys(orders)) {
    if (key === previousPrefix || key.startsWith(`${previousPrefix}/`)) {
      const suffix = key.slice(previousPrefix.length);
      const nextKey = `${nextPrefix}${suffix}`;
      orders[nextKey] = orders[key];
      delete orders[key];
    }
  }
}
