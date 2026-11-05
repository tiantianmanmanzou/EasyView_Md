import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resumeRestoredSession, terminateElectron } from './support/electronApp';
test('Version Guard discovers nested repositories, commits index only, pushes, discards unsaved edits and restores layout', async () => {
  test.setTimeout(180000);
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'easyview-guard-runtime-')));
  const workspace = join(temp, 'workspace'), repo = join(workspace, 'main'), nested = join(repo, 'deep', 'child'), second = join(workspace, 'second'), profile = join(temp, 'profile');
  const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  for (const root of [repo, nested, second]) { await mkdir(root, { recursive: true }); git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Guard Runtime'); git(root, 'config', 'user.email', 'guard@example.test'); }
  const file = join(repo, 'notes.md'); await writeFile(file, '# Original\n'); git(repo, 'add', 'notes.md'); git(repo, 'commit', '-qm', 'Initial');
  const remote = join(temp, 'remote.git'); git(temp, 'init', '--bare', '-q', remote); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-qu', 'origin', 'HEAD');
  await writeFile(file, '# Changed\n'); await writeFile(join(repo, 'other.txt'), 'other');
  await mkdir(profile); await writeFile(join(profile, 'desktop-state.json'), JSON.stringify({ recentFiles: [file], workspace: { rootPath: workspace, openTabs: [{ id: 'notes', kind: 'editor', filePath: file }], activeTabId: 'notes', expandedRelativePaths: [], explorerVisible: true, outlineVisible: true, explorerWidth: 280, outlineWidth: 280 } }));
  let app = await electron.launch({ args: [process.cwd(), `--user-data-dir=${profile}`] });
  try {
    const page = await app.firstWindow(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); await resumeRestoredSession(page);
    await page.getByRole('button', { name: '仓库版本管理', exact: true }).click();
    const panel = page.locator('.version-guard'); await expect(panel.locator('.guard-repository')).toHaveCount(3);
    const main = panel.locator('.guard-repository').filter({ has: page.locator('.guard-repo-name', { hasText: /^main$/ }) });
    // The whole header row toggles expansion. The panel may auto-expand the first repository and load
    // its status asynchronously right after the scan, so a single blind click can collapse it again.
    // Retry until the row is expanded and its composer (rendered once status loads) is present.
    const mainTitle = main.locator('.guard-repo-title');
    await expect(async () => {
      if ((await mainTitle.getAttribute('aria-expanded')) !== 'true') await mainTitle.click();
      await expect(mainTitle).toHaveAttribute('aria-expanded', 'true', { timeout: 1000 });
      await expect(main.locator('textarea')).toHaveAttribute('rows', '1', { timeout: 3000 });
    }).toPass({ timeout: 40000 }); // discovery scans nested repos; slower when the whole suite runs
    const fontSize = (selector: string) => page.locator(selector).first().evaluate(element => getComputedStyle(element).fontSize);
    const treeFont = await fontSize('.workspace-entry-name');
    await expect.poll(() => fontSize('.version-guard .guard-file-name')).toBe(treeFont);
    await expect.poll(() => fontSize('.version-guard .guard-group')).toBe(treeFont);
    const change = main.locator('.guard-file').filter({ has: page.locator('.guard-file-name', { hasText: /^notes\.md$/ }) });
    await change.locator('.guard-file-name').click();
    await expect(page.locator('.easyview-history-view .cm-content')).toContainText('Changed');
    await expect(page.locator('.easyview-history-view .cm-content')).toHaveAttribute('contenteditable', 'false');
    await change.getByRole('button', { name: '暂存', exact: true }).click();
    await expect(main.locator('.guard-group', { hasText: '已暂存' })).toBeVisible();
    await main.locator('textarea').fill('Guard runtime commit'); await main.getByRole('button', { name: '提交', exact: true }).click();
    await expect.poll(() => git(repo, 'log', '-1', '--format=%s')).toBe('Guard runtime commit'); expect(git(repo, 'ls-tree', '--name-only', 'HEAD')).not.toContain('other.txt');
    await main.locator('.guard-sync-count[data-method="push"]').click(); await expect.poll(() => git(remote, 'log', '-1', '--format=%s')).toBe('Guard runtime commit');
    await main.locator('.guard-repo-refresh').click(); await expect(main.getByRole('button', { name: /刷新此仓库并检查远程 · 上次检查远程/ })).toBeVisible(); await expect(main.locator('.guard-checked')).toHaveCount(0);
    await expect(panel.locator('.guard-commit', { hasText: 'Guard runtime commit' })).toBeVisible();
    // Open working file, edit without manually saving, and stage through the panel.
    const api = (request: object) => page.evaluate(async request => { const result = await (window as any).easyViewDesktop.versionGuard.request(request); if (!result.ok) throw new Error(result.message); return result.value; }, request);
    await api({ method: 'openFile', repository: repo, paths: ['notes.md'] });
    const editor = page.locator('.ProseMirror:visible'); await editor.click(); await editor.press('ControlOrMeta+End'); await page.keyboard.type(' unsaved');
    await api({ method: 'stage', repository: repo, paths: ['notes.md'] }); expect(git(repo, 'show', ':notes.md')).toContain('unsaved');
    await editor.click(); await editor.press('ControlOrMeta+End'); await page.keyboard.type(' discard-me');
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
    await api({ method: 'discard', repository: repo, paths: ['notes.md'] });
    await expect(editor).toContainText('unsaved'); await expect(editor).not.toContainText('discard-me'); expect(await readFile(file, 'utf8')).not.toContain('discard-me');
    await page.screenshot({ path: '/tmp/easyview-version-guard-desktop.png' });
    // Await event-driven refreshes, then verify no polling during an idle interval.
    await page.waitForTimeout(4000); const before = await api({ method: 'diagnostics' }) as any;
    await page.waitForTimeout(4000); const after = await api({ method: 'diagnostics' }) as any;
    expect(after.commands).toBe(before.commands); expect(after.peak).toBeLessThanOrEqual(2);
    await page.getByRole('button', { name: '仓库版本管理', exact: true }).click();
    await expect.poll(async () => (await api({ method: 'diagnostics' }) as any).watchers).toBe(0);
    await page.getByRole('button', { name: '仓库版本管理', exact: true }).click();
    // Exercise the real drag docking path.
    const grip = panel.locator('[data-dock-grip]'); const center = await page.locator('#desktop-center-pane').boundingBox();
    await grip.hover(); await page.mouse.down(); await page.mouse.move(center!.x + center!.width - 15, center!.y + center!.height / 2, { steps: 8 }); await page.mouse.up();
    await expect(page.locator('#version-guard-host')).toHaveAttribute('data-dock-side', 'right');
    await page.waitForTimeout(600); expect(errors).toEqual([]);
    await terminateElectron(app);
    app = await electron.launch({ args: [process.cwd(), `--user-data-dir=${profile}`] });
    const restored = await app.firstWindow();
    // The welcome page covering restored tabs keeps the panel closed and empty until the session resumes.
    await expect(restored.locator('#version-guard-host')).toBeHidden(); await expect(restored.locator('.guard-repository')).toHaveCount(0);
    await resumeRestoredSession(restored); await expect(restored.locator('#version-guard-host')).toBeVisible(); await expect(restored.locator('#version-guard-host')).toHaveAttribute('data-dock-side', 'right');
  } finally { await terminateElectron(app); await rm(temp, { recursive: true, force: true }); }
});
