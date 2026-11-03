/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceExplorerView } from './WorkspaceExplorerView';
import { WorkspaceExplorer } from '../../../../desktop/src/renderer/workspace/WorkspaceExplorer';
import type { WorkspaceExplorerEntry } from './workspace-explorer-messages';

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it.each(['extension', 'desktop'] as const)('%s opens a created file after name confirm', async (host) => {
  const created: WorkspaceExplorerEntry = {
    id: 'sheet', rootId: 'workspace', name: 'Untitled 3.xlsx',
    relativePath: 'Untitled 3.xlsx', kind: 'file', writable: true,
  };
  const request = vi.fn(async () => (
    host === 'extension' ? { ok: true, entry: created } : { ok: true, value: created }
  ));
  const onOpenFile = vi.fn(async () => true);
  const post = vi.fn();
  const prototype = (host === 'extension' ? WorkspaceExplorerView.prototype : WorkspaceExplorer.prototype) as unknown as {
    createEntry(pending: { parentRelativePath: string; kind: 'file' | 'directory'; extension?: string }, name: string): Promise<void>;
  };
  const owner = {
    createEntry: prototype.createEntry,
    pendingCreate: null,
    setEditing: vi.fn(),
    requestOp: request,
    options: { api: { workspace: { create: request } }, onOpenFile },
    primarySelected: null as string | null,
    selected: new Set<string>(),
    selectedRelativePaths: new Set<string>(),
    selectedRelativePath: null as string | null,
    selectionAnchorRelativePath: null as string | null,
    anchor: null as string | null,
    loadDirectory: vi.fn(async () => undefined),
    post,
    render: vi.fn(),
    showError: vi.fn(),
    select: vi.fn(),
    selectionFollowsActive: false,
    setActiveRelativePath: vi.fn(),
  };
  await prototype.createEntry.call(owner as never, { parentRelativePath: '', kind: 'file', extension: '.xlsx' }, created.name);
  expect(owner.loadDirectory).toHaveBeenCalledWith('');
  if (host === 'extension') {
    expect(post).toHaveBeenCalledWith({ type: 'open', relativePath: created.relativePath });
  } else {
    expect(onOpenFile).toHaveBeenCalledWith(created.relativePath);
    expect(owner.setActiveRelativePath).toHaveBeenCalledWith(created.relativePath);
  }
});

it.each(['extension', 'desktop'] as const)('%s confirms the create name once on blur, also after Enter', async (host) => {
  vi.stubGlobal('requestAnimationFrame', vi.fn());
  const pending = { parentRelativePath: '', kind: 'file' as const, extension: '.docx' };
  const prototype = (host === 'extension' ? WorkspaceExplorerView.prototype : WorkspaceExplorer.prototype) as unknown as {
    renderCreateInput(depth: number): HTMLFormElement;
  };
  const owner = {
    pendingCreate: pending,
    setEditing: vi.fn(),
    render: vi.fn(),
    defaultCreateName: () => 'Untitled 4.docx',
    createEntry: vi.fn(() => new Promise<void>(() => undefined)),
  };
  const form = prototype.renderCreateInput.call(owner as never, 0);
  document.body.append(form);
  const input = form.querySelector('input')!;
  input.value = '方案.docx';
  input.dispatchEvent(new FocusEvent('blur'));
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  input.dispatchEvent(new FocusEvent('blur'));
  expect(owner.createEntry).toHaveBeenCalledTimes(1);
  expect(owner.createEntry).toHaveBeenCalledWith(pending, '方案.docx');
});

it.each(['extension', 'desktop'] as const)('%s keeps editing the create name when a re-render replaces the input', async (host) => {
  vi.stubGlobal('requestAnimationFrame', vi.fn());
  const pending: { parentRelativePath: string; kind: 'file'; extension: string; draftName?: string } = { parentRelativePath: 'docs', kind: 'file', extension: '.md' };
  const prototype = (host === 'extension' ? WorkspaceExplorerView.prototype : WorkspaceExplorer.prototype) as unknown as {
    renderCreateInput(depth: number): HTMLFormElement;
  };
  const owner = {
    pendingCreate: pending,
    setEditing: vi.fn(),
    render: vi.fn(),
    defaultCreateName: () => 'Untitled.md',
    createEntry: vi.fn(async () => undefined),
  };
  const form = prototype.renderCreateInput.call(owner as never, 1);
  document.body.append(form);
  const input = form.querySelector('input')!;
  input.value = '方案';
  input.dispatchEvent(new Event('input'));
  form.remove();
  input.dispatchEvent(new FocusEvent('blur'));
  await Promise.resolve();
  expect(owner.createEntry).not.toHaveBeenCalled();
  const next = prototype.renderCreateInput.call(owner as never, 1);
  expect(next.querySelector('input')!.value).toBe('方案');
});

it.each(['extension', 'desktop'] as const)('%s does not open a created directory', async (host) => {
  const created: WorkspaceExplorerEntry = {
    id: 'folder', rootId: 'workspace', name: 'New Folder',
    relativePath: 'New Folder', kind: 'directory', writable: true,
  };
  const request = vi.fn(async () => (
    host === 'extension' ? { ok: true, entry: created } : { ok: true, value: created }
  ));
  const onOpenFile = vi.fn(async () => true);
  const post = vi.fn();
  const prototype = (host === 'extension' ? WorkspaceExplorerView.prototype : WorkspaceExplorer.prototype) as unknown as {
    createEntry(pending: { parentRelativePath: string; kind: 'file' | 'directory' }, name: string): Promise<void>;
  };
  const owner = {
    createEntry: prototype.createEntry,
    pendingCreate: null,
    setEditing: vi.fn(),
    requestOp: request,
    options: { api: { workspace: { create: request } }, onOpenFile },
    primarySelected: null as string | null,
    selected: new Set<string>(),
    selectedRelativePaths: new Set<string>(),
    selectedRelativePath: null as string | null,
    selectionAnchorRelativePath: null as string | null,
    anchor: null as string | null,
    loadDirectory: vi.fn(async () => undefined),
    post,
    render: vi.fn(),
    showError: vi.fn(),
    select: vi.fn(),
    selectionFollowsActive: false,
    setActiveRelativePath: vi.fn(),
  };
  await prototype.createEntry.call(owner as never, { parentRelativePath: '', kind: 'directory' }, created.name);
  expect(onOpenFile).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'open' }));
});
