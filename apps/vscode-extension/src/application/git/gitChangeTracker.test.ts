import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: {
    file: (fsPath: string) => ({ scheme: 'file', fsPath }),
  },
}));

vi.mock('../document/openMarkdownEditor', () => ({
  resolveMarkdownDiskUri: (uri: { scheme: string; fsPath: string }) => uri,
}));

const gitRuntime = vi.hoisted(() => ({
  findRepository: vi.fn(),
  getFileStatus: vi.fn(),
  getIndexFileContent: vi.fn(),
  getIndexObjectId: vi.fn(),
}));

vi.mock('@easyview/node-runtime', () => gitRuntime);

import {
  clearGitLineRangesCache,
  computeGitLineRanges,
} from './gitChangeTracker';

describe('git change tracker', () => {
  beforeEach(() => {
    clearGitLineRangesCache();
    vi.clearAllMocks();
    gitRuntime.findRepository.mockResolvedValue({ rootPath: '/repo' });
    gitRuntime.getFileStatus.mockResolvedValue({
      filePath: '/repo/note.md',
      isModified: true,
      isUntracked: false,
    });
    gitRuntime.getIndexObjectId.mockResolvedValue('index-1');
    gitRuntime.getIndexFileContent.mockResolvedValue('# initial\n');
  });

  it('returns structured revision results and hits the same revision/index cache', async () => {
    const uri = { scheme: 'file', fsPath: '/repo/note.md' } as never;

    const first = await computeGitLineRanges(uri, '# changed\n', 7, 'task-1');
    const second = await computeGitLineRanges(uri, '# changed\n', 7, 'task-2');

    expect(first).toMatchObject({
      revision: 7,
      taskId: 'task-1',
      indexObjectId: 'index-1',
      isUntracked: false,
      cacheHit: false,
      lineRanges: [{ startLine: 1, endLine: 1, kind: 'modified' }],
    });
    expect(second).toMatchObject({
      revision: 7,
      taskId: 'task-2',
      indexObjectId: 'index-1',
      cacheHit: true,
    });
    expect(gitRuntime.getIndexFileContent).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a cached result across document revisions', async () => {
    const uri = { scheme: 'file', fsPath: '/repo/note.md' } as never;

    await computeGitLineRanges(uri, '# changed\n', 7);
    await computeGitLineRanges(uri, '# changed again\n', 8);

    expect(gitRuntime.getIndexFileContent).toHaveBeenCalledTimes(2);
  });
});
