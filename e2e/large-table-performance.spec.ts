import { test, expect } from '@playwright/test';

function fixedHeightTable(rows = 80, columns = 8): string {
  return `<table>${Array.from({ length: rows }, (_, row) =>
    `<tr data-easyview-row-height="100">${Array.from({ length: columns }, (_, column) =>
      `<td>第${row + 1}行第${column + 1}列 数据安全能力描述、规则说明和配置内容</td>`
    ).join('')}</tr>`
  ).join('')}</table>`;
}

test('large fixed-height table becomes interactive without a multi-second layout stall', async ({ page }) => {
  await page.goto('/');
  await page.locator('.ProseMirror').waitFor({ state: 'visible' });

  const markdown = fixedHeightTable();
  const started = Date.now();
  await page.evaluate((content) => {
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'init',
        content,
        filename: 'large-fixed-height-table',
        fullWidth: false,
        tocVisible: false,
        tableWrap: true,
        imagePathMap: {},
      },
    }));
  }, markdown);

  await page.waitForFunction(() => document.querySelectorAll('.ProseMirror td').length === 640);
  const elapsed = Date.now() - started;
  const viewport = await page.locator('.ProseMirror tr:first-child td:first-child .easyview-table-cell-content').evaluate((content) => ({
    clientHeight: content.clientHeight,
    scrollHeight: content.scrollHeight,
    overflowY: getComputedStyle(content).overflowY,
  }));

  expect(elapsed).toBeLessThan(5_000);
  expect(viewport.clientHeight).toBeGreaterThan(0);
  expect(viewport.overflowY).toBe('auto');
});
