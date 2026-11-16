import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeRestoredSession, terminateElectron } from './support/electronApp';

async function launch(userData: string): Promise<{ application: ElectronApplication; page: Page }> {
  const application = await electron.launch({
    args: [process.cwd(), `--user-data-dir=${userData}`],
    env: { ...process.env, EASYVIEW_DISABLE_UPDATE_CHECK: '1' },
  });
  const page = await application.firstWindow();
  await resumeRestoredSession(page);
  return { application, page };
}

async function nativeBrowserViews(application: ElectronApplication): Promise<Array<{ bounds: { x: number; y: number; width: number; height: number }; visible: boolean; url: string }>> {
  return application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
    if (!win) return [];
    return win.contentView.children.flatMap((view) => {
      const guest = view as { webContents?: { isDestroyed(): boolean; getURL(): string } };
      const contents = guest.webContents;
      if (!contents || contents.isDestroyed()) return [];
      return [{ bounds: view.getBounds(), visible: view.getVisible(), url: contents.getURL() }];
    });
  });
}

test('opens, navigates, goes back, and recomputes bounds when the tab or sidebar changes', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'easyview-browser-'));
  const workspace = join(temporary, 'workspace');
  const userData = join(temporary, 'user-data');
  const notes = join(workspace, 'notes.md');
  await mkdir(workspace, { recursive: true });
  await mkdir(userData, { recursive: true });
  await writeFile(join(workspace, 'page-a.html'), '<!doctype html><title>Page A</title><h1>Page A</h1><a href="page-b.html">next</a>', 'utf8');
  await writeFile(join(workspace, 'page-b.html'), '<!doctype html><title>Page B</title><h1>Page B</h1>', 'utf8');
  await writeFile(notes, '# Notes\n\n[Example](https://example.com)\n', 'utf8');
  await writeFile(join(userData, 'desktop-state.json'), JSON.stringify({
    recentFiles: [notes],
    workspace: {
      rootPath: workspace,
      openTabs: [{ id: 'notes', kind: 'editor', filePath: notes }],
      activeTabId: 'notes',
      expandedRelativePaths: [],
      explorerVisible: true,
      outlineVisible: false,
      explorerWidth: 240,
      outlineWidth: 220,
    },
  }), 'utf8');

  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(userData);
    application = launched.application;
    const page = launched.page;
    await expect(page.locator('.desktop-tab')).toHaveCount(1);

    await application.evaluate(({ Menu }) => { Menu.getApplicationMenu()?.getMenuItemById('view-open-browser')?.click(); });
    await expect(page.locator('.desktop-browser-chrome')).toBeVisible();
    await expect(page.locator('.desktop-browser-address')).toHaveValue('');

    await page.evaluate(async () => {
      await (window as Window & { easyViewDesktop: { tabs: { openWorkspaceEntry(path: string): Promise<unknown> } } }).easyViewDesktop.tabs.openWorkspaceEntry('page-a.html');
    });
    const address = page.locator('.desktop-browser-address');
    await expect(address).toHaveValue(/page-a\.html$/, { timeout: 15_000 });
    await expect(page.locator('.desktop-browser-host')).toHaveAttribute('data-loading', 'false');
    await expect(page.locator('#file-preview-root')).toBeHidden();

    const pageB = (await address.inputValue()).replace('page-a.html', 'page-b.html');
    await address.click();
    await address.evaluate((input, next) => {
      const field = input as HTMLInputElement;
      field.focus();
      field.value = next;
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    }, pageB);
    await expect(address).toHaveValue(/page-b\.html$/);
    const back = page.locator('.desktop-browser-button[data-action="back"]');
    await expect(back).toBeEnabled();
    await back.click();
    await expect(address).toHaveValue(/page-a\.html$/);

    const zoom = await page.evaluate(() => (window as Window & { easyViewDesktop: { app: { getZoomFactor(): number } } }).easyViewDesktop.app.getZoomFactor());
    const slot = await page.locator('.desktop-browser-slot').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    const shown = (await nativeBrowserViews(application)).find((view) => view.visible);
    expect(shown).toBeTruthy();
    expect(Math.abs(shown!.bounds.x - Math.round(slot.x * zoom))).toBeLessThanOrEqual(2);
    expect(Math.abs(shown!.bounds.y - Math.round(slot.y * zoom))).toBeLessThanOrEqual(2);
    expect(Math.abs(shown!.bounds.width - Math.round(slot.width * zoom))).toBeLessThanOrEqual(2);
    expect(Math.abs(shown!.bounds.height - Math.round(slot.height * zoom))).toBeLessThanOrEqual(2);

    const handle = page.locator('.workspace-resizer');
    const handleBox = await handle.boundingBox();
    expect(handleBox).toBeTruthy();
    await page.mouse.move(handleBox!.x + 2, handleBox!.y + 40);
    await page.mouse.down();
    await page.mouse.move(handleBox!.x + 80, handleBox!.y + 40);
    await page.mouse.up();
    await expect.poll(async () => {
      const next = await page.locator('.desktop-browser-slot').evaluate((element) => element.getBoundingClientRect().x);
      return Math.round(next);
    }).toBeGreaterThan(Math.round(slot.x) + 20);
    const afterDrag = (await nativeBrowserViews(application)).find((view) => view.visible);
    const dragged = await page.locator('.desktop-browser-slot').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    expect(Math.abs(afterDrag!.bounds.x - Math.round(dragged.x * zoom))).toBeLessThanOrEqual(2);
    expect(Math.abs(afterDrag!.bounds.width - Math.round(dragged.width * zoom))).toBeLessThanOrEqual(2);

    await page.locator('.desktop-tab', { hasText: 'notes.md' }).click();
    await expect.poll(async () => (await nativeBrowserViews(application)).every((view) => !view.visible)).toBe(true);

    await page.locator('.desktop-tab', { hasText: /Page A|page-a\.html/ }).click();
    await expect(page.locator('.desktop-browser-chrome')).toBeVisible();
    await expect.poll(async () => (await nativeBrowserViews(application)).some((view) => view.visible)).toBe(true);

    await page.locator('#browser-toggle').click();
    await expect(page.locator('.desktop-tab', { hasText: '新标签页' })).toHaveCount(2);

    await application.evaluate(({ Menu }) => { Menu.getApplicationMenu()?.getMenuItemById('view-command-palette')?.click(); });
    const palette = page.locator('.desktop-command-palette.is-open');
    await expect(palette).toBeVisible();
    await expect.poll(async () => (await nativeBrowserViews(application)).every((view) => !view.visible)).toBe(true);
    await palette.getByRole('option', { name: /打开浏览器/ }).click();
    await expect(palette).toBeHidden();
    await expect(page.locator('.desktop-browser-chrome')).toBeVisible();
  } finally {
    await terminateElectron(application);
    await rm(temporary, { recursive: true, force: true });
  }
});
