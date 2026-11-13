import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeRestoredSession, terminateElectron } from './support/electronApp';

const appDir = process.cwd();

/** Drag `source` onto the middle of `target` (a folder), i.e. "move into". */
async function dragInto(page: Page, source: string, target: string): Promise<void> {
  await page.evaluate(({ source, target }) => {
    const row = (path: string) => document.querySelector<HTMLElement>(`.workspace-entry[data-relative-path="${path}"]`)!;
    const dataTransfer = new DataTransfer();
    const from = row(source);
    const to = row(target);
    const rect = to.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, dataTransfer, clientX: rect.left + 60, clientY: rect.top + rect.height / 2 };
    from.dispatchEvent(new DragEvent('dragstart', init));
    to.dispatchEvent(new DragEvent('dragover', init));
    to.dispatchEvent(new DragEvent('drop', init));
    from.dispatchEvent(new DragEvent('dragend', init));
  }, { source, target });
}

test('dragging one of several selected files moves the whole selection', async () => {
  const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'easyview-desktop-drag-multi-')));
  const workspace = join(temporaryDirectory, 'multi');
  const userData = join(temporaryDirectory, 'user-data');
  await mkdir(join(workspace, 'archive'), { recursive: true });
  await mkdir(userData, { recursive: true });
  for (const name of ['a.md', 'b.md', 'c.md']) await writeFile(join(workspace, name), `# ${name}\n`, 'utf8');
  await writeFile(join(userData, 'desktop-state.json'), JSON.stringify({
    recentFiles: [join(workspace, 'b.md')],
    workspace: {
      rootPath: workspace,
      openTabs: [{ id: 'b-tab', kind: 'editor', filePath: join(workspace, 'b.md') }],
      activeTabId: 'b-tab',
      expandedRelativePaths: ['archive'], explorerVisible: true, outlineVisible: false, explorerWidth: 280, outlineWidth: 280,
    },
  }), 'utf8');

  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
    const page = await application.firstWindow();
    await resumeRestoredSession(page);
    const row = (path: string) => page.locator(`.workspace-entry[data-relative-path="${path}"]`);
    await expect(row('c.md')).toBeVisible();

    await row('a.md').click();
    await row('c.md').click({ modifiers: ['ControlOrMeta'] });
    await expect(page.locator('.workspace-entry.selected')).toHaveCount(2);

    await dragInto(page, 'c.md', 'archive');
    await expect.poll(async () => (await readdir(join(workspace, 'archive'))).sort()).toEqual(['a.md', 'c.md']);
    expect((await readdir(workspace)).filter((name) => name.endsWith('.md'))).toEqual(['b.md']);
    await expect(row('archive/a.md')).toBeVisible();
    await expect(row('archive/c.md')).toBeVisible();
    await expect(page.locator('.workspace-entry.selected')).toHaveCount(2);

    // Back out to the root, into the slot above b.md: both land there in on-screen order.
    await page.evaluate(() => {
      const row = (path: string) => document.querySelector<HTMLElement>(`.workspace-entry[data-relative-path="${path}"]`)!;
      const dataTransfer = new DataTransfer();
      const from = row('archive/c.md');
      const to = row('b.md');
      const rect = to.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, dataTransfer, clientX: rect.left + 4, clientY: rect.top + 2 };
      from.dispatchEvent(new DragEvent('dragstart', init));
      to.dispatchEvent(new DragEvent('dragover', init));
      to.dispatchEvent(new DragEvent('drop', init));
      from.dispatchEvent(new DragEvent('dragend', init));
    });
    await expect.poll(async () => (await page.locator('.workspace-tree .workspace-entry')
      .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.relativePath!)))
      .filter((path) => !path.startsWith('.easyview')))
      .toEqual(['archive', 'a.md', 'c.md', 'b.md']);
  } finally {
    await terminateElectron(application);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('dragging one of several selected folders moves every folder with its contents', async () => {
  const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'easyview-desktop-drag-folders-')));
  const workspace = join(temporaryDirectory, 'folders');
  const userData = join(temporaryDirectory, 'user-data');
  for (const folder of ['archive', 'docs', 'notes', 'keep']) await mkdir(join(workspace, folder), { recursive: true });
  await mkdir(userData, { recursive: true });
  await writeFile(join(workspace, 'docs', 'a.md'), '# a\n', 'utf8');
  await writeFile(join(workspace, 'notes', 'n.md'), '# n\n', 'utf8');
  await writeFile(join(workspace, 'keep', 'k.md'), '# k\n', 'utf8');
  await writeFile(join(userData, 'desktop-state.json'), JSON.stringify({
    recentFiles: [join(workspace, 'keep', 'k.md')],
    workspace: {
      rootPath: workspace,
      openTabs: [{ id: 'k-tab', kind: 'editor', filePath: join(workspace, 'keep', 'k.md') }],
      activeTabId: 'k-tab',
      expandedRelativePaths: ['docs'], explorerVisible: true, outlineVisible: false, explorerWidth: 280, outlineWidth: 280,
    },
  }), 'utf8');

  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
    const page = await application.firstWindow();
    await resumeRestoredSession(page);
    const row = (path: string) => page.locator(`.workspace-entry[data-relative-path="${path}"]`);
    await expect(row('docs/a.md')).toBeVisible();

    await row('notes').locator('.workspace-entry-name').click();
    await row('docs').locator('.workspace-entry-name').click({ modifiers: ['ControlOrMeta'] });
    await row('docs/a.md').click({ modifiers: ['ControlOrMeta'] });
    await expect(page.locator('.workspace-entry.selected')).toHaveCount(3);

    await dragInto(page, 'notes', 'archive');
    await expect.poll(async () => (await readdir(join(workspace, 'archive'))).sort()).toEqual(['docs', 'notes']);
    expect(await readdir(join(workspace, 'archive', 'docs'))).toEqual(['a.md']);
    expect(await readdir(join(workspace, 'archive', 'notes'))).toEqual(['n.md']);
    expect((await readdir(workspace)).filter((name) => !name.startsWith('.')).sort()).toEqual(['archive', 'keep']);
    await expect(row('archive/docs')).toBeVisible();
    await expect(row('archive/notes')).toBeVisible();
  } finally {
    await terminateElectron(application);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
