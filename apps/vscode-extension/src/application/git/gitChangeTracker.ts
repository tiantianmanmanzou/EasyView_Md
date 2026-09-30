import * as vscode from 'vscode';
import {
  findRepository,
  getFileStatus,
  getIndexFileContent,
  getIndexObjectId,
} from '@easyview/node-runtime';
import { SETTINGS_COMMENT_RE } from '@easyview/markdown-core/editor-settings';
import { computeGitDiff } from '@easyview/markdown-core/git-diff';
import { resolveMarkdownDiskUri } from '../document/openMarkdownEditor';
import { hashContent } from '@easyview/editor-sync';

export type GitChangeKind = 'modified' | 'added';

export interface GitLineRange {
  startLine: number;
  endLine: number;
  kind: GitChangeKind;
}

export type DocumentRevision = number | string;
export type GitTaskId = number | string;

export interface GitLineRangesResult {
  revision: DocumentRevision;
  taskId?: GitTaskId;
  lineRanges: GitLineRange[];
  baseContent: string;
  currentContentHash: string;
  isUntracked: boolean;
  indexObjectId: string | null;
  elapsedMs: number;
  cacheHit: boolean;
}

interface GitLineRangesCacheEntry {
  lineRanges: GitLineRange[];
  baseContent: string;
  currentContentHash: string;
  isUntracked: boolean;
  indexObjectId: string | null;
  elapsedMs: number;
}

const gitLineRangesCache = new Map<string, GitLineRangesCacheEntry>();

function normalizeContent(content: string): string {
  return content.replace(SETTINGS_COMMENT_RE, '').replace(/\r\n/g, '\n');
}

function cacheKey(
  repositoryRoot: string,
  filePath: string,
  indexObjectId: string | null,
  revision: DocumentRevision,
  contentHash: string,
): string {
  return [repositoryRoot, filePath, indexObjectId ?? 'untracked', String(revision), contentHash].join('\\0');
}

/**
 * Computes Git markers without retaining either the index or editor document body.
 * The caller owns task ordering and can discard stale results using taskId/revision.
 */
export async function computeGitLineRangesResult(
  uri: vscode.Uri,
  currentContent: string,
  revision: DocumentRevision,
  taskId?: GitTaskId,
): Promise<GitLineRangesResult> {
  const startedAt = Date.now();
  const diskUri = resolveMarkdownDiskUri(uri);
  if (diskUri.scheme !== 'file') {
    return { revision, taskId, lineRanges: [], baseContent: '', currentContentHash: hashContent(currentContent), isUntracked: false, indexObjectId: null, elapsedMs: Date.now() - startedAt, cacheHit: false };
  }

  const repository = await findRepository(diskUri.fsPath);
  if (!repository) {
    return { revision, taskId, lineRanges: [], baseContent: '', currentContentHash: hashContent(currentContent), isUntracked: false, indexObjectId: null, elapsedMs: Date.now() - startedAt, cacheHit: false };
  }

  const status = await getFileStatus(repository.rootPath, diskUri.fsPath);
  const indexObjectId = await getIndexObjectId(repository.rootPath, diskUri.fsPath);
  const normalizedCurrent = normalizeContent(currentContent);
  const currentContentHash = hashContent(normalizedCurrent);
  const key = cacheKey(repository.rootPath, status.filePath, indexObjectId, revision, currentContentHash);
  const cached = gitLineRangesCache.get(key);
  if (cached) {
    return { revision, taskId, ...cached, lineRanges: [...cached.lineRanges], cacheHit: true };
  }

  const indexContent = status.isUntracked ? null : await getIndexFileContent(repository.rootPath, diskUri.fsPath);
  const baseContent = indexContent === null ? '' : normalizeContent(indexContent);
  const lineRanges = computeGitDiff(baseContent, normalizedCurrent).lineRanges;

  const result = {
    lineRanges,
    baseContent,
    currentContentHash,
    isUntracked: status.isUntracked,
    indexObjectId,
    elapsedMs: Date.now() - startedAt,
  } satisfies GitLineRangesCacheEntry;
  gitLineRangesCache.set(key, { ...result, lineRanges: [...result.lineRanges] });
  return { revision, taskId, ...result, lineRanges: [...lineRanges], cacheHit: false };
}

export function computeGitLineRanges(
  uri: vscode.Uri,
  currentContent: string,
): Promise<GitLineRange[]>;
export function computeGitLineRanges(
  uri: vscode.Uri,
  currentContent: string,
  revision: DocumentRevision,
  taskId?: GitTaskId,
): Promise<GitLineRangesResult>;
export async function computeGitLineRanges(
  uri: vscode.Uri,
  currentContent: string,
  revision?: DocumentRevision,
  taskId?: GitTaskId,
): Promise<GitLineRange[] | GitLineRangesResult> {
  const result = await computeGitLineRangesResult(uri, currentContent, revision ?? 'legacy', taskId);
  return revision === undefined ? result.lineRanges : result;
}

export function clearGitLineRangesCache(): void {
  gitLineRangesCache.clear();
}
