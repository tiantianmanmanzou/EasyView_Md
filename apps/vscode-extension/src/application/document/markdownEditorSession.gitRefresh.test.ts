import { afterEach, expect, it, vi } from 'vitest';
import { hashContent } from '@easyview/editor-sync';

vi.mock('vscode', () => ({}));
vi.mock('../git/gitChangeTracker', () => ({ computeGitLineRanges: vi.fn() }));

import { MarkdownEditorSession } from './markdownEditorSession';
import { computeGitLineRanges } from '../git/gitChangeTracker';

const methods = MarkdownEditorSession.prototype as unknown as {
  scheduleGit(delayMs?: number): Promise<void>;
  refreshGit(taskId: number): Promise<void>;
  onMessage(message: unknown): Promise<void>;
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('starts the first Git read immediately after a matching snapshot acknowledgement', async () => {
  const content = '# Note';
  const session = {
    documentId: 'doc',
    adapter: { content },
    sync: { snapshot: { revision: 3 } },
    initialGitReady: false,
    scheduleGit: vi.fn().mockResolvedValue(undefined),
    post: vi.fn(),
  };
  await methods.onMessage.call(session as never, {
    type: 'snapshotApplied', documentId: 'doc', revision: 3, contentHash: hashContent(content),
  });
  expect(session.scheduleGit).toHaveBeenCalledExactlyOnceWith(0);
  expect(session.initialGitReady).toBe(true);
});

it('reads immediately on demand but debounces later edits', async () => {
  vi.useFakeTimers();
  const session = {
    initialGitReady: false,
    visible: true,
    disposed: false,
    gitTask: 0,
    gitTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    gitTimerResolve: undefined as (() => void) | undefined,
    documentId: 'doc',
    sync: { snapshot: { revision: 3 } },
    post: vi.fn(),
    refreshGit: vi.fn().mockResolvedValue(undefined),
  };
  await methods.scheduleGit.call(session as never, 0);
  expect(session.refreshGit).not.toHaveBeenCalled();
  session.initialGitReady = true;
  await methods.scheduleGit.call(session as never, 0);
  expect(session.refreshGit).toHaveBeenCalledExactlyOnceWith(1);
  const firstPending = methods.scheduleGit.call(session as never);
  vi.advanceTimersByTime(200);
  const pending = methods.scheduleGit.call(session as never);
  vi.advanceTimersByTime(499);
  expect(session.refreshGit).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  await Promise.all([firstPending, pending]);
  expect(session.refreshGit).toHaveBeenLastCalledWith(3);
  expect(session.post).toHaveBeenCalledWith({
    type: 'gitRefreshStatus', documentId: 'doc', revision: 3, status: 'loading',
  });
});

it('reports a Git read failure instead of publishing an empty successful diff', async () => {
  vi.mocked(computeGitLineRanges).mockRejectedValueOnce(new Error('index unavailable'));
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const session = {
    visible: true,
    disposed: false,
    gitTask: 4,
    documentId: 'doc',
    sync: { snapshot: { revision: 3 } },
    diskUri: { scheme: 'file', fsPath: '/repo/note.md' },
    document: { getText: () => '# Note' },
    post: vi.fn(),
    gitInFlight: false,
    lastGitMs: 0,
  };
  await methods.refreshGit.call(session as never, 4);
  expect(session.post).toHaveBeenCalledExactlyOnceWith({
    type: 'gitRefreshStatus', documentId: 'doc', revision: 3, status: 'error',
  });
  expect(session.gitInFlight).toBe(false);
  warning.mockRestore();
});

it('publishes a successful empty diff as the ready state', async () => {
  vi.mocked(computeGitLineRanges).mockResolvedValueOnce({
    revision: 3, taskId: '4', lineRanges: [], baseContent: '# Note',
    currentContentHash: hashContent('# Note'), isUntracked: false,
    indexObjectId: 'index-1', elapsedMs: 2, cacheHit: false,
  });
  const session = {
    visible: true,
    disposed: false,
    gitTask: 4,
    documentId: 'doc',
    sync: { snapshot: { revision: 3 } },
    diskUri: { scheme: 'file', fsPath: '/repo/note.md' },
    document: { getText: () => '# Note' },
    post: vi.fn(),
    gitInFlight: false,
    lastGitMs: 0,
  };
  await methods.refreshGit.call(session as never, 4);
  expect(session.post).toHaveBeenCalledExactlyOnceWith({
    type: 'gitStatusChanged', documentId: 'doc', revision: 3, lineRanges: [],
    snapshot: {
      indexObjectId: 'index-1', baseContent: '# Note',
      currentContentHash: hashContent('# Note'), isUntracked: false,
    },
  });
});
