import { expect, test, type Locator } from '@playwright/test';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchPreviewWorkspace } from './support/previewWorkspace';

const loaded: Record<string, string> = {
  'sample.docx': '.paged-editor__pages .layout-page',
  'sample.xlsx': '.x-spreadsheet-sheet canvas',
};

for (const [name, content] of Object.entries(loaded)) {
  test(`the tree rename field keeps pasted text while ${name} opens, and offers a text edit menu`, async () => {
    const ws = await launchPreviewWorkspace();
    const { page, application } = ws;
    try {
      await application.evaluate(({ Menu, clipboard }) => {
        const menus: string[][] = [];
        (globalThis as typeof globalThis & { __menus?: string[][] }).__menus = menus;
        Menu.prototype.popup = function popup() { menus.push(this.items.map((item) => item.label)); };
        clipboard.writeText('粘贴');
      });
      // Clicking opens the file; the rename starts before its preview has finished loading.
      await page.locator(`.workspace-entry[data-relative-path="${name}"] .workspace-entry-name`).click();
      await page.keyboard.press('F2');
      const input = page.locator('.workspace-rename-input');
      await expect(input).toBeFocused();
      await page.keyboard.press('Meta+V');
      const extension = path.extname(name);
      await expect(input).toHaveValue(`粘贴${extension}`);

      // Neither the loaded viewer nor a file-system change (e.g. an office lock file) may end the edit.
      await expect(page.locator(content).first()).toBeVisible({ timeout: 30_000 });
      await writeFile(path.join(ws.workspace, `.~lock${extension}`), 'lock');
      await page.waitForTimeout(500);
      await expect(input).toBeFocused();
      await expect(input).toHaveValue(`粘贴${extension}`);

      await input.click({ button: 'right' });
      const menus = () => application.evaluate(() => (globalThis as typeof globalThis & { __menus?: string[][] }).__menus ?? []);
      await expect.poll(menus).toEqual([['撤销', '重做', '', '剪切', '复制', '粘贴', '全选']]);
      await expect(input).toBeFocused();
      await input.press('Home');
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.paste());
      await expect(input).toHaveValue(`粘贴粘贴${extension}`);

      await input.press('Enter');
      await expect.poll(async () => (await readdir(ws.workspace)).includes(`粘贴粘贴${extension}`)).toBe(true);
    } finally {
      await ws.dispose();
    }
  });
}

test('leaving the window to copy a name keeps the tree rename and new-file fields open', async () => {
  const ws = await launchPreviewWorkspace();
  const { page, application } = ws;
  // Playwright keeps the window focused; leaving it shows up as a blur while the page reports no focus.
  const leaveWindow = (field: Locator) => field.evaluate((element) => {
    document.hasFocus = () => false;
    element.dispatchEvent(new FocusEvent('blur'));
    Reflect.deleteProperty(document, 'hasFocus');
  });
  try {
    await page.locator('.workspace-entry[data-relative-path="sample.xlsx"] .workspace-entry-name').click();
    await page.keyboard.press('F2');
    const input = page.locator('.workspace-rename-input');
    await expect(input).toBeFocused();
    await leaveWindow(input);
    await application.evaluate(({ clipboard }) => clipboard.writeText('粘贴'));
    await expect(input).toBeFocused();
    await page.keyboard.press('Meta+V');
    await expect(input).toHaveValue('粘贴.xlsx');
    await input.press('Enter');
    await expect.poll(async () => (await readdir(ws.workspace)).includes('粘贴.xlsx')).toBe(true);

    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('workspace.contextCommand', 'beginCreateFile', '', '.md'));
    const name = page.locator('.workspace-create-row input');
    await expect(name).toBeFocused();
    await name.fill('');
    await leaveWindow(name);
    await expect(name).toBeFocused();
    await page.keyboard.press('Meta+V');
    await expect(name).toHaveValue('粘贴');
    await name.press('Enter');
    await expect.poll(async () => (await readdir(ws.workspace)).some((file) => file.startsWith('粘贴') && file !== '粘贴.xlsx')).toBe(true);
  } finally {
    await ws.dispose();
  }
});
