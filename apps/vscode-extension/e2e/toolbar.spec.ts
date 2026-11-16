import { _electron as electron, expect, test, type Frame, type Page } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ExcelJS from 'exceljs';
import { keepElectronInBackground, terminateElectron } from '../../desktop/e2e/support/electronApp';

/**
 * Real VS Code + development extension: xlsx toolbar edits must reach disk through the
 * webview → extension `writeBytes` bridge, and the toolbar icons must sit on one centre line.
 * Run via npm run test:e2e:vscode (apps/vscode-extension/scripts/run-e2e.mjs)
 */
const cell = (col: number, row: number) => ({ x: 60 + col * 100 + 50, y: 20 + row * 20 + 10 });
const shots = process.env.EASYVIEW_SCREENSHOT_DIR;

async function findFrame(page: Page, selector: string): Promise<Frame> {
  let found: Frame | undefined;
  await expect.poll(async () => {
    for (const frame of page.frames()) if (await frame.locator(selector).count().catch(() => 0)) { found = frame; return true; }
    return false;
  }, { timeout: 90_000 }).toBe(true).catch(async (error) => { await page.screenshot({ path: join(tmpdir(), 'easyview-vscode-findframe.png') }); throw error; });
  return found!;
}

async function launch(file: 'book.xlsx' | 'doc.docx' | 'sample.png' | 'sample.pdf') {
  const executablePath = process.env.VSCODE_EXECUTABLE_PATH;
  if (!executablePath) throw new Error('Set VSCODE_EXECUTABLE_PATH to the VS Code executable before running this test');
  const temporary = await mkdtemp(join(tmpdir(), 'easyview-xlsx-vscode-')), workspace = join(temporary, 'workspace');
  await mkdir(workspace); await mkdir(join(temporary, 'data', 'User'), { recursive: true });
  await writeFile(join(temporary, 'data', 'User', 'settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'window.dialogStyle': 'custom', 'workbench.editorAssociations': { '*.xlsx': 'easyviewMd.filePreview', '*.docx': 'easyviewMd.filePreview', '*.png': 'easyviewMd.filePreview', '*.pdf': 'easyviewMd.filePreview' } }));
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('Data');
  for (let r = 1; r <= 6; r += 1) for (let c = 1; c <= 4; c += 1) sheet.getCell(r, c).value = r * 10 + c;
  await book.xlsx.writeFile(join(workspace, 'book.xlsx'));
  const { copyFile } = await import('node:fs/promises');
  await copyFile(resolve(__dirname, '../../../tests/fixtures/preview/sample.docx'), join(workspace, 'doc.docx'));
  await copyFile(resolve(__dirname, '../../../tests/fixtures/preview/sample.png'), join(workspace, 'sample.png'));
  await copyFile(resolve(__dirname, '../../../tests/fixtures/preview/sample.pdf'), join(workspace, 'sample.pdf'));
  const application = await electron.launch({ executablePath, args: [`--user-data-dir=${join(temporary, 'data')}`, `--extensions-dir=${join(temporary, 'extensions')}`, `--extensionDevelopmentPath=${resolve(__dirname, '..')}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', workspace, join(workspace, file)], timeout: 60_000 });
  await keepElectronInBackground(application);
  const page = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setBounds({ x: 0, y: 0, width: 1700, height: 1000 }); });
  return { application, page, workspace, temporary };
}

async function readBook(path: string) { const book = new ExcelJS.Workbook(); await book.xlsx.readFile(path); return book.worksheets[0]; }

test('xlsx toolbar styles persist through the VS Code save bridge; icons are centred', async () => {
  const { application, page, workspace, temporary } = await launch('book.xlsx');
  try {
    const frame = await findFrame(page, '.x-spreadsheet-overlayer');
    const overlay = frame.locator('.x-spreadsheet-overlayer');
    await expect(overlay).toBeVisible();
    await page.waitForTimeout(1000);
    const button = (icon: string) => frame.locator(`.x-spreadsheet-toolbar-btns > .x-spreadsheet-toolbar-btn:has(.x-spreadsheet-icon-img.${icon})`).first();
    const menu = () => frame.locator('.x-spreadsheet-toolbar .x-spreadsheet-dropdown-content:visible');
    const select = async (col: number, row: number) => { await page.keyboard.press('Escape'); await overlay.click({ position: cell(col, row) }); };

    // Centre line: every visible toolbar icon's centre against the toolbar's own centre.
    const deviation = await frame.evaluate(() => {
      const bar = document.querySelector('.x-spreadsheet-toolbar-btns')!.getBoundingClientRect();
      const mid = bar.top + bar.height / 2;
      return Math.max(...[...document.querySelectorAll('.x-spreadsheet-toolbar-btns > .x-spreadsheet-toolbar-btn .x-spreadsheet-icon')]
        .map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0).map((r) => Math.abs(r.top + r.height / 2 - mid)));
    });
    console.log('VSCODE_XLSX_CENTRE_DEVIATION', deviation.toFixed(2));
    expect(deviation).toBeLessThanOrEqual(0.5);
    if (shots) await frame.locator('.preview-spreadsheet-editor').screenshot({ path: join(shots, 'vscode-xlsx-toolbar.png'), clip: undefined }).catch(() => page.screenshot({ path: join(shots, 'vscode-xlsx-toolbar.png') }));

    await select(1, 1); // B2: bold + fill + border
    await button('font-bold').click();
    await button('bgcolor').click(); await expect(menu()).toBeVisible();
    if (shots) await page.screenshot({ path: join(shots, 'vscode-xlsx-color-palette.png') });
    await menu().locator('.x-spreadsheet-color-palette tr:nth-child(2) td:nth-child(5) .x-spreadsheet-color-palette-cell').first().click();
    await button('border-all').click(); await expect(menu()).toBeVisible();
    await menu().locator('.x-spreadsheet-border-palette-left .x-spreadsheet-border-palette-cell').first().click();
    await button('align-left').click(); await expect(menu()).toBeVisible();
    if (shots) await page.screenshot({ path: join(shots, 'vscode-xlsx-dropdown.png') });
    await page.keyboard.press('Escape'); await select(3, 5);
    await select(1, 3); const box = (await overlay.boundingBox())!;
    await page.mouse.down(); await page.mouse.move(box.x + cell(2, 3).x, box.y + cell(2, 3).y); await page.mouse.up();
    await button('merge').click(); // B4:C4
    await select(2, 2); await expect(button('freeze')).toBeVisible(); await button('freeze').click(); // C3
    await expect(button('freeze')).toHaveClass(/active/);
    await select(0, 0); await button('autofilter').click();
    if (shots) await page.screenshot({ path: join(shots, 'vscode-xlsx-sheet-bar.png') });

    await frame.locator('[data-easyview-spreadsheet-chrome] button').filter({ hasText: /保存|Save/ }).first()
      .or(frame.locator('[data-easyview-spreadsheet-chrome] button[aria-label="保存"], [data-easyview-spreadsheet-chrome] button[aria-label="Save"]').first()).first().click();
    const xlsx = join(workspace, 'book.xlsx');
    await expect.poll(async () => (await readBook(xlsx)).getCell('B2').font?.bold ?? false, { timeout: 30_000 }).toBe(true);
    const ws = await readBook(xlsx); const b2 = ws.getCell('B2');
    expect((b2.fill as ExcelJS.FillPattern).fgColor?.argb).toBeTruthy();
    expect(b2.border?.top?.style).toBeTruthy(); expect(b2.border?.left?.style).toBeTruthy();
    expect((ws.model as { merges?: string[] }).merges).toContain('B4:C4');
    expect(ws.views[0]).toMatchObject({ state: 'frozen', xSplit: 2, ySplit: 2 });
    expect(ws.autoFilter).toBeTruthy();
  } finally { await terminateElectron(application); await rm(temporary, { recursive: true, force: true }); }
});

test('xlsx cells and the cell editor accept text pasted from the system clipboard in VS Code', async () => {
  const { application, page, workspace, temporary } = await launch('book.xlsx');
  try {
    const frame = await findFrame(page, '.x-spreadsheet-overlayer');
    const overlay = frame.locator('.x-spreadsheet-overlayer');
    await expect(overlay).toBeVisible();
    await page.waitForTimeout(1000);
    const paste = async (text: string) => {
      await application.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
      await page.keyboard.press('ControlOrMeta+V');
    };
    await overlay.click({ position: cell(1, 1) }); await paste('hello'); // B2
    await overlay.click({ position: cell(2, 2) }); await paste('a\the said "hi"\nc\td\n'); // C3:D4
    await overlay.click({ position: cell(0, 0) }); await page.keyboard.press('ControlOrMeta+C');
    await overlay.click({ position: cell(0, 6) }); await paste('fresh'); // A7: newer external text beats the internal copy
    await overlay.dblclick({ position: cell(3, 0) }); await paste('+x'); await page.keyboard.press('Enter'); // D1 while editing
    await frame.locator('[data-easyview-spreadsheet-chrome] button').filter({ hasText: /保存|Save/ }).first()
      .or(frame.locator('[data-easyview-spreadsheet-chrome] button[aria-label="保存"], [data-easyview-spreadsheet-chrome] button[aria-label="Save"]').first()).first().click();
    const xlsx = join(workspace, 'book.xlsx');
    await expect.poll(async () => String((await readBook(xlsx)).getCell('B2').value), { timeout: 30_000 }).toBe('hello');
    const ws = await readBook(xlsx);
    expect(['C3', 'D3', 'C4', 'D4', 'A7', 'D1'].map((address) => String(ws.getCell(address).value)))
      .toEqual(['a', 'he said "hi"', 'c', 'd', 'fresh', '14+x']);
  } finally { await terminateElectron(application); await rm(temporary, { recursive: true, force: true }); }
});

test('image toolbar rotates and crops a png and saves it through the VS Code bridge', async () => {
  const { application, page, workspace, temporary } = await launch('sample.png');
  try {
    const frame = await findFrame(page, 'button[aria-label="向右旋转"], button[aria-label="Rotate Right"]');
    const named = (zh: string, en: string) => frame.locator(`button[aria-label="${zh}"], button[aria-label="${en}"]`).first();
    await named('向右旋转', 'Rotate Right').click();
    const picture = frame.locator('.image-stage .image-frame');
    await expect.poll(async () => { const box = (await picture.boundingBox())!; return box.height > box.width; }).toBe(true);
    await named('裁剪', 'Crop').click();
    const crop = picture.locator('.preview-image-crop');
    await expect(crop.locator('.preview-image-crop-size')).toHaveText('192 × 384');
    await named('保存', 'Save').click();
    await expect(crop).toHaveCount(0);
    const { readFile } = await import('node:fs/promises');
    const size = async () => { const bytes = await readFile(join(workspace, 'sample.png')); return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]; };
    await expect.poll(size, { timeout: 30_000 }).toEqual([192, 384]);
    const shown = frame.locator('.preview-universal-viewer img').first();
    await expect.poll(() => shown.evaluate((img: HTMLImageElement) => `${img.naturalWidth}×${img.naturalHeight}`)).toBe('192×384');
  } finally { await terminateElectron(application); await rm(temporary, { recursive: true, force: true }); }
});

test('pdf toolbar shows match navigation only after a search; paging lives in the bottom bar', async () => {
  const { application, page, temporary } = await launch('sample.pdf');
  try {
    const frame = await findFrame(page, '.pdfViewer .page');
    const search = frame.locator('.file-viewer-web-search');
    const matchNav = search.locator('button:not([type="submit"]), .file-viewer-web-search-count');
    await expect(search.locator('input[type="search"]')).toBeVisible();
    await expect(matchNav.filter({ visible: true })).toHaveCount(0);
    await expect(frame.locator('.preview-statusbar .preview-page-controls')).toBeVisible();
    await search.locator('input[type="search"]').fill('e');
    await search.locator('input[type="search"]').press('Enter');
    await expect(search.locator('.file-viewer-web-search-count')).toBeVisible();
    await search.locator('button[aria-label="清除搜索"], button[aria-label="Clear search"]').click();
    await expect(matchNav.filter({ visible: true })).toHaveCount(0);
    if (shots) await page.screenshot({ path: join(shots, 'vscode-pdf-search.png') });
  } finally { await terminateElectron(application); await rm(temporary, { recursive: true, force: true }); }
});

test('docx chrome buttons work in VS Code: sidebar, save, export, print, theme', async () => {
  const { application, page, workspace, temporary } = await launch('doc.docx');
  try {
    const frame = await findFrame(page, '.paged-editor__pages');
    await expect(frame.locator('.paged-editor__pages .layout-paragraph').first()).toBeVisible();
    await page.waitForTimeout(800);
    if (shots) await page.screenshot({ path: join(shots, 'vscode-docx-toolbar.png') });
    const chrome = (label: string) => frame.locator(`button[aria-label^="${label}"]`).first();

    // Sidebar toggle shows/hides the outline rail.
    const shell = frame.locator('[data-preview-sidebar]').first();
    const sidebar0 = await shell.getAttribute('data-preview-sidebar');
    await chrome('Toggle sidebar').click(); await expect(shell).not.toHaveAttribute('data-preview-sidebar', sidebar0!);
    await chrome('Toggle sidebar').click(); await expect(shell).toHaveAttribute('data-preview-sidebar', sidebar0!);

    // Save: bold the first paragraph, Save, and find <w:b/> in the file on disk.
    await frame.locator('.paged-editor__pages .layout-paragraph').first().click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await chrome('Bold').click();
    await chrome('Save').click();
    const JSZip = (await import('jszip')).default;
    const { readFile } = await import('node:fs/promises');
    await expect.poll(async () => (await (await JSZip.loadAsync(await readFile(join(workspace, 'doc.docx')))).file('word/document.xml')!.async('string')).includes('<w:b/>'), { timeout: 30_000 }).toBe(true);

    // Export and Print: record the download anchor and the print window instead of OS dialogs.
    await frame.evaluate(() => {
      const w = window as Window & { __downloads?: string[]; __prints?: number };
      w.__downloads = []; w.__prints = 0;
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { if (this.download) { w.__downloads!.push(this.download); return; } return click.call(this); };
      const record = () => { w.__prints! += 1; };
      window.print = record;
      const open = window.open.bind(window);
      window.open = (...args: Parameters<typeof window.open>) => { const opened = open(...args); if (opened) opened.print = () => { record(); opened.close(); }; else record(); return opened; };
    });
    await chrome('Export').click();
    await expect.poll(() => frame.evaluate(() => (window as Window & { __downloads?: string[] }).__downloads ?? [])).toEqual([expect.stringMatching(/\.docx$/)]);
    await chrome('Print').click();
    await expect.poll(() => frame.evaluate(() => (window as Window & { __prints?: number }).__prints ?? 0)).toBeGreaterThan(0);

    // Theme cycles light -> gray -> dark -> light for this file.
    const theme = frame.locator('button[aria-label$="(click to change for this file)"]').first();
    const labels: string[] = [];
    for (let step = 0; step < 3; step += 1) { labels.push((await theme.getAttribute('aria-label'))!); await theme.click(); await expect(theme).not.toHaveAttribute('aria-label', labels.at(-1)!); }
    expect(new Set(labels).size).toBe(3);
    await expect(theme).toHaveAttribute('aria-label', labels[0]);
  } finally { await terminateElectron(application); await rm(temporary, { recursive: true, force: true }); }
});
