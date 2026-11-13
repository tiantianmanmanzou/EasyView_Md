import { expect, test } from '@playwright/test';
import { readFile, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { nestedFieldsDocx } from '../../../tests/fixtures/docx/nestedFields';
import { launchPreviewWorkspace } from './support/previewWorkspace';

const read = promisify(readFile);
test('a cross-paragraph nested table of contents renders on the next page and survives a save', async () => {
  const bytes = await nestedFieldsDocx(path.resolve(process.cwd(), '../..'));
  const ws = await launchPreviewWorkspace({}, 1600, (dir) => writeFileSync(path.join(dir, 'nested.docx'), bytes));
  try {
    await ws.open('nested.docx');
    const pages = ws.page.locator('.paged-editor__pages .layout-page');
    await expect(pages.first()).toContainText('Fixture cover');
    await expect(pages.nth(1)).toContainText('First heading');
    await expect(pages.nth(1)).toContainText('Second heading');
    await expect(pages.nth(1)).toContainText('1');
    await expect(pages.nth(1)).toContainText('2');
    await expect(pages.nth(1).locator('.layout-run-tab')).toHaveCount(2);
    await expect(pages.nth(1).locator('.layout-run-tab').first()).toContainText('.');
    await pages.first().locator('.layout-paragraph', { hasText: 'Fixture cover' }).click();
    await ws.page.keyboard.press('End'); await ws.page.keyboard.type(' UPDATED');
    await ws.page.getByRole('button', { name: '保存', exact: true }).click();
    const xml = async () => (await JSZip.loadAsync(await read(path.join(ws.workspace, 'nested.docx')))).file('word/document.xml')!.async('string');
    await expect.poll(async () => (await xml()).includes('UPDATED')).toBe(true);
    const saved = await xml();
    for (const [pattern, count] of [[/w:fldCharType="begin"/g, 5], [/w:fldCharType="end"/g, 5], [/HYPERLINK/g, 2], [/PAGEREF/g, 2]] as const) {
      expect((saved.match(pattern) ?? []).length).toBe(count);
    }
    expect(saved).toContain('First heading'); expect(saved).toContain('Second heading');
  } finally { await ws.dispose(); }
});
