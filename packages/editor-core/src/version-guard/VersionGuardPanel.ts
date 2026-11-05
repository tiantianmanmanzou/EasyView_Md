import { resolveWorkspaceTreeIcon, resolveWorkspaceTreeKeyAction, type GuardBranch, type GuardClient, type GuardCommit, type GuardFile, type GuardHistory, type GuardRepository, type GuardRequest, type GuardStatus, type GuardUiState } from '@easyview/contracts';
import { LruCache, windowedList } from './guardList';
import { formatGuard, tGuard } from './guard.i18n';
/** `header: false` drops the built-in title bar when the host already shows a title and refresh action. */
export interface GuardPanelOptions {
  client: GuardClient; grip?: string; header?: boolean;
  onExpandStateChange?: (allExpanded: boolean) => void;
  onSoloStateChange?: (solo: boolean) => void;
}
/** A file or directory row; `path` is repository-relative (directories end with "/"). */
interface GuardEntry { key: string; repository: string; path: string }
export class VersionGuardPanel {
  readonly element = document.createElement('section');
  private readonly body = document.createElement('div');
  private readonly footer = document.createElement('div');
  private readonly resizeHandle = document.createElement('div');
  private readonly refresh: HTMLButtonElement;
  private repositories: GuardRepository[] = [];
  private statuses = new Map<string, GuardStatus>();
  private stale = new Set<string>();
  private pending = new Set<string>();
  private rerun = new Set<string>();
  private fetching = new Set<string>();
  private progressive = false;
  private ui: GuardUiState;
  private visible = false;
  private scanning = false;
  private initializing = false;
  private scanWarnings: string[] = [];
  private discoverySubscription?: { dispose(): void };
  private disposed = false;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private lastRefresh = new Map<string, number>();
  private histories = new LruCache<string, GuardHistory>(8);
  private selectedCommit?: GuardCommit;
  private collapsedDirs = new Set<string>();
  private commitFiles = new LruCache<string, GuardFile[]>(16);
  private historyKey?: string;
  private historyRequests = new Set<string>();
  private historyCollapsed = false;
  private expandToggle?: HTMLButtonElement;
  private soloToggle?: HTMLButtonElement;
  private lastAllExpanded?: boolean;
  private lastSolo?: boolean;
  private branchPicker?: { element: HTMLElement; dispose(): void };
  private selectedEntry?: GuardEntry;
  private closeMenu?: () => void;
  private subscription: { dispose(): void };
  constructor(private readonly options: GuardPanelOptions) {
    this.ui = options.client.loadState() ?? { expanded: [], drafts: {} };
    // Older builds stored only `solo`; map that onto a single pinned selection.
    if (!this.ui.pinned?.length && this.ui.solo && this.ui.selected) this.ui.pinned = [this.ui.selected];
    this.syncSoloFlag();
    this.element.className = 'version-guard';
    installStyles();
    const header = document.createElement('header');
    if (options.grip) { const grip = document.createElement('span'); grip.dataset.dockGrip = options.grip; grip.className = 'guard-grip'; grip.innerHTML = ICONS.dockGrip; header.append(grip); }
    const icon = document.createElement('span'); icon.className = 'guard-panel-icon'; icon.setAttribute('role', 'img'); icon.title = tGuard('title'); icon.setAttribute('aria-label', tGuard('title')); icon.innerHTML = ICONS.versionControl; header.append(icon);
    this.refresh = this.button('↻', tGuard('refresh'), () => this.scanning ? this.cancelScan() : this.scan()); header.append(this.refresh);
    this.expandToggle = this.iconButton(ICONS.expandAll, tGuard('expandAll'), () => this.toggleExpandAll()); header.append(this.expandToggle); this.syncExpandToggle();
    this.soloToggle = this.iconButton(ICONS.solo, tGuard('soloOn'), () => this.toggleSolo()); header.append(this.soloToggle); this.syncSoloToggle();
    this.body.className = 'guard-repositories'; this.footer.className = 'guard-history';
    this.footer.style.height = `${this.ui.historyHeight ?? 220}px`;
    const resize = this.resizeHandle; resize.className = 'guard-history-resize';
    resize.onpointerdown = event => {
      event.preventDefault(); const start = event.clientY; const height = this.footer.getBoundingClientRect().height;
      const move = (e: PointerEvent) => { this.ui.historyHeight = Math.max(100, Math.min(600, height + start - e.clientY)); this.footer.style.height = `${this.ui.historyHeight}px`; };
      const end = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); this.persist(); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', end, { once: true });
    };
    // Status/errors use host dialogs (`confirm`); keep the panel free of a top banner.
    this.element.append(...(options.header === false ? [] : [header]), this.body, resize, this.footer);
    this.element.addEventListener('keydown', event => {
      const action = resolveWorkspaceTreeKeyAction(event, { targetIsEditable: event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement, hasSelection: !!this.element.querySelector('.guard-file.is-selected') });
      if (action !== 'copyPath' && action !== 'copyRelativePath') return;
      event.preventDefault(); event.stopPropagation(); void this.entryRequest(action);
    });
    this.subscription = options.client.subscribe(paths => this.invalidate(paths));
    this.discoverySubscription = options.client.onDiscovery?.((repositories, warnings) => {
      if (!this.scanning) return;
      this.scanWarnings = warnings;
      // A rescan keeps showing the known repositories; only the first scan lists them as they are found.
      if (this.progressive) { this.repositories = repositories; if (!this.ui.selected) this.ui.selected = repositories[0]?.id; }
      this.refresh.title = `${tGuard('cancel')} (${repositories.length})`;
      this.render();
    });
    window.addEventListener('focus', this.onFocus); window.addEventListener('blur', this.onBlur);
  }
  private onFocus = (): void => { if (this.visible) { void this.options.client.request({ method: 'active', active: true }).catch(error => this.error(error)); this.schedule(); } };
  private onBlur = (): void => { if (this.visible) void this.options.client.request({ method: 'active', active: false }).catch(error => this.error(error)); };
  setVisible(visible: boolean): void {
    if (this.visible === visible) return; this.visible = visible;
    void this.options.client.request({ method: 'active', active: visible && document.hasFocus() }).catch(error => this.error(error));
    if (!visible) { if (this.scanning) this.cancelScan(); if (this.timer) clearTimeout(this.timer); this.timer = undefined; return; }
    if (!this.repositories.length) void this.scan();
    else { this.repositories.forEach(repo => this.stale.add(repo.id)); this.schedule(); }
  }
  expandAll(): void {
    if (this.isSolo()) this.clearPins();
    const collapsed = this.repositories.filter(repo => !this.ui.expanded.includes(repo.id));
    this.ui.expanded = this.repositories.map(repo => repo.id); this.collapsedDirs.clear(); this.persist(); this.render();
    for (const repo of collapsed) void this.loadStatus(repo.id);
  }
  collapseAll(): void { this.ui.expanded = []; this.closeBranchPicker(); this.persist(); this.render(); }
  toggleExpandAll(): void { if (this.allExpanded()) this.collapseAll(); else this.expandAll(); }
  /** Header toggle: turn Focus-one on with the current repo, or clear every pin. */
  toggleSolo(): void { this.setSolo(!this.isSolo()); }
  setSolo(solo: boolean): void {
    if (this.isSolo() === solo) return;
    if (solo) {
      const id = this.focusRepositoryId();
      this.ui.pinned = id ? [id] : [];
      if (id) {
        this.ui.selected = id;
        if (!this.ui.expanded.includes(id)) this.ui.expanded = [...this.ui.expanded, id];
      }
    } else this.clearPins();
    this.syncSoloFlag(); this.persist(); this.syncSoloToggle(); this.render();
  }
  private clearPins(): void { this.ui.pinned = []; this.syncSoloFlag(); }
  private syncSoloFlag(): void { this.ui.solo = this.isSolo(); }
  private isSolo(): boolean { return (this.ui.pinned?.length ?? 0) > 0; }
  private pinnedIds(): string[] {
    const known = new Set(this.repositories.map(repo => repo.id));
    return (this.ui.pinned ?? []).filter(id => known.has(id));
  }
  private isPinned(id: string): boolean { return (this.ui.pinned ?? []).includes(id); }
  /** Row pin: add/remove this repository from the Focus-one set (keeps header toggle in sync). */
  private togglePin(id: string): void {
    const pinned = new Set(this.ui.pinned ?? []);
    if (pinned.has(id)) pinned.delete(id);
    else {
      pinned.add(id);
      this.ui.selected = id; this.selectedCommit = undefined;
      if (!this.ui.expanded.includes(id)) this.ui.expanded = [...this.ui.expanded, id];
    }
    // Keep list order stable with the repository scan order.
    this.ui.pinned = this.repositories.map(repo => repo.id).filter(repoId => pinned.has(repoId));
    this.syncSoloFlag(); this.persist(); this.syncSoloToggle(); this.render();
    if (this.isPinned(id)) void this.loadStatus(id);
  }
  private focusRepositoryId(): string | undefined {
    const pinned = this.pinnedIds();
    if (pinned[0]) return pinned[0];
    if (this.ui.selected && this.repositories.some(repo => repo.id === this.ui.selected)) return this.ui.selected;
    const expanded = this.ui.expanded.find(id => this.repositories.some(repo => repo.id === id));
    return expanded ?? this.repositories[0]?.id;
  }
  private allExpanded(): boolean { return this.repositories.length > 0 && this.repositories.every(repo => this.ui.expanded.includes(repo.id)); }
  private syncExpandToggle(): void {
    const expanded = this.allExpanded();
    if (this.expandToggle && this.expandToggle.dataset.state !== String(expanded)) {
      const title = tGuard(expanded ? 'collapseAll' : 'expandAll');
      this.expandToggle.dataset.state = String(expanded); this.expandToggle.innerHTML = expanded ? ICONS.collapseAll : ICONS.expandAll; this.expandToggle.title = title; this.expandToggle.setAttribute('aria-label', title);
    }
    if (this.lastAllExpanded !== expanded) { this.lastAllExpanded = expanded; this.options.onExpandStateChange?.(expanded); }
  }
  private syncSoloToggle(): void {
    const solo = this.isSolo();
    if (this.soloToggle) {
      const title = tGuard(solo ? 'soloOff' : 'soloOn');
      this.soloToggle.dataset.state = String(solo);
      this.soloToggle.classList.toggle('is-active', solo);
      this.soloToggle.innerHTML = solo ? ICONS.soloActive : ICONS.solo;
      this.soloToggle.title = title; this.soloToggle.setAttribute('aria-label', title); this.soloToggle.setAttribute('aria-pressed', String(solo));
    }
    if (this.lastSolo !== solo) { this.lastSolo = solo; this.options.onSoloStateChange?.(solo); }
  }
  refreshRepositories(): void { if (this.scanning) this.cancelScan(); else void this.scan(); }
  reset(): void { if (this.scanning) this.cancelScan(); this.generation++; this.repositories = []; this.statuses.clear(); this.histories.clear(); this.commitFiles.clear(); this.historyKey = undefined; this.pending.clear(); this.rerun.clear(); this.selectedCommit = undefined; if (this.visible) void this.scan(); else this.render(); }
  private cancelScan(): void {
    this.generation++; this.scanning = false; this.refresh.textContent = '↻'; this.refresh.title = tGuard('refresh'); this.refresh.setAttribute('aria-label', tGuard('refresh'));
    void this.options.client.request({ method: 'cancel' }).catch(error => this.error(error));
    if (this.scanWarnings.length) this.alert(this.scanWarnings.join('\n'));
  }
  private persist(): void { this.options.client.saveState(this.ui); }
  private error(error: unknown): void { this.alert(error instanceof Error ? error.message : String(error)); }
  /** Host modal for tips/errors (replaces the old top-of-panel notice banner). */
  private alert(detail: string, title = tGuard('error')): void {
    const text = detail.trim();
    if (!text) return;
    void this.showAlert(title, text);
  }
  /** Keep native host dialogs short; offer Copy for the full message. */
  private async showAlert(title: string, text: string): Promise<void> {
    const preview = alertPreview(text);
    const detail = preview === text ? text : `${preview}\n\n${tGuard('alertTruncated')}`;
    const choice = await this.confirm(title, detail, [tGuard('dismiss'), tGuard('copy')]);
    if (choice === 1) await this.copyText(text);
  }
  private iconButton(icon: string, title: string, action: () => void): HTMLButtonElement { const button = this.button('', title, action); button.classList.add('guard-header-icon'); button.innerHTML = icon; return button; }
  private button(label: string, title: string, action: () => void | Promise<unknown>): HTMLButtonElement {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.title = title; button.setAttribute('aria-label', title);
    button.onclick = event => { event.stopPropagation(); void Promise.resolve().then(action).catch(error => this.error(error)); }; return button;
  }
  private async initRepository(): Promise<void> {
    if (this.initializing || this.scanning) return;
    this.initializing = true; this.render();
    try { await this.options.client.request({ method: 'init' }); }
    finally { this.initializing = false; this.render(); }
    await this.scan();
  }
  private async scan(): Promise<void> {
    if (this.scanning) return; const generation = ++this.generation; this.scanning = true; this.scanWarnings = []; this.refresh.textContent = '×'; this.refresh.title = tGuard('cancel'); this.refresh.setAttribute('aria-label', tGuard('cancel'));
    const known = this.repositories.map(repo => repo.id); this.progressive = !known.length; this.histories.clear();
    try {
      const discovered = this.options.client.request({ method: 'discover' }) as Promise<GuardRepository[]>; discovered.catch(() => undefined);
      // Known repositories refresh right away; the directory walk only adds or removes repositories.
      await this.loadStatuses(known, generation);
      const repos = await discovered;
      if (this.disposed || generation !== this.generation) return;
      const found = new Set(repos.map(repo => repo.id));
      this.repositories = repos; for (const id of [...this.statuses.keys()]) if (!found.has(id)) this.statuses.delete(id);
      if (!repos.some(repo => repo.id === this.ui.selected)) this.ui.selected = repos[0]?.id;
      if (!this.ui.expanded.length && repos[0]) this.ui.expanded = [repos[0].id];
      this.render();
      await this.loadStatuses(repos.map(repo => repo.id).filter(id => !known.includes(id)), generation);
      await this.loadHistory();
      if (this.scanWarnings.length) this.alert(this.scanWarnings.join('\n'));
    } catch (error) { if (generation === this.generation) this.error(error); }
    finally { if (generation === this.generation) { this.scanning = false; this.refresh.textContent = '↻'; this.refresh.title = tGuard('refresh'); this.refresh.setAttribute('aria-label', tGuard('refresh')); this.render(); } }
  }
  invalidate(paths: string[] | null): void {
    for (const repo of this.repositories) if (!paths || paths.some(file => file === repo.rootPath || file.startsWith(`${repo.rootPath}/`) || repo.rootPath.startsWith(`${file}/`))) { this.stale.add(repo.id); }
    this.render(); this.schedule();
  }
  /** Hosts only report changes while active; a webview inside VS Code rarely has document focus itself. */
  private schedule(): void {
    if (!this.visible || this.timer || this.disposed) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.updateStale(); }, 800);
  }
  private async updateStale(): Promise<void> {
    for (const id of this.stale) {
      if (!this.ui.expanded.includes(id) && id !== this.ui.selected) continue;
      if (Date.now() - (this.lastRefresh.get(id) ?? 0) < 3000) { this.schedule(); continue; }
      await this.loadStatus(id);
    }
  }
  private async loadStatuses(ids: string[], generation: number): Promise<void> {
    // Sequential: bounded by the host-wide Git command limiter anyway.
    for (const id of ids) { if (!this.visible || this.disposed || generation !== this.generation) break; await this.loadStatus(id, generation); }
  }
  private async loadStatus(id: string, generation = this.generation): Promise<void> {
    // A read already in flight may predate the change the caller wants to see; read again once it ends.
    if (this.pending.has(id)) { this.rerun.add(id); return; }
    this.pending.add(id); this.rerun.delete(id); this.stale.delete(id); this.lastRefresh.set(id, Date.now());
    try {
      const status = await this.options.client.request({ method: 'status', repository: id }) as GuardStatus;
      if (this.disposed || generation !== this.generation) return;
      if (this.statuses.get(id)?.head !== status.head) this.histories.delete(id);
      this.statuses.set(id, status); this.render(); if (id === this.ui.selected) await this.loadHistory();
    } catch (error) { this.error(error); }
    finally { this.pending.delete(id); this.render(); if (this.rerun.delete(id) && !this.disposed) void this.loadStatus(id); }
  }
  private async operation(id: string, request: Omit<GuardRequest, 'repository'>): Promise<unknown> {
    if (this.pending.has(id)) return;
    this.pending.add(id); this.render();
    try {
      const result = await this.options.client.request({ ...request, repository: id });
      if (request.method === 'commit') { this.ui.drafts[id] = ''; this.persist(); this.histories.delete(id); }
      if (request.method === 'checkout') { this.histories.delete(id); this.selectedCommit = undefined; }
      return result;
    } finally { this.pending.delete(id); await this.loadStatus(id); }
  }
  /** Local status first, then a remote check in the background so the counts can update. */
  private async refreshRepository(id: string): Promise<void> {
    this.histories.delete(id); await this.loadStatus(id);
    if (!this.statuses.get(id)?.upstream || this.fetching.has(id) || this.pending.has(id)) return;
    this.fetching.add(id); this.render();
    try { await this.options.client.request({ method: 'fetch', repository: id }); }
    finally { this.fetching.delete(id); await this.loadStatus(id); }
  }
  private confirm(message: string, detail: string | undefined, choices: string[]): Promise<number> { return this.options.client.request({ method: 'confirm', message, detail, choices }) as Promise<number>; }
  private async commit(id: string, stageAll: boolean, changes: GuardFile[]): Promise<void> {
    if (stageAll && !this.ui.smartCommit) {
      const added = changes.filter(file => file.index === '?').map(file => file.path);
      const detail = added.length ? [tGuard('newFiles'), ...added.slice(0, 10), ...(added.length > 10 ? [`… +${added.length - 10}`] : [])].join('\n') : undefined;
      const choice = await this.confirm(formatGuard('stageAllConfirm', { count: String(changes.length) }), detail, [tGuard('yes'), tGuard('always')]);
      if (choice < 0) return;
      if (choice === 1) { this.ui.smartCommit = true; this.persist(); }
    }
    await this.operation(id, { method: 'commit', message: this.ui.drafts[id], stageAll });
  }
  private async amend(id: string): Promise<void> { await this.operation(id, { method: 'commit', amend: true, message: this.ui.drafts[id] }); }
  private async undoCommit(id: string): Promise<void> {
    const subject = id === this.ui.selected ? this.histories.get(id)?.entries[0]?.message.split('\n')[0] : undefined;
    if (await this.confirm(tGuard('undoConfirm'), [subject && `“${subject}”`, tGuard('undoDetail')].filter(Boolean).join('\n'), [tGuard('undo')]) < 0) return;
    const message = await this.operation(id, { method: 'undoCommit' });
    // Like VS Code, the undone message comes back into an empty commit box for re-committing.
    if (typeof message === 'string' && !this.ui.drafts[id]?.trim()) { this.ui.drafts[id] = message; this.persist(); this.render(); }
  }
  private render(): void {
    if (this.disposed) return;
    // Drop pins for repositories that disappeared from the workspace.
    if (this.ui.pinned?.length) {
      const next = this.pinnedIds();
      if (next.length !== this.ui.pinned.length) { this.ui.pinned = next; this.syncSoloFlag(); this.persist(); }
    }
    this.syncExpandToggle(); this.syncSoloToggle();
    // Preserve text input selection while status updates arrive.
    const input = document.activeElement instanceof HTMLTextAreaElement && this.body.contains(document.activeElement) ? document.activeElement : null;
    const selection = input ? { id: input.dataset.repository, start: input.selectionStart, end: input.selectionEnd } : null;
    this.body.replaceChildren();
    const solo = this.isSolo();
    const pinned = new Set(this.pinnedIds());
    this.body.classList.toggle('is-solo', solo);
    if (!this.repositories.length && !this.scanning) {
      const empty = document.createElement('div'); empty.className = 'guard-empty';
      const text = document.createElement('p'); text.textContent = tGuard('empty');
      const init = this.button(tGuard('init'), tGuard('initHint'), () => this.initRepository()); init.className = 'guard-init'; init.disabled = this.initializing;
      empty.append(text, init); this.body.append(empty);
    }
    const built: HTMLElement[] = [];
    for (const repo of this.repositories) {
      const section = document.createElement('section'); section.className = 'guard-repository'; section.dataset.repository = repo.id;
      const depth = this.repositories.filter(other => other !== repo && repo.rootPath.startsWith(`${other.rootPath}/`)).length;
      if (depth) { section.style.setProperty('--guard-depth', String(depth)); section.classList.add('is-nested'); }
      if (pinned.has(repo.id)) section.classList.add('is-focus');
      const expanded = this.ui.expanded.includes(repo.id);
      const loading = this.pending.has(repo.id) || (this.scanning && !this.statuses.has(repo.id));
      // Selected fill only while expanded — a collapsed row should not look “active”.
      const row = document.createElement('div'); row.className = `guard-repo-title${this.ui.selected === repo.id && expanded ? ' is-selected' : ''}${loading ? ' is-loading' : ''}`; row.title = repo.rootPath;
      row.tabIndex = 0; row.setAttribute('role', 'treeitem'); row.setAttribute('aria-expanded', String(expanded)); if (loading) row.setAttribute('aria-busy', 'true');
      // The whole header row toggles expansion and selects the repository, like a tree node.
      const toggle = (): void => {
        if (this.ui.selected !== repo.id) { this.ui.selected = repo.id; this.selectedCommit = undefined; }
        this.ui.expanded = expanded ? this.ui.expanded.filter(id => id !== repo.id) : [...this.ui.expanded, repo.id];
        this.persist(); this.render(); if (!expanded || this.ui.selected === repo.id) void this.loadStatus(repo.id);
      };
      row.onclick = toggle; row.onkeydown = event => { if (event.target === row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle(); } };
      const twisty = document.createElement('span'); twisty.className = 'guard-twisty'; twisty.innerHTML = expanded ? ICONS.chevronDown : ICONS.chevronRight;
      const name = document.createElement('span'); name.className = 'guard-repo-name'; name.textContent = repo.name;
      const pinnedHere = pinned.has(repo.id);
      const pin = this.button('', pinnedHere ? tGuard('unpinRepo') : tGuard('pinRepo'), () => this.togglePin(repo.id));
      pin.className = `guard-repo-pin${pinnedHere ? ' is-pinned' : ''}`; pin.innerHTML = pinnedHere ? ICONS.pinFilled : ICONS.pin;
      pin.setAttribute('aria-pressed', String(pinnedHere));
      row.append(twisty, name, pin);
      const status = this.statuses.get(repo.id);
      if (this.stale.has(repo.id)) { const badge = document.createElement('span'); badge.className = 'guard-stale'; badge.textContent = '•'; badge.title = tGuard('stale'); row.append(badge); }
      if (status) {
        const busy = this.pending.has(repo.id); const checking = this.fetching.has(repo.id); const { upstream } = status;
        const controls = document.createElement('span'); controls.className = 'guard-repo-controls';
        const checked = status.checkedAt ? `${tGuard('checked')}: ${new Date(status.checkedAt).toLocaleTimeString()}` : tGuard('previous');
        const reload = this.button('', checking ? tGuard('checking') : upstream ? `${tGuard('refreshRepositoryRemote')} · ${checked}` : tGuard('refreshRepository'), () => this.refreshRepository(repo.id));
        reload.className = `guard-repo-refresh${checking ? ' is-spinning' : ''}`; reload.innerHTML = ICONS.refresh; reload.disabled = busy || checking; controls.append(reload);
        const name = this.button('', `${tGuard('switchBranch')} (${status.branch})`, () => this.openBranchPicker(repo, name)); name.className = 'guard-branch-name'; name.disabled = busy;
        name.innerHTML = ICONS.branch; const label = document.createElement('span'); label.className = 'guard-branch-label'; label.textContent = status.branch; name.append(label); controls.append(name);
        if (upstream) {
          const conflicts = status.files.some(file => file.index === 'U');
          // The counts are the pull and push buttons themselves; 0 stays visible (dimmed) so the layout never shifts.
          const count = (method: 'pull' | 'push', value: number, ready: boolean, title: string): void => {
            const button = this.button(`${method === 'pull' ? '↓' : '↑'}${checking ? '…' : value}`, checking ? tGuard('checking') : title, () => this.operation(repo.id, { method }));
            button.className = `guard-sync-count${ready ? ' is-ready' : ''}`; button.dataset.method = method; button.disabled = busy || checking || !ready; controls.append(button);
          };
          count('pull', status.behind, status.behind > 0 && !conflicts, !status.behind ? tGuard('noIncoming') : conflicts ? tGuard('resolveConflicts') : formatGuard('pullHint', { count: String(status.behind), upstream }));
          count('push', status.ahead, status.ahead > 0 && !status.behind, !status.ahead ? tGuard('noOutgoing') : status.behind ? tGuard('pullFirst') : formatGuard('pushHint', { count: String(status.ahead), upstream }));
        } else { const none = document.createElement('span'); none.className = 'guard-no-upstream'; none.textContent = tGuard('noUpstream'); none.title = tGuard('noUpstreamHint'); controls.append(none); }
        row.append(controls);
      }
      section.append(row);
      if (expanded && status) {
        const mac = isMac(); const shortcut = mac ? '⌘↩' : 'Ctrl+Enter';
        const input = document.createElement('textarea'); input.dataset.repository = repo.id; input.placeholder = formatGuard('messageHint', { shortcut, branch: status.branch }); input.setAttribute('aria-label', `${repo.name}: ${tGuard('message')}`); input.value = this.ui.drafts[repo.id] ?? ''; input.rows = 1;
        input.oninput = () => {
          this.ui.drafts[repo.id] = input.value; this.persist();
          commit.disabled = !input.value.trim() || !committable || busy || conflicts.length > 0;
          fitCommitInput(input);
        };
        input.onkeydown = event => {
          if (event.key !== 'Enter' || event.isComposing || !(mac ? event.metaKey : event.ctrlKey)) return;
          event.preventDefault(); if (event.altKey) { if (rewritable) void this.amend(repo.id).catch(error => this.error(error)); } else if (!commit.disabled) commit.click();
        };
        const busy = this.pending.has(repo.id); const conflicts = status.files.filter(file => file.index === 'U');
        const staged = status.files.filter(file => !['.', '?', 'U'].includes(file.index)); const changes = status.files.filter(file => file.worktree !== '.' && file.index !== 'U');
        const actions = document.createElement('div'); actions.className = 'guard-actions';
        const stageAll = !staged.length; const committable = staged.length > 0 || changes.length > 0;
        const commit = this.button(tGuard('commit'), `${tGuard('commit')} (${shortcut})`, () => this.commit(repo.id, stageAll, changes)); commit.disabled = busy || !input.value.trim() || !committable || conflicts.length > 0;
        // Undo and amend rewrite the last commit, so they are offered only while it exists locally alone.
        const rewritable = !busy && status.head !== '(initial)' && (!status.upstream || status.ahead > 0) && !conflicts.length;
        const more = this.button('⋯', tGuard('moreActions'), () => {
          const rect = more.getBoundingClientRect();
          this.openMenu(rect.right, rect.bottom + 2, [
            { label: tGuard('undoCommit'), disabled: !rewritable, run: () => this.undoCommit(repo.id) },
            { label: tGuard('amendCommit'), shortcut: mac ? '⌥⌘↩' : 'Ctrl+Alt+Enter', disabled: !rewritable, run: () => this.amend(repo.id) },
            null,
            { label: tGuard('stash'), disabled: busy || !status.files.length || conflicts.length > 0, run: () => this.operation(repo.id, { method: 'stash' }) },
            { label: tGuard('stashPop'), disabled: busy, run: () => this.operation(repo.id, { method: 'stashPop' }) },
          ], true);
        });
        more.classList.add('guard-more'); more.setAttribute('aria-haspopup', 'menu');
        commit.classList.add('is-primary'); actions.append(commit, more);
        const body = document.createElement('div'); body.className = 'guard-repo-body';
        const composer = document.createElement('div'); composer.className = 'guard-composer'; composer.append(input, actions); body.append(composer);
        fitCommitInput(input);
        const group = (label: string, files: GuardFile[], source: 'working' | 'staged', conflict = false) => {
          if (!files.length) return;
          const key = `${repo.id}:group:${conflict ? 'conflicts' : source}`; const collapsed = this.collapsedDirs.has(key);
          const header = document.createElement('div'); header.className = 'guard-group'; header.tabIndex = 0; header.setAttribute('role', 'treeitem'); header.setAttribute('aria-expanded', String(!collapsed));
          header.innerHTML = `<span class="guard-twisty">${collapsed ? ICONS.chevronRight : ICONS.chevronDown}</span>`;
          const text = document.createElement('span'); text.textContent = `${label} (${files.length})`; header.append(text); header.setAttribute('aria-label', text.textContent);
          const toggle = (): void => { if (collapsed) this.collapsedDirs.delete(key); else this.collapsedDirs.add(key); this.render(); };
          header.onclick = toggle; header.onkeydown = event => { if (event.target === header && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle(); } };
          if (!conflict) {
            const groupActions = document.createElement('span'); groupActions.className = 'guard-group-actions';
            const action = (svg: string, title: string, run: () => Promise<unknown>): void => { const button = this.button('', title, run); button.className = 'guard-icon-button'; button.innerHTML = svg; button.disabled = busy; groupActions.append(button); };
            const discardable = files.filter(file => !file.submodule).map(file => file.path);
            if (source === 'working' && discardable.length) action(ICONS.discard, tGuard('discardAll'), () => this.operation(repo.id, { method: 'discard', paths: discardable }));
            action(source === 'staged' ? ICONS.minus : ICONS.plus, tGuard(source === 'staged' ? 'unstageAll' : 'stageAll'), () => this.operation(repo.id, { method: source === 'staged' ? 'unstage' : 'stage', paths: files.flatMap(file => file.oldPath ? [file.oldPath, file.path] : [file.path]) }));
            header.append(groupActions);
          }
          body.append(header); if (!collapsed) this.fileTree(body, repo.id, files, source, busy, conflict, 16);
        };
        group(tGuard('conflicts'), conflicts, 'working', true); group(tGuard('staged'), staged, 'staged'); group(tGuard('changes'), changes, 'working');
        section.append(body);
      }
      built.push(section);
    }
    if (solo && pinned.size && built.length) {
      // Pinned repos stay on top (and can expand); every other repo stacks at the bottom.
      const main = document.createElement('div'); main.className = 'guard-solo-main';
      const below = document.createElement('div'); below.className = 'guard-solo-below';
      for (const section of built) {
        if (pinned.has(section.dataset.repository ?? '')) main.append(section);
        else below.append(section);
      }
      this.body.append(main, below);
    } else {
      this.body.append(...built);
    }
    this.renderHistory();
    if (selection) { const next = [...this.body.querySelectorAll('textarea')].find(input => input.dataset.repository === selection.id); next?.focus(); next?.setSelectionRange(selection.start, selection.end); }
  }
  private closeBranchPicker(): void { const picker = this.branchPicker; this.branchPicker = undefined; picker?.dispose(); }
  private openBranchPicker(repo: GuardRepository, anchor: HTMLElement): void {
    const reopen = this.branchPicker?.element.dataset.repository === repo.id; this.closeBranchPicker(); if (reopen) return;
    const picker = document.createElement('div'); picker.className = 'guard-branch-picker'; picker.dataset.repository = repo.id; picker.setAttribute('role', 'dialog'); picker.setAttribute('aria-label', tGuard('switchBranch'));
    const input = document.createElement('input'); input.type = 'text'; input.placeholder = tGuard('branchPlaceholder'); input.setAttribute('aria-label', tGuard('branchPlaceholder'));
    const list = document.createElement('div'); list.className = 'guard-branch-list'; list.setAttribute('role', 'listbox');
    picker.append(input, list); this.element.append(picker);
    const host = this.element.getBoundingClientRect(); picker.style.top = `${anchor.getBoundingClientRect().bottom - host.top + 4}px`;
    type Item = { kind: 'create' | 'branch'; branch?: GuardBranch; name: string };
    let branches: GuardBranch[] | undefined; let failure = ''; let items: Item[] = []; let active = 0;
    const choose = (item: Item | undefined): void => {
      if (!item) return;
      if (item.kind === 'create' && !item.name) { input.focus(); input.placeholder = tGuard('branchNamePlaceholder'); return; }
      this.closeBranchPicker();
      if (item.kind === 'branch' && item.branch?.current) return;
      void this.operation(repo.id, { method: 'checkout', branch: item.name, create: item.kind === 'create' }).catch(error => this.error(error));
    };
    const draw = (): void => {
      const query = input.value.trim(); const needle = query.toLowerCase();
      const matches = (branches ?? []).filter(branch => !needle || branch.name.toLowerCase().includes(needle));
      const exact = (branches ?? []).some(branch => !branch.remote && branch.name === query);
      items = [...(exact ? [] : [{ kind: 'create' as const, name: query }]), ...matches.filter(branch => !branch.remote), ...matches.filter(branch => branch.remote)].map(item => 'kind' in item ? item : { kind: 'branch' as const, branch: item, name: item.name });
      active = Math.min(active, Math.max(0, items.length - 1));
      list.replaceChildren();
      let previous: string | undefined;
      items.forEach((item, index) => {
        const group = item.kind === 'create' ? 'create' : item.branch!.remote ? 'remote' : 'local';
        if (previous && previous !== group) { const separator = document.createElement('div'); separator.className = 'guard-branch-sep'; list.append(separator); }
        previous = group;
        const option = document.createElement('div'); option.className = `guard-branch-item${index === active ? ' is-active' : ''}`; option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(index === active));
        const main = document.createElement('div'); main.className = 'guard-branch-item-main';
        const icon = document.createElement('span'); icon.className = 'guard-file-icon'; icon.innerHTML = item.kind === 'create' ? ICONS.plus : item.branch!.remote ? ICONS.cloud : item.branch!.current ? ICONS.check : ICONS.branch;
        const label = document.createElement('span'); label.className = 'guard-branch-item-name'; label.textContent = item.kind === 'create' ? (item.name ? formatGuard('createBranchNamed', { name: item.name }) : `${tGuard('createBranch')}…`) : item.name;
        main.append(icon, label);
        if (item.branch) {
          const { branch } = item;
          const meta = document.createElement('span'); meta.className = 'guard-branch-item-meta';
          meta.textContent = [branch.upstream ? `${branch.behind ?? 0}↓ ${branch.ahead ?? 0}↑` : '', relativeTime(branch.timestamp)].filter(Boolean).join(' · '); main.append(meta);
          if (branch.remote) { const tag = document.createElement('span'); tag.className = 'guard-branch-item-tag'; tag.textContent = tGuard('remote'); main.append(tag); }
          option.append(main);
          if (branch.subject) { const detail = document.createElement('div'); detail.className = 'guard-branch-item-detail'; detail.textContent = `${branch.author} • ${branch.subject}`; option.append(detail); }
        } else option.append(main);
        option.onmousemove = () => { if (active !== index) { active = index; draw(); } };
        option.onmousedown = event => {
          if (event.button !== 0) return;
          event.preventDefault();
          choose(item);
        };
        if (item.kind === 'branch' && item.branch) {
          const branch = item.branch;
          option.addEventListener('contextmenu', event => {
            event.preventDefault();
            event.stopPropagation();
            this.openBranchMenu(event.clientX, event.clientY, branch);
          });
        }
        list.append(option);
      });
      if (!branches || failure || !items.some(item => item.kind === 'branch')) { const note = document.createElement('div'); note.className = 'guard-branch-note'; note.textContent = failure || (branches ? tGuard('noBranches') : tGuard('branchesLoading')); list.append(note); }
      list.querySelector('.is-active')?.scrollIntoView?.({ block: 'nearest' });
    };
    input.oninput = () => { active = 0; draw(); };
    input.onkeydown = event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); active = Math.min(items.length - 1, active + 1); draw(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); active = Math.max(0, active - 1); draw(); }
      else if (event.key === 'Enter') { event.preventDefault(); choose(items[active]); }
      else if (event.key === 'Escape') { event.preventDefault(); this.closeBranchPicker(); anchor.focus(); }
    };
    const outside = (event: Event): void => {
      const target = event.target as Node | null;
      if (!target) return;
      if (picker.contains(target) || anchor.contains(target)) return;
      if ((target as Element).closest?.('.guard-context-menu')) return;
      this.closeBranchPicker();
    };
    const close = (): void => this.closeBranchPicker();
    document.addEventListener('pointerdown', outside, true); this.body.addEventListener('scroll', close); window.addEventListener('blur', close);
    this.branchPicker = { element: picker, dispose: () => { document.removeEventListener('pointerdown', outside, true); this.body.removeEventListener('scroll', close); window.removeEventListener('blur', close); picker.remove(); } };
    draw(); input.focus();
    void this.options.client.request({ method: 'branches', repository: repo.id }).then(value => { branches = value as GuardBranch[]; }, error => { branches = []; failure = error instanceof Error ? error.message : String(error); }).then(() => { if (this.branchPicker?.element === picker) draw(); });
  }
  private fileTree(root: HTMLElement, id: string, files: GuardFile[], source: 'working' | 'staged' | 'commit', busy = false, conflict = false, indent = 8): void {
    type Node = { dirs: Map<string, Node>; files: GuardFile[] };
    const tree: Node = { dirs: new Map(), files: [] };
    for (const file of files) { let node = tree; for (const part of file.path.replace(/\/$/, '').split('/').slice(0, -1)) { let next = node.dirs.get(part); if (!next) { next = { dirs: new Map(), files: [] }; node.dirs.set(part, next); } node = next; } node.files.push(file); }
    const visibleRows: Array<() => HTMLElement> = [];
    const walk = (node: Node, depth: number, prefix: string): void => {
      for (const [name, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
        // Collapse single-child directory chains like VS Code's compact folders.
        let label = name; let target = child; let path = `${prefix}${name}/`;
        while (!target.files.length && target.dirs.size === 1) { const [[next, nested]] = [...target.dirs]; label += `/${next}`; path += `${next}/`; target = nested; }
        const key = `${id}:${source}:${path}`; const collapsed = this.collapsedDirs.has(key);
        visibleRows.push(() => {
        const row = document.createElement('div'); row.className = 'guard-file guard-dir'; row.style.paddingLeft = `calc(var(--guard-indent, 0px) + ${indent + depth * 12}px)`; row.tabIndex = 0; row.title = this.fullPath(id, path); row.setAttribute('role', 'treeitem'); row.setAttribute('aria-expanded', String(!collapsed));
        row.innerHTML = `<span class="guard-twisty">${collapsed ? ICONS.chevronRight : ICONS.chevronDown}</span><span class="guard-file-icon">${resolveWorkspaceTreeIcon({ kind: 'directory', name: label, expanded: !collapsed }).svg}</span>`;
        const text = document.createElement('span'); text.className = 'guard-file-name'; text.textContent = label; row.append(text);
        const toggle = (): void => { if (collapsed) this.collapsedDirs.delete(key); else this.collapsedDirs.add(key); this.render(); };
        row.onclick = toggle; row.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } };
        this.attachEntry(row, { key, repository: id, path });
        return row; }); if (!collapsed) walk(target, depth + 1, path);
      }
      for (const file of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) { visibleRows.push(() => { const row = this.fileRow(id, file, source, busy, conflict, true); row.style.paddingLeft = `calc(var(--guard-indent, 0px) + ${indent + depth * 12 + 16}px)`; return row; }); }
    };
    walk(tree, 0, ''); const viewport = document.createElement('div'); root.append(viewport); windowedList(viewport, visibleRows, this.body);
  }
  private fileRow(id: string, file: GuardFile, source: 'working' | 'staged' | 'commit', busy = false, conflict = false, nested = false): HTMLElement {
    const row = document.createElement('div'); row.className = 'guard-file'; row.title = file.oldPath ? `${this.fullPath(id, file.oldPath)} → ${this.fullPath(id, file.path)}` : this.fullPath(id, file.path); row.dataset.path = file.path;
    const trimmed = file.path.replace(/\/$/, ''); const name = trimmed.split('/').pop()!; const folder = trimmed.slice(0, -name.length);
    const openDiff = this.button(name, row.title, () => this.options.client.request({ method: 'openDiff', repository: id, paths: [file.path], source, revision: this.selectedCommit?.hash })); openDiff.className = 'guard-file-name'; openDiff.disabled = file.submodule || conflict;
    const parent = document.createElement('span'); parent.className = 'guard-file-path'; parent.textContent = nested ? '' : folder;
    const letter = file.submodule ? 'S' : source === 'working' ? file.worktree : file.index;
    const state = document.createElement('span'); state.className = `guard-file-status is-${statusClass(letter)}`; state.textContent = letter;
    if (letter === 'D') row.classList.add('is-deleted');
    const icon = document.createElement('span'); icon.className = 'guard-file-icon'; icon.innerHTML = resolveWorkspaceTreeIcon({ kind: file.submodule ? 'directory' : 'file', name }).svg;
    const actions = document.createElement('span'); actions.className = 'guard-file-actions';
    const action = (svg: string, title: string, run: () => void | Promise<unknown>): void => { const button = this.button('', title, run); button.className = 'guard-icon-button'; button.innerHTML = svg; actions.append(button); };
    if (!file.submodule && (source === 'commit' || file.worktree !== 'D')) action(ICONS.open, tGuard('open'), () => this.options.client.request({ method: 'openFile', repository: id, paths: [file.path] }));
    if (source !== 'commit') {
      if (source === 'working' && !file.submodule && !conflict) action(ICONS.discard, tGuard('discard'), () => this.operation(id, { method: 'discard', paths: [file.path] }));
      action(source === 'staged' ? ICONS.minus : ICONS.plus, source === 'staged' ? tGuard('unstage') : tGuard('stage'), () => this.operation(id, { method: source === 'staged' ? 'unstage' : 'stage', paths: file.oldPath ? [file.oldPath, file.path] : [file.path] }));
    }
    row.append(icon, openDiff, parent, actions, state);
    row.querySelectorAll('button').forEach(button => { if (busy) button.disabled = true; });
    if (!openDiff.disabled) { row.classList.add('is-openable'); row.onclick = () => openDiff.click(); }
    row.tabIndex = -1; this.attachEntry(row, { key: `${id}:${source}:${file.path}`, repository: id, path: file.path });
    return row;
  }
  /** Absolute on-disk path of a repository-relative entry, shown as the row tooltip. */
  private fullPath(id: string, relative: string): string {
    const root = this.repositories.find(repo => repo.id === id)?.rootPath ?? id; const separator = root.includes('\\') ? '\\' : '/';
    return [root.replace(/[\\/]+$/, ''), ...relative.split('/').filter(Boolean)].join(separator);
  }
  /** Click selects the row (target of the copy-path shortcuts); right-click opens the copy-path menu. */
  private attachEntry(row: HTMLElement, entry: GuardEntry): void {
    if (this.selectedEntry?.key === entry.key) row.classList.add('is-selected');
    const select = (): void => { this.selectedEntry = entry; this.element.querySelectorAll('.guard-file.is-selected').forEach(other => other.classList.remove('is-selected')); row.classList.add('is-selected'); };
    row.addEventListener('click', select, true);
    row.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); select(); row.focus({ preventScroll: true }); this.openEntryMenu(event.clientX, event.clientY, entry); });
  }
  private openEntryMenu(x: number, y: number, entry: GuardEntry): void {
    const mac = isMac();
    this.openMenu(x, y, [
      { label: tGuard('revealInIndexArea'), run: () => this.entryRequest('revealInIndexArea', entry) },
      null,
      { label: tGuard('copyPath'), shortcut: mac ? '⌥⌘C' : 'Ctrl+Alt+C', run: () => this.entryRequest('copyPath', entry) },
      { label: tGuard('copyRelativePath'), shortcut: mac ? '⇧⌥⌘C' : 'Ctrl+Shift+Alt+C', run: () => this.entryRequest('copyRelativePath', entry) },
    ]);
  }
  /** Branch picker: copy the short name or the git ref path (`refs/heads/…` / `refs/remotes/…`). */
  private openBranchMenu(x: number, y: number, branch: GuardBranch): void {
    this.openMenu(x, y, [
      { label: tGuard('copyName'), run: () => this.copyText(branch.name) },
      { label: tGuard('copyPath'), run: () => this.copyText(branchRefPath(branch)) },
    ]);
  }
  private async copyText(text: string): Promise<void> {
    try { await this.options.client.request({ method: 'copyText', text }); }
    catch (error) { this.error(error); }
  }
  /** `null` items are separators. `alignRight` (or overflowing the window) puts the menu to the left of the point; overflowing the bottom puts it above. */
  private openMenu(x: number, y: number, items: Array<{ label: string; shortcut?: string; disabled?: boolean; run: () => Promise<unknown> } | null>, alignRight = false): void {
    this.closeMenu?.();
    const menu = document.createElement('div'); menu.className = 'guard-context-menu'; menu.setAttribute('role', 'menu');
    for (const entry of items) {
      if (!entry) { const separator = document.createElement('div'); separator.className = 'guard-context-sep'; separator.setAttribute('role', 'separator'); menu.append(separator); continue; }
      const item = this.button('', entry.label, () => { close(); return entry.run(); }); item.removeAttribute('title'); item.setAttribute('role', 'menuitem'); item.disabled = !!entry.disabled;
      const label = document.createElement('span'); label.textContent = entry.label;
      const keys = document.createElement('span'); keys.className = 'guard-context-shortcut'; keys.textContent = entry.shortcut ?? '';
      item.append(label, keys); menu.append(item);
    }
    menu.style.left = `${x}px`; menu.style.top = `${y}px`; document.body.append(menu);
    const rect = menu.getBoundingClientRect();
    if (alignRight || rect.right > window.innerWidth) menu.style.left = `${Math.max(0, x - rect.width)}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(0, y - rect.height)}px`;
    const outside = (event: Event): void => { if (!menu.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
    const close = (): void => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); window.removeEventListener('blur', close); this.body.removeEventListener('scroll', close); this.footer.removeEventListener('scroll', close); menu.remove(); if (this.closeMenu === close) this.closeMenu = undefined; };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape, true); window.addEventListener('blur', close); this.body.addEventListener('scroll', close); this.footer.addEventListener('scroll', close);
    this.closeMenu = close;
  }
  private async entryRequest(method: 'revealInIndexArea' | 'copyPath' | 'copyRelativePath', entry = this.selectedEntry): Promise<void> {
    if (!entry) return;
    try { await this.options.client.request({ method, repository: entry.repository, paths: [entry.path] }); }
    catch (error) { this.error(error); }
  }
  private async loadHistory(cursor?: string): Promise<void> {
    const id = this.ui.selected; if (!id || this.histories.has(id) && !cursor) return;
    const generation = this.generation;
    const requestKey = `${id}:${cursor ?? ''}`; if (this.historyRequests.has(requestKey)) return;
    this.historyRequests.add(requestKey);
    try { const page = await this.options.client.request({ method: 'history', repository: id, cursor }) as GuardHistory; if (generation !== this.generation || this.disposed) return; this.histories.set(id, { ...page, entries: (cursor ? [...(this.histories.get(id)?.entries ?? []), ...page.entries] : page.entries).slice(-500) }); this.renderHistory(); }
    catch (error) { if (generation === this.generation && !this.disposed) this.error(error); }
    finally { this.historyRequests.delete(requestKey); }
  }
  /**
   * Rebuilds the history footer only when what it shows changes. render() runs on every status
   * poll and file-watcher event; rebuilding here unconditionally used to wipe the commit file
   * list and re-request it each time, which made the history view flicker.
   */
  private applyHistoryCollapsed(): void {
    this.footer.classList.toggle('is-collapsed', this.historyCollapsed); this.resizeHandle.hidden = this.historyCollapsed;
    this.footer.style.height = this.historyCollapsed ? '' : `${this.ui.historyHeight ?? 220}px`;
  }
  private renderHistory(): void {
    const id = this.ui.selected; const history = id ? this.histories.get(id) : undefined;
    const key = id ? `${id}|${this.selectedCommit?.hash ?? ''}|${history?.entries[0]?.hash ?? ''}|${history?.entries.length ?? -1}|${history?.cursor ?? ''}|${this.selectedCommit && this.commitFiles.has(`${id}:${this.selectedCommit.hash}`) ? 'files' : ''}|${this.repositories.find(repo => repo.id === id)?.name ?? ''}|${this.historyCollapsed}` : '';
    if (key === this.historyKey) return; this.historyKey = key;
    this.footer.replaceChildren(); if (!id) return;
    const head = document.createElement('div'); head.className = `guard-history-head${this.historyCollapsed ? '' : ' is-open'}`; head.tabIndex = 0; head.setAttribute('role', 'button'); head.setAttribute('aria-expanded', String(!this.historyCollapsed));
    head.title = this.historyCollapsed ? tGuard('expandHistory') : tGuard('collapseHistory');
    const toggleHistory = (): void => { this.historyCollapsed = !this.historyCollapsed; this.applyHistoryCollapsed(); this.renderHistory(); };
    head.onclick = toggleHistory; head.onkeydown = event => { if (event.target === head && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggleHistory(); } };
    const twisty = document.createElement('span'); twisty.className = 'guard-twisty'; twisty.classList.toggle('is-expanded', !this.historyCollapsed); twisty.innerHTML = ICONS.sectionChevron; head.append(twisty);
    const title = document.createElement('strong'); title.textContent = tGuard('history');
    const repositoryName = this.repositories.find(repo => repo.id === id)?.name ?? '';
    const repository = document.createElement('span'); repository.className = 'guard-history-repo'; repository.title = repositoryName; repository.innerHTML = ICONS.versionControl;
    const repositoryLabel = document.createElement('span'); repositoryLabel.textContent = repositoryName; repository.append(repositoryLabel);
    head.append(title, repository); this.footer.append(head);
    if (this.historyCollapsed) return;
    if (this.selectedCommit) {
      const commit = this.selectedCommit;
      const back = this.button('', tGuard('back'), () => { this.selectedCommit = undefined; this.renderHistory(); }); back.className = 'guard-back'; back.innerHTML = ICONS.back; back.append(tGuard('back')); head.append(back);
      const description = document.createElement('pre'); description.textContent = `${commit.message}\n\n${commit.author} · ${new Date(commit.timestamp).toLocaleString()}\n${commit.hash}${commit.parents.length > 1 ? `\n${tGuard('first')}` : ''}`; this.footer.append(description);
      const filesRoot = document.createElement('div'); this.footer.append(filesRoot);
      const cached = this.commitFiles.get(`${id}:${commit.hash}`);
      if (cached) { windowedList(filesRoot, cached.map(file => () => this.fileRow(id, file, 'commit')), this.footer); return; }
      const generation = this.generation;
      void this.options.client.request({ method: 'commitFiles', repository: id, revision: commit.hash }).then(files => { if (this.disposed || generation !== this.generation) return; this.commitFiles.set(`${id}:${commit.hash}`, files as GuardFile[]); if (this.ui.selected !== id || this.selectedCommit !== commit) return; this.renderHistory(); }).catch(error => this.error(error)); return;
    }
    const entriesRoot = document.createElement('div'); this.footer.append(entriesRoot);
    windowedList(entriesRoot, (this.histories.get(id)?.entries ?? []).map(commit => () => {
      const item = this.button(commit.message.split('\n')[0], `${commit.author} · ${new Date(commit.timestamp).toLocaleString()} · ${commit.hash.slice(0, 8)}`, () => { this.selectedCommit = commit; this.renderHistory(); }); item.className = 'guard-commit';
      const author = document.createElement('small'); author.textContent = ` ${commit.author} · ${new Date(commit.timestamp).toLocaleDateString()}`; item.append(author); return item;
    }), this.footer);
    if ((history?.entries.length ?? 0) >= 500) this.footer.append(this.button(tGuard('refresh'), tGuard('refresh'), () => { this.histories.delete(id); return this.loadHistory(); }));
    const cursor = this.histories.get(id)?.cursor; if (cursor) this.footer.append(this.button(tGuard('more'), tGuard('more'), () => this.loadHistory(cursor)));
  }
  dispose(): void { this.closeBranchPicker(); this.closeMenu?.(); this.disposed = true; this.generation++; if (this.timer) clearTimeout(this.timer); this.histories.clear(); this.commitFiles.clear(); this.subscription.dispose(); this.discoverySubscription?.dispose(); window.removeEventListener('focus', this.onFocus); window.removeEventListener('blur', this.onBlur); void this.options.client.request({ method: 'active', active: false }).catch(() => undefined); this.element.remove(); }
}
function installStyles(): void {
  if (document.getElementById('version-guard-styles')) return;
  const style = document.createElement('style'); style.id = 'version-guard-styles'; style.textContent = `
.version-guard{height:100%;min-height:0;display:flex;flex-direction:column;color:var(--vscode-foreground,#ccc);background:var(--vscode-sideBar-background,var(--vscode-editorWidget-background,#202020));font:inherit;line-height:1.5;overflow:hidden}
.version-guard header{display:flex;align-items:center;gap:6px;padding:8px;min-height:24px;border-bottom:1px solid var(--vscode-panel-border,#444)}.guard-panel-icon{display:inline-flex;flex:none;margin-right:auto;align-items:center;justify-content:center;width:16px;height:16px;opacity:.85;cursor:default}.guard-panel-icon svg{display:block;width:15px;height:15px}.version-guard .guard-header-icon{display:inline-flex;align-items:center;justify-content:center}.guard-header-icon svg{width:16px;height:16px}.version-guard button{font:inherit;color:inherit;background:transparent;border:0;border-radius:3px;cursor:pointer;padding:3px 5px}.version-guard button:hover{background:var(--vscode-list-hoverBackground,#ffffff15)}.version-guard button:disabled{opacity:.45;cursor:default}.guard-empty{padding:8px 12px}.guard-empty p{margin:0 0 10px}.version-guard .guard-init{width:100%;padding:4px 8px;background:var(--vscode-button-background,#225d89);color:var(--vscode-button-foreground,#fff)}.version-guard .guard-init:hover:not(:disabled){background:var(--vscode-button-hoverBackground,#1c4f75)}.version-guard button:focus-visible,.version-guard textarea:focus-visible{outline:1px solid var(--vscode-focusBorder,#3794ff)}
.guard-grip{cursor:grab}.guard-grip svg{width:14px;height:14px;fill:currentColor}.guard-repositories{flex:1;min-height:80px;overflow:auto;padding-bottom:6px}.guard-repositories.is-solo{display:flex;flex-direction:column;overflow:hidden;padding-bottom:0}.guard-solo-below{flex:none;max-height:40%;overflow:auto;border-top:1px solid var(--vscode-panel-border,color-mix(in srgb,currentColor 14%,transparent))}.guard-solo-main{flex:1;min-height:120px;overflow:auto;display:flex;flex-direction:column}.guard-solo-main>.guard-repository{display:flex;flex-direction:column}.guard-solo-main>.guard-repository.is-focus>.guard-repo-body{min-height:0}.version-guard .guard-header-icon.is-active{color:var(--vscode-button-foreground,#fff);background:var(--vscode-button-background,#225d89);opacity:1}.version-guard .guard-header-icon.is-active:hover{background:var(--vscode-button-hoverBackground,#1c4f75)}.guard-repo-pin{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;margin-left:2px;border-radius:3px;opacity:0;pointer-events:none;color:inherit}.guard-repo-title:hover .guard-repo-pin,.guard-repo-title:focus-within .guard-repo-pin,.guard-repo-pin.is-pinned{opacity:.85;pointer-events:auto}.guard-repo-pin.is-pinned{opacity:1;color:var(--vscode-button-background,#1372da)}.guard-repo-pin:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground,color-mix(in srgb,currentColor 12%,transparent));cursor:pointer}.guard-repo-pin svg{width:14px;height:14px}.guard-repo-title{position:relative;display:flex;align-items:center;gap:4px;height:24px;min-height:24px;box-sizing:border-box;padding:0 6px;cursor:pointer;background:color-mix(in srgb,currentColor 4%,transparent);border-bottom:1px solid var(--vscode-panel-border,color-mix(in srgb,currentColor 14%,transparent))}.guard-repo-title:hover{background:color-mix(in srgb,currentColor 7%,transparent)}.guard-repo-title:focus-visible{outline:1px solid var(--vscode-focusBorder,#3794ff);outline-offset:-1px}.guard-repo-title.is-loading::after{content:'';position:absolute;left:0;right:0;bottom:-1px;height:2px;background:linear-gradient(90deg,transparent 0,var(--vscode-progressBar-background,#0e70c0) 40%,var(--vscode-progressBar-background,#0e70c0) 60%,transparent 100%) no-repeat;background-size:35% 100%;animation:guard-progress 1.1s linear infinite}@keyframes guard-progress{from{background-position:-50% 0}to{background-position:150% 0}}@media (prefers-reduced-motion:reduce){.guard-repo-title.is-loading::after{animation:none;background:var(--vscode-progressBar-background,#0e70c0);opacity:.6}}.guard-repo-title.is-selected{background:color-mix(in srgb,var(--guard-accent,var(--vscode-focusBorder,#3794ff)) 16%,transparent)}.guard-repo-title.is-selected:hover{background:color-mix(in srgb,var(--guard-accent,var(--vscode-focusBorder,#3794ff)) 22%,transparent)}.version-guard{position:relative}.guard-repo-controls{display:inline-flex;flex:0 1 auto;align-items:center;gap:3px;min-width:0;margin-left:auto;padding-left:6px}.guard-repo-controls .guard-repo-refresh,.version-guard .guard-repo-controls .guard-sync-count{flex:none}.version-guard .guard-repo-controls .guard-sync-count{min-width:34px;justify-content:center;font-variant-numeric:tabular-nums}.version-guard .guard-repo-controls .guard-sync-count.is-ready{background:transparent;opacity:1}.version-guard .guard-repo-controls .guard-sync-count.is-ready:hover:not(:disabled){background:var(--vscode-toolbar-hoverBackground,color-mix(in srgb,currentColor 10%,transparent))}.version-guard .guard-repo-controls .guard-sync-count.is-ready:disabled{opacity:.6}.guard-no-upstream{flex:none;padding:0 4px;font-size:.85em;opacity:.6;white-space:nowrap;cursor:default}.guard-repo-refresh.is-spinning svg{animation:guard-spin 1s linear infinite}.version-guard .guard-repo-controls .guard-repo-refresh.is-spinning:disabled{opacity:.9;color:var(--vscode-progressBar-background,#0e70c0)}@keyframes guard-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.guard-repo-refresh.is-spinning svg{animation:none}}.version-guard .guard-repo-controls button{display:inline-flex;align-items:center;gap:3px;height:20px;box-sizing:border-box;padding:0 6px;border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:4px;background:transparent;color:inherit;opacity:.85;cursor:pointer}.version-guard .guard-repo-controls button:hover:not(:disabled){opacity:1;background:var(--vscode-toolbar-hoverBackground,color-mix(in srgb,currentColor 10%,transparent))}.version-guard .guard-repo-controls button:disabled{opacity:.45;cursor:default}.guard-repo-controls svg{width:14px;height:14px;flex:none}.guard-branch-name{min-width:0}.guard-branch-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.version-guard .guard-repo-controls .guard-repo-refresh{width:24px;padding:0;justify-content:center}.guard-stale{opacity:.6}.guard-branch-picker{position:absolute;left:6px;right:6px;z-index:30;max-height:min(420px,70%);display:flex;flex-direction:column;color:var(--vscode-quickInput-foreground,var(--vscode-foreground,inherit));background:var(--vscode-quickInput-background,var(--vscode-editorWidget-background,#252526));border:1px solid var(--vscode-widget-border,var(--vscode-panel-border,#454545));border-radius:6px;box-shadow:0 4px 16px var(--vscode-widget-shadow,rgba(0,0,0,.36));overflow:hidden}.guard-branch-picker input{margin:6px;padding:3px 6px;font:inherit;color:inherit;background:var(--vscode-input-background,#333);border:1px solid var(--vscode-focusBorder,#3794ff);border-radius:3px;outline:none}.guard-branch-list{overflow:auto;padding-bottom:4px}.guard-branch-item{padding:3px 10px;cursor:pointer}.guard-branch-item.is-active{color:var(--vscode-quickInputList-focusForeground,var(--vscode-list-activeSelectionForeground,inherit));background:var(--vscode-quickInputList-focusBackground,var(--vscode-list-activeSelectionBackground,#04395e))}.guard-branch-item-main{display:flex;align-items:center;gap:6px;white-space:nowrap;min-width:0}.guard-branch-item-name{overflow:hidden;text-overflow:ellipsis}.guard-branch-item-meta,.guard-branch-item-tag,.guard-branch-item-detail,.guard-branch-note{opacity:.7;font-size:.88em}.guard-branch-item-tag{margin-left:auto}.guard-branch-item-detail{padding-left:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.guard-branch-note{padding:6px 10px}.guard-branch-sep{margin:3px 0;border-top:1px solid var(--vscode-widget-border,color-mix(in srgb,currentColor 14%,transparent))}.guard-repo-name{font-weight:400;flex:0 1 auto;min-width:40px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.guard-repo-body{--guard-indent:19px;padding:6px 0}.guard-composer{display:flex;align-items:flex-start;gap:4px;padding:0 6px 4px calc(var(--guard-indent,0px) + 2px)}.guard-repository textarea{flex:1;min-width:0;box-sizing:border-box;width:auto;margin:0;padding:3px 6px;resize:none;overflow-y:auto;font:inherit;line-height:1.5;min-height:calc(1.5em + 8px);max-height:12.5em;color:inherit;background:var(--vscode-input-background,#333);border:1px solid var(--vscode-input-border,#555);border-radius:4px;field-sizing:content}.guard-actions{display:flex;flex:none;gap:4px}.version-guard .guard-actions button{border:1px solid var(--vscode-button-border,color-mix(in srgb,currentColor 25%,transparent));background:var(--vscode-button-secondaryBackground,color-mix(in srgb,currentColor 10%,transparent));color:var(--vscode-button-secondaryForeground,inherit)}.version-guard .guard-actions button:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground,color-mix(in srgb,currentColor 18%,transparent))}.version-guard .guard-actions button{white-space:nowrap;padding:3px 8px}.version-guard .guard-actions button.is-primary{background:var(--vscode-button-background,#225d89);color:var(--vscode-button-foreground,#fff)}.version-guard .guard-actions button.is-primary:hover:not(:disabled){background:var(--vscode-button-hoverBackground,#1c4f75)}.version-guard .guard-actions button:disabled{opacity:.45}.version-guard .guard-actions .guard-more{padding:3px 6px;letter-spacing:1px}.guard-checked{display:block;opacity:.6;padding:5px 8px}.guard-group{display:flex;align-items:center;gap:2px;height:24px;min-height:24px;box-sizing:border-box;padding:0 6px 0 calc(var(--guard-indent,0px) + 4px);margin-top:4px;opacity:.65;cursor:pointer}.guard-group:focus-visible{outline:1px solid var(--vscode-focusBorder,#3794ff);outline-offset:-1px}.guard-group:hover,.guard-group:focus-within{opacity:1}.guard-group-actions{display:inline-flex;gap:1px;margin-left:auto;visibility:hidden}.guard-group:hover .guard-group-actions,.guard-group:focus-within .guard-group-actions{visibility:visible}.guard-file{display:flex;align-items:center;gap:3px;height:24px;min-height:24px;box-sizing:border-box;padding:0 6px}.guard-file.is-openable{cursor:pointer}.version-guard .guard-file-name:hover{background:transparent}.guard-file:focus{outline:none}.version-guard .guard-file.is-selected{background:var(--vscode-list-inactiveSelectionBackground,color-mix(in srgb,currentColor 14%,transparent))}.version-guard .guard-file.is-selected:focus-within{background:var(--vscode-list-activeSelectionBackground,color-mix(in srgb,var(--vscode-focusBorder,#3794ff) 28%,transparent))}.guard-context-menu{position:fixed;z-index:10000;display:flex;flex-direction:column;min-width:max-content;padding:4px 0;color:var(--vscode-menu-foreground,var(--vscode-foreground,#ccc));background:var(--vscode-menu-background,var(--vscode-editorWidget-background,#252526));border:1px solid var(--vscode-menu-border,var(--vscode-widget-border,#454545));border-radius:6px;box-shadow:0 2px 8px var(--vscode-widget-shadow,rgba(0,0,0,.36));font-size:13px}.guard-context-menu button{display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:26px;margin:0;padding:0 12px;border:0;border-radius:0;color:inherit;background:transparent;font:inherit;text-align:left;white-space:nowrap;cursor:pointer}.guard-context-menu button:disabled{opacity:.45;cursor:default}.guard-context-menu button:hover:not(:disabled),.guard-context-menu button:focus-visible{outline:none;color:var(--vscode-menu-selectionForeground,#fff);background:var(--vscode-menu-selectionBackground,var(--vscode-list-activeSelectionBackground,#094771))}.guard-context-shortcut{font-size:12px;opacity:.7}.guard-context-sep{margin:4px 0;border-top:1px solid var(--vscode-menu-separatorBackground,var(--vscode-widget-border,#454545))}.guard-file:hover,.guard-file:focus-within{background:var(--vscode-list-hoverBackground,color-mix(in srgb,currentColor 8%,transparent))}.guard-dir{cursor:pointer;gap:2px}.guard-dir:focus-visible{outline:1px solid var(--vscode-focusBorder,#3794ff);outline-offset:-1px}.guard-twisty,.guard-file-icon{display:inline-flex;flex:none;width:16px;height:16px;align-items:center;justify-content:center;opacity:.9}.guard-file-icon svg{width:16px;height:16px}.guard-twisty{opacity:.7}.guard-file-actions{display:none;flex:none;gap:1px}.guard-file:hover .guard-file-actions,.guard-file:focus-within .guard-file-actions{display:inline-flex}.version-guard .guard-icon-button{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border-radius:4px;opacity:.8}.version-guard .guard-icon-button:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground,color-mix(in srgb,currentColor 14%,transparent))}.guard-file.is-deleted .guard-file-name{text-decoration:line-through;opacity:.6}.guard-file .guard-file-status.is-deleted{color:var(--vscode-gitDecoration-deletedResourceForeground,#c74e39)}.guard-file .guard-file-status.is-added{color:var(--vscode-gitDecoration-addedResourceForeground,#3fa266)}.guard-file .guard-file-status.is-untracked{color:var(--vscode-gitDecoration-untrackedResourceForeground,#3fa266)}.guard-file .guard-file-status.is-renamed{color:var(--vscode-gitDecoration-renamedResourceForeground,#3fa266)}.guard-file-status{width:14px;text-align:center;flex:none}.guard-file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;flex-shrink:1;min-width:40px}.guard-file-path{opacity:.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}.guard-file-status{color:var(--vscode-gitDecoration-modifiedResourceForeground,#c99)}.guard-history-resize{position:relative;z-index:2;height:0;flex:none;cursor:row-resize}.guard-history-resize::after{content:'';position:absolute;left:0;right:0;top:-2px;height:5px}.guard-history{background:inherit;flex:none;min-height:100px;max-height:60%;overflow:auto;padding:0 0 6px;box-sizing:border-box;border-top:1px solid var(--vscode-panel-border,#444);font-size:13px}.guard-history-head{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:4px;height:24px;padding:0 6px 0 4px;margin-bottom:2px;box-sizing:border-box;font-size:11px;line-height:16px;letter-spacing:.02em;cursor:pointer;background:color-mix(in srgb,currentColor 8%,var(--vscode-sideBar-background,var(--vscode-editorWidget-background,#202020)))}.guard-history-head:hover{background:color-mix(in srgb,currentColor 12%,var(--vscode-sideBar-background,var(--vscode-editorWidget-background,#202020)))}.guard-history-head.is-open{background:color-mix(in srgb,var(--guard-accent,var(--vscode-focusBorder,#3794ff)) 16%,var(--vscode-sideBar-background,var(--vscode-editorWidget-background,#202020)))}.guard-history-head.is-open:hover{background:color-mix(in srgb,var(--guard-accent,var(--vscode-focusBorder,#3794ff)) 22%,var(--vscode-sideBar-background,var(--vscode-editorWidget-background,#202020)))}.guard-history-head:focus-visible{outline:1px solid var(--vscode-focusBorder,#3794ff);outline-offset:-1px}.guard-history-head .guard-twisty svg{width:12px;height:12px;transition:transform .12s}.guard-history-head .guard-twisty.is-expanded svg{transform:rotate(90deg)}.guard-history.is-collapsed{height:auto!important;min-height:0;flex:none;padding-bottom:0;overflow:hidden}.guard-history.is-collapsed .guard-history-head{margin-bottom:0}.guard-history-resize[hidden]{display:none}.guard-repository.is-nested>.guard-repo-title{padding-left:calc(6px + var(--guard-depth,1) * 12px)}.guard-repository.is-nested>.guard-repo-body{--guard-indent:calc(19px + var(--guard-depth,1) * 12px)}.guard-history-head strong{flex:none;font-weight:600}.guard-history-repo{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:65%;height:18px;box-sizing:border-box;margin-left:auto;padding:0 7px 0 5px;border-radius:3px;border:1px solid color-mix(in srgb,var(--guard-accent,var(--vscode-focusBorder,#3794ff)) 40%,transparent);background:color-mix(in srgb,var(--guard-accent,var(--vscode-focusBorder,#3794ff)) 10%,transparent);color:inherit;font-weight:400;letter-spacing:0}.guard-history-repo svg{flex:none;width:11px;height:11px}.guard-history-repo span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.version-guard .guard-back{display:inline-flex;align-items:center;gap:3px;flex:none;height:18px;box-sizing:border-box;padding:0 6px 0 4px;font-size:11px;border:1px solid var(--vscode-button-border,color-mix(in srgb,currentColor 25%,transparent));background:var(--vscode-button-secondaryBackground,color-mix(in srgb,currentColor 10%,transparent));color:var(--vscode-button-secondaryForeground,inherit)}.version-guard .guard-back:hover{background:var(--vscode-button-secondaryHoverBackground,color-mix(in srgb,currentColor 18%,transparent))}.guard-history pre{margin:6px 10px;white-space:pre-wrap;font:inherit;overflow-wrap:anywhere}.version-guard .guard-commit{display:block;width:100%;box-sizing:border-box;min-height:24px;padding:3px 10px;border:0;border-radius:0;background:transparent;color:inherit;font-size:13px;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}.version-guard .guard-commit:hover{background:var(--vscode-list-hoverBackground,color-mix(in srgb,currentColor 8%,transparent))}.guard-commit:before{content:'●';color:var(--vscode-focusBorder,#3794ff);font-size:9px;vertical-align:2px;margin-right:8px}.guard-commit small{font-size:11px;opacity:.6}
`; document.head.append(style);
}
const svg = (body: string, extra = ''): string => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" ${extra}>${body}</svg>`;
const stroke = 'fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  chevronDown: svg('<path d="M4 6l4 4 4-4"/>', stroke), chevronRight: svg('<path d="M6 4l4 4-4 4"/>', stroke),
  open: svg('<path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M12 9.5v4H2.5V4h4"/>', stroke),
  discard: svg('<path d="M3.5 6.5h6.5a3 3 0 010 6H7M6 3.5l-3 3 3 3"/>', stroke),
  back: svg('<path d="M13 8H3M7 4L3 8l4 4"/>', stroke),
  plus: svg('<path d="M8 3v10M3 8h10"/>', stroke), minus: svg('<path d="M3 8h10"/>', stroke),
  branch: svg('<circle cx="5" cy="3.5" r="1.5"/><circle cx="5" cy="12.5" r="1.5"/><circle cx="11" cy="5.5" r="1.5"/><path d="M5 5v6M11 7c0 2.5-3 2.5-5.4 4.4"/>', stroke),
  cloud: svg('<path d="M4.5 12.5a3 3 0 01-.3-6 4 4 0 017.6-.8 3.2 3.2 0 01.4 6.8z"/>', stroke),
  check: svg('<path d="M3 8.5l3 3 7-7"/>', stroke),
  expandAll: svg('<path d="M4 3.5l4 4 4-4M4 8.5l4 4 4-4"/>', stroke), collapseAll: svg('<path d="M4 7.5l4-4 4 4M4 12.5l4-4 4 4"/>', stroke),
  // Off: equal rows. On / row pins: same slanted pushpin as VS Code `$(pinned)`.
  solo: svg('<path d="M3 4h10M3 8h10M3 12h10"/>', stroke),
  soloActive: svg('<path fill="currentColor" d="M10.0589 2.44511C9.34701 1.73063 8.14697 1.90829 7.67261 2.79839L5.6526 6.58878L2.8419 7.52568C2.6775 7.58048 2.5532 7.71649 2.51339 7.88514C2.47357 8.0538 2.52392 8.23104 2.64646 8.35357L4.79291 10.5L2.14645 13.1465L2 14L2.85356 13.8536L5.50002 11.2071L7.64646 13.3536C7.76899 13.4761 7.94623 13.5265 8.11489 13.4866C8.28354 13.4468 8.41955 13.3225 8.47435 13.1581L9.41143 10.3469L13.1897 8.32423C14.0759 7.84982 14.2538 6.6551 13.5443 5.94305L10.0589 2.44511ZM8.55511 3.2687C8.71323 2.972 9.11324 2.91278 9.35055 3.15094L12.836 6.64889C13.0725 6.88624 13.0131 7.28448 12.7178 7.44262L8.76403 9.55921C8.65137 9.61952 8.56608 9.72068 8.52567 9.84191L7.7815 12.0744L3.92562 8.21853L6.15812 7.47436C6.27966 7.43385 6.38101 7.34823 6.44126 7.23518L8.55511 3.2687Z"/>'),
  pin: svg('<path fill="currentColor" d="M13.5 3C13.303 3 13.109 3.038 12.923 3.114L8.481 4.967L5.659 4.026C5.505 3.976 5.339 4.001 5.209 4.095C5.078 4.189 5.001 4.339 5.001 4.5V7H1.257L0.5 7.5L1.257 8H5V10.5C5 10.661 5.077 10.812 5.208 10.905C5.338 11 5.504 11.023 5.658 10.974L8.48 10.033L12.925 11.887C13.109 11.962 13.302 12 13.499 12C14.326 12 14.999 11.327 14.999 10.5V4.5C14.999 3.673 14.326 3 13.499 3H13.5ZM14 10.5C14 10.843 13.615 11.09 13.308 10.962L8.693 9.038C8.631 9.013 8.566 9 8.501 9C8.447 9 8.395 9.009 8.343 9.025L6.001 9.806V5.193L8.343 5.974C8.457 6.011 8.581 6.007 8.694 5.961L13.306 4.038C13.629 3.902 14.001 4.156 14.001 4.499V10.499L14 10.5Z"/>'),
  pinFilled: svg('<path fill="currentColor" d="M10.0589 2.44511C9.34701 1.73063 8.14697 1.90829 7.67261 2.79839L5.6526 6.58878L2.8419 7.52568C2.6775 7.58048 2.5532 7.71649 2.51339 7.88514C2.47357 8.0538 2.52392 8.23104 2.64646 8.35357L4.79291 10.5L2.14645 13.1465L2 14L2.85356 13.8536L5.50002 11.2071L7.64646 13.3536C7.76899 13.4761 7.94623 13.5265 8.11489 13.4866C8.28354 13.4468 8.41955 13.3225 8.47435 13.1581L9.41143 10.3469L13.1897 8.32423C14.0759 7.84982 14.2538 6.6551 13.5443 5.94305L10.0589 2.44511ZM8.55511 3.2687C8.71323 2.972 9.11324 2.91278 9.35055 3.15094L12.836 6.64889C13.0725 6.88624 13.0131 7.28448 12.7178 7.44262L8.76403 9.55921C8.65137 9.61952 8.56608 9.72068 8.52567 9.84191L7.7815 12.0744L3.92562 8.21853L6.15812 7.47436C6.27966 7.43385 6.38101 7.34823 6.44126 7.23518L8.55511 3.2687Z"/>'),
  dockGrip: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>',
  sectionChevron: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>',
  versionControl: svg('<circle cx="4" cy="3.5" r="1.75"/><circle cx="12" cy="3.5" r="1.75"/><circle cx="8" cy="12.5" r="1.75"/><path d="M4 5.25v.75a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-.75M8 8v2.75"/>', stroke.replace('1.2', '1.3')),
  refresh: svg('<path d="M13 8a5 5 0 1 1-1.46-3.54"/><path d="M11.8 1.8v2.9H8.9"/>', stroke),
};
function relativeTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const seconds = Math.round((timestamp - Date.now()) / 1000); const format = new Intl.RelativeTimeFormat(document.documentElement.lang || undefined, { numeric: 'auto' });
  for (const [unit, size] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]] as const) if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return format.format(seconds, 'second');
}
function isMac(): boolean { return /mac|iphone|ipad/i.test(navigator.platform); }
function statusClass(letter: string): string { return letter === 'D' ? 'deleted' : letter === 'A' ? 'added' : letter === '?' || letter === 'U' ? 'untracked' : letter === 'R' ? 'renamed' : 'modified'; }
/** Git ref path for a listed branch (`origin/foo` → `refs/remotes/origin/foo`). */
function branchRefPath(branch: GuardBranch): string {
  return branch.remote ? `refs/remotes/${branch.name}` : `refs/heads/${branch.name}`;
}

/** Grow the commit box with wrapped/multiline text, capped so the panel stays usable. */
function fitCommitInput(input: HTMLTextAreaElement): void {
  input.style.height = 'auto';
  const max = 12.5 * 16; // ~8 lines at 16px; matches max-height:12.5em
  input.style.height = `${Math.min(Math.max(input.scrollHeight, 0), max)}px`;
}

/** Short preview for host message boxes so long hook logs stay flat. */
function alertPreview(text: string, maxLines = 6, maxChars = 360): string {
  const lines = text.split('\n');
  let preview = lines.length > maxLines ? `${lines.slice(0, maxLines).join('\n')}\n…` : text;
  if (preview.length <= maxChars) return preview;
  const cut = preview.slice(0, maxChars);
  const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return `${(at > maxChars / 2 ? cut.slice(0, at) : cut).trimEnd()}\n…`;
}
