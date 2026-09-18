import * as vscode from 'vscode';
import { findRepository, getFileStatus, getIndexFileContent } from '@easyview/node-runtime';
import { SETTINGS_COMMENT_RE } from '@easyview/markdown-core/editor-settings';

export type GitChangeKind = 'modified' | 'added';

export interface GitLineRange {
  startLine: number;
  endLine: number;
  kind: GitChangeKind;
}

function normalizeContent(content: string): string {
  return content.replace(SETTINGS_COMMENT_RE, '').replace(/\r\n/g, '\n');
}

function countLines(content: string): number {
  if (!content) return 1;
  return content.split('\n').length;
}

function allLines(content: string, kind: GitChangeKind): GitLineRange[] {
  return [{ startLine: 1, endLine: Math.max(1, countLines(content)), kind }];
}

function groupLineNumbers(lines: Array<{ line: number; kind: GitChangeKind }>): GitLineRange[] {
  const sorted = [...lines].sort((a, b) => a.line - b.line);
  const ranges: GitLineRange[] = [];

  for (const item of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && item.line <= last.endLine + 1 && item.kind === last.kind) {
      last.endLine = Math.max(last.endLine, item.line);
    } else {
      ranges.push({ startLine: item.line, endLine: item.line, kind: item.kind });
    }
  }

  return ranges;
}

function computeChangedLineRanges(baseContent: string, currentContent: string): GitLineRange[] {
  const baseLines = baseContent.split('\n');
  const currentLines = currentContent.split('\n');

  if (baseContent === currentContent) return [];

  const n = baseLines.length;
  const m = currentLines.length;

  // Keep pathological large files cheap; a broad marker is better than blocking the extension host.
  if (n * m > 4_000_000) {
    let prefix = 0;
    while (prefix < n && prefix < m && baseLines[prefix] === currentLines[prefix]) prefix++;

    let suffix = 0;
    while (
      suffix < n - prefix &&
      suffix < m - prefix &&
      baseLines[n - 1 - suffix] === currentLines[m - 1 - suffix]
    ) {
      suffix++;
    }

    const startLine = Math.max(1, prefix + 1);
    const endLine = Math.max(startLine, m - suffix);
    return [{ startLine, endLine, kind: 'modified' }];
  }

  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (baseLines[i - 1] === currentLines[j - 1]) {
        dp[i * width + j] = dp[(i - 1) * width + j - 1] + 1;
      } else {
        dp[i * width + j] = Math.max(dp[(i - 1) * width + j], dp[i * width + j - 1]);
      }
    }
  }

  const changed: Array<{ line: number; kind: GitChangeKind }> = [];
  let i = n;
  let j = m;
  let pendingDeletion = false;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && baseLines[i - 1] === currentLines[j - 1]) {
      if (pendingDeletion) {
        changed.push({ line: Math.max(1, Math.min(m, j + 1)), kind: 'modified' });
        pendingDeletion = false;
      }
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i * width + j - 1] > dp[(i - 1) * width + j])) {
      changed.push({ line: j, kind: pendingDeletion ? 'modified' : 'added' });
      pendingDeletion = false;
      j--;
    } else {
      pendingDeletion = true;
      i--;
    }
  }

  if (pendingDeletion) {
    changed.push({ line: 1, kind: 'modified' });
  }

  return groupLineNumbers(changed);
}

export async function computeGitLineRanges(
  uri: vscode.Uri,
  currentContent: string
): Promise<GitLineRange[]> {
  if (uri.scheme !== 'file') return [];

  try {
    const repository = await findRepository(uri.fsPath);
    if (!repository) return [];

    const status = await getFileStatus(repository.rootPath, uri.fsPath);
    if (!status.isModified) return [];

    const normalizedCurrent = normalizeContent(currentContent);
    if (status.isUntracked) return allLines(normalizedCurrent, 'added');

    const indexContent = await getIndexFileContent(repository.rootPath, uri.fsPath);
    if (indexContent === null) return allLines(normalizedCurrent, 'added');
    return computeChangedLineRanges(normalizeContent(indexContent), normalizedCurrent);
  } catch {
    return [];
  }
}
