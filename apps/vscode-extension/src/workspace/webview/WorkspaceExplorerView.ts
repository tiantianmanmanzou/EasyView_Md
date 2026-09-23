import {
  describeWorkspaceEntryTimestamps,
  filterWorkspaceEntriesByDotVisibility,
  resolveWorkspaceTreeDropMode,
  resolveWorkspaceTreeIcon,
  type WorkspaceTreeSortMode,
} from '@easyview/contracts';
import type {
  WorkspaceExplorerEntry,
  WorkspaceExplorerEvent,
  WorkspaceExplorerRequest,
  WorkspaceExplorerSortConfig,
} from './workspace-explorer-messages';

export interface WorkspaceExplorerVsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
}

const SORT_MODE_LABELS: Record<WorkspaceTreeSortMode, string> = {
  created: 'Sort by Created Time',
  name: 'Sort by Name',
  custom: 'Custom',
};

type PendingOpResolve = (result: Extract<WorkspaceExplorerEvent, { type: 'opResult' }>) => void;
type PendingListResolve = (result: Extract<WorkspaceExplorerEvent, { type: 'listChildrenResult' }>) => void;

interface ContextMenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  action: () => void;
}

const IS_MAC =
  /mac|iphone|ipad/i.test(navigator.platform)
  || (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform === 'macOS';

function modKey(): string {
  return IS_MAC ? '⌘' : 'Ctrl+';
}

/**
 * Pure-DOM workspace tree for the Extension sidebar webview.
 * Talks to the host exclusively via {@link WorkspaceExplorerRequest} / {@link WorkspaceExplorerEvent}.
 */
export class WorkspaceExplorerView {
  private rootName: string | null = null;
  private rootUri: string | null = null;
  private readonly entriesByDirectory = new Map<string, WorkspaceExplorerEntry[]>();
  private readonly expanded = new Set<string>();
  private readonly selected = new Set<string>();
  private anchor: string | null = null;
  private primarySelected: string | null = null;
  private sortMode: WorkspaceTreeSortMode = 'name';
  private showCreatedAt = false;
  private showUpdatedAt = false;
  private showDotEntries = true;
  private showTimestampHover = true;
  private pendingCreate: { parentRelativePath: string; kind: 'file' | 'directory' } | null = null;
  private renamePath: string | null = null;
  private sortMenuOpen = false;
  private dragRelativePath: string | null = null;
  private dropIntent: { mode: 'before' | 'into'; targetRelativePath: string } | null = null;
  private dropIndicator: HTMLElement | null = null;
  private contextMenuEl: HTMLElement | null = null;
  private sortMenuEl: HTMLElement | null = null;
  private timestampTooltipEl: HTMLElement | null = null;
  private selectionFollowsActive = true;
  private activeRelativePath: string | null = null;
  private hasClipboard = false;
  private editing = false;
  private requestSeq = 0;
  private readonly pendingOps = new Map<string, PendingOpResolve>();
  private readonly pendingLists = new Map<string, PendingListResolve>();
  private readonly handleKeyDown = (event: KeyboardEvent): void => this.onKeyDown(event);
  private readonly handleWindowPointerDown = (event: PointerEvent): void => {
    if (!(event.target instanceof Node)) return;
    if (this.contextMenuEl?.contains(event.target)) return;
    if (this.sortMenuEl?.contains(event.target)) return;
    this.closeContextMenu();
    if (this.sortMenuOpen) {
      this.sortMenuOpen = false;
      this.closeSortMenu();
    }
  };

  constructor(
    private readonly container: HTMLElement,
    private readonly vscodeApi: WorkspaceExplorerVsCodeApi,
  ) {
    this.container.classList.add('workspace-explorer');
    this.container.tabIndex = 0;
    // Capture so Enter on a focused name <button> renames instead of activating click.
    this.container.addEventListener('keydown', this.handleKeyDown, true);
    window.addEventListener('pointerdown', this.handleWindowPointerDown, true);
    this.render();
  }

  dispose(): void {
    this.container.removeEventListener('keydown', this.handleKeyDown, true);
    window.removeEventListener('pointerdown', this.handleWindowPointerDown, true);
    this.closeContextMenu();
    this.closeSortMenu();
    this.hideTimestampTooltip();
    this.timestampTooltipEl?.remove();
    this.timestampTooltipEl = null;
    this.clearDropVisuals();
  }

  /** Handle a host → webview event (call from `window` message listener). */
  handleEvent(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string') return;
    const event = raw as WorkspaceExplorerEvent;
    switch (event.type) {
      case 'bootstrap':
        this.onBootstrap(event);
        break;
      case 'rootChanged':
        this.onRootChanged();
        break;
      case 'fsChanged':
        void this.onFsChanged(event.relativePaths);
        break;
      case 'reveal':
        void this.onReveal(event.relativePath);
        break;
      case 'sortConfig':
        this.applySortConfig(event.sort);
        this.render();
        break;
      case 'clipboardChanged':
        this.hasClipboard = event.hasClipboard;
        break;
      case 'contextCommand':
        void this.onContextCommand(event.command, event.relativePath);
        break;
      case 'listChildrenResult': {
        const pending = this.pendingLists.get(event.requestId);
        if (pending) {
          this.pendingLists.delete(event.requestId);
          pending(event);
        }
        break;
      }
      case 'opResult': {
        const pending = this.pendingOps.get(event.requestId);
        if (pending) {
          this.pendingOps.delete(event.requestId);
          pending(event);
        } else if (!event.ok) {
          this.showError(event.message);
        }
        break;
      }
      default:
        break;
    }
  }

  private post(msg: WorkspaceExplorerRequest): void {
    this.vscodeApi.postMessage(msg);
  }

  private nextRequestId(): string {
    this.requestSeq += 1;
    return `we-${this.requestSeq}`;
  }

  private requestOp(
    build: (requestId: string) => WorkspaceExplorerRequest,
  ): Promise<Extract<WorkspaceExplorerEvent, { type: 'opResult' }>> {
    const requestId = this.nextRequestId();
    return new Promise((resolve) => {
      this.pendingOps.set(requestId, resolve);
      this.post(build(requestId));
    });
  }

  private setEditing(next: boolean): void {
    if (this.editing === next) return;
    this.editing = next;
    this.post({ type: 'setInputFocus', focused: next });
  }

  private applySortConfig(sort: WorkspaceExplorerSortConfig): void {
    this.sortMode = sort.sortMode;
    this.showCreatedAt = sort.showCreatedAt;
    this.showUpdatedAt = sort.showUpdatedAt;
    this.showDotEntries = sort.showDotEntries !== false;
    this.showTimestampHover = sort.showTimestampHover !== false;
  }

  private onBootstrap(event: Extract<WorkspaceExplorerEvent, { type: 'bootstrap' }>): void {
    this.rootName = event.rootName;
    this.rootUri = event.rootUri;
    this.applySortConfig(event.sort);
    this.hasClipboard = event.hasClipboard;
    this.entriesByDirectory.clear();
    this.expanded.clear();
    this.selected.clear();
    this.anchor = null;
    this.primarySelected = null;
    this.activeRelativePath = null;
    this.selectionFollowsActive = true;
    this.pendingCreate = null;
    this.renamePath = null;
    this.setEditing(false);
    this.sortMenuOpen = false;
    this.render();
    if (this.rootUri !== null || this.rootName !== null) {
      void this.loadDirectory('').then(() => {
        if (event.revealRelativePath) void this.onReveal(event.revealRelativePath);
      });
    }
  }

  private onRootChanged(): void {
    this.rootName = null;
    this.rootUri = null;
    this.entriesByDirectory.clear();
    this.expanded.clear();
    this.selected.clear();
    this.anchor = null;
    this.primarySelected = null;
    this.activeRelativePath = null;
    this.pendingCreate = null;
    this.renamePath = null;
    this.setEditing(false);
    this.sortMenuOpen = false;
    this.clearDropVisuals();
    this.closeContextMenu();
    this.render();
  }

  private async onFsChanged(relativePaths: string[]): Promise<void> {
    if (!this.hasRoot()) return;
    if (this.editing || this.pendingCreate || this.renamePath) return;
    const targets = [...new Set(relativePaths.map(normalizeRelativePath))].filter(
      (value) => value === '' || this.expanded.has(value),
    );
    if (targets.length === 0) return;
    await Promise.all(targets.map((relativePath) => this.loadDirectory(relativePath)));
  }

  private async onReveal(relativePath: string): Promise<void> {
    if (!this.hasRoot() || !relativePath) return;
    if (this.activeRelativePath === relativePath) return;
    this.activeRelativePath = relativePath;
    this.selectionFollowsActive = true;
    const segments = relativePath.split('/').filter(Boolean);
    segments.pop();
    for (let index = 1; index <= segments.length; index += 1) {
      const dir = segments.slice(0, index).join('/');
      if (!this.expanded.has(dir)) {
        this.expanded.add(dir);
        this.post({ type: 'setExpanded', relativePath: dir, expanded: true });
      }
    }
    await Promise.all(['', ...this.expanded].map((path) => this.loadDirectory(path)));
    this.select(relativePath);
    requestAnimationFrame(() => {
      const row = [...this.container.querySelectorAll<HTMLElement>('.workspace-entry')]
        .find((el) => el.dataset.relativePath === relativePath);
      row?.scrollIntoView({ block: 'nearest' });
    });
  }

  private async onContextCommand(
    command: Extract<WorkspaceExplorerEvent, { type: 'contextCommand' }>['command'],
    relativePath?: string,
  ): Promise<void> {
    this.selectionFollowsActive = false;
    if (relativePath) this.select(relativePath);
    switch (command) {
      case 'rename':
        if (this.primarySelected) this.beginRename(this.primarySelected);
        break;
      case 'paste':
        await this.pasteAt(this.primarySelected ?? '');
        break;
      case 'beginCreateFile':
        this.beginCreate(relativePath ?? this.primarySelectedDirectory() ?? '', 'file');
        break;
      case 'beginCreateFolder':
        this.beginCreate(relativePath ?? this.primarySelectedDirectory() ?? '', 'directory');
        break;
      case 'toggleSortMenu':
        this.sortMenuOpen = !this.sortMenuOpen;
        if (this.sortMenuOpen) this.openSortMenu();
        else this.closeSortMenu();
        break;
      case 'refresh':
        this.entriesByDirectory.clear();
        await this.refreshExpanded();
        this.post({ type: 'refresh' });
        break;
      case 'collapseAll':
        this.expanded.clear();
        this.render();
        break;
      default:
        break;
    }
  }

  private hasRoot(): boolean {
    return this.rootName !== null || this.rootUri !== null;
  }

  private primarySelectedDirectory(): string | null {
    if (!this.primarySelected) return '';
    const entry = this.findEntry(this.primarySelected);
    if (!entry) return parentRelativePath(this.primarySelected);
    return entry.kind === 'directory' ? entry.relativePath : parentRelativePath(entry.relativePath);
  }

  private findEntry(relativePath: string): WorkspaceExplorerEntry | undefined {
    const parent = parentRelativePath(relativePath);
    return (this.entriesByDirectory.get(parent) ?? []).find((entry) => entry.relativePath === relativePath);
  }

  private async loadDirectory(relativePath: string): Promise<void> {
    if (!this.hasRoot()) return;
    const requestId = this.nextRequestId();
    const result = await new Promise<Extract<WorkspaceExplorerEvent, { type: 'listChildrenResult' }>>((resolve) => {
      this.pendingLists.set(requestId, resolve);
      this.post({ type: 'listChildren', requestId, relativePath });
    });
    if (!result.ok) {
      this.showError(result.message);
      return;
    }
    this.entriesByDirectory.set(result.relativePath, result.entries);
    this.render();
  }

  private async refreshExpanded(): Promise<void> {
    if (!this.hasRoot()) return;
    await Promise.all(['', ...this.expanded].map((relativePath) => this.loadDirectory(relativePath)));
  }

  private toggleDirectory(relativePath: string): void {
    if (this.expanded.has(relativePath)) {
      this.expanded.delete(relativePath);
      this.post({ type: 'setExpanded', relativePath, expanded: false });
      this.render();
      return;
    }
    this.expanded.add(relativePath);
    this.post({ type: 'setExpanded', relativePath, expanded: true });
    void this.loadDirectory(relativePath);
    this.render();
  }

  private select(
    relativePath: string,
    options?: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean },
  ): void {
    const shiftKey = Boolean(options?.shiftKey);
    const toggleKey = Boolean(options?.metaKey || options?.ctrlKey);

    if (shiftKey && this.anchor) {
      const visible = this.visibleRelativePaths();
      const anchorIndex = visible.indexOf(this.anchor);
      const targetIndex = visible.indexOf(relativePath);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const [from, to] = anchorIndex < targetIndex
          ? [anchorIndex, targetIndex]
          : [targetIndex, anchorIndex];
        this.selected.clear();
        for (const path of visible.slice(from, to + 1)) this.selected.add(path);
      } else {
        this.selected.clear();
        this.selected.add(relativePath);
        this.anchor = relativePath;
      }
    } else if (toggleKey) {
      if (this.selected.has(relativePath)) this.selected.delete(relativePath);
      else this.selected.add(relativePath);
      this.anchor = relativePath;
    } else {
      this.selected.clear();
      this.selected.add(relativePath);
      this.anchor = relativePath;
    }

    this.primarySelected = relativePath;
    this.post({
      type: 'setSelection',
      relativePaths: [...this.selected],
      anchorRelativePath: this.anchor,
    });
    this.render();
    this.container.focus({ preventScroll: true });
  }

  private visibleRelativePaths(): string[] {
    const paths: string[] = [];
    const walk = (directoryRelativePath: string): void => {
      for (const entry of this.entriesByDirectory.get(directoryRelativePath) ?? []) {
        paths.push(entry.relativePath);
        if (entry.kind === 'directory' && this.expanded.has(entry.relativePath)) {
          walk(entry.relativePath);
        }
      }
    };
    walk('');
    return paths;
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if ((event.key === 'F2' || event.key === 'Enter') && this.primarySelected) {
      event.preventDefault();
      event.stopPropagation();
      this.beginRename(this.primarySelected);
      return;
    }
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === 'c' && this.selected.size > 0) {
      event.preventDefault();
      void this.copyEntries([...this.selected]);
      return;
    }
    if (modifier && event.key.toLowerCase() === 'v') {
      event.preventDefault();
      void this.pasteAt(this.primarySelected ?? '');
      return;
    }
    const deleteShortcut = event.key === 'Delete' || (event.key === 'Backspace' && event.metaKey);
    const deleteTargets = [...this.selected];
    if (!deleteShortcut || deleteTargets.length === 0) return;
    event.preventDefault();
    void this.deleteEntries(deleteTargets);
  }

  private showError(message: string): void {
    this.post({ type: 'showError', message });
  }

  private render(): void {
    const previousTree = this.container.querySelector<HTMLElement>('.workspace-tree');
    const previousScrollTop = previousTree?.scrollTop ?? 0;
    const previousScrollLeft = previousTree?.scrollLeft ?? 0;
    this.clearDropVisuals();
    this.dropIndicator = null;
    this.hideTimestampTooltip();
    this.closeContextMenu();
    // Keep floating sort menu on body (outside overflow:hidden tree) while open.
    this.container.replaceChildren();

    if (!this.hasRoot()) {
      this.closeSortMenu();
      this.sortMenuOpen = false;
      const empty = document.createElement('div');
      empty.className = 'workspace-empty';
      empty.textContent = 'Open a folder or workspace';
      this.container.appendChild(empty);
      return;
    }

    const tree = document.createElement('div');
    tree.className = 'workspace-tree';
    tree.setAttribute('role', 'tree');
    tree.appendChild(this.renderDirectory('', 0));
    this.container.appendChild(tree);
    tree.scrollTop = previousScrollTop;
    tree.scrollLeft = previousScrollLeft;

    if (this.sortMenuOpen) this.openSortMenu();
    else this.closeSortMenu();
  }

  private closeSortMenu(): void {
    this.sortMenuEl?.remove();
    this.sortMenuEl = null;
  }

  private openSortMenu(): void {
    this.closeSortMenu();
    const menu = this.buildSortMenu();
    // Mount on body with position:fixed so overflow:hidden on the tree cannot clip it.
    // Still confined to the webview viewport — align to the right edge so labels stay visible.
    document.body.appendChild(menu);
    this.sortMenuEl = menu;
    const pad = 8;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    let left = window.innerWidth - width - pad;
    let top = pad;
    if (left < pad) left = pad;
    if (top + height > window.innerHeight - pad) {
      top = Math.max(pad, window.innerHeight - height - pad);
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  private buildSortMenu(): HTMLElement {
    const menu = document.createElement('div');
    menu.className = 'workspace-sort-menu';
    menu.setAttribute('role', 'menu');

    for (const mode of ['created', 'name', 'custom'] as const) {
      this.appendSortMenuItem(menu, {
        label: SORT_MODE_LABELS[mode],
        checked: this.sortMode === mode,
        onClick: () => { void this.changeSortMode(mode); },
      });
    }
    const separator = document.createElement('div');
    separator.className = 'workspace-sort-menu-separator';
    menu.appendChild(separator);
    this.appendSortMenuItem(menu, {
      label: 'Show Created Time',
      checked: this.showCreatedAt,
      onClick: () => { void this.changeShowCreatedAt(!this.showCreatedAt); },
    });
    this.appendSortMenuItem(menu, {
      label: 'Show Updated Time',
      checked: this.showUpdatedAt,
      onClick: () => { void this.changeShowUpdatedAt(!this.showUpdatedAt); },
    });
    this.appendSortMenuItem(menu, {
      label: 'Show Time on Hover',
      checked: this.showTimestampHover,
      onClick: () => { void this.changeShowTimestampHover(!this.showTimestampHover); },
    });
    const dotSeparator = document.createElement('div');
    dotSeparator.className = 'workspace-sort-menu-separator';
    menu.appendChild(dotSeparator);
    this.appendSortMenuItem(menu, {
      label: 'Show Dotfiles and Folders',
      checked: this.showDotEntries,
      onClick: () => { void this.changeShowDotEntries(!this.showDotEntries); },
    });
    return menu;
  }

  private renderDirectory(relativePath: string, depth: number): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const entries = filterWorkspaceEntriesByDotVisibility(
      this.entriesByDirectory.get(relativePath) ?? [],
      this.showDotEntries,
    );
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = `workspace-entry workspace-entry-${entry.kind}`;
      row.dataset.relativePath = entry.relativePath;
      row.style.paddingInlineStart = `${8 + depth * 16}px`;
      row.classList.toggle('active', entry.relativePath === this.activeRelativePath);
      row.classList.toggle('selected', this.selected.has(entry.relativePath));
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-selected', String(this.selected.has(entry.relativePath)));
      const expanded = entry.kind === 'directory' && this.expanded.has(entry.relativePath);
      if (entry.kind === 'directory') row.setAttribute('aria-expanded', String(expanded));

      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'workspace-entry-name';
      const chevron = document.createElement('span');
      chevron.className = 'workspace-chevron';
      if (entry.kind === 'directory') {
        chevron.classList.add('is-directory');
        chevron.classList.toggle('is-expanded', expanded);
      }
      const icon = document.createElement('span');
      icon.className = 'workspace-entry-icon';
      const iconDesc = resolveWorkspaceTreeIcon({
        kind: entry.kind,
        name: entry.name,
        expanded: entry.kind === 'directory' ? expanded : false,
      });
      icon.dataset.icon = iconDesc.id;
      icon.innerHTML = iconDesc.svg;
      name.append(chevron, icon);
      if (this.renamePath === entry.relativePath) name.appendChild(this.renderRenameInput(entry));
      else {
        const label = document.createElement('span');
        label.textContent = entry.name;
        name.appendChild(label);
      }
      name.addEventListener('click', (event) => {
        this.selectionFollowsActive = false;
        this.select(entry.relativePath, {
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
        });
        if (event.shiftKey || event.metaKey || event.ctrlKey) return;
        if (entry.kind === 'directory') {
          this.toggleDirectory(entry.relativePath);
          return;
        }
        this.selectionFollowsActive = true;
        this.activeRelativePath = entry.relativePath;
        this.post({ type: 'open', relativePath: entry.relativePath });
        // Keep keyboard focus on the tree so Enter can still rename.
        requestAnimationFrame(() => this.container.focus({ preventScroll: true }));
      });
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this.selectionFollowsActive = false;
        if (!this.selected.has(entry.relativePath)) this.select(entry.relativePath);
        this.openContextMenu(event.clientX, event.clientY, entry);
      });
      this.attachDragHandlers(row, entry);
      row.appendChild(name);
      this.appendEntryTimestamps(row, entry);
      if (entry.kind === 'directory') {
        const create = document.createElement('button');
        create.type = 'button';
        create.className = 'workspace-entry-create';
        create.textContent = '＋';
        create.title = 'New File';
        create.disabled = !entry.writable;
        create.addEventListener('click', (event) => {
          event.stopPropagation();
          this.beginCreate(entry.relativePath, 'file');
        });
        row.appendChild(create);
      } else if (this.showCreatedAt || this.showUpdatedAt) {
        const spacer = document.createElement('span');
        spacer.className = 'workspace-entry-create-spacer';
        row.appendChild(spacer);
      }
      fragment.appendChild(row);
      if (entry.kind === 'directory' && expanded) {
        fragment.appendChild(this.renderDirectory(entry.relativePath, depth + 1));
      }
    }
    if (this.pendingCreate?.parentRelativePath === relativePath) {
      fragment.appendChild(this.renderCreateInput(depth));
    }
    return fragment;
  }

  private appendEntryTimestamps(row: HTMLElement, entry: WorkspaceExplorerEntry): void {
    const display = describeWorkspaceEntryTimestamps(entry, {
      showCreatedAt: this.showCreatedAt,
      showUpdatedAt: this.showUpdatedAt,
    });
    if (!display) return;
    if (this.showTimestampHover) {
      row.addEventListener('pointerenter', (event) => {
        this.showTimestampTooltip(display.title, event.clientX, event.clientY);
      });
      row.addEventListener('pointerleave', () => this.hideTimestampTooltip());
    }
    if (display.parts.length === 0) return;
    row.classList.add('has-timestamps');
    const meta = document.createElement('span');
    meta.className = 'workspace-entry-timestamps';
    for (const part of display.parts) {
      const item = document.createElement('span');
      item.className = `workspace-entry-timestamp is-${part.kind}`;
      const icon = document.createElement('span');
      icon.className = `workspace-entry-timestamp-icon is-${part.kind}`;
      icon.setAttribute('aria-hidden', 'true');
      const value = document.createElement('span');
      value.className = 'workspace-entry-timestamp-value';
      value.textContent = part.value;
      item.append(icon, value);
      meta.appendChild(item);
    }
    row.appendChild(meta);
  }

  private showTimestampTooltip(text: string, x: number, y: number): void {
    const el = this.timestampTooltipEl ?? document.createElement('div');
    if (!this.timestampTooltipEl) {
      el.className = 'workspace-timestamp-tooltip';
      document.body.appendChild(el);
      this.timestampTooltipEl = el;
    }
    el.textContent = text;
    el.hidden = false;
    const pad = 8;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    let left = x + 12;
    let top = y + 16;
    if (left + width > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - width - pad);
    if (top + height > window.innerHeight - pad) top = Math.max(pad, y - height - 12);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  private hideTimestampTooltip(): void {
    if (this.timestampTooltipEl) this.timestampTooltipEl.hidden = true;
  }

  private appendSortMenuItem(
    menu: HTMLElement,
    options: { label: string; checked: boolean; onClick: () => void },
  ): void {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'workspace-sort-menu-item';
    button.setAttribute('role', 'menuitemcheckbox');
    button.setAttribute('aria-checked', String(options.checked));
    const label = document.createElement('span');
    label.className = 'workspace-menu-item-label';
    label.textContent = options.label;
    button.appendChild(label);
    const check = document.createElement('span');
    check.className = 'workspace-menu-item-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = options.checked ? '✓' : '';
    button.appendChild(check);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      options.onClick();
    });
    menu.appendChild(button);
  }

  private appendMenuItem(
    menu: HTMLElement,
    options: { label: string; shortcut?: string; disabled?: boolean; className?: string; onClick: () => void },
  ): void {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = options.className ?? '';
    button.disabled = Boolean(options.disabled);
    const label = document.createElement('span');
    label.className = 'workspace-menu-item-label';
    label.textContent = options.label;
    button.appendChild(label);
    if (options.shortcut) {
      const shortcut = document.createElement('span');
      shortcut.className = 'workspace-menu-item-shortcut';
      shortcut.textContent = options.shortcut;
      button.appendChild(shortcut);
    }
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (button.disabled) return;
      options.onClick();
    });
    menu.appendChild(button);
  }

  private openContextMenu(x: number, y: number, entry: WorkspaceExplorerEntry): void {
    this.closeContextMenu();
    const items = this.buildContextMenuItems(entry);
    if (items.length === 0) return;
    const menu = document.createElement('div');
    menu.className = 'workspace-file-context-menu';
    menu.setAttribute('role', 'menu');
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    for (const item of items) {
      if (item.label === '---') {
        const sep = document.createElement('div');
        sep.className = 'workspace-context-separator';
        menu.appendChild(sep);
        continue;
      }
      this.appendMenuItem(menu, {
        label: item.label,
        shortcut: item.shortcut,
        disabled: item.disabled,
        onClick: () => {
          this.closeContextMenu();
          item.action();
        },
      });
    }
    document.body.appendChild(menu);
    this.contextMenuEl = menu;
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${Math.max(0, x - rect.width)}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(0, y - rect.height)}px`;
  }

  private closeContextMenu(): void {
    this.contextMenuEl?.remove();
    this.contextMenuEl = null;
  }

  private buildContextMenuItems(entry: WorkspaceExplorerEntry): ContextMenuItem[] {
    const writable = entry.writable;
    const isFile = entry.kind === 'file' || entry.kind === 'symlink';
    const items: ContextMenuItem[] = [];

    if (isFile) {
      items.push(
        { label: 'Open Preview', action: () => this.post({ type: 'open', relativePath: entry.relativePath }) },
        { label: 'Open with Default Application', action: () => this.post({ type: 'openExternal', relativePath: entry.relativePath }) },
      );
    } else if (writable) {
      items.push(
        { label: 'New File', action: () => this.beginCreate(entry.relativePath, 'file') },
        { label: 'New Folder', action: () => this.beginCreate(entry.relativePath, 'directory') },
      );
    }

    items.push({
      label: /mac|iphone|ipad/i.test(navigator.platform) || (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform === 'macOS'
        ? 'Reveal in Finder'
        : 'Reveal in File Explorer',
      action: () => this.post({ type: 'revealInOS', relativePath: entry.relativePath }),
    });
    items.push({ label: '---', action: () => undefined });

    if (writable) {
      items.push({
        label: 'Copy',
        shortcut: `${modKey()}C`,
        action: () => { void this.copyEntries([...this.selected].length ? [...this.selected] : [entry.relativePath]); },
      });
    }
    items.push({
      label: 'Paste',
      shortcut: `${modKey()}V`,
      disabled: !this.hasClipboard || !writable,
      action: () => { void this.pasteAt(entry.relativePath); },
    });
    items.push(
      {
        label: 'Copy Path',
        shortcut: IS_MAC ? '⌥⌘C' : 'Shift+Alt+C',
        action: () => this.post({
          type: 'copyPath',
          relativePaths: [...this.selected].length ? [...this.selected] : [entry.relativePath],
        }),
      },
      {
        label: 'Copy Relative Path',
        shortcut: IS_MAC ? '⇧⌥⌘C' : 'Ctrl+K Ctrl+Shift+C',
        action: () => this.post({
          type: 'copyRelativePath',
          relativePaths: [...this.selected].length ? [...this.selected] : [entry.relativePath],
        }),
      },
    );
    items.push({ label: '---', action: () => undefined });
    if (writable) {
      items.push(
        {
          label: 'Rename...',
          shortcut: 'Enter',
          action: () => this.beginRename(entry.relativePath),
        },
        {
          label: 'Delete',
          shortcut: IS_MAC ? '⌘⌫' : 'Delete',
          action: () => {
            void this.deleteEntries(
              [...this.selected].length ? [...this.selected] : [entry.relativePath],
            );
          },
        },
      );
    }
    return items;
  }

  private renderRenameInput(entry: WorkspaceExplorerEntry): HTMLInputElement {
    const input = document.createElement('input');
    input.className = 'workspace-rename-input';
    input.value = entry.name;
    this.setEditing(true);
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        this.renamePath = null;
        this.setEditing(false);
        this.render();
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        void this.renameEntry(entry.relativePath, input.value);
      }
    });
    input.addEventListener('blur', () => {
      if (this.renamePath === entry.relativePath) void this.renameEntry(entry.relativePath, input.value);
    });
    input.addEventListener('focus', () => this.setEditing(true));
    requestAnimationFrame(() => {
      input.focus();
      selectFileName(input);
    });
    return input;
  }

  private beginRename(relativePath: string): void {
    const entry = this.findEntry(relativePath);
    if (entry && !entry.writable) return;
    this.pendingCreate = null;
    this.renamePath = relativePath;
    this.setEditing(true);
    this.render();
  }

  private async renameEntry(relativePath: string, newName: string): Promise<void> {
    if (this.renamePath !== relativePath) return;
    const trimmed = newName.trim();
    const entry = this.findEntry(relativePath);
    if (!trimmed || (entry && trimmed === entry.name)) {
      this.renamePath = null;
      this.setEditing(false);
      this.render();
      return;
    }
    const result = await this.requestOp((requestId) => ({
      type: 'rename',
      requestId,
      relativePath,
      newName: trimmed,
    }));
    this.renamePath = null;
    this.setEditing(false);
    if (!result.ok) {
      this.showError(result.message);
      this.render();
      return;
    }
    if (result.entry) {
      this.selected.delete(relativePath);
      this.selected.add(result.entry.relativePath);
      this.primarySelected = result.entry.relativePath;
      this.anchor = result.entry.relativePath;
      this.post({
        type: 'setSelection',
        relativePaths: [...this.selected],
        anchorRelativePath: this.anchor,
      });
      await this.loadDirectory(parentRelativePath(result.entry.relativePath));
      return;
    }
    await this.loadDirectory(parentRelativePath(relativePath));
  }

  private async deleteEntries(relativePaths: string[]): Promise<void> {
    const unique = [...new Set(relativePaths.filter(Boolean))];
    if (unique.length === 0) return;
    const result = await this.requestOp((requestId) => ({
      type: 'delete',
      requestId,
      relativePaths: unique,
    }));
    if (!result.ok) {
      this.showError(result.message);
      return;
    }
    for (const relativePath of unique) {
      this.selected.delete(relativePath);
      if (this.primarySelected === relativePath) this.primarySelected = null;
      if (this.anchor === relativePath) this.anchor = null;
      this.expanded.delete(relativePath);
    }
    const parents = [...new Set(unique.map(parentRelativePath))];
    await Promise.all(parents.map((parent) => this.loadDirectory(parent)));
  }

  private beginCreate(parentRelativePathValue: string, kind: 'file' | 'directory'): void {
    if (parentRelativePathValue) {
      this.expanded.add(parentRelativePathValue);
      this.post({ type: 'setExpanded', relativePath: parentRelativePathValue, expanded: true });
      void this.loadDirectory(parentRelativePathValue);
    }
    this.renamePath = null;
    this.pendingCreate = { parentRelativePath: parentRelativePathValue, kind };
    this.setEditing(true);
    this.render();
  }

  private renderCreateInput(depth: number): HTMLElement {
    const wrapper = document.createElement('form');
    wrapper.className = 'workspace-create-row';
    wrapper.style.paddingInlineStart = `${28 + depth * 16}px`;
    const input = document.createElement('input');
    input.autofocus = true;
    input.value = this.pendingCreate?.kind === 'file' ? 'untitled.md' : 'untitled';
    wrapper.appendChild(input);
    wrapper.addEventListener('submit', (event) => {
      event.preventDefault();
      const pending = this.pendingCreate;
      if (pending) void this.createEntry(pending, input.value);
    });
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        this.pendingCreate = null;
        this.setEditing(false);
        this.render();
      }
    });
    input.addEventListener('focus', () => this.setEditing(true));
    input.addEventListener('blur', () => {
      if (!this.pendingCreate) return;
      // Keep editing flag until create settles or Escape cancels.
    });
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return wrapper;
  }

  private async createEntry(
    pending: NonNullable<WorkspaceExplorerView['pendingCreate']>,
    name: string,
  ): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      this.pendingCreate = null;
      this.setEditing(false);
      this.render();
      return;
    }
    const result = await this.requestOp((requestId) => ({
      type: 'create',
      requestId,
      parentRelativePath: pending.parentRelativePath,
      name: trimmed,
      kind: pending.kind,
    }));
    this.pendingCreate = null;
    this.setEditing(false);
    if (!result.ok) {
      this.showError(result.message);
      this.render();
      return;
    }
    if (result.entry) {
      this.primarySelected = result.entry.relativePath;
      this.selected.clear();
      this.selected.add(result.entry.relativePath);
      this.anchor = result.entry.relativePath;
      this.post({
        type: 'setSelection',
        relativePaths: [...this.selected],
        anchorRelativePath: this.anchor,
      });
    }
    await this.loadDirectory(pending.parentRelativePath);
  }

  private async copyEntries(relativePaths: string[]): Promise<void> {
    const unique = [...new Set(relativePaths.filter(Boolean))];
    if (unique.length === 0) return;
    const result = await this.requestOp((requestId) => ({
      type: 'copy',
      requestId,
      relativePaths: unique,
    }));
    if (!result.ok) this.showError(result.message);
    else this.hasClipboard = true;
  }

  private async pasteAt(targetRelativePath: string): Promise<void> {
    const entry = targetRelativePath ? this.findEntry(targetRelativePath) : undefined;
    const targetParentRelativePath = entry?.kind === 'directory'
      ? entry.relativePath
      : parentRelativePath(targetRelativePath);
    const result = await this.requestOp((requestId) => ({
      type: 'paste',
      requestId,
      targetParentRelativePath,
    }));
    if (!result.ok) {
      this.showError(result.message);
      return;
    }
    if (result.entry) {
      this.primarySelected = result.entry.relativePath;
      this.selected.clear();
      this.selected.add(result.entry.relativePath);
      this.anchor = result.entry.relativePath;
      await this.loadDirectory(parentRelativePath(result.entry.relativePath));
      return;
    }
    await this.loadDirectory(targetParentRelativePath);
  }

  private async changeSortMode(sortMode: WorkspaceTreeSortMode): Promise<void> {
    this.sortMenuOpen = false;
    this.closeSortMenu();
    if (sortMode === this.sortMode) {
      this.render();
      return;
    }
    const result = await this.requestOp((requestId) => ({
      type: 'setSortMode',
      requestId,
      sortMode,
    }));
    if (!result.ok) {
      this.showError(result.message);
      this.render();
      return;
    }
    if (result.sort) this.applySortConfig(result.sort);
    else this.sortMode = sortMode;
    this.entriesByDirectory.clear();
    await this.refreshExpanded();
  }

  private async changeShowCreatedAt(showCreatedAt: boolean): Promise<void> {
    this.sortMenuOpen = false;
    this.closeSortMenu();
    const result = await this.requestOp((requestId) => ({
      type: 'setShowCreatedAt',
      requestId,
      showCreatedAt,
    }));
    if (!result.ok) {
      this.showError(result.message);
      this.render();
      return;
    }
    if (result.sort) this.applySortConfig(result.sort);
    else this.showCreatedAt = showCreatedAt;
    this.render();
  }

  private async changeShowUpdatedAt(showUpdatedAt: boolean): Promise<void> {
    this.sortMenuOpen = false;
    this.closeSortMenu();
    const result = await this.requestOp((requestId) => ({
      type: 'setShowUpdatedAt',
      requestId,
      showUpdatedAt,
    }));
    if (!result.ok) {
      this.showError(result.message);
      this.render();
      return;
    }
    if (result.sort) this.applySortConfig(result.sort);
    else this.showUpdatedAt = showUpdatedAt;
    this.render();
  }

  private async changeShowTimestampHover(showTimestampHover: boolean): Promise<void> {
    this.sortMenuOpen = false;
    this.closeSortMenu();
    this.hideTimestampTooltip();
    const result = await this.requestOp((requestId) => ({
      type: 'setShowTimestampHover',
      requestId,
      showTimestampHover,
    }));
    if (!result.ok) {
      this.showError(result.message);
      this.render();
      return;
    }
    if (result.sort) this.applySortConfig(result.sort);
    else this.showTimestampHover = showTimestampHover;
    this.render();
  }

  private async changeShowDotEntries(showDotEntries: boolean): Promise<void> {
    this.sortMenuOpen = false;
    this.closeSortMenu();
    const result = await this.requestOp((requestId) => ({
      type: 'setShowDotEntries',
      requestId,
      showDotEntries,
    }));
    if (!result.ok) {
      this.showError(result.message);
      this.render();
      return;
    }
    if (result.sort) this.applySortConfig(result.sort);
    else this.showDotEntries = showDotEntries;
    this.render();
  }

  private attachDragHandlers(row: HTMLElement, entry: WorkspaceExplorerEntry): void {
    if (!entry.writable) return;
    row.draggable = true;
    row.addEventListener('dragstart', (event) => {
      this.dragRelativePath = entry.relativePath;
      event.dataTransfer?.setData('text/plain', entry.relativePath);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      row.classList.add('is-dragging');
      this.clearDropVisuals();
    });
    row.addEventListener('dragend', () => {
      this.dragRelativePath = null;
      row.classList.remove('is-dragging');
      this.clearDropVisuals();
    });
    row.addEventListener('dragover', (event) => {
      if (!this.dragRelativePath || this.dragRelativePath === entry.relativePath) return;
      if (
        entry.kind === 'directory'
        && (
          this.dragRelativePath === entry.relativePath
          || entry.relativePath.startsWith(`${this.dragRelativePath}/`)
        )
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      this.updateDropIntent(row, entry, event.clientY);
    });
    row.addEventListener('dragleave', (event) => {
      const related = event.relatedTarget;
      if (related instanceof Node && row.contains(related)) return;
      if (this.dropIntent?.targetRelativePath === entry.relativePath) {
        this.clearDropVisuals();
      }
    });
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const source = this.dragRelativePath ?? event.dataTransfer?.getData('text/plain');
      const intent = this.dropIntent;
      this.clearDropVisuals();
      if (!source || source === entry.relativePath) return;
      const mode = intent?.targetRelativePath === entry.relativePath
        ? intent.mode
        : this.resolveDropMode(entry, event.clientY, row);
      void this.handleDrop(source, entry, mode);
    });
  }

  private resolveDropMode(
    entry: WorkspaceExplorerEntry,
    clientY: number,
    row: HTMLElement,
  ): 'before' | 'into' {
    const rect = row.getBoundingClientRect();
    return resolveWorkspaceTreeDropMode(entry.kind, clientY, rect.top, rect.height);
  }

  private updateDropIntent(row: HTMLElement, entry: WorkspaceExplorerEntry, clientY: number): void {
    const mode = this.resolveDropMode(entry, clientY, row);
    this.dropIntent = { mode, targetRelativePath: entry.relativePath };
    this.renderDropVisuals(row, mode);
  }

  private renderDropVisuals(row: HTMLElement, mode: 'before' | 'into'): void {
    this.container.querySelectorAll('.workspace-entry.is-drop-into').forEach((node) => {
      node.classList.remove('is-drop-into');
    });
    if (!this.dropIndicator) {
      this.dropIndicator = document.createElement('div');
      this.dropIndicator.className = 'workspace-drop-indicator';
      this.container.appendChild(this.dropIndicator);
    }

    if (mode === 'into') {
      this.dropIndicator.classList.remove('is-visible');
      row.classList.add('is-drop-into');
      return;
    }

    row.classList.remove('is-drop-into');
    const tree = this.container.querySelector('.workspace-tree');
    const containerRect = this.container.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const left = (tree?.getBoundingClientRect().left ?? rowRect.left) - containerRect.left;
    const width = tree?.clientWidth ?? rowRect.width;
    const top = rowRect.top - containerRect.top - 1;
    this.dropIndicator.style.left = `${Math.max(0, left + 8)}px`;
    this.dropIndicator.style.width = `${Math.max(40, width - 16)}px`;
    this.dropIndicator.style.top = `${top}px`;
    this.dropIndicator.classList.add('is-visible');
  }

  private clearDropVisuals(): void {
    this.dropIntent = null;
    this.container.querySelectorAll('.workspace-entry.is-drop-into, .workspace-entry.is-drop-target').forEach((node) => {
      node.classList.remove('is-drop-into', 'is-drop-target');
    });
    if (this.dropIndicator) this.dropIndicator.classList.remove('is-visible');
  }

  private async ensureCustomSort(): Promise<boolean> {
    if (this.sortMode === 'custom') return true;
    const result = await this.requestOp((requestId) => ({
      type: 'setSortMode',
      requestId,
      sortMode: 'custom',
    }));
    if (!result.ok) {
      this.showError(result.message);
      return false;
    }
    if (result.sort) this.applySortConfig(result.sort);
    else this.sortMode = 'custom';
    return true;
  }

  private async handleDrop(
    sourceRelativePath: string,
    target: WorkspaceExplorerEntry,
    mode: 'before' | 'into',
  ): Promise<void> {
    const sourceParent = parentRelativePath(sourceRelativePath);
    const sourceName = sourceRelativePath.split('/').at(-1)!;
    const targetParent = parentRelativePath(target.relativePath);

    if (mode === 'into' && target.kind === 'directory') {
      if (
        sourceRelativePath === target.relativePath
        || target.relativePath.startsWith(`${sourceRelativePath}/`)
      ) {
        this.showError('Cannot move a folder into itself or its descendants.');
        return;
      }
      if (sourceParent === target.relativePath) return;
      const moveResult = await this.requestOp((requestId) => ({
        type: 'move',
        requestId,
        relativePath: sourceRelativePath,
        targetParentRelativePath: target.relativePath,
      }));
      if (!moveResult.ok) {
        this.showError(moveResult.message);
        return;
      }
      if (!(await this.ensureCustomSort())) return;
      const movedName = moveResult.entry?.name ?? sourceName;
      const siblings = (this.entriesByDirectory.get(target.relativePath) ?? [])
        .map((entry) => entry.name)
        .filter((name) => name !== sourceName && name !== movedName);
      siblings.push(movedName);
      const reorderResult = await this.requestOp((requestId) => ({
        type: 'reorder',
        requestId,
        parentRelativePath: target.relativePath,
        movedName,
        siblingNames: siblings,
      }));
      if (!reorderResult.ok) {
        this.showError(reorderResult.message);
        return;
      }
      this.expanded.add(target.relativePath);
      this.post({ type: 'setExpanded', relativePath: target.relativePath, expanded: true });
      await Promise.all([
        this.loadDirectory(sourceParent),
        this.loadDirectory(target.relativePath),
      ]);
      return;
    }

    if (sourceParent === targetParent) {
      await this.reorderBefore(sourceParent, sourceName, target.name);
      return;
    }

    const moveResult = await this.requestOp((requestId) => ({
      type: 'move',
      requestId,
      relativePath: sourceRelativePath,
      targetParentRelativePath: targetParent,
    }));
    if (!moveResult.ok) {
      this.showError(moveResult.message);
      return;
    }
    if (!(await this.ensureCustomSort())) return;
    const movedName = moveResult.entry?.name ?? sourceName;
    const siblings = (this.entriesByDirectory.get(targetParent) ?? []).map((entry) => entry.name);
    if (!siblings.includes(movedName)) siblings.push(movedName);
    const reorderResult = await this.requestOp((requestId) => ({
      type: 'reorder',
      requestId,
      parentRelativePath: targetParent,
      movedName,
      siblingNames: siblings,
      beforeName: target.name,
    }));
    if (!reorderResult.ok) {
      this.showError(reorderResult.message);
      return;
    }
    await Promise.all([
      this.loadDirectory(sourceParent),
      this.loadDirectory(targetParent),
    ]);
  }

  private async reorderBefore(
    parentRelativePathValue: string,
    movedName: string,
    beforeName: string,
  ): Promise<void> {
    if (!(await this.ensureCustomSort())) return;
    if (movedName === beforeName) return;
    const siblings = (this.entriesByDirectory.get(parentRelativePathValue) ?? []).map((entry) => entry.name);
    const result = await this.requestOp((requestId) => ({
      type: 'reorder',
      requestId,
      parentRelativePath: parentRelativePathValue,
      movedName,
      siblingNames: siblings,
      beforeName,
    }));
    if (!result.ok) {
      this.showError(result.message);
      return;
    }
    await this.loadDirectory(parentRelativePathValue);
  }
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function parentRelativePath(value: string): string {
  const normalized = normalizeRelativePath(value);
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '' : normalized.slice(0, index);
}

function selectFileName(input: HTMLInputElement): void {
  const dot = input.value.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
}
