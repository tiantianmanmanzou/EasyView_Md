import { beforeEach, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => ({
  env: { remoteName: undefined as string | undefined },
  showQuickPick: vi.fn(), showErrorMessage: vi.fn(),
  getITermSnapshot: vi.fn(), pasteIntoITermSession: vi.fn(),
}));
vi.mock('vscode', () => ({ env: mocks.env, window: mocks }));
vi.mock('./iTermBridge', () => mocks);
import { insertIntoITerm } from './insertIntoITerm';

const first = { id: 'first', name: 'Claude', windowId: 10, window: 1, tab: 1, pane: 1 };
const second = { id: 'second', name: 'Claude', windowId: 10, window: 1, tab: 2, pane: 1 };
const snapshot = (windowIds = [10], activeWindowId = 10, sessions = [first, second]) => ({
  windowIds, activeWindowId, sessions,
});
let remembered: unknown;
const state = {
  get: vi.fn(() => remembered),
  update: vi.fn(async (_key: string, value: unknown) => { remembered = value; }),
} as unknown as vscode.Memento;

beforeEach(() => {
  vi.clearAllMocks();
  remembered = undefined;
  mocks.env.remoteName = undefined;
  mocks.getITermSnapshot.mockResolvedValue(snapshot());
  mocks.pasteIntoITermSession.mockResolvedValue(undefined);
  mocks.showQuickPick.mockImplementation(async (items) => items[1]);
});

it.skipIf(process.platform !== 'darwin')('remembers the chosen session and fills it again without prompting', async () => {
  const text = '\n内容位置：sample.md  》Root  》标题\n';
  await insertIntoITerm(text, state);
  await insertIntoITerm(text, state);
  expect(mocks.showQuickPick).toHaveBeenCalledTimes(1);
  expect(mocks.pasteIntoITermSession).toHaveBeenNthCalledWith(1, 'second', text);
  expect(mocks.pasteIntoITermSession).toHaveBeenNthCalledWith(2, 'second', text);
});

it.skipIf(process.platform !== 'darwin')('prompts again when a window is added or the active window changes', async () => {
  await insertIntoITerm('first prompt', state);
  const third = { id: 'third', name: 'Claude', windowId: 20, window: 1, tab: 1, pane: 1 };
  mocks.getITermSnapshot.mockResolvedValue(snapshot([20, 10], 20, [third, first, second]));
  mocks.showQuickPick.mockImplementation(async (items) => items[0]);
  await insertIntoITerm('second prompt', state);
  await insertIntoITerm('third prompt', state);
  expect(mocks.showQuickPick).toHaveBeenCalledTimes(2);
  expect(mocks.pasteIntoITermSession).toHaveBeenLastCalledWith('third', 'third prompt');

  mocks.getITermSnapshot.mockResolvedValue(snapshot([10, 20], 10, [first, second, third]));
  await insertIntoITerm('fourth prompt', state);
  expect(mocks.showQuickPick).toHaveBeenCalledTimes(3);
});

it.skipIf(process.platform !== 'darwin')('prompts again when the remembered session closes', async () => {
  await insertIntoITerm('first prompt', state);
  mocks.getITermSnapshot.mockResolvedValue(snapshot([10], 10, [first]));
  await insertIntoITerm('second prompt', state);
  expect(mocks.showQuickPick).toHaveBeenCalledTimes(2);
});

it.skipIf(process.platform !== 'darwin')('cancelling the picker does not write or remember a terminal', async () => {
  mocks.showQuickPick.mockResolvedValue(undefined);
  await insertIntoITerm('context', state);
  expect(mocks.pasteIntoITermSession).not.toHaveBeenCalled();
  expect(state.update).not.toHaveBeenCalled();
});

it('rejects remote extension execution without accessing a terminal', async () => {
  mocks.env.remoteName = 'ssh-remote';
  await insertIntoITerm('context', state);
  expect(mocks.getITermSnapshot).not.toHaveBeenCalled();
  expect(mocks.showErrorMessage).toHaveBeenCalled();
});
