import { _electron as electron, expect, test, type ElectronApplication, type Frame } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { keepElectronInBackground, terminateElectron } from '../../desktop/e2e/support/electronApp';

test('shows sizes in the tree and hover independently', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'easyview-size-vscode-'));
  const workspace = join(temporary, 'workspace');
  await mkdir(join(workspace, 'docs'), { recursive: true });
  await mkdir(join(temporary, 'data', 'User'), { recursive: true });
  await writeFile(join(workspace, 'notes.md'), '12345');
  await writeFile(join(workspace, 'docs', '.hidden'), '12345678');
  await writeFile(join(temporary, 'data', 'User', 'settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'easyviewMd.workspace.focusFilesOnStartup': true,
  }));
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ executablePath: process.env.VSCODE_EXECUTABLE_PATH, args: [
      `--user-data-dir=${join(temporary, 'data')}`, `--extensions-dir=${join(temporary, 'extensions')}`,
      `--extensionDevelopmentPath=${resolve(__dirname, '..')}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', workspace,
    ], timeout: 60_000 });
    await keepElectronInBackground(application);
    const page = await application.firstWindow();
    let tree: Frame | undefined;
    await expect.poll(async () => {
      for (const frame of page.frames()) if (await frame.locator('.workspace-entry[data-relative-path="docs"]').count()) { tree = frame; return true; }
      return false;
    }, { timeout: 60_000 }).toBe(true);
    const frame = tree!;
    await page.getByRole('button', { name: /Configure Sort|设置排序/ }).click();
    await frame.getByText(/^(大小|Size)$/).click();
    await frame.getByText(/^(悬停时显示大小|Size on hover)$/).click();
    await frame.getByRole('button', { name: /^(保存|Save)$/ }).click();
    const folder = frame.locator('.workspace-entry[data-relative-path="docs"]');
    await expect(folder.locator('.workspace-entry-size')).toHaveText('8 B');
    await expect(frame.locator('.workspace-entry[data-relative-path="notes.md"] .workspace-entry-size')).toHaveText('5 B');
    await folder.hover();
    await expect(frame.locator('.workspace-timestamp-tooltip')).toContainText(/(大小：|Size: )8 B/);
  } finally {
    await terminateElectron(application);
    await rm(temporary, { recursive: true, force: true });
  }
});
