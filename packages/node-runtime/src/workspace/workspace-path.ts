import type { WorkspaceEntry } from '@easyview/contracts';
import { WorkspaceOperationError } from '@easyview/contracts';

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:\//;

export function normalizeWorkspaceRelativePath(value: string): string {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new WorkspaceOperationError('INVALID_PATH', 'Workspace path is invalid');
  }

  const slashPath = value.replace(/\\/g, '/');
  if (slashPath.startsWith('/') || slashPath.startsWith('//') || WINDOWS_ABSOLUTE_PATH.test(slashPath)) {
    throw new WorkspaceOperationError('INVALID_PATH', 'Workspace path must be relative');
  }

  const normalized: string[] = [];
  for (const segment of slashPath.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      throw new WorkspaceOperationError('ROOT_ESCAPE', 'Workspace path cannot escape the root');
    }
    normalized.push(segment);
  }
  return normalized.join('/');
}

export function validateWorkspaceEntryName(name: string): void {
  if (
    typeof name !== 'string'
    || name.includes('\0')
    || !name.trim()
    || name === '.'
    || name === '..'
    || /[\\/]/.test(name)
  ) {
    throw new WorkspaceOperationError(
      'INVALID_NAME',
      'Workspace entry name must be non-empty and cannot contain path separators',
    );
  }
}

export function joinWorkspaceRelativePath(parentRelativePath: string, name: string): string {
  const parent = normalizeWorkspaceRelativePath(parentRelativePath);
  validateWorkspaceEntryName(name);
  return parent ? `${parent}/${name}` : name;
}

export function parentWorkspaceRelativePath(relativePath: string): string {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  const separator = normalized.lastIndexOf('/');
  return separator < 0 ? '' : normalized.slice(0, separator);
}

/** Returns root first and the direct parent last. */
export function getWorkspaceAncestorPaths(relativePath: string): string[] {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  if (!normalized) return [];
  const segments = normalized.split('/');
  const ancestors = [''];
  let current = '';
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = current ? `${current}/${segments[index]}` : segments[index];
    ancestors.push(current);
  }
  return ancestors;
}

export function compareWorkspaceEntries(left: WorkspaceEntry, right: WorkspaceEntry): number {
  return compareWorkspaceEntriesByName(left, right);
}

export function compareWorkspaceEntriesByName(left: WorkspaceEntry, right: WorkspaceEntry): number {
  const leftDirectory = left.kind === 'directory';
  const rightDirectory = right.kind === 'directory';
  if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
}
