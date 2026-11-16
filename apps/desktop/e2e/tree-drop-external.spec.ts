import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeRestoredSession, terminateElectron } from './support/electronApp';

const appDir = process.cwd();

/**
 * Drop Finder files on `selector` (a folder row's middle, or the tree container). Like a real OS drag,
 * the file entries are readable only while the drop event is being dispatched.
 */
async function dropExternalFiles(page: Page, selector: string, names: string[]): Promise<void> {
  await page.evaluate(({ selector, names }) => {
    let readable = true;
    const dataTransfer = new DataTransfer();
    for (const name of names) dataTransfer.items.add(new File([`from ${name}`], name, { type: 'text/markdown' }));
    const original = DataTransferItem.prototype.webkitGetAsEntry;
    DataTransferItem.prototype.webkitGetAsEntry = function webkitGetAsEntry() {
      const file = readable ? this.getAsFile() : null;
      return file ? { isFile: true, isDirectory: false, name: file.name, file: (done: (value: File) => void) => done(file) } as unknown as FileSystemEntry : null;
    };
    const target = document.querySelector<HTMLElement>(selector)!;
    const rect = target.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, dataTransfer, clientX: rect.left + 40, clientY: rect.top + rect.height / 2 };
    target.dispatchEvent(new DragEvent('dragover', init));
    target.dispatchEvent(new DragEvent('drop', init));
    readable = false;
    setTimeout(() => { DataTransferItem.prototype.webkitGetAsEntry = original; }, 5000);
  }, { selector, names });
}

test('dropping several Finder files imports all of them, into a folder or the workspace root', async () => {
  const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'easyview-desktop-drop-external-')));
  const workspace = join(temporaryDirectory, 'drop');
  const userData = join(temporaryDirectory, 'user-data');
  const notes = join(workspace, 'notes.md');
  await mkdir(join(workspace, 'docs'), { recursive: true });
  await mkdir(userData, { recursive: true });
  await writeFile(notes, '# Notes\n', 'utf8');
  await writeFile(join(userData, 'desktop-state.json'), JSON.stringify({
    recentFiles: [notes],
    workspace: {
      rootPath: workspace,
      openTabs: [{ id: 'notes-tab', kind: 'editor', filePath: notes }],
      activeTabId: 'notes-tab',
      expandedRelativePaths: [], explorerVisible: true, outlineVisible: false, explorerWidth: 280, outlineWidth: 280,
    },
  }), 'utf8');

  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
    const page = await application.firstWindow();
    await resumeRestoredSession(page);
    await expect(page.locator('.workspace-entry[data-relative-path="docs"]')).toBeVisible();

    await dropExternalFiles(page, '.workspace-entry[data-relative-path="docs"]', ['a.md', 'b.md', 'c.md']);
    await expect.poll(async () => (await readdir(join(workspace, 'docs'))).sort()).toEqual(['a.md', 'b.md', 'c.md']);
    expect(await readFile(join(workspace, 'docs', 'c.md'), 'utf8')).toBe('from c.md');

    await dropExternalFiles(page, '#workspace-explorer', ['x.md', 'y.md']);
    await expect.poll(async () => (await readdir(workspace)).filter((name) => name.endsWith('.md')).sort()).toEqual(['notes.md', 'x.md', 'y.md']);
    await expect(page.locator('.workspace-entry[data-relative-path="y.md"]')).toBeVisible();
  } finally {
    await terminateElectron(application);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
