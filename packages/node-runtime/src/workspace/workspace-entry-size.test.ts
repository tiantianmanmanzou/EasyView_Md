import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalWorkspaceGateway } from './local-workspace-gateway';
import { workspaceEntrySize } from './workspace-entry-size';
import { WorkspaceTreeOrderState } from './workspace-tree-order-state';

it('counts files recursively including hidden files without following links', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'easyview-size-'));
  try {
    await mkdir(path.join(root, 'folder', 'nested'), { recursive: true });
    await writeFile(path.join(root, 'folder', 'a'), '12345');
    await writeFile(path.join(root, 'folder', 'nested', '.hidden'), 'abc');
    await symlink(root, path.join(root, 'folder', 'loop'));
    const gateway = new LocalWorkspaceGateway([{ id: 'root', rootPath: root }]);
    await expect(workspaceEntrySize(gateway, 'root', 'folder/a')).resolves.toBe(5);
    await expect(workspaceEntrySize(gateway, 'root', 'folder')).resolves.toBe(8);
    await expect(workspaceEntrySize(gateway, 'root', 'missing')).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('persists independent display and hover settings', () => {
  const state = new WorkspaceTreeOrderState();
  expect(state.getShowSize()).toBe(false);
  expect(state.getShowSizeHover()).toBe(false);
  state.setShowSize(true);
  state.setShowSizeHover(true);
  const restored = new WorkspaceTreeOrderState();
  restored.loadFromJson(state.toJson());
  expect(restored.getShowSize()).toBe(true);
  expect(restored.getShowSizeHover()).toBe(true);
});
