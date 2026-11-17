import { expect, test } from '@playwright/test';
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { launchPreviewWorkspace, previewFixtures } from './support/previewWorkspace';

// pagination.doc: A4, margins 1800/1440 twips, 30 numbered paragraphs around a 30-row table, then
// "Before the blank page.", a page break, an empty page and "After the blank page." (Word and
// LibreOffice: 7 pages, the 6th blank).
const A4 = { width: 794, height: 1123, bottom: 96 };

test('a .doc is paginated on its own paper like Word, keeping blank pages and following zoom', async () => {
  const ws = await launchPreviewWorkspace({}, 1600, (workspace) => copyFileSync(path.join(previewFixtures, 'pagination.doc'), path.join(workspace, 'pagination.doc')));
  try {
    await ws.open('pagination.doc');
    const pages = ws.page.locator('.msdoc-page');
    await expect(pages).toHaveCount(7, { timeout: 30_000 });
    await expect(ws.page.locator('.preview-page-count')).toHaveText('/ 7');

    const sheets = await ws.page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.msdoc-page')].map((page) => {
      const root = page.querySelector<HTMLElement>(':scope > .msdoc-root')!;
      const last = root.lastElementChild as HTMLElement | null;
      return {
        width: root.offsetWidth,
        height: root.offsetHeight,
        contentBottom: last ? last.offsetTop + last.offsetHeight : 0,
        text: root.innerText.replace(/\s+/g, ' ').trim(),
        rows: [...root.querySelectorAll('tr')].map((row) => /Row (\d+)/.exec(row.textContent ?? '')?.[1]).map(Number),
      };
    }));
    for (const sheet of sheets) {
      expect(sheet).toMatchObject({ width: A4.width, height: A4.height });
      expect(sheet.contentBottom).toBeLessThanOrEqual(A4.height - A4.bottom + 1);
    }
    expect(sheets[5].text).toBe('');
    expect(sheets[4].text).toMatch(/Before the blank page\.$/);
    expect(sheets[6].text).toBe('After the blank page.');
    const text = sheets.map((sheet) => sheet.text).join(' ');
    const numbers = Array.from({ length: 30 }, (_, index) => text.indexOf(` ${index + 1}. `));
    expect(numbers.every((at, index) => at >= 0 && (index === 0 || at > numbers[index - 1]))).toBe(true);
    expect(sheets.flatMap((sheet) => sheet.rows)).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
    expect(sheets.filter((sheet) => sheet.rows.length).length).toBeGreaterThan(1);

    const width = () => pages.nth(6).evaluate((page) => Math.round(page.getBoundingClientRect().width));
    const before = await width();
    await ws.page.locator('#file-preview-root').getByRole('button', { name: '放大预览', exact: true }).first().click();
    await expect.poll(width).toBeGreaterThan(before);
  } finally {
    await ws.dispose();
  }
});
