import { _electron as electron, expect, test, type Frame } from '@playwright/test';
import { copyFile, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { keepElectronInBackground, terminateElectron } from '../../desktop/e2e/support/electronApp';

for (const name of ['sample.docx', 'sample.xlsx']) {
  test(`the tree rename field keeps pasted text while ${name} opens; right-click does not open the file menu`, async () => {
    test.setTimeout(120_000);
    const temporary = await mkdtemp(join(tmpdir(), 'easyview-rename-paste-vscode-'));
    const workspace = join(temporary, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'notes.md'), '# Notes\n');
    await copyFile(resolve(__dirname, '../../../tests/fixtures/preview', name), join(workspace, name));
    await mkdir(join(temporary, 'data', 'User'), { recursive: true });
    await writeFile(join(temporary, 'data', 'User', 'settings.json'), JSON.stringify({
      'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'easyviewMd.workspace.focusFilesOnStartup': true,
    }));
    const application = await electron.launch({
      executablePath: process.env.VSCODE_EXECUTABLE_PATH!,
      args: [`--user-data-dir=${join(temporary, 'data')}`, `--extensions-dir=${join(temporary, 'extensions')}`,
        `--extensionDevelopmentPath=${resolve(__dirname, '..')}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', workspace],
      timeout: 60_000,
    });
    await keepElectronInBackground(application);
    try {
      const page = await application.firstWindow();
      let sidebar: Frame | undefined;
      await expect.poll(async () => {
        for (const frame of page.frames()) if (await frame.locator(`.workspace-entry[data-relative-path="${name}"]`).count()) { sidebar = frame; return true; }
        return false;
      }, { timeout: 60_000 }).toBe(true);
      const tree = sidebar!;
      const extension = extname(name);
      await application.evaluate(({ clipboard }) => clipboard.writeText('粘贴'));

      // Clicking opens the file; the rename starts before its editor has finished loading.
      await tree.locator(`.workspace-entry[data-relative-path="${name}"] .workspace-entry-name`).click();
      await tree.locator(`.workspace-entry[data-relative-path="${name}"]`).click({ button: 'right' });
      await tree.locator('.workspace-file-context-menu button', { hasText: 'Rename' }).click();
      const input = tree.locator('.workspace-rename-input');
      await expect(input).toBeFocused();
      await page.keyboard.press('Meta+V');
      await expect(input).toHaveValue(`粘贴${extension}`);

      await expect(page.locator('.tab.active', { hasText: name })).toBeVisible({ timeout: 30_000 });
      await writeFile(join(workspace, `.~lock${extension}`), 'lock');
      await page.waitForTimeout(3000);
      await expect(input).toBeFocused();
      await expect(input).toHaveValue(`粘贴${extension}`);

      await input.click({ button: 'right' });
      await page.waitForTimeout(300);
      await expect(tree.locator('.workspace-file-context-menu')).toBeHidden();
      await expect(input).toHaveValue(`粘贴${extension}`);

      // Leaving the window to copy a name blurs the field while the view reports no focus.
      await input.evaluate((element) => {
        document.hasFocus = () => false;
        element.dispatchEvent(new FocusEvent('blur'));
        Reflect.deleteProperty(document, 'hasFocus');
      });
      await expect(input).toHaveValue(`粘贴${extension}`);
      await input.press('Enter');
      await expect.poll(async () => (await readdir(workspace)).includes(`粘贴${extension}`)).toBe(true);
    } finally {
      await terminateElectron(application);
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
