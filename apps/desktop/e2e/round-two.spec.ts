import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { resumeRestoredSession, terminateElectron } from './support/electronApp';

test('lazily switches worksheets, retains edits, saves and preserves unopened sheets in the real desktop', async () => {
  const temporary = await mkdtemp(path.join(process.cwd(), '.round-two-e2e-'));
  const workspace = path.join(temporary, 'workspace'), userData = path.join(temporary, 'user-data');
  await mkdir(workspace); await mkdir(userData);
  const markdown = path.join(workspace, 'notes.md'), xlsx = path.join(workspace, 'book.xlsx');
  await writeFile(markdown, '# Notes\n\nOriginal.\n');
  const book = new ExcelJS.Workbook();
  for (const name of ['First', 'Second', 'Unopened']) { const sheet = book.addWorksheet(name); sheet.getCell('A1').value = name; }
  book.worksheets[2].getCell('B1').value = { formula: '1+2', result: 3 };
  book.worksheets[2].mergeCells('C3:D4'); book.worksheets[2].getCell('C3').font = { bold: true };
  await book.xlsx.writeFile(xlsx);
  const original = await JSZip.loadAsync(await readFile(xlsx));
  await writeFile(path.join(userData, 'desktop-state.json'), JSON.stringify({ recentFiles: [markdown], workspace: { rootPath: workspace, openTabs: [{ id: 'notes', kind: 'editor', filePath: markdown }], activeTabId: 'notes', expandedRelativePaths: [], explorerVisible: true, outlineVisible: false, explorerWidth: 280, outlineWidth: 280 } }));
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ args: [process.cwd(), `--user-data-dir=${userData}`], env: { ...process.env, EASYVIEW_DISABLE_UPDATE_CHECK: '1' } });
    const page = await application.firstWindow(); await resumeRestoredSession(page);
    const paragraph = page.locator('.ProseMirror p').last();
    await paragraph.click(); await page.keyboard.press('End'); await page.keyboard.type(' Sync change.');
    await expect(paragraph).toContainText('Sync change.');
    await page.keyboard.press('ControlOrMeta+z'); await expect(paragraph).not.toContainText('Sync change.');
    await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(paragraph).toContainText('Sync change.');
    await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => readFile(markdown, 'utf8')).toContain('Sync change.');
    await page.evaluate(async () => { await (window as any).easyViewDesktop.tabs.openWorkspaceEntry('book.xlsx'); });
    const first = page.getByRole('tab', { name: 'First', exact: true }), second = page.getByRole('tab', { name: 'Second', exact: true });
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await second.click(); await expect(second).toHaveAttribute('aria-selected', 'true');
    const overlay = page.locator('.x-spreadsheet-overlayer');
    // The toolbar chrome is attached after mount and can shift the grid; aim at A1 only once the layout is stable.
    let previous = '';
    await expect.poll(async () => { const box = JSON.stringify(await overlay.boundingBox()); const stable = box === previous; previous = box; return stable; }, { intervals: [100] }).toBe(true);
    await overlay.dblclick({ position: { x: 85, y: 40 } });
    const input = page.locator('.x-spreadsheet-editor textarea'); await expect(input).toBeVisible();
    // Select existing cell text, then paste — Windows-proven clipboard path from xlsx-toolbar.spec.ts.
    await input.press('ControlOrMeta+A');
    await application!.evaluate(({ BrowserWindow, clipboard }) => {
      clipboard.writeText('Changed second');
      BrowserWindow.getAllWindows()[0].webContents.paste();
    });
    await expect(input).toHaveValue('Changed second');
    await page.keyboard.press('Enter');
    await first.click(); await expect(first).toHaveAttribute('aria-selected', 'true');
    await second.click(); await expect(second).toHaveAttribute('aria-selected', 'true'); await expect(first).toBeEnabled();
    const expand = page.getByRole('button', { name: '展开预览工具栏' }); if (await expand.isVisible()) await expand.click();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(async () => {
      const saved = new ExcelJS.Workbook(); await saved.xlsx.readFile(xlsx);
      return saved.worksheets[1].getCell('A1').text;
    }).toBe('Changed second');
    const savedZip = await JSZip.loadAsync(await readFile(xlsx));
    expect(await savedZip.file('xl/worksheets/sheet3.xml')!.async('string')).toBe(await original.file('xl/worksheets/sheet3.xml')!.async('string'));
    expect(await savedZip.file('xl/worksheets/sheet1.xml')!.async('string')).toBe(await original.file('xl/worksheets/sheet1.xml')!.async('string'));
    await page.locator('.desktop-tab-close').last().click();
    await expect(page.locator('.preview-spreadsheet-tabs')).toHaveCount(0);
  } finally { await terminateElectron(application); await rm(temporary, { recursive: true, force: true }); }
});
