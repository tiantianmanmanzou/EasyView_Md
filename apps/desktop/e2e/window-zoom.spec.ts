import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeRestoredSession, terminateElectron } from './support/electronApp';

const appDir = process.cwd();

test('each window restores and changes its own zoom without affecting other windows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easyview-desktop-window-zoom-'));
  const userData = join(directory, 'user-data');
  const filePath = join(directory, 'zoom.md');
  await mkdir(userData);
  await writeFile(filePath, '# 缩放\n');
  await writeFile(join(userData, 'desktop-state.json'), JSON.stringify({
    recentFiles: [filePath],
    zoomLevel: 2,
    workspace: {
      rootPath: directory, openTabs: [{ id: 'zoom-tab', kind: 'editor', filePath }], activeTabId: 'zoom-tab',
      expandedRelativePaths: [], explorerVisible: true, outlineVisible: false, explorerWidth: 280, outlineWidth: 280,
    },
  }));

  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
    const first = await application.firstWindow();
    await resumeRestoredSession(first);
    const pageZoom = (page: typeof first) => page.evaluate(() => Number(document.documentElement.style.getPropertyValue('--desktop-page-zoom')));
    await expect.poll(() => pageZoom(first)).toBeCloseTo(1.44, 2);

    const opened = application.waitForEvent('window');
    await first.evaluate(() => (window as unknown as { easyViewDesktop: { app: { newWindow(): Promise<unknown> } } }).easyViewDesktop.app.newWindow());
    const second = await opened;
    await second.waitForLoadState('domcontentloaded');
    await expect.poll(() => pageZoom(second)).toBe(1);
    await expect.poll(() => pageZoom(first)).toBeCloseTo(1.44, 2);

    const zoomLevels = () => application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .sort((a, b) => a.webContents.id - b.webContents.id)
      .map((window) => window.webContents.getZoomLevel()));
    await application.evaluate(({ BrowserWindow, Menu }) => {
      const target = BrowserWindow.getAllWindows().sort((a, b) => a.webContents.id - b.webContents.id)[1];
      const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
        for (const item of items) {
          if (item.accelerator === 'CmdOrCtrl+-') return item;
          const nested = item.submenu && find(item.submenu.items);
          if (nested) return nested;
        }
        return undefined;
      };
      find(Menu.getApplicationMenu()!.items)!.click(undefined, target, target.webContents);
    });
    await expect.poll(zoomLevels).toEqual([2, -1]);
    await expect.poll(() => pageZoom(second)).toBeCloseTo(1 / 1.2, 2);
    expect(await pageZoom(first)).toBeCloseTo(1.44, 2);
  } finally {
    await terminateElectron(application);
    await rm(directory, { recursive: true, force: true });
  }
});
