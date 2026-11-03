import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeRestoredSession, terminateElectron } from './support/electronApp';

test('shows file and directory sizes in the tree and on hover', async () => {
  const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'easyview-size-e2e-')));
  const workspace = join(temporaryDirectory, 'workspace');
  const userData = join(temporaryDirectory, 'user-data');
  const notes = join(workspace, 'notes.md');
  await mkdir(join(workspace, 'docs'), { recursive: true });
  await mkdir(userData, { recursive: true });
  await writeFile(notes, '12345');
  await writeFile(join(workspace, 'docs', '.hidden'), '12345678');
  await writeFile(join(userData, 'desktop-state.json'), JSON.stringify({ workspace: {
    rootPath: workspace, openTabs: [{ id: 'notes-tab', kind: 'editor', filePath: notes }], activeTabId: 'notes-tab',
    expandedRelativePaths: [], explorerVisible: true, outlineVisible: false, explorerWidth: 400, outlineWidth: 280,
  } }));
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ args: [process.cwd(), `--user-data-dir=${userData}`] });
    const page = await application.firstWindow();
    await resumeRestoredSession(page);
    await page.getByTitle('设置', { exact: true }).click();
    await page.getByText('大小', { exact: true }).click();
    await page.getByText('悬停时显示大小', { exact: true }).click();
    await page.getByRole('button', { name: '保存' }).click();
    const file = page.locator('.workspace-entry[data-relative-path="notes.md"]');
    const folder = page.locator('.workspace-entry[data-relative-path="docs"]');
    await expect(file.locator('.workspace-entry-size')).toHaveText('5 B');
    await expect(folder.locator('.workspace-entry-size')).toHaveText('8 B');
    await folder.hover();
    await expect(page.locator('.workspace-timestamp-tooltip')).toContainText('大小：8 B');
    await expect.poll(async () => JSON.parse(await readFile(join(workspace, '.easyview/tree-order.json'), 'utf8'))).toMatchObject({ showSize: true, showSizeHover: true });
    await writeFile(notes, '1234567');
    await expect(file.locator('.workspace-entry-size')).toHaveText('7 B');
    await writeFile(join(workspace, 'docs', '.hidden'), '1234567890');
    await expect(folder.locator('.workspace-entry-size')).toHaveText('10 B');
    await page.getByTitle('设置', { exact: true }).click();
    await page.getByText('大小', { exact: true }).click();
    await page.getByRole('button', { name: '保存' }).click();
    await expect(folder.locator('.workspace-entry-size')).toHaveCount(0);
    await folder.hover();
    await expect(page.locator('.workspace-timestamp-tooltip')).toContainText('大小：10 B');
  } finally {
    await terminateElectron(application);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
