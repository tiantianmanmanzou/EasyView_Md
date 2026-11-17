import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeRestoredSession, terminateElectron } from './support/electronApp';

const appDir = process.cwd();

for (const [name, content] of [['empty', ''], ['text', '# 标题\n\n第一段文字。\n']] as const) {
  test(`WYSIWYG shows a 2px editor caret like the code editor (${name} file)`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'easyview-desktop-caret-'));
    const userData = join(directory, 'user-data');
    const filePath = join(directory, 'caret.md');
    await mkdir(userData);
    await writeFile(filePath, content);
    await writeFile(join(userData, 'desktop-state.json'), JSON.stringify({
      recentFiles: [filePath],
      workspace: {
        rootPath: directory, openTabs: [{ id: 'caret-tab', kind: 'editor', filePath }], activeTabId: 'caret-tab',
        expandedRelativePaths: [], explorerVisible: true, outlineVisible: false, explorerWidth: 280, outlineWidth: 280,
      },
    }));

    let application: ElectronApplication | undefined;
    try {
      application = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
      const page = await application.firstWindow();
      await resumeRestoredSession(page);
      const prose = page.locator('.ProseMirror');
      const caret = page.locator('.editor-caret');

      if (content) await prose.getByText('第一段文字。', { exact: true }).click();
      else await prose.click();
      await expect(caret).toHaveCount(1);
      await expect(prose).toHaveClass(/editor-caret-active/);
      const style = await caret.evaluate((element) => {
        const computed = getComputedStyle(element);
        return { width: computed.width, height: parseFloat(computed.height), background: computed.backgroundColor };
      });
      expect(style.width).toBe('2px');
      expect(style.height).toBeGreaterThan(10);
      expect(style.background).not.toBe('rgba(0, 0, 0, 0)');
      expect(await prose.evaluate((element) => getComputedStyle(element).caretColor)).toBe('rgba(0, 0, 0, 0)');

      const before = await caret.boundingBox();
      await page.keyboard.press('End');
      await page.keyboard.type('追加');
      await expect.poll(async () => (await caret.boundingBox())?.x).toBeGreaterThan(before!.x);
      await page.screenshot({ path: join(appDir, `../../test-results/desktop-editor-caret-${name}.png`), caret: 'initial' });

      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].webContents.send('desktop.menuCommand', 'toggleSourceMode');
      });
      await expect(caret).toHaveCount(0);
    } finally {
      await terminateElectron(application);
      await rm(directory, { recursive: true, force: true });
    }
  });
}
