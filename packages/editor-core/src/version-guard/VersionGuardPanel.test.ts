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
        case 'remoteVisibility': return {};
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
    // Collapse-all keeps the selected title highlighted.
    expect(panel.element.querySelector('.guard-repository[data-repository="/repo"] .guard-repo-title')?.classList.contains('is-selected')).toBe(true);
    panel.element.querySelectorAll<HTMLElement>('.guard-repo-title')[0]!.click(); await flush();
    expect(panel.element.querySelector('.guard-repository[data-repository="/repo"] .guard-repo-title')?.classList.contains('is-selected')).toBe(true);
    expect(expanded()[0]).toBe('true');
    // Re-clicking the selected title only collapses; selection stays.
    panel.element.querySelectorAll<HTMLElement>('.guard-repo-title')[0]!.click(); await flush();
    expect(panel.element.querySelector('.guard-repository[data-repository="/repo"] .guard-repo-title')?.classList.contains('is-selected')).toBe(true);
    expect(expanded()[0]).toBe('false');
    // Clicking another title moves selection and expands that repository.
    panel.element.querySelectorAll<HTMLElement>('.guard-repo-title')[1]!.click(); await flush();
    expect(panel.element.querySelector('.guard-repository[data-repository="/other"] .guard-repo-title')?.classList.contains('is-selected')).toBe(true);
    expect(panel.element.querySelector('.guard-repository[data-repository="/repo"] .guard-repo-title')?.classList.contains('is-selected')).toBe(false);
    expect(expanded()[1]).toBe('true');
    panel.dispose();
  });
  it('restores pinned repositories after reload and does not clear them during progressive discovery', async () => {
    const guard = client(); const base = guard.request; const saved: GuardUiState[] = [];
    let resolveDiscover!: (repos: Array<{ id: string; name: string; rootPath: string }>) => void;
    const discovered = new Promise<Array<{ id: string; name: string; rootPath: string }>>(resolve => { resolveDiscover = resolve; });
    const discoveryListeners = new Set<(repositories: Array<{ id: string; name: string; rootPath: string }>, warnings: string[]) => void>();
    guard.loadState = () => ({ expanded: ['/a', '/b'], drafts: {}, selected: '/a', pinned: ['/a', '/b'], solo: true });
    guard.saveState = state => saved.push(structuredClone(state));
    guard.onDiscovery = listener => { discoveryListeners.add(listener); return { dispose: () => discoveryListeners.delete(listener) }; };
    guard.request = vi.fn(async (request: GuardRequest) => {
      if (request.method === 'discover') return discovered;
      if (request.method === 'status') return { files: [], branch: 'main', head: 'h', ahead: 0, behind: 0 };
      return base(request);
    });
    const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); await flush();
    // Partial progressive update must not persist a pruned pin list.
    for (const listener of discoveryListeners) listener([{ id: '/a', name: 'a', rootPath: '/a' }], []);
    await flush();
    expect(saved.some(state => state.pinned?.length === 1)).toBe(false);
    expect(panel.element.querySelector('.guard-repository[data-repository="/a"] .guard-repo-pin.is-pinned')).not.toBeNull();
    resolveDiscover([{ id: '/a', name: 'a', rootPath: '/a' }, { id: '/b', name: 'b', rootPath: '/b' }]);
    for (let i = 0; i < 8; i++) await flush();
    expect(panel.element.querySelector('.guard-repository[data-repository="/a"] .guard-repo-pin.is-pinned')).not.toBeNull();
    expect(panel.element.querySelector('.guard-repository[data-repository="/b"] .guard-repo-pin.is-pinned')).not.toBeNull();
    expect(saved.every(state => (state.pinned?.length ?? 0) !== 1)).toBe(true);
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
        { name: 'product_design', type: 'branch', current: false, subject: 'Design', author: 'B', timestamp: Date.now() - 172800000 },
        { name: 'main', type: 'branch', current: true, upstream: 'origin/main', ahead: 0, behind: 1, subject: 'Base', author: 'A', timestamp: Date.now() - 86400000 },
        { name: 'origin/feature', type: 'remote', current: false, subject: 'Feature', author: 'C', timestamp: Date.now() },
        { name: 'origin/docs', type: 'remote', current: false, subject: 'Docs', author: 'C', timestamp: Date.now() },
        { name: 'v1.0.0', type: 'tag', current: false, subject: 'Release', author: 'D', timestamp: Date.now() },
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
    expect(names()).toEqual(['product_design', 'main', 'origin/feature', 'origin/docs', 'v1.0.0']);
    expect(picker()!.textContent).toContain('A • Base');
    // VS Code-style groups: the label sits on the first row of each group only.
    const groups = () => [...picker()!.querySelectorAll('.guard-branch-item')].map(row => row.querySelector('.guard-branch-item-group')?.textContent ?? null);
    expect(groups()).toEqual(['Local', null, 'Remote', null, 'Tags']);
    expect(picker()!.querySelectorAll('.guard-branch-sep')).toHaveLength(2);
    expect(picker()!.querySelector('.guard-branch-item.is-active .guard-branch-item-name')!.textContent).toBe('main');
    // The create action sits beside the search box; with no name it only asks for one.
    const create = picker()!.querySelector<HTMLButtonElement>('.guard-branch-picker-head .guard-branch-create')!;
    create.click(); for (let i = 0; i < 3; i++) await flush();
    expect(picker()!.querySelector('input')!.placeholder).toBe('输入新分支名称后按回车');
    expect(guard.calls.some(call => call.method === 'checkout')).toBe(false);
    // Only the current branch uses the History ref badge; every other row stays plain text.
    expect([...picker()!.querySelectorAll('.guard-branch-item-name.guard-ref')].map(node => `${node.textContent}:${node.className}`)).toEqual([expect.stringMatching(/^main:.*is-current/)]);
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
    const third = picker()!.querySelector('input')!; third.value = 'topic/y'; third.dispatchEvent(new Event('input'));
    picker()!.querySelector<HTMLButtonElement>('.guard-branch-create')!.click(); for (let i = 0; i < 3; i++) await flush();
    expect(picker()).toBeNull();
    expect(guard.calls.filter(call => call.method === 'checkout').at(-1)).toMatchObject({ branch: 'topic/y', create: true });
    panel.element.querySelector<HTMLButtonElement>('.guard-branch-name')!.click(); for (let i = 0; i < 3; i++) await flush();
    const tagRow = [...picker()!.querySelectorAll('.guard-branch-item')].find(row => row.querySelector('.guard-branch-item-name')?.textContent === 'v1.0.0')!;
    expect(tagRow.querySelector('.guard-branch-item-group')?.textContent).toBe('Tags');
    tagRow.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true })); for (let i = 0; i < 3; i++) await flush();
    expect(guard.calls.filter(call => call.method === 'checkout').at(-1)).toMatchObject({ branch: 'v1.0.0', create: false });
    panel.element.querySelector<HTMLButtonElement>('.guard-branch-name')!.click(); for (let i = 0; i < 3; i++) await flush();
    picker()!.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(picker()).toBeNull();
    panel.dispose();
  });
  it('hides the branch picker hint after five seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const panel = new VersionGuardPanel({ client: client() }); document.body.append(panel.element);
      panel.setVisible(true); for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
      panel.element.querySelector<HTMLButtonElement>('.guard-branch-name')!.click(); await vi.advanceTimersByTimeAsync(0);
      const input = panel.element.querySelector<HTMLInputElement>('.guard-branch-picker input')!;
      expect(input.placeholder).toBe('选择要切换的分支或标签，或输入新分支名称');
      await vi.advanceTimersByTimeAsync(4999); expect(input.placeholder).not.toBe('');
      await vi.advanceTimersByTimeAsync(1); expect(input.placeholder).toBe('');
      expect(input.getAttribute('aria-label')).toBe('选择要切换的分支或标签，或输入新分支名称');
      panel.element.querySelector<HTMLButtonElement>('.guard-branch-create')!.click(); await vi.advanceTimersByTimeAsync(0);
      expect(input.placeholder).toBe('输入新分支名称后按回车');
      await vi.advanceTimersByTimeAsync(5000); expect(input.placeholder).toBe('');
      panel.dispose();
    } finally { vi.useRealTimers(); }
  });
  it('offers Copy Name and Copy Path on branch picker rows', async () => {
    const guard = client(); const base = guard.request;
    guard.request = vi.fn(async (request: GuardRequest) => {
      if (request.method === 'branches') {
        guard.calls.push(request);
        return [
          { name: 'main', type: 'branch', current: true, subject: 'Base', author: 'A', timestamp: Date.now() },
          { name: 'design_zxy', type: 'branch', current: false, subject: 'Design', author: 'B', timestamp: Date.now() },
          { name: 'origin/release/v2.0.0', type: 'remote', current: false, subject: 'Release', author: 'C', timestamp: Date.now() },
          { name: 'github/main', type: 'remote', current: false, subject: 'Mirror', author: 'C', timestamp: Date.now() },
          { name: 'gitlab/main', type: 'remote', current: false, subject: 'Other', author: 'C', timestamp: Date.now() },
        ];
      }
      if (request.method === 'remoteVisibility') { guard.calls.push(request); return { origin: 'private', github: 'public' }; }
      return base(request);
    });
    const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
    panel.setVisible(true); for (let i = 0; i < 5; i++) await flush();
    panel.element.querySelector<HTMLButtonElement>('.guard-branch-name')!.click(); for (let i = 0; i < 3; i++) await flush();
    const rows = [...panel.element.querySelectorAll('.guard-branch-item')];
    const visibility = (name: string) => rows.find(row => row.querySelector('.guard-branch-item-name')?.textContent === name)!.querySelector('.guard-branch-item-visibility')?.textContent;
    expect([visibility('origin/release/v2.0.0'), visibility('github/main'), visibility('gitlab/main'), visibility('main')]).toEqual(['私有', '公开', undefined, undefined]);
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
    // Visibility is asked once per repository until the repository is refreshed.
    const reopen = async () => { for (let i = 0; i < 2; i++) { panel.element.querySelector<HTMLButtonElement>('.guard-branch-name')!.click(); for (let j = 0; j < 3; j++) await flush(); } };
    const asked = () => guard.calls.filter(call => call.method === 'remoteVisibility').length;
    await reopen(); expect(asked()).toBe(1);
    panel.element.querySelector<HTMLButtonElement>('.guard-repo-refresh')!.click(); for (let i = 0; i < 5; i++) await flush();
    await reopen(); expect(asked()).toBe(2);
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
  it('shows VS Code-style ref badges on history rows and a commit card on hover', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const guard = client(); const base = guard.request;
      guard.request = vi.fn(async (request: GuardRequest) => request.method === 'commitStats'
        ? (guard.calls.push(request), { files: 3, insertions: 155, deletions: 14 })
        : request.method === 'remoteUrl'
        ? (guard.calls.push(request), 'https://example.test/group/repo.git')
        : request.method === 'history'
        ? { entries: [
          { ...commit, message: 'Head commit\n\nBody text', refs: [{ name: 'origin/dev', type: 'remote' }, { name: 'dev', type: 'branch', current: true }, { name: 'v1', type: 'tag' }] },
          { ...commit, hash: 'def5678', message: 'Older commit' },
        ] }
        : base(request));
      const panel = new VersionGuardPanel({ client: guard }); document.body.append(panel.element);
      panel.setVisible(true); for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
      const rows = [...panel.element.querySelectorAll<HTMLElement>('.guard-commit')];
      expect(rows).toHaveLength(2);
      expect(rows[1]!.querySelector('.guard-commit-refs')).toBeNull();
      const refs = rows[0]!.querySelector<HTMLElement>('.guard-commit-refs')!;
      const badges = [...refs.querySelectorAll<HTMLElement>('.guard-ref')];
      // Current branch first with its name; matching remote collapses to an icon; tag keeps its label.
      expect(badges.map(badge => badge.className)).toEqual(['guard-ref is-branch is-current', 'guard-ref is-remote is-compact', 'guard-ref is-tag']);
      expect(badges.map(badge => badge.textContent)).toEqual(['dev', '', 'v1']);
      // The whole row opens the card, so it carries no native tooltip.
      expect(rows.map(row => row.hasAttribute('title'))).toEqual([false, false]);
      rows[1]!.dispatchEvent(new MouseEvent('mouseenter')); await vi.advanceTimersByTimeAsync(300);
      const plain = panel.element.querySelector<HTMLElement>('.guard-ref-card')!;
      expect(plain.querySelector('.guard-ref-card-message')?.textContent).toBe('Older commit');
      expect(plain.querySelector('.guard-ref-card-refs')).toBeNull();
      expect(plain.querySelector('.guard-ref-card-hash')?.textContent).toBe('def5678');
      rows[1]!.dispatchEvent(new MouseEvent('mouseleave')); await vi.advanceTimersByTimeAsync(150);
      expect(panel.element.querySelector('.guard-ref-card')).toBeNull();
      rows[0]!.dispatchEvent(new MouseEvent('mouseenter')); await vi.advanceTimersByTimeAsync(300);
      const card = panel.element.querySelector<HTMLElement>('.guard-ref-card')!;
      expect(card.querySelector('.guard-ref-card-message')?.textContent).toBe('Head commit\n\nBody text');
      expect([...card.querySelectorAll('.guard-ref-label')].map(label => label.textContent)).toEqual(['dev', 'origin/dev', 'v1']);
      expect(card.querySelector('.guard-ref-card-meta strong')?.textContent).toBe('Tester');
      expect(card.querySelector('.guard-ref-card-stats')?.textContent).toBe('3 个文件已更改，155 处插入(+)，14 处删除(-)');
      expect(card.querySelector('.guard-ref-card-stats .is-insertions')?.textContent).toBe('155 处插入(+)');
      const hash = card.querySelector<HTMLButtonElement>('.guard-ref-card-hash')!;
      expect(hash.textContent).toBe('abc1234');
      hash.click(); await vi.advanceTimersByTimeAsync(0);
      expect(guard.calls).toContainEqual({ method: 'copyText', text: 'abc1234' });
      rows[0]!.dispatchEvent(new MouseEvent('mouseleave')); await vi.advanceTimersByTimeAsync(150);
      expect(panel.element.querySelector('.guard-ref-card')).toBeNull();
      // Statistics are cached per commit, so hovering again does not query git.
      rows[0]!.dispatchEvent(new MouseEvent('mouseenter')); await vi.advanceTimersByTimeAsync(300);
      expect(guard.calls.filter(call => call.method === 'commitStats' && call.revision === 'abc1234')).toHaveLength(1);
      // Right-click a remote badge: copy its full name or the remote repository address.
      const menuItems = () => [...document.querySelectorAll<HTMLButtonElement>('.guard-context-menu [role="menuitem"]')];
      badges[1]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
      expect(panel.element.querySelector('.guard-ref-card')).toBeNull();
      expect(menuItems().map(item => item.textContent)).toEqual(['复制分支名', '复制仓库地址']);
      menuItems()[0]!.click(); await vi.advanceTimersByTimeAsync(0);
      expect(guard.calls).toContainEqual({ method: 'copyText', text: 'origin/dev' });
      badges[1]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      menuItems()[1]!.click(); for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(0);
      expect(guard.calls).toContainEqual({ method: 'remoteUrl', repository: '/repo', branch: 'refs/remotes/origin/dev' });
      expect(guard.calls).toContainEqual({ method: 'copyText', text: 'https://example.test/group/repo.git' });
      badges[2]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      expect(menuItems()[0]!.textContent).toBe('复制标签名');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      panel.dispose();
    } finally { vi.useRealTimers(); }
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
      [...panel.element.querySelectorAll<HTMLButtonElement>('.guard-history button')].find(button => button.textContent === '加载更多')!.click();
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
