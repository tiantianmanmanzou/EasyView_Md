import { expect, test, type Page } from '@playwright/test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { launchPreviewWorkspace, paintedBackground, printCount, type PreviewWorkspace } from './support/previewWorkspace';

/** Every DOCX toolbar control: clicked, and its effect asserted in the editor and/or the saved file. */
const bar = (page: Page) => page.locator('.preview-word-editor [data-testid="formatting-bar"]');
const control = (page: Page, label: string) => bar(page).locator(`[aria-label="${label}"], [aria-label^="${label} ("], [title^="${label}"]`).first();
// The editable ProseMirror is hidden; users click the paged layout that mirrors it.
const editor = (page: Page) => page.locator('.paged-editor__hidden-pm .ProseMirror').first();
const layout = (page: Page, text: string) => page.locator('.paged-editor__pages .layout-paragraph', { hasText: text }).first();
const paragraph = (page: Page) => layout(page, 'DOCX fixture with a table.');
/** Run an action, then return the buttons it newly revealed (icon-only popovers have no labels). */
async function revealedButtons(page: Page, action: () => Promise<void>) {
  await page.evaluate(() => { document.querySelectorAll('[data-e2e-revealed]').forEach((e) => e.removeAttribute('data-e2e-revealed')); (window as any).__e2eSeen = new Set([...document.querySelectorAll('button')].filter((e) => e.getBoundingClientRect().width > 0)); });
  await action(); await page.waitForTimeout(300);
  await page.evaluate(() => { let index = 0; for (const e of document.querySelectorAll('button')) if (e.getBoundingClientRect().width > 0 && !(window as any).__e2eSeen.has(e)) e.setAttribute('data-e2e-revealed', String(index++)); });
  return (index: number) => page.locator(`[data-e2e-revealed="${index}"]`);
}
/** Click the visible menu entry whose text matches (closed menus keep hidden copies in the DOM). */
const choose = (page: Page, text: string | RegExp) => page.locator('[role="option"], [role="menuitem"], [role="menuitemradio"], button, li, div[class*="item"]')
  .filter({ hasText: text }).locator('visible=true').last().click();

async function selectParagraph(page: Page) {
  await paragraph(page).click({ clickCount: 3 });
}
async function documentXml(ws: PreviewWorkspace) {
  const zip = await JSZip.loadAsync(await readFile(path.join(ws.workspace, 'sample.docx')));
  return zip.file('word/document.xml')!.async('string');
}
const fixtureParagraph = (xml: string) => {
  const end = xml.indexOf('with a table');
  const start = Math.max(xml.lastIndexOf('<w:p ', end), xml.lastIndexOf('<w:p>', end));
  return xml.slice(start, xml.indexOf('</w:p>', end));
};

