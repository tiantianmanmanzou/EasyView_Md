import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { resumeRestoredSession, terminateElectron } from './support/electronApp';

// Grid geometry for the generated book: row header 60px, column 100px, rows at the file's 15pt default (20px).
const cell = (col: number, row: number) => ({ x: 60 + col * 100 + 50, y: 20 + row * 20 + 10 });
const button = (page: Page, icon: string) => page.locator(`.x-spreadsheet-toolbar-btns > .x-spreadsheet-toolbar-btn:has(.x-spreadsheet-icon-img.${icon})`).first();
const openMenu = (page: Page) => page.locator('.x-spreadsheet-toolbar .x-spreadsheet-dropdown-content:visible');

async function launch(width: number) {
  const temporary = await mkdtemp(path.join(process.cwd(), '.xlsx-toolbar-e2e-'));
  const workspace = path.join(temporary, 'workspace'), userData = path.join(temporary, 'user-data');
  await mkdir(workspace); await mkdir(userData);
  const xlsx = path.join(workspace, 'book.xlsx');
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('Data');
  for (let r = 1; r <= 6; r += 1) for (let c = 1; c <= 4; c += 1) sheet.getCell(r, c).value = r * 10 + c;
  await book.xlsx.writeFile(xlsx);
  const markdown = path.join(workspace, 'notes.md'); await writeFile(markdown, '# Notes\n');
  await writeFile(path.join(userData, 'desktop-state.json'), JSON.stringify({ recentFiles: [markdown], workspace: { rootPath: workspace, openTabs: [{ id: 'notes', kind: 'editor', filePath: markdown }], activeTabId: 'notes', expandedRelativePaths: [], explorerVisible: true, outlineVisible: false, explorerWidth: 240, outlineWidth: 240 } }));
  const application = await electron.launch({ args: [process.cwd(), `--user-data-dir=${userData}`], env: { ...process.env, EASYVIEW_DISABLE_UPDATE_CHECK: '1' } });
  const page = await application.firstWindow(); await resumeRestoredSession(page);
  await application.evaluate(({ BrowserWindow }, w) => { BrowserWindow.getAllWindows()[0].setSize(w, 800); }, width);
  await page.evaluate(async () => { await (window as any).easyViewDesktop.tabs.openWorkspaceEntry('book.xlsx'); });
  const overlay = page.locator('.x-spreadsheet-overlayer'); await expect(overlay).toBeVisible();
  let previous = '';
  await expect.poll(async () => { const box = JSON.stringify(await overlay.boundingBox()); const stable = box === previous; previous = box; return stable; }, { intervals: [150] }).toBe(true);
  return { application, page, overlay, xlsx, temporary };
}

async function readBook(xlsx: string) { const book = new ExcelJS.Workbook(); await book.xlsx.readFile(xlsx); return book.worksheets[0]; }

