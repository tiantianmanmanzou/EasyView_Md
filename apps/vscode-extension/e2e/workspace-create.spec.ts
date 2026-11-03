import { _electron as electron, expect, test, type Frame } from '@playwright/test';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { keepElectronInBackground, terminateElectron } from '../../desktop/e2e/support/electronApp';

test('new files and folders in a collapsed folder start in name editing, then end selected', async () => {
  test.setTimeout(120_000);
  const temporary = await mkdtemp(join(tmpdir(), 'easyview-create-vscode-'));
  const workspace = join(temporary, 'workspace');
  await mkdir(join(workspace, 'docs'), { recursive: true });
  await writeFile(join(workspace, 'notes.md'), '# Notes\n');
  await writeFile(join(workspace, 'docs', 'guide.md'), '# Guide\n');
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
    const input = tree.locator('.workspace-create-row input');
    const menuItem = (label: string) => tree.locator('.workspace-file-context-menu button', { hasText: label });
    const entry = (relativePath: string) => tree.locator(`.workspace-entry[data-relative-path="${relativePath}"]`);

    await entry('docs').click({ button: 'right' });
    await menuItem('New Folder').click();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Untitled Folder');
    await input.fill('Assets');
    await input.press('Enter');
    await expect(entry('docs/Assets')).toHaveClass(/selected/);

    await entry('docs').click({ button: 'right' });
    await menuItem('New File').hover();
    await menuItem('Markdown (.md)').click();
    await expect(input).toBeFocused();
    await input.fill('Plan.md');
    const box = (await tree.locator('.workspace-tree').boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 10);
    await expect(entry('docs/Plan.md')).toHaveClass(/selected/);
    await expect(entry('docs/Assets')).not.toHaveClass(/selected/);

    expect((await readdir(join(workspace, 'docs'))).sort()).toEqual(['Assets', 'Plan.md', 'guide.md'].sort());
  } finally {
    await terminateElectron(application);
    await rm(temporary, { recursive: true, force: true });
  }
});
