import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeRestoredSession, terminateElectron } from './support/electronApp';

const appDir = process.cwd();

test('context menu actions use the workspace of the window that opened the menu', async () => {
  const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'easyview-desktop-multi-window-menu-')));
  const parent = join(temporaryDirectory, 'parent');
  const child = join(parent, 'child');
  const userData = join(temporaryDirectory, 'user-data');
  const notes = join(parent, 'notes.md');
  await mkdir(join(child, 'Tests'), { recursive: true });
  await mkdir(userData, { recursive: true });
  await writeFile(notes, '# Notes\n', 'utf8');
  await writeFile(join(userData, 'desktop-state.json'), JSON.stringify({
    recentFiles: [notes],
    workspace: {
      rootPath: parent,
      openTabs: [{ id: 'notes-tab', kind: 'editor', filePath: notes }],
      activeTabId: 'notes-tab',
      expandedRelativePaths: [], explorerVisible: true, outlineVisible: false, explorerWidth: 260, outlineWidth: 280,
    },
  }), 'utf8');
  await writeFile(join(userData, 'recent-folders.json'), JSON.stringify([parent, child]), 'utf8');

  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
    const page = await application.firstWindow();
    await resumeRestoredSession(page);

    const newWindow = application.waitForEvent('window');
    await page.evaluate(() => (window as unknown as { easyViewDesktop: { app: { newWindow(): Promise<unknown> } } }).easyViewDesktop.app.newWindow());
    const second = await newWindow;
    await second.evaluate((folder) => (window as unknown as { easyViewDesktop: { workspace: { openRecentFolder(path: string): Promise<unknown> } } }).easyViewDesktop.workspace.openRecentFolder(folder), child);
    const testsEntry = second.locator('.workspace-entry[data-relative-path="Tests"]');
    await expect(testsEntry).toBeVisible();

    await application.evaluate(({ BrowserWindow, Menu }) => {
      BrowserWindow.getAllWindows().find((window) => window.getTitle().endsWith('— parent'))!.focus();
      Menu.prototype.popup = function capture(this: Electron.Menu) { (globalThis as { lastMenu?: Electron.Menu }).lastMenu = this; };
    });
    await page.bringToFront();

    await testsEntry.click({ button: 'right' });
    await expect.poll(() => application!.evaluate(() => Boolean((globalThis as { lastMenu?: Electron.Menu }).lastMenu))).toBe(true);
    await application.evaluate(({ clipboard }) => {
      clipboard.writeText('');
      const state = globalThis as { lastMenu?: Electron.Menu };
      const item = state.lastMenu!.items.find((candidate) => candidate.label === '复制路径');
      state.lastMenu = undefined;
      item!.click();
    });
    await expect.poll(() => application!.evaluate(({ clipboard }) => clipboard.readText())).toBe(join(child, 'Tests'));
  } finally {
    await terminateElectron(application);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
