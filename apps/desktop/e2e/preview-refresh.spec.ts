import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { launchPreviewWorkspace } from './support/previewWorkspace';

const SPREADSHEET = '#file-preview-root .x-spreadsheet';
const entry = (page: Page, file: string) => page.locator(`.workspace-entry[data-relative-path="${file}"] .workspace-entry-name`);
/** Tags the rendered spreadsheet; a re-render replaces the node and drops the tag. */
const mark = (page: Page) => page.locator(SPREADSHEET).first().evaluate((element) => { (element as HTMLElement).dataset.e2eMarker = '1'; });
const marked = (page: Page) => page.evaluate(() => Boolean(document.querySelector('#file-preview-root [data-e2e-marker]')));

test('re-clicking an open preview keeps its rendering; external edits reload it', async () => {
  const ws = await launchPreviewWorkspace({ 'data.txt': 'alpha\n' });
  const { page } = ws;
  try {
    await entry(page, 'sample.xlsx').click();
    await expect(page.locator(SPREADSHEET).first()).toBeVisible({ timeout: 30_000 });
    await mark(page);
    await entry(page, 'sample.xlsx').click();
    await page.waitForTimeout(1500);
    expect(await marked(page)).toBe(true);

    const xlsx = path.join(ws.workspace, 'sample.xlsx');
    // Change bytes (not just mtime) so Windows fs.watch + stale size/mtime checks both fire.
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(xlsx);
    book.worksheets[0].getCell('Z99').value = `external-${Date.now()}`;
    await book.xlsx.writeFile(xlsx);
    await expect.poll(() => marked(page), { timeout: 15_000 }).toBe(false);
    await expect(page.locator(SPREADSHEET).first()).toBeVisible({ timeout: 30_000 });

    await entry(page, 'data.txt').click();
    await expect(page.locator('#file-preview-root').getByText('alpha', { exact: true })).toBeVisible({ timeout: 30_000 });
    await writeFile(path.join(ws.workspace, 'data.txt'), 'bravo\n');
    await expect(page.locator('#file-preview-root').getByText('bravo', { exact: true })).toBeVisible({ timeout: 15_000 });
  } finally { await ws.dispose(); }
});
