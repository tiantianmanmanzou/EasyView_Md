import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeRestoredSession, terminateElectron } from './support/electronApp';

const appDir = process.cwd();

async function launch(userDataDir: string): Promise<{ application: ElectronApplication; page: Page }> {
  const application = await electron.launch({ args: [appDir, `--user-data-dir=${userDataDir}`] });
  const page = await application.firstWindow();
  await resumeRestoredSession(page);
  return { application, page };
}

test('keeps Markdown dirty content while preview tabs occupy the central surface and restore after restart', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'easyview-desktop-tabs-'));
  const workspace = join(temporaryDirectory, 'workspace');
  const userData = join(temporaryDirectory, 'user-data');
  const markdownPath = join(workspace, 'notes.md');
  await mkdir(workspace, { recursive: true });
  await mkdir(userData, { recursive: true });
  await writeFile(markdownPath, '# Notes\n\nOriginal.\n', 'utf8');
  await writeFile(join(workspace, 'preview.txt'), 'Preview content.\n', 'utf8');
  await writeFile(join(workspace, 'transparent.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Wbq4WQAAAABJRU5ErkJggg==', 'base64'));
  const secondMarkdownPath = join(workspace, 'second.md');
  await writeFile(secondMarkdownPath, '# Second\n\nSecond original.\n', 'utf8');
  await Promise.all(Array.from({ length: 80 }, (_, index) => (
    writeFile(join(workspace, `bulk-${String(index).padStart(3, '0')}.txt`), `Bulk file ${index}\n`, 'utf8')
  )));
  await writeFile(join(userData, 'desktop-state.json'), JSON.stringify({
    recentFiles: [markdownPath],
    workspace: {
      rootPath: workspace,
      openTabs: [{ id: 'notes-tab', kind: 'editor', filePath: markdownPath }],
      activeTabId: 'notes-tab',
      expandedRelativePaths: [],
      explorerVisible: true,
      outlineVisible: true,
      explorerWidth: 280,
      outlineWidth: 280,
    },
  }), 'utf8');

  let first: ElectronApplication | undefined;
  let second: ElectronApplication | undefined;
  try {
    const launched = await launch(userData);
    first = launched.application;
    const page = launched.page;
    await expect(page.locator('.desktop-tab')).toHaveCount(1);
    await expect(page.locator('.ProseMirror')).toContainText('Original.');

    const tree = page.locator('.workspace-tree');
    await expect(tree.locator('.workspace-entry')).toHaveCount(84);
    await tree.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const treeScrollTop = await tree.evaluate((element) => element.scrollTop);
    expect(treeScrollTop).toBeGreaterThan(0);
    await page.locator('.workspace-action[title="刷新"]').click();
    await expect.poll(() => page.locator('.workspace-tree').evaluate((element) => element.scrollTop)).toBe(treeScrollTop);

    const paragraph = page.locator('.ProseMirror p').last();
    await paragraph.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Unsaved tab content.');
    await expect(page.locator('.desktop-tab-dirty')).toHaveCount(1);

    await page.evaluate(async () => {
      const api = (window as typeof window & { easyViewDesktop: { tabs: { openWorkspaceEntry(path: string): Promise<unknown> } } }).easyViewDesktop;
      await api.tabs.openWorkspaceEntry('preview.txt');
    });
    await expect(page.locator('.desktop-tab')).toHaveCount(2);
    await expect(page.locator('.desktop-tab.active .desktop-tab-label')).toHaveText('preview.txt');
    await expect(page.locator('#file-preview-root')).toBeVisible();
    await expect(page.locator('#desktop-editor-mount')).toBeHidden();
    await expect(page.locator('.preview-header')).toHaveCount(0);
    await expect(page.locator('.preview-text-editor-host')).toHaveAttribute('data-editor-ready', '1', { timeout: 15_000 });
    await expect(page.locator('.preview-text-shell .cm-content')).toContainText('Preview content.');

    await page.locator('.workspace-entry-name', { hasText: 'preview.txt' }).click({ button: 'right' });
    await expect(page.locator('.workspace-entry.selected .workspace-entry-name')).toContainText('preview.txt');
    await expect(page.locator('.workspace-file-context-menu')).toHaveCount(0);

    await page.locator('#ai-chat-toggle').click();
    const aiPanel = page.locator('.ai-chat-panel:not(.hidden):not(.suspended)');
    await expect(aiPanel).toBeVisible();
    await expect(aiPanel.locator('[data-mode="agent"]')).toBeDisabled();
    await expect.poll(() => aiPanel.evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
    const previewLayout = await page.evaluate(() => {
      const preview = document.getElementById('file-preview-root')!.getBoundingClientRect();
      const tabBar = document.getElementById('desktop-tab-bar')!.getBoundingClientRect();
      const ai = document.querySelector('.ai-chat-panel:not(.hidden):not(.suspended)')!.getBoundingClientRect();
      return {
        previewRight: preview.right,
        aiLeft: ai.left,
        aiRight: ai.right,
        aiTop: ai.top,
        aiBottom: ai.bottom,
        tabBarTop: tabBar.top,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
    });
    expect(previewLayout.aiLeft).toBeGreaterThanOrEqual(previewLayout.previewRight - 1);
    expect(Math.abs(previewLayout.viewportWidth - previewLayout.aiRight)).toBeLessThanOrEqual(1);
    expect(Math.abs(previewLayout.tabBarTop - previewLayout.aiTop)).toBeLessThanOrEqual(1);
    expect(Math.abs(previewLayout.viewportHeight - previewLayout.aiBottom)).toBeLessThanOrEqual(1);

    const clickMenuItem = (id: string) => launched.application.evaluate(({ Menu }, menuId) => {
      Menu.getApplicationMenu()?.getMenuItemById(menuId)?.click();
    }, id);
    const menuItemChecked = (id: string) => launched.application.evaluate(({ Menu }, menuId) =>
      Menu.getApplicationMenu()?.getMenuItemById(menuId)?.checked ?? false, id);
    await expect(page.locator('#theme-toggle, #accent-toggle')).toHaveCount(0);
    const initialMode = await page.evaluate(() => document.documentElement.dataset.easyviewTheme ?? '');
    await expect.poll(() => menuItemChecked(`appearance-mode-${initialMode}`)).toBe(true);
    await clickMenuItem('appearance-accent-green');
    await expect.poll(() => page.evaluate(() => document.body.dataset.mdpreAccent)).toBe('green');
    const accentColors = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--mdpre-accent-text)';
      document.body.appendChild(probe);
      const result = {
        previewColor: getComputedStyle(document.getElementById('file-preview-root')!).color,
        accentColor: getComputedStyle(probe).color,
      };
      probe.remove();
      return result;
    });
    expect(accentColors.previewColor).toBe(accentColors.accentColor);

    const backgroundBefore = await page.locator('#file-preview-root').evaluate((element) => getComputedStyle(element).backgroundColor);
    const currentMode = await page.evaluate(() => document.documentElement.dataset.easyviewTheme ?? '');
    await clickMenuItem(currentMode === 'dark' ? 'appearance-mode-light' : 'appearance-mode-dark');
    await expect.poll(() => page.locator('#file-preview-root').evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(backgroundBefore);
    const themedColors = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--mdpre-accent-text)';
      probe.style.background = 'var(--vscode-editor-background)';
      document.body.appendChild(probe);
      const result = {
        previewBackground: getComputedStyle(document.getElementById('file-preview-root')!).backgroundColor,
        themeBackground: getComputedStyle(probe).backgroundColor,
        previewColor: getComputedStyle(document.getElementById('file-preview-root')!).color,
        accentColor: getComputedStyle(probe).color,
      };
      probe.remove();
      return result;
    });
    expect(themedColors.previewBackground).toBe(themedColors.themeBackground);
    expect(themedColors.previewColor).toBe(themedColors.accentColor);

    await page.evaluate(async () => {
      const api = (window as typeof window & { easyViewDesktop: { tabs: { openWorkspaceEntry(path: string): Promise<unknown> } } }).easyViewDesktop;
      await api.tabs.openWorkspaceEntry('transparent.png');
    });
    // Raster images render through the universal file viewer (.image-viewer); only HEIC uses .preview-image-viewer.
    await expect(page.locator('.preview-universal-viewer .image-viewer')).toBeVisible();
    const imageBackground = await page.locator('.preview-universal-viewer .image-viewer').evaluate((element) => {
      const style = getComputedStyle(element);
      return { color: style.backgroundColor, image: style.backgroundImage };
    });
    expect(imageBackground.image).toBe('none');
    expect(imageBackground.color).not.toBe('rgba(0, 0, 0, 0)');
    await page.locator('.desktop-tab.active .desktop-tab-close').click();
    await expect(page.locator('.desktop-tab')).toHaveCount(2);

    await page.locator('.desktop-tab', { hasText: 'notes.md' }).locator('.desktop-tab-activate').click();
    await expect(page.locator('#desktop-editor-mount')).toBeVisible();
    await expect(page.locator('.desktop-editor-session:not([hidden]) .ProseMirror')).toBeVisible();
    await expect(page.locator('#file-preview-root')).toBeHidden();
    await expect(page.locator('.desktop-editor-session:not([hidden]) .ProseMirror')).toContainText('Unsaved tab content.');
    await expect(aiPanel).toBeVisible();
    await expect(aiPanel.locator('[data-mode="agent"]')).toBeEnabled();
    const markdownLayout = await page.evaluate(() => {
      const outline = document.querySelector('.toc-sidebar:not(.hidden)')!.getBoundingClientRect();
      const ai = document.querySelector('.ai-chat-panel:not(.hidden):not(.suspended)')!.getBoundingClientRect();
      return { outlineRight: outline.right, aiLeft: ai.left };
    });
    expect(markdownLayout.aiLeft).toBeGreaterThanOrEqual(markdownLayout.outlineRight - 1);

    await page.evaluate(async () => {
      const api = (window as typeof window & { easyViewDesktop: { tabs: { openWorkspaceEntry(path: string): Promise<unknown> } } }).easyViewDesktop;
      await api.tabs.openWorkspaceEntry('second.md');
    });
    await expect(page.locator('.desktop-tab')).toHaveCount(3);
    await expect(page.locator('.desktop-tab.active .desktop-tab-label')).toHaveText('second.md');
    await expect(page.locator('.desktop-editor-session:not([hidden]) .ProseMirror')).toContainText('Second original.');
    const secondEditor = page.locator('.desktop-editor-session:not([hidden]) .ProseMirror');
    const secondParagraph = secondEditor.locator('p').last();
    // Under CI load, the first click/type can miss ProseMirror focus — retry until the edit sticks.
    await expect(async () => {
      if (!(await secondEditor.innerText()).includes('Second saved.')) {
        await secondParagraph.click();
        await page.keyboard.press('End');
        await page.keyboard.type(' Second saved.');
      }
      await expect(secondEditor).toContainText('Second saved.', { timeout: 2000 });
    }).toPass({ timeout: 30000 });
    await expect(page.locator('.desktop-tab.active .desktop-tab-dirty')).toHaveCount(1);
    // Save through File > Save: a CDP-synthesized Cmd/Ctrl+S reaches the renderer first and is only
    // sometimes forwarded to the menu accelerator (flaky on CI and on busy desktops). The shortcut
    // itself is still exercised by the second save below.
    await launched.application.evaluate(({ Menu }) => {
      const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
        for (const item of items) {
          if (item.accelerator === 'CmdOrCtrl+S') return item;
          const nested = item.submenu ? find(item.submenu.items) : undefined;
          if (nested) return nested;
        }
        return undefined;
      };
      const save = find(Menu.getApplicationMenu()?.items ?? []);
      if (!save?.enabled) throw new Error('File > Save is not available');
      save.click();
    });
    await expect.poll(async () => readFile(secondMarkdownPath, 'utf8')).toContain('Second saved.');
    await page.locator('.desktop-tab', { hasText: 'notes.md' }).locator('.desktop-tab-activate').click();
    await expect(page.locator('.desktop-editor-session:not([hidden]) .ProseMirror')).toContainText('Unsaved tab content.');

    await page.evaluate(async () => {
      const api = (window as typeof window & { easyViewDesktop: { tabs: { openWorkspaceEntry(path: string): Promise<unknown> } } }).easyViewDesktop;
      await api.tabs.openWorkspaceEntry('preview.txt');
    });
    await expect(page.locator('.desktop-tab')).toHaveCount(3);
    await page.locator('.desktop-tab', { hasText: 'notes.md' }).locator('.desktop-tab-activate').click();
    await page.locator('.desktop-editor-session:not([hidden]) .ProseMirror').click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
    await expect.poll(async () => readFile(markdownPath, 'utf8')).toContain('Unsaved tab content.');

    await page.locator('.desktop-tab', { hasText: 'preview.txt' }).locator('.desktop-tab-activate').click();
    await expect(aiPanel).toBeVisible();
    await expect(aiPanel.locator('[data-mode="agent"]')).toBeDisabled();
    await expect.poll(async () => {
      const workspaceState = JSON.parse(await readFile(join(userData, 'desktop-state.json'), 'utf8')).workspace;
      const activeTab = workspaceState.openTabs.find((tab: { id: string }) => tab.id === workspaceState.activeTabId);
      // Wait until the preview.txt activation itself is persisted, not just any non-notes tab.
      return { tabCount: workspaceState.openTabs.length, activeRelativePath: activeTab?.relativePath };
    }).toEqual({ tabCount: 3, activeRelativePath: 'preview.txt' });
    await terminateElectron(first);
    first = undefined;

    const restored = await launch(userData);
    second = restored.application;
    await expect(restored.page.locator('.desktop-tab')).toHaveCount(3);
    await expect(restored.page.locator('.desktop-tab.active .desktop-tab-label')).toHaveText('preview.txt');
    await expect(restored.page.locator('#file-preview-root')).toBeVisible();
  } finally {
    await terminateElectron(first).catch(() => undefined);
    await terminateElectron(second).catch(() => undefined);
    // Windows keeps Chromium profile files locked briefly after the Electron process is killed.
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => undefined);
  }
});
