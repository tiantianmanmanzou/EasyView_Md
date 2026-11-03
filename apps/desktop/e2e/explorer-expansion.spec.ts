import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeRestoredSession, terminateElectron } from './support/electronApp';

const appDir = process.cwd();

test('the tree remembers expanded folders when the folder is reopened or the app restarts', async () => {
  const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'easyview-desktop-expansion-')));
  const workspace = join(temporaryDirectory, 'workspace');
  const userData = join(temporaryDirectory, 'user-data');
  const notes = join(workspace, 'notes.md');
  await mkdir(join(workspace, 'docs'), { recursive: true });
  await mkdir(userData, { recursive: true });
  await writeFile(notes, '# Notes\n', 'utf8');
  await writeFile(join(workspace, 'docs', 'guide.md'), '# Guide\n', 'utf8');
  await writeFile(join(userData, 'recent-folders.json'), JSON.stringify([workspace]), 'utf8');
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
    await page.locator('.workspace-entry[data-relative-path="docs"]').click();
    await expect(page.locator('.workspace-entry[data-relative-path="docs/guide.md"]')).toBeVisible();

    const newWindow = application.waitForEvent('window');
    await page.evaluate(() => (window as unknown as { easyViewDesktop: { app: { newWindow(): Promise<unknown> } } }).easyViewDesktop.app.newWindow());
    const second = await newWindow;
    await second.locator('#desktop-welcome .desktop-welcome-recent-item').first().click();
    await expect(second.locator('.workspace-entry[data-relative-path="docs/guide.md"]')).toBeVisible();

    // The window state is saved on a debounce and the process is killed below.
    await expect.poll(async () => (JSON.parse(await readFile(join(userData, 'desktop-state.json'), 'utf8')) as {
      workspace: { expandedRelativePaths: string[] };
    }).workspace.expandedRelativePaths).toEqual(['docs']);
    await terminateElectron(application);
    application = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
    const restored = await application.firstWindow();
    await resumeRestoredSession(restored);
    await expect(restored.locator('.workspace-entry[data-relative-path="docs/guide.md"]')).toBeVisible();
  } finally {
    await terminateElectron(application);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
