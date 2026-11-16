import { expect, test } from '@playwright/test';
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { launchPreviewWorkspace, previewFixtures } from './support/previewWorkspace';

test('empty cells keep the borders from the source workbook', async () => {
  const ws = await launchPreviewWorkspace({}, 1400, (workspace) => {
    copyFileSync(path.join(previewFixtures, 'empty-border-cells.xlsx'), path.join(workspace, 'empty-border-cells.xlsx'));
  });
  try {
    await ws.open('empty-border-cells.xlsx');
    const overlay = ws.page.locator('.x-spreadsheet-overlayer');
    await expect(overlay).toBeVisible({ timeout: 30_000 });
    // Touch a valued cell so save is enabled; empty bordered cells must survive the round-trip.
    await overlay.click({ position: { x: 60, y: 20 } });
    await ws.page.locator('.x-spreadsheet-toolbar-btns > .x-spreadsheet-toolbar-btn:has(.x-spreadsheet-icon-img.font-bold)').first().click();
    await ws.page.getByRole('button', { name: '保存', exact: true }).click();
    const book = new ExcelJS.Workbook();
    await expect.poll(async () => {
      await book.xlsx.readFile(path.join(ws.workspace, 'empty-border-cells.xlsx'));
      const sheet = book.worksheets[0];
      return Boolean(sheet.getCell('B1').border?.top?.style && sheet.getCell('A2').border?.left?.style && sheet.getCell('B2').border?.bottom?.style);
    }, { timeout: 15_000 }).toBe(true);
  } finally {
    await ws.dispose();
  }
});