test('every working xlsx toolbar button changes the cell and survives save', async () => {
  let application: ElectronApplication | undefined; let temporary = '';
  try {
    const opened = await launch(1400); application = opened.application; temporary = opened.temporary;
    const { page, overlay, xlsx } = opened;
    const select = async (col: number, row: number) => { await page.keyboard.press('Escape'); await overlay.click({ position: cell(col, row) }); };
    const pick = async (icon: string, item: string) => { await button(page, icon).click(); const menu = openMenu(page); await expect(menu).toBeVisible(); await menu.locator(item).first().click(); };

    // Dropdowns must be on top of the grid's overlayer so they can be clicked.
    await button(page, 'color').first().click();
    const hit = await openMenu(page).evaluate((menu) => { const r = menu.getBoundingClientRect(); return menu.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); });
    expect(hit).toBe(true); await page.keyboard.press('Escape'); await overlay.click({ position: cell(3, 5) });

    await select(1, 1); // B2
    for (const icon of ['font-bold', 'font-italic', 'underline', 'strike']) await button(page, icon).click();
    await pick('color', '.x-spreadsheet-color-palette tr:nth-child(2) td:nth-child(4) .x-spreadsheet-color-palette-cell');
    await pick('bgcolor', '.x-spreadsheet-color-palette tr:nth-child(2) td:nth-child(5) .x-spreadsheet-color-palette-cell');
    await pick('border-all', '.x-spreadsheet-border-palette-left .x-spreadsheet-border-palette-cell');
    await pick('align-left', '.x-spreadsheet-item:has(.align-center)');
    await pick('align-middle', '.x-spreadsheet-item:has(.align-top)');
    await button(page, 'textwrap').click();
    await select(2, 1); await button(page, 'font-bold').click(); await button(page, 'undo').click(); await button(page, 'redo').click(); // C2 bold via redo
    await select(1, 3); await page.mouse.down(); await page.mouse.move((await overlay.boundingBox())!.x + cell(2, 3).x, (await overlay.boundingBox())!.y + cell(2, 3).y); await page.mouse.up();
    await button(page, 'merge').click(); // B4:C4
    await select(3, 2); await button(page, 'font-bold').click(); await button(page, 'clearformat').click(); // D3 bold then cleared

    const tip = (name: string) => page.locator(`.x-spreadsheet-toolbar-btns > .x-spreadsheet-toolbar-btn[data-tooltip="${name}"]`).first();
    const pickTip = async (name: string, nth: number) => { await tip(name).click(); const menu = openMenu(page); await expect(menu).toBeVisible(); await menu.locator('.x-spreadsheet-item').nth(nth).click(); };
    await select(0, 2); // A3
    await pickTip('Format', 4); // percent
    await pickTip('Font', 2);
    await pickTip('Font size', 7);
    await select(1, 1); await button(page, 'paintformat').click(); await overlay.click({ position: cell(1, 5) }); // B2 format -> B6
    await select(2, 2); await button(page, 'freeze').click(); // freeze at C3
    await select(0, 0); await button(page, 'autofilter').click(); // filter on A1
    await select(3, 5); await button(page, 'formula').click(); await openMenu(page).locator('.x-spreadsheet-item').first().click();
    await page.keyboard.press('Enter'); // D6 = SUM(...)

    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(async () => (await readBook(xlsx)).getCell('B2').font?.bold ?? false).toBe(true);
    const extra = await readBook(xlsx);
    const a3 = extra.getCell('A3');
    expect(a3.numFmt).toMatch(/%/);
    expect(a3.font?.name).toBeTruthy(); expect(a3.font?.name).not.toBe('Calibri');
    expect(a3.font?.size).toBeTruthy(); expect(a3.font?.size).not.toBe(11);
    expect(extra.getCell('B6').font?.bold).toBe(true);
    expect(extra.views[0]).toMatchObject({ state: 'frozen', xSplit: 2, ySplit: 2 });
    expect(extra.autoFilter).toBeTruthy();
    expect(String(extra.getCell('D6').formula ?? extra.getCell('D6').value)).toMatch(/SUM/i);
    const ws = await readBook(xlsx); const b2 = ws.getCell('B2');
    expect(b2.font).toMatchObject({ bold: true, italic: true, strike: true });
    expect(b2.font.underline).toBeTruthy();
    expect(b2.font.color?.argb).toBeTruthy();
    expect((b2.fill as ExcelJS.FillPattern).fgColor?.argb).toBeTruthy();
    expect(b2.border?.top?.style).toBeTruthy(); expect(b2.border?.left?.style).toBeTruthy();
    expect(b2.alignment).toMatchObject({ horizontal: 'center', vertical: 'top', wrapText: true });
    expect(ws.getCell('C2').font?.bold).toBe(true);
    expect(ws.getCell('D3').font?.bold).toBeFalsy();
    expect((ws.model as { merges?: string[] }).merges).toContain('B4:C4');
  } finally { await terminateElectron(application); if (temporary) await rm(temporary, { recursive: true, force: true }); }
});

test('text from the system clipboard pastes into cells and into the cell editor', async () => {
  let application: ElectronApplication | undefined; let temporary = '';
  try {
    const opened = await launch(1400); application = opened.application; temporary = opened.temporary;
    const { page, overlay, xlsx } = opened;
    // Same path as Cmd/Ctrl+V through the app's Edit menu.
    const paste = (text: string) => opened.application.evaluate(({ BrowserWindow, clipboard }, value) => {
      clipboard.writeText(value); BrowserWindow.getAllWindows()[0].webContents.paste();
    }, text);
    await overlay.click({ position: cell(1, 1) }); await paste('hello'); // B2: no trailing newline
    await overlay.click({ position: cell(2, 2) }); await paste('a\the said "hi"\nc\td\n'); // C3:D4
    await overlay.click({ position: cell(0, 0) }); await page.keyboard.press('ControlOrMeta+C');
    await overlay.click({ position: cell(0, 6) }); await paste('fresh'); // A7: newer external text beats the internal copy
    await overlay.dblclick({ position: cell(3, 0) }); await paste('+x'); await page.keyboard.press('Enter'); // D1 while editing
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(async () => String((await readBook(xlsx)).getCell('B2').value)).toBe('hello');
    const ws = await readBook(xlsx);
    expect(['C3', 'D3', 'C4', 'D4', 'A7', 'D1'].map((address) => String(ws.getCell(address).value)))
      .toEqual(['a', 'he said "hi"', 'c', 'd', 'fresh', '14+x']);
  } finally { await terminateElectron(application); if (temporary) await rm(temporary, { recursive: true, force: true }); }
});