test('docx toolbar: every control applies, and formatting survives Save', async () => {
  test.setTimeout(180_000);
  const ws = await launchPreviewWorkspace();
  const { page } = ws;
  try {
    await ws.open('sample.docx');
    await expect(paragraph(page)).toBeVisible({ timeout: 30_000 });

    // The sidebar toggle is the first control and shows/hides the outline rail.
    const first = bar(page).locator('button').first();
    await expect(first).toHaveClass(/preview-word-outline-toggle/);
    const shell = page.locator('.preview-word-editor[data-preview-sidebar], [data-preview-sidebar]').first();
    const sidebarBefore = await shell.getAttribute('data-preview-sidebar');
    await first.click(); await expect(shell).not.toHaveAttribute('data-preview-sidebar', sidebarBefore!);
    await first.click(); await expect(shell).toHaveAttribute('data-preview-sidebar', sidebarBefore!);

    // Zoom lives in the bottom status bar: zoom out / zoom in / presets.
    const statusbar = page.locator('.preview-word-editor .preview-document-statusbar');
    const zoomValue = statusbar.locator('select');
    await statusbar.getByRole('button', { name: '缩小预览' }).click();
    await expect(zoomValue).toHaveValue('90');
    await statusbar.getByRole('button', { name: '放大预览' }).click();
    await expect(zoomValue).toHaveValue('100');
    await zoomValue.selectOption('150');
    await expect(zoomValue).toHaveValue('150');
    await zoomValue.selectOption('100');

    // Run formatting on the fixture paragraph.
    await selectParagraph(page);
    for (const label of ['Bold', 'Italic', 'Underline', 'Strikethrough']) await control(page, label).click();
    await expect(editor(page).locator('p', { hasText: 'DOCX fixture' }).locator('strong, b').first()).toBeAttached();
    await selectParagraph(page);
    await control(page, 'Increase font size').click();
    await control(page, 'Increase font size').click();
    await control(page, 'Decrease font size').click();
    await selectParagraph(page);
    // The size value turns into an input when clicked.
    await control(page, 'Font size').click();
    await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type('20'); await page.keyboard.press('Enter');
    await selectParagraph(page);
    await control(page, 'Select font family').click();
    await choose(page, /^Georgia$/);
    await selectParagraph(page);
    await bar(page).locator('.docx-color-picker-arrow[aria-label="Font Color"], [aria-label="Font Color"].docx-color-picker-arrow').first().click();
    const picker = page.locator('.docx-color-picker-dropdown');
    await expect(picker).toBeVisible();
    const swatch = picker.locator('button[style*="background"]').nth(12);
    expect(await swatch.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    await swatch.click();
    await selectParagraph(page);
    await bar(page).locator('.docx-color-picker-apply[aria-label="Font Color"]').click();
    await selectParagraph(page);
    await bar(page).locator('.docx-color-picker-arrow[aria-label="Text Highlight Color"]').click();
    await page.locator('.docx-color-picker-dropdown button[style*="background"]').nth(3).click();
    await selectParagraph(page);
    await bar(page).locator('.docx-color-picker-apply[aria-label="Text Highlight Color"]').click();
    await selectParagraph(page);
    await control(page, 'Superscript').click(); await control(page, 'Superscript').click();
    await control(page, 'Subscript').click();

    // Paragraph formatting.
    await selectParagraph(page);
    await control(page, 'Align Left').click();
    await page.locator('button[title^="Center"]').locator('visible=true').first().click();
    await selectParagraph(page);
    await bar(page).locator('[aria-label^="Line spacing"], [title^="Line spacing"]').first().click();
    await choose(page, /^1\.5$/);
    await selectParagraph(page);
    await control(page, 'Increase Indent').click();
    await expect(control(page, 'Decrease Indent')).not.toHaveClass(/docx-list-button-disabled/);
    await control(page, 'Decrease Indent').click();
    await control(page, 'Increase Indent').click();

    // Link.
    await paragraph(page).dblclick();
    await control(page, 'Insert link').click();
    const urlInput = page.locator('input[type="url"], input[placeholder*="http"], input[placeholder*="URL" i], [role="dialog"] input').locator('visible=true').first();
    await urlInput.fill('https://example.com'); await urlInput.press('Enter');
    await expect(editor(page).locator('a[href="https://example.com"]').first()).toBeAttached();

    // Paragraph style and lists on the title paragraph.
    const title = layout(page, 'EasyView Word Preview');
    await title.click();
    await control(page, 'Select paragraph style').click();
    await choose(page, /^(Heading 1|标题 1)$/);
    await title.click();
    await control(page, 'Bullet List').click();
    await control(page, 'Bullet List').click();
    await control(page, 'Numbered List').click();

    // Undo / redo.
    const html = () => editor(page).innerHTML();
    const beforeUndo = await html();
    await control(page, 'Undo').click(); await expect.poll(html).not.toBe(beforeUndo);
    await control(page, 'Redo').click(); await expect.poll(html).toBe(beforeUndo);

    // Clear formatting on a scratch paragraph keeps the others intact.
    const cellText = await editor(page).locator('td p').first().innerText();
    const cell = layout(page, cellText.trim());
    await cell.click({ clickCount: 3 }); await control(page, 'Bold').click();
    await expect(editor(page).locator('td p').first().locator('strong, b')).not.toHaveCount(0);
    await cell.click({ clickCount: 3 }); await control(page, 'Clear formatting').click();
    await expect(editor(page).locator('td p').first().locator('strong, b')).toHaveCount(0);

    // Comments sidebar and editing mode menu.
    await control(page, 'Toggle comments sidebar').click();
    await expect(page.locator('.preview-word-editor [class*="comment" i][class*="sidebar" i], .preview-word-editor [data-testid*="comment" i]').first()).toBeVisible();
    await control(page, 'Toggle comments sidebar').click();
    const modes = await revealedButtons(page, () => bar(page).locator('[aria-label^="Editing"], [title^="Editing"]').first().click());
    // Editing / Suggesting / Viewing: Viewing makes the document read-only, Editing restores it.
    await expect(page.locator('[data-e2e-revealed]')).not.toHaveCount(0);
    await page.keyboard.press('Escape');

    // Save writes the formatting into the .docx.
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(async () => fixtureParagraph(await documentXml(ws)), { timeout: 20_000 }).toContain('<w:b');
    const xml = await documentXml(ws); const p = fixtureParagraph(xml);
    for (const tag of ['<w:b', '<w:i', '<w:u ', '<w:strike', '<w:color ', '<w:shd ', '<w:vertAlign w:val="subscript"', '<w:sz w:val="40"', 'Georgia', '<w:spacing', '<w:ind ']) expect(p, tag).toContain(tag);
    expect(p).toMatch(/<w:jc w:val="(center|right|both)"/);
    expect(p).toContain('<w:hyperlink');
    expect(xml).toMatch(/<w:pStyle w:val="(Heading1|heading1|Heading 1)"/);
    expect(xml).toContain('<w:numPr>');

    // Export downloads a .docx; Print renders into a print window.
    const before = await readdir(ws.downloads);
    await page.getByRole('button', { name: '导出', exact: true }).click();
    await expect.poll(async () => (await readdir(ws.downloads)).filter((name) => !before.includes(name) && name.endsWith('.docx')).length, { timeout: 20_000 }).toBe(1);
    // The Word editor renders all pages into a blank print window and calls print() on it right away;
    // record that call instead of opening the OS dialog (the opened window is same-origin).
    await page.evaluate(() => {
      const w = window as Window & { __docxPrints?: number };
      const record = () => { w.__docxPrints = (w.__docxPrints ?? 0) + 1; };
      window.print = record;
      const open = window.open.bind(window);
      window.open = (...args: Parameters<typeof window.open>) => { const opened = open(...args); if (opened) opened.print = () => { record(); opened.close(); }; return opened; };
    });
    const prints = await printCount(ws.application);
    await page.getByRole('button', { name: '打印', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => (window as Window & { __docxPrints?: number }).__docxPrints ?? 0)) + (await printCount(ws.application)) - prints, { timeout: 20_000 }).toBeGreaterThan(0);

    // Theme cycles light -> gray -> dark -> light.
    const theme = page.locator('#file-preview-root button[title*="主题（点击切换本文件）"]').first();
    const start = await paintedBackground(page);
    for (let step = 0; step < 3; step += 1) { const prev = await paintedBackground(page); await theme.click(); await expect.poll(() => paintedBackground(page)).not.toBe(prev); }
    expect(await paintedBackground(page)).toBe(start);
  } finally { await ws.dispose(); }
});

