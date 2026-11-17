import { expect, test } from '@playwright/test';
import { copyFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import path from 'node:path';
import { launchPreviewWorkspace } from './support/previewWorkspace';

test('inspect document', async () => {
 test.skip(!process.env.EASYVIEW_CHECK_DOCX, '设置 EASYVIEW_CHECK_DOCX 为《技术规范书.docx》后再核对照封面、目录和保存');
 const ws = await launchPreviewWorkspace({}, 1600, workspace => copyFileSync(process.env.EASYVIEW_CHECK_DOCX!, path.join(workspace,'spec.docx')));
 try {
  await ws.open('spec.docx');
  await expect(ws.page.locator('.preview-word-editor')).toBeVisible();
  const laidOutPages = ws.page.locator('.paged-editor__pages .layout-page');
  await expect(laidOutPages.first()).toContainText('浙江公司');
  await expect(laidOutPages.first()).not.toContainText('总则');
  await expect(laidOutPages.nth(1)).toContainText('总则');
  await expect(laidOutPages.nth(1).locator('.layout-run-tab').first()).toContainText('.');
  await expect(ws.page.locator('.paged-editor__pages')).toContainText('1、 总则');
  await expect(ws.page.locator('.paged-editor__pages')).toContainText('10、 其他要求');
  await expect(ws.page.locator('.paged-editor__hidden-pm .ProseMirror')).toContainText('总则', {timeout:30000});
  await ws.page.locator('.docx-editor__scroll-container').first().evaluate((el) => { el.scrollTop = 1300; });
  await ws.page.waitForTimeout(500);
  await ws.page.screenshot({path:'/tmp/easyview-docx-toc.png'});
  const details=await ws.page.evaluate(() => {
   const p=document.querySelector('.paged-editor__hidden-pm .ProseMirror');
   const pages=[...document.querySelectorAll('[class*="page"]')].filter(x=>x.getBoundingClientRect().height>300);
   return {hasFirst:!!p?.textContent?.includes('总则'),hasLast:!!p?.textContent?.includes('其他要求'),pageCount:pages.length,markers:document.querySelectorAll('[data-field-marker]').length};
  });
  console.log('CHECK',JSON.stringify(details));
  const file = path.join(ws.workspace, 'spec.docx');
  const xml = async () => (await JSZip.loadAsync(await readFile(file))).file('word/document.xml')!.async('string');
  const before = await xml();
  const cover = ws.page.locator('.paged-editor__pages .layout-paragraph', { hasText: '浙江公司' }).first();
  await cover.scrollIntoViewIfNeeded(); await cover.click();
  await ws.page.keyboard.press('End'); await ws.page.keyboard.type('EASYVIEWVERIFYXYZ');
  await ws.page.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await xml()).includes('EASYVIEWVERIFYXYZ'), {timeout:30000}).toBe(true);
  const after = await xml();
  copyFileSync(file, '/tmp/easyview-docx-saved-copy.docx');
  for (const pattern of [/w:fldCharType="begin"/g, /w:fldCharType="end"/g, /HYPERLINK/g, /PAGEREF/g]) {
   expect((after.match(pattern) ?? []).length).toBe((before.match(pattern) ?? []).length);
  }
  const text = ws.page.locator('.paged-editor__hidden-pm .ProseMirror');
  await expect(text).toContainText('其他要求');

 } finally { await ws.dispose(); }
});
