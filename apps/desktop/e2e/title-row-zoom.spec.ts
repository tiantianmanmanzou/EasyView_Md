import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeRestoredSession, terminateElectron } from './support/electronApp';

const appDir = process.cwd();

test('the tab strip scales with app zoom and native window controls stay centered in it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easyview-desktop-title-zoom-'));
  const userData = join(directory, 'user-data');
  const filePath = join(directory, 'zoom.md');
  await mkdir(userData);
  await writeFile(filePath, '# 缩放\n\n正文。\n');
  await writeFile(join(userData, 'desktop-state.json'), JSON.stringify({
    recentFiles: [filePath],
    workspace: {
      rootPath: directory, openTabs: [{ id: 'zoom-tab', kind: 'editor', filePath }], activeTabId: 'zoom-tab',
      expandedRelativePaths: [], explorerVisible: true, outlineVisible: false, explorerWidth: 280, outlineWidth: 280,
    },
  }));

  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
    const page = await application.firstWindow();
    await resumeRestoredSession(page);
    await expect(page.locator('.desktop-tab.active')).toBeVisible();

    await application.evaluate(({ BrowserWindow, Menu }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const zoomIn = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
        for (const item of items) {
          if (item.accelerator === 'CmdOrCtrl+=') return item;
          const nested = item.submenu && zoomIn(item.submenu.items);
          if (nested) return nested;
        }
        return undefined;
      };
      const item = zoomIn(Menu.getApplicationMenu()!.items)!;
      item.click(undefined, window, window.webContents);
      item.click(undefined, window, window.webContents);
    });
    await expect.poll(() => page.evaluate(() => Number(document.documentElement.style.getPropertyValue('--desktop-page-zoom')))).toBeCloseTo(1.44, 2);

    const layout = await page.evaluate(() => {
      const tab = document.querySelector('.desktop-tab.active')!.getBoundingClientRect();
      const label = getComputedStyle(document.querySelector('.desktop-tab.active .desktop-tab-label')!);
      const leftControls = document.getElementById('desktop-title-left')!.getBoundingClientRect();
      const workbench = document.getElementById('desktop-workbench')!.getBoundingClientRect();
      return { tabHeight: tab.height, tabLeft: tab.left, labelFontSize: label.fontSize, leftControlsRight: leftControls.right, workbenchTop: workbench.top };
    });
    // CSS pixels are multiplied by the page zoom on screen: 32px row × 1.44 ≈ 46 screen pixels.
    expect(layout.tabHeight).toBeCloseTo(32, 1);
    expect(layout.labelFontSize).toBe('12px');
    if (Math.abs(layout.workbenchTop) < 2) expect(layout.tabLeft).toBeGreaterThanOrEqual(layout.leftControlsRight - 1);

    if (process.platform === 'darwin') {
      const position = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getWindowButtonPosition());
      expect(position).toEqual({ x: 12, y: Math.round((Math.round(32 * 1.44) - 16) / 2) });
    }
    await page.screenshot({ path: join(appDir, '../../test-results/desktop-title-row-zoom.png') });
  } finally {
    await terminateElectron(application);
    await rm(directory, { recursive: true, force: true });
  }
});
