/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest';
import { resolveWorkspaceTreeIcon, type GuardClient, type GuardRequest, type GuardUiState } from '@easyview/contracts';
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
    expect(titles()).toEqual(['刷新仓库', '展开全部', '单仓聚焦：关（点击开启）']);
    const expanded = () => [...panel.element.querySelectorAll('.guard-repo-title')].map(row => row.getAttribute('aria-expanded'));
    expect(expanded()).toEqual(['true', 'false']);
    header.querySelector<HTMLButtonElement>('[title="展开全部"]')!.click(); for (let i = 0; i < 3; i++) await flush();
    expect(expanded()).toEqual(['true', 'true']);
    expect(titles()).toEqual(['刷新仓库', '收起全部', '单仓聚焦：关（点击开启）']);
    expect(guard.calls.some(call => call.method === 'status' && call.repository === '/other')).toBe(true);
    header.querySelector<HTMLButtonElement>('[title="收起全部"]')!.click(); await flush();
    expect(expanded()).toEqual(['false', 'false']);
    expect(titles()).toEqual(['刷新仓库', '展开全部', '单仓聚焦：关（点击开启）']);
    expect(states).toEqual([false, true, false]);
    expect(panel.element.querySelector('.guard-repo-title.is-selected')).toBeNull();
    panel.element.querySelectorAll<HTMLElement>('.guard-repo-title')[0]!.click(); await flush();
    expect(panel.element.querySelector('.guard-repository[data-repository="/repo"] .guard-repo-title')?.classList.contains('is-selected')).toBe(true);
    panel.element.querySelectorAll<HTMLElement>('.guard-repo-title')[0]!.click(); await flush();
    expect(panel.element.querySelector('.guard-repo-title.is-selected')).toBeNull();
    panel.dispose();
  });
  it('keeps pinned repositories on top and syncs the header Focus toggle with row pins', async () => {
    const guard = client(); const base = guard.request; const soloStates: boolean[] = []; const saved: GuardUiState[] = [];
    const ids = ['/a', '/b', '/c'];
    guard.request = vi.fn(async (request: GuardRequest) => {
      if (request.method === 'discover') return ids.map(id => ({ id, name: id.slice(1), rootPath: id }));
      if (request.method === 'status') return { files: [{ path: 'f.md', index: 'M', worktree: '.', submodule: false }], branch: 'main', head: 'h', ahead: 0, behind: 0 };
      return base(request);
    });
    guard.loadState = () => ({ expanded: ['/b'], drafts: {}, selected: '/b' });
    guard.saveState = state => saved.push(structuredClone(state));
    const panel = new VersionGuardPanel({ client: guard, onSoloStateChange: state => soloStates.push(state) }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 8; i++) await flush();
    const solo = () => panel.element.querySelector<HTMLButtonElement>('header [aria-pressed]')!;
    const pinOf = (id: string) => panel.element.querySelector<HTMLButtonElement>(`.guard-repository[data-repository="${id}"] .guard-repo-pin`)!;
    expect(solo().getAttribute('aria-pressed')).toBe('false');
    expect(panel.element.querySelectorAll('.guard-repo-pin')).toHaveLength(3);
    // Header on → pins the current selection at the top.
    solo().click(); await flush();
    expect(solo().getAttribute('aria-pressed')).toBe('true');
    expect(solo().classList.contains('is-active')).toBe(true);
    expect(soloStates).toEqual([false, true]);
    expect(pinOf('/b').classList.contains('is-pinned')).toBe(true);
    expect([...panel.element.querySelectorAll('.guard-solo-main .guard-repository')].map(el => el.getAttribute('data-repository'))).toEqual(['/b']);
    expect([...panel.element.querySelectorAll('.guard-solo-below .guard-repository')].map(el => el.getAttribute('data-repository'))).toEqual(['/a', '/c']);
    // Row pin adds another repo to the focused top stack and keeps header on.
    pinOf('/c').click(); await flush();
    expect(solo().getAttribute('aria-pressed')).toBe('true');
    expect([...panel.element.querySelectorAll('.guard-solo-main .guard-repository')].map(el => el.getAttribute('data-repository'))).toEqual(['/b', '/c']);
    expect([...panel.element.querySelectorAll('.guard-solo-below .guard-repository')].map(el => el.getAttribute('data-repository'))).toEqual(['/a']);
    expect(saved.at(-1)?.pinned).toEqual(['/b', '/c']);
    expect(saved.at(-1)?.solo).toBe(true);
    // Unpinning the last focused repos turns Focus mode off and clears the header.
    pinOf('/b').click(); await flush();
    pinOf('/c').click(); await flush();
    expect(solo().getAttribute('aria-pressed')).toBe('false');
    expect(panel.element.querySelector('.guard-solo-main')).toBeNull();
    expect(soloStates.at(-1)).toBe(false);
    // Pinning from a normal list turns Focus mode on without using the header first.
    pinOf('/a').click(); await flush();
    expect(solo().getAttribute('aria-pressed')).toBe('true');
    expect([...panel.element.querySelectorAll('.guard-solo-main .guard-repository')].map(el => el.getAttribute('data-repository'))).toEqual(['/a']);
    solo().click(); await flush();
    expect(solo().getAttribute('aria-pressed')).toBe('false');
    expect(saved.at(-1)?.pinned).toEqual([]);
    panel.dispose();
  });
  it('opens the diff when clicking anywhere on a change row, but not from its action buttons', async () => {
    const guard = client(); const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    const row = panel.element.querySelector<HTMLElement>('.guard-file:not(.guard-dir)')!;
    row.querySelector<HTMLElement>('.guard-file-status')!.click(); await flush();
    expect(guard.calls.filter(call => call.method === 'openDiff')).toEqual([expect.objectContaining({ repository: '/repo', paths: ['docs/a.md'], source: 'working' })]);
    row.querySelector<HTMLButtonElement>('.guard-file-actions button')!.click(); await flush();
    expect(guard.calls.filter(call => call.method === 'openDiff')).toHaveLength(1);
    panel.dispose();
  });
  it('reveals and copies file and directory paths from the context menu and the tree shortcuts', async () => {
    const guard = client(); const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    const copies = () => guard.calls.filter(call => ['revealInIndexArea', 'copyPath', 'copyRelativePath'].includes(call.method)).map(({ method, repository, paths }) => ({ method, repository, paths }));
    const file = panel.element.querySelector<HTMLElement>('.guard-file[data-path="docs/a.md"]')!;
    expect(file.title).toBe('/repo/docs/a.md');
    const expected = document.createElement('span'); expected.innerHTML = resolveWorkspaceTreeIcon({ kind: 'file', name: 'a.md' }).svg;
    expect(file.querySelector('.guard-file-icon')!.innerHTML).toBe(expected.innerHTML);
    expect(panel.element.querySelector<HTMLElement>('.guard-dir')!.title).toBe('/repo/docs');
    file.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    const items = [...document.querySelectorAll<HTMLButtonElement>('.guard-context-menu button')];
    expect(items.map(item => item.firstElementChild?.textContent)).toEqual(['在 IndexArea 中显示', '复制路径', '复制相对路径']);
    items[2].click(); await flush();
    expect(document.querySelector('.guard-context-menu')).toBeNull();
    expect(file.classList.contains('is-selected')).toBe(true);
    file.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ç', code: 'KeyC', altKey: true, metaKey: true }));
    await flush();
    const dir = panel.element.querySelector<HTMLElement>('.guard-dir')!;
    dir.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    document.querySelector<HTMLButtonElement>('.guard-context-menu button')!.click(); await flush();
    dir.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    document.querySelectorAll<HTMLButtonElement>('.guard-context-menu button')[1].click(); await flush();
    expect(copies()).toEqual([
      { method: 'copyRelativePath', repository: '/repo', paths: ['docs/a.md'] },
      { method: 'copyPath', repository: '/repo', paths: ['docs/a.md'] },
      { method: 'revealInIndexArea', repository: '/repo', paths: ['docs/'] },
      { method: 'copyPath', repository: '/repo', paths: ['docs/'] },
    ]);
    panel.dispose();
  });
  it('collapses and expands every node of a change group from its header', async () => {
    const guard = client(); const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    const header = () => panel.element.querySelector<HTMLElement>('.guard-group')!;
    const rows = () => panel.element.querySelectorAll('.guard-repo-body .guard-file').length;
    expect(header().getAttribute('aria-expanded')).toBe('true'); expect(rows()).toBe(2);
    header().querySelector<HTMLButtonElement>('[aria-label="全部暂存"]')!.click(); await flush();
    expect(guard.calls.some(call => call.method === 'stage')).toBe(true); expect(rows()).toBe(2);
    header().querySelector<HTMLButtonElement>('[aria-label="全部丢弃"]')!.click(); await flush();
    expect(guard.calls.find(call => call.method === 'discard')).toMatchObject({ repository: '/repo', paths: ['docs/a.md'] });
    header().click();
    expect(header().getAttribute('aria-expanded')).toBe('false'); expect(rows()).toBe(0);
    header().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(header().getAttribute('aria-expanded')).toBe('true'); expect(rows()).toBe(2);
    panel.dispose();
  });
  it('refreshes only one repository from its row refresh button', async () => {
    const guard = client(); const base = guard.request;
    guard.request = vi.fn(async (request: GuardRequest) => request.method === 'discover'
      ? (guard.calls.push(request), [{ id: '/repo', name: 'repo', rootPath: '/repo' }, { id: '/other', name: 'other', rootPath: '/other' }])
      : base(request));
    const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 8; i++) await flush();
    guard.calls.length = 0;
    const row = (id: string) => panel.element.querySelector<HTMLElement>(`.guard-repository[data-repository="${id}"] .guard-repo-title`)!;
    const expanded = row('/repo').getAttribute('aria-expanded');
    row('/repo').querySelector<HTMLButtonElement>('.guard-repo-refresh')!.click(); for (let i = 0; i < 5; i++) await flush();
    expect(guard.calls.map(call => `${call.method}:${call.repository ?? ''}`)).toEqual(['status:/repo', 'history:/repo']);
    expect(row('/repo').getAttribute('aria-expanded')).toBe(expanded);
    expect(row('/repo').querySelector('.guard-repo-refresh')?.getAttribute('title')).toBe('刷新此仓库');
    panel.dispose();
  });
  it('renders deleted files struck through, without the removed hint texts', async () => {
    const guard = client(); const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    expect(panel.element.querySelector('.guard-file.is-deleted')).not.toBeNull();
    expect(panel.element.querySelector('.guard-checked')).toBeNull();
    expect(panel.element.querySelector('textarea')?.getAttribute('rows')).toBe('1');
    expect(panel.element.querySelector('.guard-notice')).toBeNull();
    panel.dispose();
  });
  it('shows operation failures in a host dialog instead of a top banner', async () => {
    const guard = client(); const base = guard.request;
    guard.request = vi.fn(async (request: GuardRequest) => {
      if (request.method === 'commit') { guard.calls.push(request); throw new Error('> running pre-commit hook\nlint failed'); }
      if (request.method === 'confirm') { guard.calls.push(request); return 0; }
      return base(request);
    });
    const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    const input = panel.element.querySelector('textarea')!;
    input.value = 'msg'; input.dispatchEvent(new Event('input'));
    panel.element.querySelector<HTMLButtonElement>('.guard-actions .is-primary')!.click();
    for (let i = 0; i < 5; i++) await flush();
    expect(guard.calls.filter(call => call.method === 'confirm').at(-1)).toMatchObject({
      method: 'confirm',
      message: '操作失败',
      detail: '> running pre-commit hook\nlint failed',
      choices: ['确定', '复制'],
    });
    expect(panel.element.querySelector('.guard-notice')).toBeNull();
    panel.dispose();
  });
  it('keeps long failure dialogs short and copies the full text on request', async () => {
    const full = Array.from({ length: 20 }, (_, i) => `line ${i + 1}: npm ERR! detail`).join('\n');
    const guard = client(); const base = guard.request;
    guard.request = vi.fn(async (request: GuardRequest) => {
      if (request.method === 'commit') { guard.calls.push(request); throw new Error(full); }
      if (request.method === 'confirm') { guard.calls.push(request); return 1; }
      if (request.method === 'copyText') { guard.calls.push(request); return true; }
      return base(request);
    });
    const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    const input = panel.element.querySelector('textarea')!;
    input.value = 'msg'; input.dispatchEvent(new Event('input'));
    panel.element.querySelector<HTMLButtonElement>('.guard-actions .is-primary')!.click();
    for (let i = 0; i < 6; i++) await flush();
    const dialog = guard.calls.filter(call => call.method === 'confirm').at(-1)!;
    expect(dialog.message).toBe('操作失败');
    expect(dialog.choices).toEqual(['确定', '复制']);
    expect(String(dialog.detail)).toContain('完整内容请点「复制」。');
    expect(String(dialog.detail).split('\n').length).toBeLessThan(full.split('\n').length);
    expect(guard.calls.filter(call => call.method === 'copyText').at(-1)).toMatchObject({ method: 'copyText', text: full });
    panel.dispose();
  });
  it('grows the commit message box as lines wrap or break', async () => {
    const guard = client(); const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    const input = panel.element.querySelector('textarea')!;
    Object.defineProperty(input, 'scrollHeight', {
      configurable: true,
      get() { return Math.max(1, String((this as HTMLTextAreaElement).value).split('\n').length) * 24; },
    });
    input.value = 'one'; input.dispatchEvent(new Event('input'));
    const short = parseFloat(input.style.height);
    input.value = 'line1\nline2\nline3\nline4\nline5'; input.dispatchEvent(new Event('input'));
    const tall = parseFloat(input.style.height);
    expect(short).toBeGreaterThan(0);
    expect(tall).toBeGreaterThan(short);
    expect(tall).toBeLessThanOrEqual(12.5 * 16 + 1);
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
    expect(head().classList.contains('is-open')).toBe(true);
    expect(head().classList.contains('is-collapsed')).toBe(false);
    head().click();
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(head().classList.contains('is-collapsed')).toBe(true);
    expect(head().classList.contains('is-open')).toBe(false);
    expect(panel.element.querySelector('.guard-commit')).toBeNull();
    head().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(panel.element.querySelector('.guard-commit')).not.toBeNull();
    expect(head().classList.contains('is-open')).toBe(true);
    panel.dispose();
  });
  it('asks before staging every change when committing with nothing staged, until the user picks Always', async () => {
    const guard = client(); const base = guard.request; const answers = [-1, 0, 1]; const saved: GuardUiState[] = [];
    guard.request = vi.fn(async (request: GuardRequest) => request.method === 'confirm' ? (guard.calls.push(request), answers.shift()) : base(request));
    guard.saveState = state => saved.push(structuredClone(state));
    const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    const commitButton = () => panel.element.querySelector<HTMLButtonElement>('.guard-actions .is-primary')!;
    const input = () => panel.element.querySelector('textarea')!;
    const type = (text: string) => { input().value = text; input().dispatchEvent(new Event('input')); };
    const commits = () => guard.calls.filter(call => call.method === 'commit');
    expect(commitButton().disabled).toBe(true);
    expect(input().placeholder).toMatch(/^提交说明（(⌘↩|Ctrl\+Enter) 提交到“main”）$/);
    type('Remove a'); expect(commitButton().disabled).toBe(false);
    commitButton().click(); for (let i = 0; i < 3; i++) await flush();
    expect(guard.calls.find(call => call.method === 'confirm')).toMatchObject({ message: '没有已暂存的更改。要暂存全部 1 个更改并直接提交吗？', choices: ['是', '总是（不再询问）'] });
    expect(commits()).toHaveLength(0);
    const mac = /mac|iphone|ipad/i.test(navigator.platform);
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: mac, ctrlKey: !mac, bubbles: true })); for (let i = 0; i < 3; i++) await flush();
    expect(commits()).toEqual([expect.objectContaining({ message: 'Remove a', stageAll: true })]);
    type('Again'); commitButton().click(); for (let i = 0; i < 3; i++) await flush();
    expect(saved.at(-1)?.smartCommit).toBe(true); expect(commits()).toHaveLength(2);
    type('Third'); commitButton().click(); for (let i = 0; i < 3; i++) await flush();
    expect(guard.calls.filter(call => call.method === 'confirm')).toHaveLength(3); expect(commits()).toHaveLength(3);
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
    const rows = [...panel.element.querySelectorAll('.guard-branch-item')];
    const design = rows.find(row => row.querySelector('.guard-branch-item-name')?.textContent === 'design_zxy')!;
    design.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    const menu = () => document.body.querySelector<HTMLElement>('.guard-context-menu');
    expect(menu()).not.toBeNull();
    expect([...menu()!.querySelectorAll('button')].map(button => button.textContent)).toEqual(['复制名称', '复制路径']);
    expect(panel.element.querySelector('.guard-branch-picker')).not.toBeNull();
    [...menu()!.querySelectorAll('button')].find(button => button.textContent === '复制名称')!.click();
    for (let i = 0; i < 3; i++) await flush();
    expect(guard.calls.filter(call => call.method === 'copyText').at(-1)).toMatchObject({ method: 'copyText', text: 'design_zxy' });
    expect(panel.element.querySelector('.guard-branch-picker')).not.toBeNull();

    const remote = [...panel.element.querySelectorAll('.guard-branch-item')].find(row => row.querySelector('.guard-branch-item-name')?.textContent === 'origin/release/v2.0.0')!;
    remote.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 80 }));
    [...menu()!.querySelectorAll('button')].find(button => button.textContent === '复制路径')!.click();
    for (let i = 0; i < 3; i++) await flush();
    expect(guard.calls.filter(call => call.method === 'copyText').at(-1)).toMatchObject({
      method: 'copyText',
      text: 'refs/remotes/origin/release/v2.0.0',
    });
    // Local branch Copy Path uses refs/heads/…
    const local = [...panel.element.querySelectorAll('.guard-branch-item')].find(row => row.querySelector('.guard-branch-item-name')?.textContent === 'design_zxy')!;
    local.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    [...menu()!.querySelectorAll('button')].find(button => button.textContent === '复制路径')!.click();
    for (let i = 0; i < 3; i++) await flush();
    expect(guard.calls.filter(call => call.method === 'copyText').at(-1)).toMatchObject({
      method: 'copyText',
      text: 'refs/heads/design_zxy',
    });
    panel.dispose();
  });
  it.each([
    { ahead: 0, behind: 0, pull: false, push: false, pushTitle: '没有需要推送的提交' },
    { ahead: 0, behind: 5, pull: true, push: false, pushTitle: '没有需要推送的提交' },
    { ahead: 2, behind: 0, pull: false, push: true, pushTitle: '推送 2 个提交到 origin/main' },
    { ahead: 1, behind: 5, pull: true, push: false, pushTitle: '远端有新提交，请先拉取' },
  ])('shows pull and push count buttons in the title row for ahead $ahead / behind $behind', async ({ ahead, behind, pull, push, pushTitle }) => {
    const guard = client();
    const base = guard.request;
    guard.request = vi.fn(async (request: GuardRequest) => {
      if (request.method !== 'status') return base(request);
      guard.calls.push(request);
      return { files: [], branch: 'main', head: 'h', upstream: 'origin/main', ahead, behind };
    });
    const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    const title = () => panel.element.querySelector('.guard-repo-title')!;
    const button = (method: string) => title().querySelector<HTMLButtonElement>(`.guard-sync-count[data-method="${method}"]`)!;
    expect(title().textContent).not.toContain('·');
    expect(panel.element.querySelectorAll('.guard-actions button')).toHaveLength(2);
    expect(button('pull').textContent).toBe(`↓${behind}`); expect(button('pull').disabled).toBe(!pull); expect(button('pull').classList.contains('is-ready')).toBe(pull);
    expect(button('push').textContent).toBe(`↑${ahead}`); expect(button('push').disabled).toBe(!push); expect(button('push').title).toBe(pushTitle);
    const expanded = title().getAttribute('aria-expanded');
    const enabled = pull ? 'pull' : push ? 'push' : undefined;
    if (enabled) { button(enabled).click(); for (let i = 0; i < 3; i++) await flush(); expect(guard.calls.some(call => call.method === enabled)).toBe(true); }
    expect(title().getAttribute('aria-expanded')).toBe(expanded);
    panel.dispose();
  });
  it('refreshes one repository locally first, then checks its remote while showing the counts as pending', async () => {
    const guard = client(); const base = guard.request; let finishFetch: (() => void) | undefined;
    guard.request = vi.fn(async (request: GuardRequest) => {
      if (request.method === 'status') { guard.calls.push(request); return { files: [], branch: 'main', head: 'h', upstream: 'origin/main', ahead: 1, behind: 0 }; }
      if (request.method === 'fetch') { guard.calls.push(request); await new Promise<void>(resolve => { finishFetch = resolve; }); return ''; }
      return base(request);
    });
    const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    guard.calls.length = 0;
    panel.element.querySelector<HTMLButtonElement>('.guard-repo-refresh')!.click(); for (let i = 0; i < 5; i++) await flush();
    expect(guard.calls.map(call => call.method)).toEqual(['status', 'history', 'fetch']);
    const refresh = panel.element.querySelector<HTMLButtonElement>('.guard-repo-refresh')!;
    expect(refresh.classList.contains('is-spinning')).toBe(true);
    expect([...panel.element.querySelectorAll('.guard-sync-count')].map(node => node.textContent)).toEqual(['↓…', '↑…']);
    finishFetch!(); for (let i = 0; i < 5; i++) await flush();
    expect(guard.calls.map(call => call.method).at(-1)).toBe('status');
    expect([...panel.element.querySelectorAll('.guard-sync-count')].map(node => node.textContent)).toEqual(['↓0', '↑1']);
    panel.dispose();
  });
  it('shows "no remote" instead of counts for a branch without upstream', async () => {
    const guard = client(); const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    expect(panel.element.querySelector('.guard-sync-count')).toBeNull();
    expect(panel.element.querySelector('.guard-no-upstream')?.textContent).toBe('未关联远程');
    panel.dispose();
  });
  it('undoes, amends and stashes from the more menu, restoring the undone message into an empty box', async () => {
    const guard = client(); const base = guard.request;
    guard.request = vi.fn(async (request: GuardRequest) => {
      if (request.method === 'status') { guard.calls.push(request); return { files: [{ path: 'docs/a.md', index: 'M', worktree: '.', submodule: false }], branch: 'main', head: 'h', upstream: 'origin/main', ahead: 1, behind: 0 }; }
      if (request.method === 'confirm') { guard.calls.push(request); return 0; }
      if (request.method === 'undoCommit') { guard.calls.push(request); return 'First change'; }
      return base(request);
    });
    const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    const open = async () => { panel.element.querySelector<HTMLButtonElement>('.guard-more')!.click(); await flush(); return [...document.querySelectorAll<HTMLButtonElement>('.guard-context-menu button')]; };
    const items = await open();
    expect(items.map(item => item.firstElementChild?.textContent)).toEqual(['撤销上次提交', '修改上次提交（amend）', '暂存工作区（stash）', '恢复最近暂存（stash pop）']);
    expect(items.every(item => !item.disabled)).toBe(true);
    items[0].click(); for (let i = 0; i < 5; i++) await flush();
    expect(guard.calls.find(call => call.method === 'confirm')).toMatchObject({ message: '撤销上次提交？', detail: expect.stringContaining('“First change”'), choices: ['撤销'] });
    expect(guard.calls.some(call => call.method === 'undoCommit' && call.repository === '/repo')).toBe(true);
    expect(panel.element.querySelector('textarea')!.value).toBe('First change');
    (await open())[1].click(); for (let i = 0; i < 3; i++) await flush();
    expect(guard.calls.find(call => call.method === 'commit')).toMatchObject({ amend: true, message: 'First change' });
    (await open())[2].click(); for (let i = 0; i < 3; i++) await flush();
    (await open())[3].click(); for (let i = 0; i < 3; i++) await flush();
    expect(guard.calls.filter(call => call.method === 'stash' || call.method === 'stashPop').map(call => call.method)).toEqual(['stash', 'stashPop']);
    panel.dispose();
  });
  it('disables undo and amend once the last commit has been pushed', async () => {
    const guard = client(); const base = guard.request;
    guard.request = vi.fn(async (request: GuardRequest) => request.method === 'status' ? { files: [], branch: 'main', head: 'h', upstream: 'origin/main', ahead: 0, behind: 0 } : base(request));
    const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    panel.element.querySelector<HTMLButtonElement>('.guard-more')!.click(); await flush();
    expect([...document.querySelectorAll<HTMLButtonElement>('.guard-context-menu button')].map(item => item.disabled)).toEqual([true, true, true, false]);
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
  it('refreshes known repositories first when rescanning, keeping them listed until the walk ends', async () => {
    const guard = client(); const base = guard.request; let finishWalk: (() => void) | undefined; let rescanning = false;
    guard.request = vi.fn(async (request: GuardRequest) => {
      if (request.method === 'discover' && rescanning) { guard.calls.push(request); await new Promise<void>(resolve => { finishWalk = resolve; }); return [{ id: '/repo', name: 'repo', rootPath: '/repo' }]; }
      return base(request);
    });
    const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    guard.calls.length = 0; rescanning = true;
    panel.refreshRepositories(); for (let i = 0; i < 5; i++) await flush();
    expect(guard.calls.map(call => call.method)).toEqual(['discover', 'status', 'history']);
    expect(panel.element.querySelectorAll('.guard-repo-title')).toHaveLength(1);
    expect(panel.element.querySelector('.guard-file[data-path="docs/a.md"]')).not.toBeNull();
    finishWalk!(); for (let i = 0; i < 5; i++) await flush();
    expect(guard.calls.filter(call => call.method === 'status')).toHaveLength(1);
    panel.dispose();
  });
  it('refreshes after a host change report even when the panel document is not focused', async () => {
    const guard = client(); let notify: ((paths: string[] | null) => void) | undefined;
    guard.subscribe = listener => { notify = listener; return { dispose() {} }; };
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    await new Promise(resolve => setTimeout(resolve, 3100));
    guard.calls.length = 0; notify!(null);
    await new Promise(resolve => setTimeout(resolve, 900)); await flush();
    expect(guard.calls.map(call => call.method)).toContain('status');
    focus.mockRestore(); panel.dispose();
  }, 10000);
  it('reads the status again when a refresh arrives while a read is still in flight', async () => {
    const guard = client(); const base = guard.request; let release: (() => void) | undefined; let hold = false; let reads = 0;
    guard.request = vi.fn(async (request: GuardRequest) => {
      if (request.method === 'status') { reads++; if (hold) { hold = false; await new Promise<void>(resolve => { release = resolve; }); } }
      return base(request);
    });
    const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    reads = 0; hold = true;
    panel.element.querySelector<HTMLButtonElement>('.guard-repo-refresh')!.click(); await flush();
    expect(reads).toBe(1);
    void (panel as unknown as { loadStatus(id: string): Promise<void> }).loadStatus('/repo'); await flush();
    expect(reads).toBe(1);
    release!(); for (let i = 0; i < 8; i++) await flush();
    expect(reads).toBe(2);
    panel.dispose();
  });
});
