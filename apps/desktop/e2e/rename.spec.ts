import { _electron as electron, expect, test } from '@playwright/test';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EasyViewDesktopApi } from '../src/preload/desktopApi';

test('renames the original document through document and workspace commands while saves follow the new path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easyview-desktop-rename-'));
  const workspace = join(directory, 'workspace');
  const userData = join(directory, 'user-data');
  await mkdir(join(workspace, 'docs'), { recursive: true });
  await mkdir(userData);
  const originalPath = join(workspace, 'docs', 'original.md');
  await writeFile(originalPath, '# Notes\n\nOriginal.\n');
  const originalInode = (await stat(originalPath)).ino;
  await writeFile(join(userData, 'desktop-state.json'), JSON.stringify({
    recentFiles: [originalPath],
    workspace: {
      rootPath: workspace,
      openTabs: [{ id: 'notes-tab', kind: 'editor', filePath: originalPath }],
      activeTabId: 'notes-tab', expandedRelativePaths: ['docs'],
      explorerVisible: true, outlineVisible: true, explorerWidth: 280, outlineWidth: 280,
    },
  }));
  const executablePath = process.env.EASYVIEW_DESKTOP_TEST_EXECUTABLE;
  const application = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : [process.cwd()]), `--user-data-dir=${userData}`],
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on('dialog', (dialog) => { errors.push(dialog.message()); void dialog.dismiss(); });
    await expect(page.locator('.ProseMirror')).toContainText('Original.');
    await page.locator('.ProseMirror p').last().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Unsaved content.');
    await expect(page.locator('.desktop-tab-dirty')).toHaveCount(1);

    const documentRename = await page.evaluate(async () => {
      const api = (window as typeof window & { easyViewDesktop: EasyViewDesktopApi }).easyViewDesktop;
      const state = await api.tabs.getState();
      if (!state.ok) throw new Error(state.message);
      return api.document.rename('title-renamed.md', state.value.activeTabId!);
    });
    expect(documentRename.ok).toBe(true);
    await expect(page.locator('.desktop-tab-label')).toHaveText('title-renamed.md');
    const titlePath = join(workspace, 'docs', 'title-renamed.md');
    expect((await stat(titlePath)).ino).toBe(originalInode);
    await expect(page.locator('.ProseMirror')).toContainText('Unsaved content.');
    await expect(page.locator('.desktop-tab-dirty')).toHaveCount(1);
    await expect.poll(() => readdir(join(workspace, 'docs'))).toEqual(['title-renamed.md']);

    await page.locator('[data-relative-path="docs/title-renamed.md"] .workspace-entry-name').click();
    await page.keyboard.press('F2');
    const renameInput = page.locator('.workspace-rename-input');
    await renameInput.fill('键盘提交.md');
    await renameInput.evaluate((input) => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      (input as HTMLInputElement).blur();
    });
    await expect(page.locator('.desktop-tab-label')).toHaveText('键盘提交.md');
    await expect.poll(() => readdir(join(workspace, 'docs'))).toEqual(['键盘提交.md']);

    const results = await page.evaluate(async () => {
      const api = (window as typeof window & { easyViewDesktop: EasyViewDesktopApi }).easyViewDesktop;
      const state = await api.tabs.getState();
      if (!state.ok) throw new Error(state.message);
      const id = state.value.activeTabId!;
      const content = '# Notes\n\nOriginal. Unsaved content.\n';
      const saving = api.document.save(content, id);
      const renaming = api.workspace.rename({ relativePath: 'docs/键盘提交.md', newName: 'tree-renamed.md' });
      const nextSave = api.document.save(content, id);
      return Promise.all([saving, renaming, nextSave]);
    });
    expect(results.every((result) => result.ok)).toBe(true);
    await expect(page.locator('.desktop-tab-label')).toHaveText('tree-renamed.md');
    await expect.poll(() => readdir(join(workspace, 'docs'))).toEqual(['tree-renamed.md']);
    expect(await readFile(join(workspace, 'docs', 'tree-renamed.md'), 'utf8')).toContain('Unsaved content.');

    const folderResult = await page.evaluate(async () => {
      const api = (window as typeof window & { easyViewDesktop: EasyViewDesktopApi }).easyViewDesktop;
      const renamed = await api.workspace.rename({ relativePath: 'docs', newName: 'renamed-folder' });
      const state = await api.tabs.getState();
      if (!state.ok) throw new Error(state.message);
      const saved = await api.document.save('# Notes\n\nSaved after folder rename.\n', state.value.activeTabId!);
      return { renamed, saved, state };
    });
    expect(folderResult.renamed.ok).toBe(true);
    expect(folderResult.saved.ok).toBe(true);
    if (folderResult.state.ok) expect(folderResult.state.value.tabs[0]).toMatchObject({ filePath: await realpath(join(workspace, 'renamed-folder', 'tree-renamed.md')) });
    await expect.poll(async () => (await readdir(workspace)).filter((name) => !name.startsWith('.'))).toEqual(['renamed-folder']);
    expect(await readFile(join(workspace, 'renamed-folder', 'tree-renamed.md'), 'utf8')).toContain('Saved after folder rename.');
    expect(errors).toEqual([]);
  } finally {
    const process = application.process();
    if (process.exitCode === null) {
      const exited = once(process, 'exit');
      process.kill('SIGKILL');
      await exited;
    }
    await application.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => undefined);
  }
});
