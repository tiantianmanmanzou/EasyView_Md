import { expect, test } from '@playwright/test';
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { launchPreviewWorkspace, previewFixtures } from './support/previewWorkspace';

test('filter lists values, hides sort, and keeps matching rows at the top after OK', async () => {
  const ws = await launchPreviewWorkspace({}, 1400, (workspace) => {
    copyFileSync(path.join(previewFixtures, 'header-only-filter.xlsx'), path.join(workspace, 'header-only-filter.xlsx'));
  });
  try {
    await ws.open('header-only-filter.xlsx');
    const overlay = ws.page.locator('.x-spreadsheet-overlayer');
    await expect(overlay).toBeVisible({ timeout: 30_000 });

    // Index gutter ~60×20; default cell ~100×25. Click the filter chevron in A1's bottom-right.
    await overlay.click({ position: { x: 60 + 100 - 8, y: 20 + 25 - 8 } });
    const menu = ws.page.locator('.x-spreadsheet-sort-filter');
    await expect(menu).toBeVisible();
    await expect(menu.locator(':scope > .x-spreadsheet-item.state').first()).toBeHidden();
    await expect(menu.getByText('Sort A -> Z')).toBeHidden();
    await expect(menu.getByText('Sort Z -> A')).toBeHidden();
    await expect(menu.locator('.x-spreadsheet-header')).not.toHaveText('0 / 0');
    await expect(menu.locator('.x-spreadsheet-body .x-spreadsheet-item')).toContainText(['数据安全中台', '数据安全运营']);

    // Scroll away while the menu is open so OK must pull the viewport back to the top.
    const scrollbar = ws.page.locator('.x-spreadsheet-scrollbar.vertical');
    await scrollbar.evaluate((el) => {
      el.scrollTop = 480;
      el.dispatchEvent(new Event('scroll'));
    });
    await expect.poll(async () => scrollbar.evaluate((el) => (el as HTMLElement).scrollTop)).toBeGreaterThan(0);

    // Keep only「数据安全中台」.
    await menu.locator('.x-spreadsheet-header').click();
    await menu.locator('.x-spreadsheet-body .x-spreadsheet-item', { hasText: '数据安全中台' }).click();
    await menu.locator('.x-spreadsheet-button.primary').click();
    await expect(menu).toBeHidden();
    await expect.poll(async () => scrollbar.evaluate((el) => (el as HTMLElement).scrollTop)).toBe(0);
  } finally {
    await ws.dispose();
  }
});
