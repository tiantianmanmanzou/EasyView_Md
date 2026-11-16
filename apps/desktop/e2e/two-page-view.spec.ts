import { expect, test, type Page } from '@playwright/test';
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { launchPreviewWorkspace, previewFixtures } from './support/previewWorkspace';

/** Tops and lefts of the first three rendered pages. */
const layout = (page: Page, selector: string) => page.evaluate((sel) => [...document.querySelectorAll<HTMLElement>(sel)].slice(0, 3).map((element) => {
  const rect = element.getBoundingClientRect();
  return { top: Math.round(rect.top), left: Math.round(rect.left) };
}), selector);

const pairedThenWrapped = async (page: Page, selector: string, pages: number) => {
  await expect.poll(async () => {
    const [first, second, third] = await layout(page, selector);
    return Math.abs(first.top - second.top) <= 1 && second.left > first.left && (pages < 3 || third.top > first.top + 100);
  }).toBe(true);
};

const singleColumn = async (page: Page, selector: string) => {
  await expect.poll(async () => {
    const [first, second] = await layout(page, selector);
    return second.top > first.top + 100 && Math.abs(second.left - first.left) <= 1;
  }).toBe(true);
};

test('PDF, DOC and DOCX lay pages out in pairs from one toolbar switch that every document remembers', async () => {
  const ws = await launchPreviewWorkspace({}, 1600, (workspace) => copyFileSync(path.join(previewFixtures, 'pagination.doc'), path.join(workspace, 'pagination.doc')));
  const toggle = () => ws.page.getByRole('button', { name: '双页显示', exact: true }).filter({ visible: true });
  const current = () => ws.page.locator('.preview-page-controls input').filter({ visible: true });
  try {
    const pdf = '.pdfViewer > .page';
    await ws.open('samples/中文/示例PDF文档.pdf');
    await expect(ws.page.locator(pdf)).toHaveCount(8, { timeout: 30_000 });
    await singleColumn(ws.page, pdf);
    await expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    await toggle().click();
    await expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    await pairedThenWrapped(ws.page, pdf, 8);
    await ws.page.getByRole('button', { name: '下一页' }).filter({ visible: true }).click();
    await expect(current()).toHaveValue('3');

    const doc = '.msdoc-page';
    await ws.open('pagination.doc');
    await expect(ws.page.locator(doc)).toHaveCount(7, { timeout: 30_000 });
    await expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    await pairedThenWrapped(ws.page, doc, 7);

    const docx = '.paged-editor__pages > .layout-page';
    await ws.open('samples/中文/示例文档.docx');
    await expect(ws.page.locator(docx).first()).toBeVisible({ timeout: 30_000 });
    await expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    await pairedThenWrapped(ws.page, docx, 2);
    const [, second] = await ws.page.locator(docx).evaluateAll((pages) => pages.map((element) => element.getBoundingClientRect().toJSON() as DOMRect));
    await ws.page.mouse.click(second.left + second.width / 2, second.top + second.height / 2);
    await ws.page.keyboard.type('Ж');
    await expect.poll(() => ws.page.locator(docx).evaluateAll((pages) => pages.findIndex((element) => element.textContent?.includes('Ж')))).toBe(1);

    await toggle().click();
    await expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    await singleColumn(ws.page, docx);
  } finally {
    await ws.dispose();
  }
});
