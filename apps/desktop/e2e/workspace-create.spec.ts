import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeRestoredSession, terminateElectron } from './support/electronApp';

const appDir = process.cwd();

test('new files and folders start in name editing, then end selected on Enter or a blank click', async () => {
  const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'easyview-desktop-create-')));
  const workspace = join(temporaryDirectory, 'workspace');
  const userData = join(temporaryDirectory, 'user-data');
  const notes = join(workspace, 'notes.md');
  await mkdir(join(workspace, 'docs'), { recursive: true });
  await mkdir(userData, { recursive: true });
  await writeFile(notes, '# Notes\n', 'utf8');
  await writeFile(join(workspace, 'docs', 'guide.md'), '# Guide\n', 'utf8');
  await writeFile(join(userData, 'desktop-state.json'), JSON.stringify({
    recentFiles: [notes],
    workspace: {
      rootPath: workspace,
      openTabs: [{ id: 'notes-tab', kind: 'editor', filePath: notes }],
      activeTabId: 'notes-tab',
      expandedRelativePaths: [], explorerVisible: true, outlineVisible: false, explorerWidth: 260, outlineWidth: 280,
    },
  }), 'utf8');

  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
    const page = await application.firstWindow();
    await resumeRestoredSession(page);
    await expect(page.locator('.workspace-entry[data-relative-path="notes.md"]')).toHaveCount(1);
    // Native context-menu items send this command; the docs folder starts collapsed and unloaded.
    const beginCreate = (command: 'beginCreateFile' | 'beginCreateFolder', parent: string, extension?: string) =>
      application!.evaluate(({ BrowserWindow }, args) => {
        const contents = BrowserWindow.getAllWindows()[0]!.webContents;
        contents.focus();
        contents.send('workspace.contextCommand', ...args);
      }, [command, parent, ...(extension ? [extension] : [])]);
    const input = page.locator('.workspace-create-row input');
    const entry = (relativePath: string) => page.locator(`.workspace-entry[data-relative-path="${relativePath}"]`);
    const clickBlank = async () => {
      const tree = (await page.locator('.workspace-tree').boundingBox())!;
      await page.mouse.click(tree.x + tree.width / 2, tree.y + tree.height - 10);
    };

    await beginCreate('beginCreateFile', 'docs', '.md');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('未命名.md');
    await input.fill('计划.md');
    await page.keyboard.press('Enter');
    await expect(entry('docs/计划.md')).toHaveClass(/selected/);
    await expect(entry('docs/计划.md')).toHaveClass(/active/);

    await beginCreate('beginCreateFolder', 'docs');
    await expect(input).toBeFocused();
    await input.fill('资料');
    await clickBlank();
    await expect(entry('docs/资料')).toHaveClass(/selected/);
    await expect(entry('docs/计划.md')).not.toHaveClass(/selected/);

    await page.getByTitle('新建文件夹').click();
    await expect(input).toBeFocused();
    await input.fill('归档');
    await page.keyboard.press('Enter');
    await expect(entry('归档')).toHaveClass(/selected/);
    await expect(input).toHaveCount(0);

    expect((await readdir(join(workspace, 'docs'))).sort()).toEqual(['guide.md', '计划.md', '资料'].sort());
  } finally {
    await terminateElectron(application);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
