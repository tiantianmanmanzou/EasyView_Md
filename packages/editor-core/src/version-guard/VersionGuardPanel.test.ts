/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest';
import type { GuardClient, GuardRequest } from '@easyview/contracts';
import { VersionGuardPanel } from './VersionGuardPanel';

const commit = { hash: 'abc1234', parents: ['p'], message: 'First change', author: 'Tester', timestamp: 0 };
function client(): GuardClient & { calls: GuardRequest[] } {
  const calls: GuardRequest[] = [];
  return {
    calls,
    request: vi.fn(async (request: GuardRequest) => {
      calls.push(request);
      switch (request.method) {
        case 'discover': return [{ id: '/repo', name: 'repo', rootPath: '/repo' }];
        case 'status': return { files: [{ path: 'docs/a.md', index: '.', worktree: 'D', submodule: false }], branch: 'main', head: 'h', ahead: 0, behind: 0 };
        case 'history': return { entries: [commit] };
        case 'commitFiles': return [{ path: 'docs/a.md', index: 'M', worktree: '.', submodule: false }];
        default: return undefined;
      }
    }),
    subscribe: () => ({ dispose() {} }),
    loadState: () => ({ expanded: ['/repo'], drafts: {}, selected: '/repo' }),
    saveState: () => {},
  };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('VersionGuardPanel', () => {
  it('offers to create a Git repository when the open folder has none', async () => {
    const guard = client(); const base = guard.request; let initialized = false;
    guard.request = vi.fn(async (request: GuardRequest) => {
      if (request.method === 'init') { guard.calls.push(request); initialized = true; return ['/repo']; }
      if (request.method === 'discover' && !initialized) { guard.calls.push(request); return []; }
      return base(request);
    });
    const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    const init = panel.element.querySelector<HTMLButtonElement>('.guard-init');
    expect(init?.textContent).toBe('创建 Git 仓库');
    init!.click(); for (let i = 0; i < 8; i++) await flush();
    expect(guard.calls.map(call => call.method)).toContain('init');
    expect(panel.element.querySelector('.guard-init')).toBeNull();
    expect(panel.element.querySelector('.guard-repo-title')).not.toBeNull();
    panel.dispose();
  });
  it('keeps the commit file list stable across status refreshes (no flicker)', async () => {
    const guard = client(); const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    panel.element.querySelector<HTMLButtonElement>('.guard-commit')!.click(); for (let i = 0; i < 3; i++) await flush();
    const row = panel.element.querySelector('.guard-history .guard-file'); expect(row).not.toBeNull();
    for (let i = 0; i < 5; i++) { panel.invalidate(null); await flush(); }
    expect(panel.element.querySelector('.guard-history .guard-file')).toBe(row);
    expect(guard.calls.filter(call => call.method === 'commitFiles')).toHaveLength(1);
    expect(panel.element.querySelector('.guard-history-head .guard-back')?.textContent).toBeTruthy();
    panel.dispose();
  });
  it('expands and collapses every repository from one header toggle, without a close button', async () => {
    const guard = client(); const base = guard.request;
    guard.request = vi.fn(async (request: GuardRequest) => request.method === 'discover'
      ? [{ id: '/repo', name: 'repo', rootPath: '/repo' }, { id: '/other', name: 'other', rootPath: '/other' }]
      : base(request));
    const states: boolean[] = [];
    const panel = new VersionGuardPanel({ client: guard, onExpandStateChange: state => states.push(state) }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    const header = panel.element.querySelector('header')!;
    expect(header.querySelector('.guard-panel-icon')?.getAttribute('title')).toBe('仓库版本管理');
    expect(header.textContent).not.toContain('仓库版本管理');
    const titles = () => [...header.querySelectorAll('button')].map(button => button.title);
    expect(titles()).toEqual(['刷新仓库', '展开全部']);
    const expanded = () => [...panel.element.querySelectorAll('.guard-repo-title')].map(row => row.getAttribute('aria-expanded'));
    expect(expanded()).toEqual(['true', 'false']);
    header.querySelector<HTMLButtonElement>('[title="展开全部"]')!.click(); for (let i = 0; i < 3; i++) await flush();
    expect(expanded()).toEqual(['true', 'true']);
    expect(titles()).toEqual(['刷新仓库', '收起全部']);
    expect(guard.calls.some(call => call.method === 'status' && call.repository === '/other')).toBe(true);
    header.querySelector<HTMLButtonElement>('[title="收起全部"]')!.click(); await flush();
    expect(expanded()).toEqual(['false', 'false']);
    expect(titles()).toEqual(['刷新仓库', '展开全部']);
    expect(states).toEqual([false, true, false]);
    panel.dispose();
  });
  it('renders deleted files struck through, without the removed hint texts', async () => {
    const guard = client(); const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    expect(panel.element.querySelector('.guard-file.is-deleted')).not.toBeNull();
    expect(panel.element.querySelector('.guard-checked')).toBeNull();
    expect(panel.element.querySelector('textarea')?.getAttribute('rows')).toBe('1');
    panel.dispose();
  });
  it('indents nested repositories and collapses history by clicking its header', async () => {
    const guard = client();
    const base = guard.request;
    guard.request = vi.fn(async (request: GuardRequest) => request.method === 'discover'
      ? [{ id: '/repo', name: 'repo', rootPath: '/repo' }, { id: '/repo/sub', name: 'sub', rootPath: '/repo/sub' }]
      : base(request));
    const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 6; i++) await flush();
    const sections = panel.element.querySelectorAll<HTMLElement>('.guard-repository');
    expect(sections[0].classList.contains('is-nested')).toBe(false);
    expect(sections[1].classList.contains('is-nested')).toBe(true);
    expect(sections[1].style.getPropertyValue('--guard-depth')).toBe('1');
    const head = () => panel.element.querySelector<HTMLElement>('.guard-history-head')!;
    expect(panel.element.querySelector('.guard-commit')).not.toBeNull();
    head().click();
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(panel.element.querySelector('.guard-commit')).toBeNull();
    head().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(panel.element.querySelector('.guard-commit')).not.toBeNull();
    panel.dispose();
  });
  it('commits unstaged changes directly once a message is entered, staging them first', async () => {
    const guard = client(); const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    const commitButton = () => panel.element.querySelector<HTMLButtonElement>('.guard-actions .is-primary')!;
    expect(commitButton().disabled).toBe(true);
    const input = panel.element.querySelector('textarea')!; input.value = 'Remove a'; input.dispatchEvent(new Event('input'));
    expect(commitButton().disabled).toBe(false);
    expect(commitButton().title).toMatch(/^(Stage all changes and commit|暂存全部更改并提交)$/);
    commitButton().click(); for (let i = 0; i < 3; i++) await flush();
    expect(guard.calls.find(call => call.method === 'commit')).toMatchObject({ message: 'Remove a', stageAll: true });
    panel.dispose();
  });
  it('omits the built-in header for hosts that provide their own title and refresh action', async () => {
    const guard = client(); const panel = new VersionGuardPanel({ client: guard, header: false }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    expect(panel.element.querySelector('header')).toBeNull();
    const discovers = guard.calls.filter(call => call.method === 'discover').length;
    panel.refreshRepositories(); for (let i = 0; i < 5; i++) await flush();
    expect(guard.calls.filter(call => call.method === 'discover').length).toBe(discovers + 1);
    panel.dispose();
  });
  it('opens a branch picker from the branch label and switches or creates branches', async () => {
    const guard = client(); const base = guard.request;
    guard.request = vi.fn(async (request: GuardRequest) => {
      if (request.method !== 'branches') return base(request);
      guard.calls.push(request);
      return [
        { name: 'main', remote: false, current: true, upstream: 'origin/main', ahead: 0, behind: 1, subject: 'Base', author: 'A', timestamp: Date.now() - 86400000 },
        { name: 'product_design', remote: false, current: false, subject: 'Design', author: 'B', timestamp: Date.now() - 172800000 },
        { name: 'origin/feature', remote: true, current: false, subject: 'Feature', author: 'C', timestamp: Date.now() },
      ];
    });
    const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    const label = panel.element.querySelector<HTMLButtonElement>('.guard-branch-name')!;
    expect(label.textContent).toBe('main');
    const expanded = panel.element.querySelector('.guard-repo-title')!.getAttribute('aria-expanded');
    label.click(); for (let i = 0; i < 3; i++) await flush();
    expect(panel.element.querySelector('.guard-repo-title')!.getAttribute('aria-expanded')).toBe(expanded);
    const picker = () => panel.element.querySelector<HTMLElement>('.guard-branch-picker');
    const names = () => [...picker()!.querySelectorAll('.guard-branch-item-name')].map(node => node.textContent);
    expect(names()).toEqual([expect.stringMatching(/…$/), 'main', 'product_design', 'origin/feature']);
    expect(picker()!.textContent).toContain('A • Base');
    const input = picker()!.querySelector('input')!;
    input.value = 'feat'; input.dispatchEvent(new Event('input'));
    expect(names()).toEqual([expect.stringContaining('feat'), 'origin/feature']);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    for (let i = 0; i < 3; i++) await flush();
    expect(picker()).toBeNull();
    expect(guard.calls.find(call => call.method === 'checkout')).toMatchObject({ branch: 'origin/feature', create: false });
    panel.element.querySelector<HTMLButtonElement>('.guard-branch-name')!.click(); for (let i = 0; i < 3; i++) await flush();
    const second = picker()!.querySelector('input')!; second.value = 'topic/x'; second.dispatchEvent(new Event('input'));
    second.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); for (let i = 0; i < 3; i++) await flush();
    expect(guard.calls.filter(call => call.method === 'checkout').at(-1)).toMatchObject({ branch: 'topic/x', create: true });
    panel.element.querySelector<HTMLButtonElement>('.guard-branch-name')!.click(); for (let i = 0; i < 3; i++) await flush();
    picker()!.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(picker()).toBeNull();
    panel.dispose();
  });
  it('offers Copy Name and Copy Path on branch picker rows', async () => {
    const guard = client(); const base = guard.request;
    guard.request = vi.fn(async (request: GuardRequest) => {
      if (request.method === 'branches') {
        guard.calls.push(request);
        return [
          { name: 'main', remote: false, current: true, subject: 'Base', author: 'A', timestamp: Date.now() },
          { name: 'design_zxy', remote: false, current: false, subject: 'Design', author: 'B', timestamp: Date.now() },
          { name: 'origin/release/v2.0.0', remote: true, current: false, subject: 'Release', author: 'C', timestamp: Date.now() },
        ];
      }
      return base(request);
    });
    const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    panel.element.querySelector<HTMLButtonElement>('.guard-branch-name')!.click(); for (let i = 0; i < 3; i++) await flush();
    const design = [...panel.element.querySelectorAll('.guard-branch-item')].find(row => row.querySelector('.guard-branch-item-name')?.textContent === 'design_zxy')!;
    design.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    const menu = () => document.body.querySelector<HTMLElement>('.guard-context-menu');
    expect([...menu()!.querySelectorAll('button')].map(button => button.textContent)).toEqual(['复制名称', '复制路径']);
    expect(panel.element.querySelector('.guard-branch-picker')).not.toBeNull();
    [...menu()!.querySelectorAll('button')].find(button => button.textContent === '复制名称')!.click();
    for (let i = 0; i < 3; i++) await flush();
    expect(guard.calls.filter(call => call.method === 'copyText').at(-1)).toMatchObject({ method: 'copyText', text: 'design_zxy' });

    const remote = [...panel.element.querySelectorAll('.guard-branch-item')].find(row => row.querySelector('.guard-branch-item-name')?.textContent === 'origin/release/v2.0.0')!;
    remote.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 80 }));
    [...menu()!.querySelectorAll('button')].find(button => button.textContent === '复制路径')!.click();
    for (let i = 0; i < 3; i++) await flush();
    expect(guard.calls.filter(call => call.method === 'copyText').at(-1)).toMatchObject({
      method: 'copyText',
      text: 'refs/remotes/origin/release/v2.0.0',
    });
    panel.dispose();
  });
  it.each([
    { ahead: 0, behind: 0, method: 'none', label: /^(Up to date|已同步)$/, disabled: true },
    { ahead: 0, behind: 5, method: 'pull', label: /↓5$/, disabled: false },
    { ahead: 2, behind: 0, method: 'push', label: /↑2$/, disabled: false },
    { ahead: 1, behind: 5, method: 'sync', label: /↓5 ↑1$/, disabled: false },
  ])('shows one sync button for ahead $ahead / behind $behind', async ({ ahead, behind, method, label, disabled }) => {
    const guard = client();
    const base = guard.request;
    guard.request = vi.fn(async (request: GuardRequest) => {
      if (request.method !== 'status') return base(request);
      guard.calls.push(request);
      return { files: [], branch: 'main', head: 'h', upstream: 'origin/main', ahead, behind };
    });
    const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    const actions = panel.element.querySelector('.guard-actions')!;
    expect(actions.querySelectorAll('button')).toHaveLength(2);
    const sync = actions.querySelector<HTMLButtonElement>('.guard-sync')!;
    expect(sync.dataset.method).toBe(method); expect(sync.textContent).toMatch(label); expect(sync.disabled).toBe(disabled);
    const fetch = panel.element.querySelector<HTMLButtonElement>('.guard-repo-title .guard-fetch')!;
    expect(fetch.disabled).toBe(false);
    const expanded = panel.element.querySelector('.guard-repo-title')!.getAttribute('aria-expanded');
    fetch.click(); for (let i = 0; i < 3; i++) await flush();
    expect(guard.calls.some(call => call.method === 'fetch')).toBe(true);
    expect(panel.element.querySelector('.guard-repo-title')!.getAttribute('aria-expanded')).toBe(expanded);
    if (!disabled) { sync.click(); for (let i = 0; i < 3; i++) await flush(); expect(guard.calls.some(call => call.method === method)).toBe(true); }
    panel.dispose();
  });
  it('bounds history pages and renders file/history viewports after repeated more requests', async () => {
    const guard = client(); const base = guard.request;
    guard.request = vi.fn(async request => {
      if (request.method === 'history') {
        const offset = Number(request.cursor ?? 0);
        return { entries: Array.from({ length: 100 }, (_, i) => ({ ...commit, hash: `commit-${offset + i}`, message: `Commit ${offset + i}` })), cursor: String(offset + 100) };
      }
      if (request.method === 'commitFiles') return Array.from({ length: 5000 }, (_, i) => ({ path: `file-${i}.md`, index: 'M', worktree: '.', submodule: false }));
      return base(request);
    });
    const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element); panel.setVisible(true);
    for (let i = 0; i < 5; i++) await flush();
    for (let page = 0; page < 9; page++) {
      panel.element.querySelector<HTMLButtonElement>('.guard-history button[aria-label="加载更多"]')!.click();
      for (let i = 0; i < 3; i++) await flush();
    }
    const internal = panel as unknown as { histories: { get(key: string): { entries: unknown[] } }; commitFiles: { size: number } };
    expect(internal.histories.get('/repo').entries).toHaveLength(500);
    expect(panel.element.querySelectorAll('.guard-commit').length).toBeLessThan(25);
    panel.element.querySelector<HTMLButtonElement>('.guard-commit')!.click(); for (let i = 0; i < 3; i++) await flush();
    expect(panel.element.querySelectorAll('.guard-history .guard-file').length).toBeLessThan(25);
    expect(internal.commitFiles.size).toBe(1); panel.dispose(); expect(internal.commitFiles.size).toBe(0);
  });

});
