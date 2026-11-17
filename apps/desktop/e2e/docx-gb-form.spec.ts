import { expect, test } from '@playwright/test';
import { readFile, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { gbFormDocx } from '../../../tests/fixtures/docx/gbForm';
import { launchPreviewWorkspace } from './support/previewWorkspace';

const read = promisify(readFile);
test('Chinese form docx: checkboxes, hidden highlights and GB-font blanks render like WPS and survive a save', async () => {
  const bytes = await gbFormDocx(path.resolve(process.cwd(), '../..'));
  const ws = await launchPreviewWorkspace({}, 1600, (dir) => writeFileSync(path.join(dir, 'form.docx'), bytes));
  try {
    await ws.open('form.docx');
    const page = ws.page.locator('.paged-editor__pages .layout-page').first();
    await expect(page).toContainText('☑ Option one ☐ Option two');

    const background = (text: string) => page.locator('span', { hasText: text }).last().evaluate((el) => getComputedStyle(el).backgroundColor);
    await expect.poll(() => background('Marked text')).toBe('rgba(0, 0, 0, 0)');
    expect(await background('Shaded text')).toBe('rgb(204, 232, 207)');
    const toggle = ws.page.getByRole('button', { name: '显示突出显示' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => background('Marked text')).toBe('rgb(255, 255, 0)');
    await toggle.click();

    // GB faces use half-em ASCII spaces; when the substitute already draws a wide space
    // (common on Windows CI without 仿宋), word-spacing compensation can be 0 — still assert
    // the run resolved onto the FangSong stack and that blanks stay wide enough to fill.
    const blank = page.locator('span', { hasText: 'Signature:' }).last();
    const blankMetrics = await blank.evaluate((el) => {
      const style = getComputedStyle(el);
      const spaces = /\[([ ]+)\]/.exec(el.textContent ?? '')?.[1] ?? '';
      return {
        fontFamily: style.fontFamily,
        wordSpacing: parseFloat(style.wordSpacing) || 0,
        spaceCount: spaces.length,
        width: el.getBoundingClientRect().width,
      };
    });
    expect(blankMetrics.fontFamily).toMatch(/FangSong|仿宋|Noto Serif SC/i);
    expect(blankMetrics.spaceCount).toBeGreaterThan(8);
    expect(blankMetrics.width + blankMetrics.wordSpacing * blankMetrics.spaceCount).toBeGreaterThan(40);

    await page.locator('.layout-paragraph', { hasText: 'Option two' }).click();
    await ws.page.keyboard.press('End'); await ws.page.keyboard.type(' UPDATED');
    await ws.page.getByRole('button', { name: '保存', exact: true }).click();
    const xml = async () => (await JSZip.loadAsync(await read(path.join(ws.workspace, 'form.docx')))).file('word/document.xml')!.async('string');
    await expect.poll(async () => (await xml()).includes('UPDATED')).toBe(true);
    const saved = await xml();
    expect(saved).toContain('<w:sym w:font="Wingdings 2" w:char="0052"/>');
    expect(saved).toContain('<w:sym w:font="Wingdings 2" w:char="00A3"/>');
    expect(saved).not.toContain('☑');
    expect(saved).toContain('<w:highlight w:val="yellow"/>');
  } finally { await ws.dispose(); }
});
