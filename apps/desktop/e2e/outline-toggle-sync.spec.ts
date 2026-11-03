import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeRestoredSession, terminateElectron } from './support/electronApp';

const appDir = process.cwd();

test('every outline toggle keeps the saved outline state, so other tabs follow it', async () => {
  const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'easyview-outline-sync-')));
  const workspace = join(temporaryDirectory, 'workspace');
  const userData = join(temporaryDirectory, 'user-data');
  const first = join(workspace, 'first.md');
  const second = join(workspace, 'second.md');
  const body = (title: string) => ['# ' + title, '## 背景', '正文。', '## 方案', '正文。'].join('\n\n');
  await mkdir(workspace, { recursive: true });
  await mkdir(userData, { recursive: true });
  await writeFile(first, body('第一篇'), 'utf8');
  await writeFile(second, body('第二篇'), 'utf8');
  await writeFile(join(userData, 'desktop-state.json'), JSON.stringify({
    recentFiles: [first, second],
    workspace: {
      rootPath: workspace,
      openTabs: [{ id: 'first-tab', kind: 'editor', filePath: first }, { id: 'second-tab', kind: 'editor', filePath: second }],
      activeTabId: 'first-tab',
      expandedRelativePaths: [], explorerVisible: true, outlineVisible: true, explorerWidth: 260, outlineWidth: 280,
    },
  }), 'utf8');

  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
    const page = await application.firstWindow();
    await resumeRestoredSession(page);
    const openOutline = page.locator('.toc-sidebar:not(.hidden):visible');
    const outlineButton = page.locator('.file-header-btn:visible').filter({ has: page.locator('svg line[x1="3"][y1="6"][x2="15"]') });
    const savedOutlineVisible = async () => JSON.parse(await readFile(join(userData, 'desktop-state.json'), 'utf8')).workspace.outlineVisible;
    const activate = (name: string) => page.locator('.desktop-tab', { hasText: name }).click();

    await expect(openOutline).toHaveCount(1);
    await outlineButton.click();
    await expect(openOutline).toHaveCount(0);
    await expect.poll(savedOutlineVisible).toBe(false);
    await activate('second.md');
    await expect(openOutline).toHaveCount(0);

    await outlineButton.click();
    await expect(openOutline).toHaveCount(1);
    await expect.poll(savedOutlineVisible).toBe(true);
    await activate('first.md');
    await expect(openOutline).toHaveCount(1);

    await page.locator('.toc-sidebar-unpin:visible').click();
    await expect(openOutline).toHaveCount(0);
    await expect(outlineButton).not.toHaveClass(/active/);
    await expect.poll(savedOutlineVisible).toBe(false);
  } finally {
    await terminateElectron(application);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