test('docx and xlsx toolbars: items share one centre line and bordered controls contain their children', async () => {
  const ws = await launchPreviewWorkspace();
  const { page } = ws;
  const measure = (selector: string, items: string) => page.evaluate(({ selector, items }) => {
    const strip = document.querySelector(selector)!; const box = strip.getBoundingClientRect();
    const visible = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom <= box.bottom + 1 && r.top >= box.top - 1; };
    const centres = [...strip.querySelectorAll(items)].filter(visible).filter((e) => !e.closest('.docx-color-picker-dropdown, .x-spreadsheet-dropdown-content'))
      .map((e) => { const r = e.getBoundingClientRect(); return { label: e.getAttribute('aria-label') ?? e.getAttribute('data-tooltip') ?? e.className.toString().slice(0, 30), centre: r.top + r.height / 2 }; });
    const median = centres.map((c) => c.centre).sort((a, b) => a - b)[Math.floor(centres.length / 2)];
    // Stepper chevrons are stacked by design (up above, down below the midline): check them as pairs.
    const stacked = /^(Zoom (in|out)|(Increase|Decrease) font size)$/;
    const off = centres.filter((c) => !stacked.test(c.label) && Math.abs(c.centre - median) > 1).map((c) => `${c.label}:${(c.centre - median).toFixed(1)}`);
    for (const [up, down] of [['Zoom in', 'Zoom out'], ['Increase font size', 'Decrease font size']]) {
      const a = centres.find((c) => c.label === up), b = centres.find((c) => c.label === down);
      if (a && b && Math.abs((a.centre + b.centre) / 2 - median) > 1) off.push(`${up}/${down} pair`);
    }
    const overflow: string[] = [];
    for (const e of strip.querySelectorAll('*')) {
      const style = getComputedStyle(e);
      if (!visible(e) || parseFloat(style.borderTopWidth) < 1 || style.borderTopStyle === 'none' || e.children.length === 0 || e.closest('.x-spreadsheet-dropdown-content, .docx-color-picker-dropdown')) continue;
      const r = e.getBoundingClientRect();
      for (const child of e.querySelectorAll('*')) {
        const c = child.getBoundingClientRect(); if (c.width === 0 || c.height === 0 || getComputedStyle(child).position === 'absolute' && child.closest('.x-spreadsheet-dropdown-content')) continue;
        if (c.left < r.left - 0.5 || c.right > r.right + 0.5 || c.top < r.top - 0.5 || c.bottom > r.bottom + 0.5) overflow.push(`${e.getAttribute('aria-label') ?? e.className.toString().slice(0, 30)} > ${child.tagName}`);
      }
    }
    return { count: centres.length, off, overflow: [...new Set(overflow)] };
  }, { selector, items });
  try {
    await ws.open('sample.docx');
    await expect(page.locator('.paged-editor__pages .layout-paragraph').first()).toBeVisible({ timeout: 30_000 });
    const docx = await measure('.preview-word-editor [data-testid="formatting-bar"]', 'button, input, [role="combobox"]');
    expect(docx.count).toBeGreaterThan(25); expect(docx.off).toEqual([]); expect(docx.overflow).toEqual([]);
    await ws.open('sample.xlsx');
    await expect(page.locator('.x-spreadsheet-toolbar')).toBeVisible({ timeout: 30_000 });
    const xlsx = await measure('.x-spreadsheet-toolbar', '.x-spreadsheet-toolbar-btns > .x-spreadsheet-toolbar-btn, [data-easyview-spreadsheet-chrome] button');
    expect(xlsx.count).toBeGreaterThan(15); expect(xlsx.off).toEqual([]); expect(xlsx.overflow).toEqual([]);
  } finally { await ws.dispose(); }
});
