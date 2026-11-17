import { _electron as electron, expect, test, type ElectronApplication, type Frame } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import JSZip from 'jszip';
import { nestedFieldsDocx } from '../../../tests/fixtures/docx/nestedFields';
import { keepElectronInBackground, terminateElectron } from '../../desktop/e2e/support/electronApp';

test('nested table of contents renders on a new page and survives save in VS Code', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'easyview-vscode-fields-'));
  const workspace = join(temporary, 'workspace');
  await mkdir(workspace); await mkdir(join(temporary, 'data', 'User'), { recursive: true });
  await writeFile(join(temporary, 'data', 'User', 'settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none',
    'workbench.editorAssociations': { '*.docx': 'easyviewMd.filePreview' },
  }));
  const file = join(workspace, 'nested.docx');
  await writeFile(file, await nestedFieldsDocx(resolve(__dirname, '../../..')));
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ executablePath: process.env.VSCODE_EXECUTABLE_PATH, args: [
      `--user-data-dir=${join(temporary, 'data')}`, `--extensions-dir=${join(temporary, 'extensions')}`,
      `--extensionDevelopmentPath=${resolve(__dirname, '..')}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', workspace, file,
    ], timeout: 60_000 });
    await keepElectronInBackground(app); const page = await app.firstWindow(); let frame: Frame | undefined;
    await expect.poll(async () => {
      for (const f of page.frames()) if (await f.locator('.paged-editor__pages .layout-page').count()) { frame = f; return true; }
      return false;
    }, { timeout: 60_000 }).toBe(true);
    const pages = frame!.locator('.paged-editor__pages .layout-page');
    await expect(pages.first()).toContainText('Fixture cover');
    await expect(pages.nth(1)).toContainText('First heading');
    await expect(pages.nth(1)).toContainText('Second heading');
    await expect(pages.nth(1)).toContainText('1');
    await expect(pages.nth(1)).toContainText('2');
    await expect(pages.nth(1).locator('.layout-run-tab')).toHaveCount(2);
    await expect(pages.nth(1).locator('.layout-run-tab').first()).toContainText('.');
    await pages.first().locator('.layout-paragraph', { hasText: 'Fixture cover' }).click();
    await page.keyboard.press('End'); await page.keyboard.type(' UPDATED');
    await frame!.getByRole('button', { name: /^(保存|Save)$/ }).first().click();
    const xml = async () => (await JSZip.loadAsync(await readFile(file))).file('word/document.xml')!.async('string');
    await expect.poll(async () => (await xml()).includes('UPDATED'), { timeout: 30_000 }).toBe(true);
    const saved = await xml();
    for (const [pattern, count] of [[/w:fldCharType="begin"/g, 5], [/w:fldCharType="end"/g, 5], [/HYPERLINK/g, 2], [/PAGEREF/g, 2]] as const) {
      expect((saved.match(pattern) ?? []).length).toBe(count);
    }
  } finally { if (app) await terminateElectron(app); await rm(temporary, { recursive: true, force: true }); }
});