for (const width of [900, 700]) {
  test(`xlsx toolbar overflow never covers EasyView buttons at ${width}px`, async () => {
    let application: ElectronApplication | undefined; let temporary = '';
    try {
      const opened = await launch(width); application = opened.application; temporary = opened.temporary;
      const { page } = opened;
      const expand = page.getByRole('button', { name: '展开预览工具栏' }); if (await expand.isVisible()) await expand.click();
      const layout = await page.evaluate(() => {
        const chrome = document.querySelector('[data-easyview-spreadsheet-chrome]')!.getBoundingClientRect();
        const buttons = [...document.querySelectorAll('.x-spreadsheet-toolbar-btns > .x-spreadsheet-toolbar-btn, .x-spreadsheet-toolbar-btns > .x-spreadsheet-toolbar-divider')]
          .map((element) => element.getBoundingClientRect()).filter((rect) => rect.width > 0);
        const toolbar = document.querySelector('.x-spreadsheet-toolbar')!;
        return { chromeLeft: chrome.left, chromeWidth: chrome.width, maxRight: Math.max(...buttons.map((rect) => rect.right)), toolbarScroll: toolbar.scrollHeight - toolbar.clientHeight };
      });
      expect(layout.chromeWidth).toBeGreaterThan(0);
      expect(layout.maxRight).toBeLessThanOrEqual(layout.chromeLeft);
      // Nothing from x-spreadsheet sits on top of our buttons (the Windows CI failure).
      const onTop = await page.evaluate(() => [...document.querySelectorAll('[data-easyview-spreadsheet-chrome] button')].map((element) => {
        const r = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }));
      expect(onTop.length).toBeGreaterThan(0); expect(onTop.every(Boolean)).toBe(true);
    } finally { await terminateElectron(application); if (temporary) await rm(temporary, { recursive: true, force: true }); }
  });
}

test('xlsx sheet bar matches the toolbar height and never scrolls vertically', async () => {
  let application: ElectronApplication | undefined; let temporary = '';
  try {
    const opened = await launch(1200); application = opened.application; temporary = opened.temporary;
    const metrics = await opened.page.evaluate(() => {
      const tabs = document.querySelector('.preview-spreadsheet-tabs') as HTMLElement; const style = getComputedStyle(tabs);
      const tab = tabs.querySelector('[role="tab"]') as HTMLElement;
      const editor = document.querySelector('.preview-spreadsheet-editor')!.getBoundingClientRect();
      return { height: tabs.getBoundingClientRect().height, overflowY: style.overflowY, overflowing: tabs.scrollHeight - tabs.clientHeight, font: getComputedStyle(tab).fontSize, bottomGap: Math.abs(editor.bottom - tabs.getBoundingClientRect().bottom), editorOverflow: (document.querySelector('.preview-spreadsheet-editor') as HTMLElement).scrollHeight - (document.querySelector('.preview-spreadsheet-editor') as HTMLElement).clientHeight };
    });
    expect(metrics).toMatchObject({ height: 24, overflowY: 'hidden', overflowing: 0, font: '12px', editorOverflow: 0 });
    expect(metrics.bottomGap).toBeLessThanOrEqual(1);
  } finally { await terminateElectron(application); if (temporary) await rm(temporary, { recursive: true, force: true }); }
});

test('xlsx print preview, theme and the overflow menu work', async () => {
  let application: ElectronApplication | undefined; let temporary = '';
  try {
    const opened = await launch(1400); application = opened.application; temporary = opened.temporary;
    const { page } = opened;
    // Print: x-spreadsheet opens its own print preview overlay; cancel closes it without printing.
    await button(page, 'print').click();
    const preview = page.locator('.x-spreadsheet-print');
    await expect(preview).toBeVisible();
    await expect(preview.locator('canvas').first()).toBeVisible();
    await preview.locator('.x-spreadsheet-print-bar .x-spreadsheet-button').first().click();
    await expect(preview).toBeHidden();
    // Theme: per-file theme toggle repaints the spreadsheet surface.
    const paint = () => page.locator('#file-preview-root').evaluate((root) => getComputedStyle(root).backgroundColor);
    const before = await paint();
    const theme = page.locator('[data-easyview-spreadsheet-chrome] button[title*="主题"]');
    await theme.click(); await expect.poll(paint).not.toBe(before);
    await theme.click(); await theme.click(); await expect.poll(paint).toBe(before);
    // More: hidden when every button fits; at a narrow width overflow items land in the menu.
    const more = page.locator('.x-spreadsheet-toolbar-btns > .x-spreadsheet-toolbar-btn:has(.x-spreadsheet-icon-img.ellipsis)');
    await expect(more).toBeHidden();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 800));
    await expect(more).toBeVisible();
    await more.click();
    const menu = more.locator('.x-spreadsheet-dropdown-content').first();
    await expect(menu).toBeVisible();
    expect(await menu.locator('.x-spreadsheet-toolbar-btn').count()).toBeGreaterThan(0);
    await menu.locator('.x-spreadsheet-toolbar-btn').first().click();
    const inside = await menu.evaluate((element) => { const r = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + 10)); });
    expect(inside).toBe(true);
  } finally { await terminateElectron(application); if (temporary) await rm(temporary, { recursive: true, force: true }); }
});
