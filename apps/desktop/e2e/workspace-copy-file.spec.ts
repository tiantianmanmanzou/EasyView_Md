import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeRestoredSession, terminateElectron } from './support/electronApp';

const appDir = process.cwd();

function pasteboardFilePaths(): string[] {
  const script = 'ObjC.import("AppKit"); const items = $.NSPasteboard.generalPasteboard.pasteboardItems; const out = [];'
    + ' for (let i = 0; i < items.count; i++) { const url = items.objectAtIndex(i).stringForType("public.file-url"); if (!url.isNil()) out.push($.NSURL.URLWithString(url).path.js); }'
    + ' out.join("\\n")';
  return execFileSync('osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
}

test('Copy File puts the file or folder itself on the system clipboard', async () => {
  test.skip(process.platform !== 'darwin', 'reads the macOS pasteboard');
  const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'easyview-desktop-copy-file-')));
  const workspace = join(temporaryDirectory, 'workspace');
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
      expandedRelativePaths: [], explorerVisible: true, outlineVisible: false, explorerWidth: 260, outlineWidth: 280,
    },
  }), 'utf8');

  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
    const page = await application.firstWindow();
    await resumeRestoredSession(page);
    await application.evaluate(({ Menu }) => {
      Menu.prototype.popup = function capture(this: Electron.Menu) { (globalThis as { lastMenu?: Electron.Menu }).lastMenu = this; };
    });
    const copyFileFromMenu = async (relativePath: string) => {
      await page.locator(`.workspace-entry[data-relative-path="${relativePath}"]`).click({ button: 'right' });
      await expect.poll(() => application!.evaluate(() => Boolean((globalThis as { lastMenu?: Electron.Menu }).lastMenu))).toBe(true);
      await application!.evaluate(() => {
        const state = globalThis as { lastMenu?: Electron.Menu };
        const item = state.lastMenu!.items.find((candidate) => candidate.label === '复制文件');
        state.lastMenu = undefined;
        item!.click();
      });
    };

    await copyFileFromMenu('notes.md');
    await expect.poll(pasteboardFilePaths).toEqual([notes]);
    await copyFileFromMenu('docs');
    await expect.poll(pasteboardFilePaths).toEqual([join(workspace, 'docs')]);
  } finally {
    await terminateElectron(application);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('copy actions in the context menu apply to every selected entry', async () => {
  test.skip(process.platform !== 'darwin', 'reads the macOS pasteboard');
  const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'easyview-desktop-copy-multi-')));
  const workspace = join(temporaryDirectory, 'workspace');
  const userData = join(temporaryDirectory, 'user-data');
  const notes = join(workspace, 'notes.md');
  await mkdir(join(workspace, 'docs'), { recursive: true });
  await mkdir(join(workspace, 'target'), { recursive: true });
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
    await application.evaluate(({ Menu }) => {
      Menu.prototype.popup = function capture(this: Electron.Menu) { (globalThis as { lastMenu?: Electron.Menu }).lastMenu = this; };
    });
    const entry = (relativePath: string) => page.locator(`.workspace-entry[data-relative-path="${relativePath}"]`);
    const clickMenuItem = async (relativePath: string, label: string) => {
      await entry(relativePath).click({ button: 'right' });
      await expect.poll(() => application!.evaluate(() => Boolean((globalThis as { lastMenu?: Electron.Menu }).lastMenu))).toBe(true);
      await application!.evaluate((_electron, wanted) => {
        const state = globalThis as { lastMenu?: Electron.Menu };
        const item = state.lastMenu!.items.find((candidate) => candidate.label === wanted);
        state.lastMenu = undefined;
        item!.click();
      }, label);
    };
    const clipboardText = () => application!.evaluate(({ clipboard }) => clipboard.readText());

    await entry('docs').click();
    await entry('notes.md').click({ modifiers: ['Meta'] });
    await expect(page.locator('.workspace-entry.selected')).toHaveCount(2);

    await clickMenuItem('notes.md', '复制路径');
    await expect.poll(clipboardText).toBe([join(workspace, 'docs'), notes].join('\n'));
    await clickMenuItem('docs', '复制相对路径');
    await expect.poll(clipboardText).toBe('docs\nnotes.md');

    await page.keyboard.press('Meta+Alt+KeyC');
    await expect.poll(clipboardText).toBe([join(workspace, 'docs'), notes].join('\n'));
    await page.keyboard.press('Meta+Shift+Alt+KeyC');
    await expect.poll(clipboardText).toBe('docs\nnotes.md');

    await clickMenuItem('notes.md', '复制文件');
    await expect.poll(pasteboardFilePaths).toEqual([join(workspace, 'docs'), notes]);

    await clickMenuItem('docs', '复制');
    await clickMenuItem('target', '粘贴');
    await expect.poll(() => readdir(join(workspace, 'target')).then((names) => names.sort())).toEqual(['docs', 'notes.md']);
    await expect.poll(() => readdir(join(workspace, 'target', 'docs'))).toEqual(['guide.md']);
  } finally {
    await terminateElectron(application);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
