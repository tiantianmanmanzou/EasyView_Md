import { expect, test } from '@playwright/test';
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { launchPreviewWorkspace, previewFixtures } from './support/previewWorkspace';

/** Every document route ends in one status strip flush with the bottom edge; paged ones navigate from it. */
test('document status bar sits on the bottom edge and pages through PDF, PPTX and DOCX', async () => {
  test.setTimeout(240_000);
  const ws = await launchPreviewWorkspace({}, 1400, (workspace) => copyFileSync(path.join(previewFixtures, 'sample.ppt'), path.join(workspace, 'sample.ppt')));
  const { page } = ws;
  const bar = page.locator('#file-preview-root .preview-statusbar');
  const pageInput = bar.getByRole('textbox', { name: '页码' });
  try {
    for (const [file, pages] of [
      ['samples/中文/示例PDF文档.pdf', 8],
      ['samples/中文/示例演示文稿A.pptx', 5],
      ['samples/中文/示例文档.docx', 2],
      ['sample.ppt', 1],
      ['samples/中文/示例旧版文档.doc', 1],
      ['sample.xlsx', 0],
    ] as const) {
      await ws.open(file);
      await expect(bar).toBeVisible();
      await expect(bar.getByRole('button', { name: '适合页面宽度' })).toBeVisible();
      await expect.poll(() => page.evaluate(() => {
        const root = document.querySelector('#file-preview-root')!.getBoundingClientRect();
        const strip = document.querySelector('#file-preview-root .preview-statusbar')!.getBoundingClientRect();
        return [root.bottom - strip.bottom, root.left - strip.left, root.right - strip.right, strip.height].map(Math.round);
      }), file).toEqual([0, 0, 0, 25]);
      if (!pages) {
        await expect(pageInput).toHaveCount(0);
        continue;
      }
      await expect(bar.locator('.preview-page-count')).toHaveText(`/ ${pages}`, { timeout: 30_000 });
      await expect(pageInput).toHaveValue('1');
      await expect(bar.getByRole('button', { name: '上一页' })).toBeDisabled();
      if (pages === 1) {
        await expect(bar.getByRole('button', { name: '下一页' })).toBeDisabled();
        continue;
      }
      await bar.getByRole('button', { name: '下一页' }).click();
      await expect(pageInput).toHaveValue('2');
      await pageInput.fill(String(pages));
      await pageInput.press('Enter');
      await expect(pageInput).toHaveValue(String(pages));
      await expect(bar.getByRole('button', { name: '下一页' })).toBeDisabled();
    }
  } finally { await ws.dispose(); }
});
