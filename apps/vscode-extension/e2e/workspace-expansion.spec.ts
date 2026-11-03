import { _electron as electron, expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { keepElectronInBackground, terminateElectron } from '../../desktop/e2e/support/electronApp';

test('the tree restores the folders left expanded in the previous session', async () => {
  test.setTimeout(180_000);
  const temporary = await mkdtemp(join(tmpdir(), 'easyview-expansion-vscode-'));
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
  const launch = async () => {
    const application = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${join(temporary, 'data')}`, `--extensions-dir=${join(temporary, 'extensions')}`,
        `--extensionDevelopmentPath=${resolve(__dirname, '..')}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', workspace],
      timeout: 60_000,
    });
    await keepElectronInBackground(application);
    return application;
  };
  const treeFrame = async (page: Page, relativePath: string): Promise<Frame> => {
    let found: Frame | undefined;
    await expect.poll(async () => {
      for (const frame of page.frames()) if (await frame.locator(`.workspace-entry[data-relative-path="${relativePath}"]`).count()) { found = frame; return true; }
      return false;
    }, { timeout: 60_000 }).toBe(true);
    return found!;
  };

  let application: ElectronApplication | undefined;
  try {
    application = await launch();
    let page = await application.firstWindow();
    const tree = await treeFrame(page, 'docs');
    await tree.locator('.workspace-entry[data-relative-path="docs"]').click();
    await expect(tree.locator('.workspace-entry[data-relative-path="docs/guide.md"]')).toBeVisible();
    await application.close();

    application = await launch();
    page = await application.firstWindow();
    await treeFrame(page, 'docs/guide.md');
  } finally {
    await terminateElectron(application);
    await rm(temporary, { recursive: true, force: true });
  }
});
