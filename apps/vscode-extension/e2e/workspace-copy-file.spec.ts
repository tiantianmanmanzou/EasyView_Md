import { _electron as electron, expect, test, type Frame } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { keepElectronInBackground, terminateElectron } from '../../desktop/e2e/support/electronApp';

function pasteboardFilePaths(): string[] {
  const script = 'ObjC.import("AppKit"); const items = $.NSPasteboard.generalPasteboard.pasteboardItems; const out = [];'
    + ' for (let i = 0; i < items.count; i++) { const url = items.objectAtIndex(i).stringForType("public.file-url"); if (!url.isNil()) out.push($.NSURL.URLWithString(url).path.js); }'
    + ' out.join("\\n")';
  return execFileSync('osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map((path) => realpathSync(path));
}

test('Copy File puts the file or folder itself on the system clipboard', async () => {
  test.skip(process.platform !== 'darwin', 'reads the macOS pasteboard');
  test.setTimeout(120_000);
  const temporary = await mkdtemp(join(tmpdir(), 'easyview-copy-file-vscode-'));
  const workspace = join(temporary, 'workspace');
  await mkdir(join(workspace, 'docs'), { recursive: true });
  await writeFile(join(workspace, 'notes.md'), '# Notes\n');
  await mkdir(join(temporary, 'data', 'User'), { recursive: true });
  await writeFile(join(temporary, 'data', 'User', 'settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'easyviewMd.workspace.focusFilesOnStartup': true,
  }));
  const executablePath = process.env.VSCODE_EXECUTABLE_PATH;
  if (!executablePath) throw new Error('Set VSCODE_EXECUTABLE_PATH to the VS Code executable before running this test');
  const application = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${join(temporary, 'data')}`, `--extensions-dir=${join(temporary, 'extensions')}`,
      `--extensionDevelopmentPath=${resolve(__dirname, '..')}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', workspace],
    timeout: 60_000,
  });
  await keepElectronInBackground(application);
  try {
    const page = await application.firstWindow();
    let sidebar: Frame | undefined;
    await expect.poll(async () => {
      for (const frame of page.frames()) if (await frame.locator('.workspace-entry[data-relative-path="docs"]').count()) { sidebar = frame; return true; }
      return false;
    }, { timeout: 60_000 }).toBe(true);
    const tree = sidebar!;
    const copyFileFromMenu = async (relativePath: string) => {
      await tree.locator(`.workspace-entry[data-relative-path="${relativePath}"]`).click({ button: 'right' });
      await tree.locator('.workspace-file-context-menu button', { hasText: 'Copy File' }).click();
    };

    await copyFileFromMenu('notes.md');
    await expect.poll(pasteboardFilePaths).toEqual([realpathSync(join(workspace, 'notes.md'))]);
    await copyFileFromMenu('docs');
    await expect.poll(pasteboardFilePaths).toEqual([realpathSync(join(workspace, 'docs'))]);

    const clipboardText = () => application.evaluate(({ clipboard }) => clipboard.readText());
    await tree.locator('.workspace-entry[data-relative-path="notes.md"]').dblclick();
    await expect(page.locator('.tab', { hasText: 'notes.md' }).first()).toBeVisible();
    await tree.locator('.workspace-entry[data-relative-path="docs"]').click();
    await tree.locator('.workspace-entry[data-relative-path="notes.md"]').click({ modifiers: ['Meta'] });
    await page.keyboard.press('Meta+Alt+KeyC');
    await expect.poll(async () => (await clipboardText()).split('\n').map((path) => realpathSync(path)))
      .toEqual([realpathSync(join(workspace, 'docs')), realpathSync(join(workspace, 'notes.md'))]);
    await page.keyboard.press('Meta+Shift+Alt+KeyC');
    await expect.poll(clipboardText).toBe('docs\nnotes.md');
  } finally {
    await terminateElectron(application);
    await rm(temporary, { recursive: true, force: true });
  }
});
