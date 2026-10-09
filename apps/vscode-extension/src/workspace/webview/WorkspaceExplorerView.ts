import {
  describeWorkspaceEntryTimestamps,
  filterWorkspaceEntriesByDotVisibility,
  normalizeWorkspaceViewRelativePath as normalizeRelativePath,
  parentOfWorkspaceViewRelativePath as parentRelativePath,
  collectVisibleWorkspaceTreeRelativePaths,
  computeNextWorkspaceTreeSelection,
  resolveWorkspaceTreeKeyAction,
  resolveWorkspaceTreeDropMode,
  isExternalWorkspaceFileDrag,
  collectWorkspaceExternalDropSources,
  workspaceTreeDropParentRelativePath,
  resolveWorkspaceTreeIcon,
  workspaceEntryNameSelectionRange,
  WORKSPACE_TREE_SORT_MODE_LABELS as SORT_MODE_LABELS,
  WORKSPACE_TREE_SORT_MODE_ICONS as SORT_MODE_ICONS,
  workspaceTreeMenuIconSvg,
  type WorkspaceTreeMenuIconId,
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

type PendingOpResolve = (result: Extract<WorkspaceExplorerEvent, { type: 'opResult' }>) => void;
type PendingListResolve = (result: Extract<WorkspaceExplorerEvent, { type: 'listChildrenResult' }>) => void;
const DIRECTORY_LOAD_TIMEOUT_MS = 8_000;
const DIRECTORY_LOAD_TIMEOUT_MESSAGE = 'Directory loading timed out.';

interface ContextMenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  action: () => void;
}

type WorkspaceDisplayMode = 'list' | 'icons';
interface SavedDisplayState { displayMode?: WorkspaceDisplayMode; iconDirectory?: string; rootUri?: string | null }

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
  private rootRevision = 0;
  private rootLoadError: string | null = null;
  private readonly entriesByDirectory = new Map<string, WorkspaceExplorerEntry[]>();
  private readonly expanded = new Set<string>();
  private readonly selected = new Set<string>();
  private anchor: string | null = null;
  private primarySelected: string | null = null;
  private sortMode: WorkspaceTreeSortMode = 'name';
  private displayMode: WorkspaceDisplayMode = 'list';
  private iconDirectory = '';
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
  private readonly handleContextMenuPointerMove = (event: PointerEvent): void => {
    const menu = this.contextMenuEl;
    if (!menu) return;
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const hovered = hit?.closest<HTMLButtonElement>('button');
    for (const button of menu.querySelectorAll<HTMLButtonElement>(':scope > button')) {
      button.classList.toggle('is-hovered', button === hovered && !button.disabled);
    }
  };

  constructor(
    private readonly container: HTMLElement,
    private readonly vscodeApi: WorkspaceExplorerVsCodeApi,
  ) {
    const saved = this.vscodeApi.getState() as SavedDisplayState | undefined;
    if (saved?.displayMode === 'icons') this.displayMode = 'icons';
    this.container.classList.add('workspace-explorer');
    this.container.tabIndex = 0;
    // Capture so Enter on a focused name <button> renames instead of activating click.
    this.container.addEventListener('keydown', this.handleKeyDown, true);
    this.container.addEventListener('dragover', this.handleContainerDragOver);
    this.container.addEventListener('drop', this.handleContainerDrop);
    window.addEventListener('pointerdown', this.handleWindowPointerDown, true);
    this.render();
  }

  dispose(): void {
    this.container.removeEventListener('keydown', this.handleKeyDown, true);
    this.container.removeEventListener('dragover', this.handleContainerDragOver);
    this.container.removeEventListener('drop', this.handleContainerDrop);
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

  private saveDisplayState(): void {
    const previous = this.vscodeApi.getState();
    const state = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
    this.vscodeApi.setState({ ...state, displayMode: this.displayMode, iconDirectory: this.iconDirectory, rootUri: this.rootUri });
  }

  private onBootstrap(event: Extract<WorkspaceExplorerEvent, { type: 'bootstrap' }>): void {
    this.rootRevision += 1;
    this.rootName = event.rootName;
    this.rootUri = event.rootUri;
    const saved = this.vscodeApi.getState() as SavedDisplayState | undefined;
    this.iconDirectory = saved?.rootUri === event.rootUri ? normalizeRelativePath(saved?.iconDirectory ?? '') : '';
    this.rootLoadError = null;
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
      void this.loadDirectory('').then(async () => {
        if (this.displayMode === 'icons' && this.iconDirectory) await this.loadDirectory(this.iconDirectory);
        if (event.revealRelativePath) void this.onReveal(event.revealRelativePath);
      });
    }
  }

  private onRootChanged(): void {
    this.rootRevision += 1;
    this.rootName = null;
    this.rootUri = null;
    this.iconDirectory = '';
    this.rootLoadError = null;
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
      (value) => value === '' || this.expanded.has(value) || (this.displayMode === 'icons' && value === this.iconDirectory),
    );
    if (targets.length === 0) return;
    await Promise.all(targets.map((relativePath) => this.loadDirectory(relativePath)));
  }

  private async onReveal(relativePath: string): Promise<void> {
    if (!this.hasRoot() || !relativePath) return;
    if (this.activeRelativePath === relativePath
      && (this.displayMode !== 'icons' || this.iconDirectory === parentRelativePath(relativePath))) return;
    this.activeRelativePath = relativePath;
    if (this.displayMode === 'icons') {
      this.iconDirectory = parentRelativePath(relativePath);
      this.saveDisplayState();
      await this.loadDirectory(this.iconDirectory);
      this.select(relativePath);
      return;
    }
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
        await this.pasteAt(this.primarySelected ?? (this.displayMode === 'icons' ? this.iconDirectory : ''));
        break;
      case 'beginCreateFile':
        this.beginCreate(relativePath ?? this.primarySelectedDirectory() ?? (this.displayMode === 'icons' ? this.iconDirectory : ''), 'file');
        break;
      case 'beginCreateFolder':
        this.beginCreate(relativePath ?? this.primarySelectedDirectory() ?? (this.displayMode === 'icons' ? this.iconDirectory : ''), 'directory');
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

  private async loadDirectory(relativePath: string, attempt = 0): Promise<void> {
    if (!this.hasRoot()) return;
    const revision = this.rootRevision;
    const requestId = this.nextRequestId();
    const result = await new Promise<Extract<WorkspaceExplorerEvent, { type: 'listChildrenResult' }>>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingLists.delete(requestId);
        resolve({ type: 'listChildrenResult', requestId, ok: false, relativePath, message: DIRECTORY_LOAD_TIMEOUT_MESSAGE });
      }, DIRECTORY_LOAD_TIMEOUT_MS);
      this.pendingLists.set(requestId, (event) => {
        clearTimeout(timer);
        resolve(event);
      });
      this.post({ type: 'listChildren', requestId, relativePath });
    });
    if (revision !== this.rootRevision) return;
    if (!result.ok) {
      if (relativePath === '' && attempt === 0 && result.message === DIRECTORY_LOAD_TIMEOUT_MESSAGE) {
        await this.loadDirectory(relativePath, 1);
        return;
      }
      if (relativePath === '') {
        this.rootLoadError = result.message;
        this.render();
      }
      this.showError(result.message);
      return;
    }
    if (relativePath === '') this.rootLoadError = null;
    this.entriesByDirectory.set(result.relativePath, result.entries);
    this.render();
  }

  private async refreshExpanded(): Promise<void> {
    if (!this.hasRoot()) return;
    await Promise.all([...new Set(['', ...this.expanded, ...(this.displayMode === 'icons' ? [this.iconDirectory] : [])])]
      .map((relativePath) => this.loadDirectory(relativePath)));
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
    rerender = true,
  ): void {
    const next = computeNextWorkspaceTreeSelection(
      { selected: this.selected, anchor: this.anchor },
      {
        target: relativePath,
        visible: this.visibleRelativePaths(),
        shiftKey: Boolean(options?.shiftKey),
        toggleKey: Boolean(options?.metaKey || options?.ctrlKey),
      },
    );
    this.selected.clear();
    for (const path of next.selected) this.selected.add(path);
    this.anchor = next.anchor;
    this.primarySelected = relativePath;
    this.post({
      type: 'setSelection',
      relativePaths: [...this.selected],
      anchorRelativePath: this.anchor,
    });
    if (rerender) this.render();
    else this.container.querySelectorAll<HTMLElement>('.workspace-icon-tile').forEach((tile) => {
      const selected = this.selected.has(tile.dataset.relativePath ?? '');
      tile.classList.toggle('selected', selected);
      tile.setAttribute('aria-selected', String(selected));
    });
    this.container.focus({ preventScroll: true });
  }

  private visibleRelativePaths(): string[] {
    if (this.displayMode === 'icons') {
      return filterWorkspaceEntriesByDotVisibility(this.entriesByDirectory.get(this.iconDirectory) ?? [], this.showDotEntries)
        .map((entry) => entry.relativePath);
    }
    return collectVisibleWorkspaceTreeRelativePaths(this.entriesByDirectory, (path) => this.expanded.has(path));
  }

  private onKeyDown(event: KeyboardEvent): void {
    const action = resolveWorkspaceTreeKeyAction(event, {
      targetIsEditable: event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement,
      hasSelection: this.selected.size > 0,
      hasPrimarySelection: this.primarySelected !== null,
    });
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (action === 'rename' && this.primarySelected) {
      this.beginRename(this.primarySelected);
      return;
    }
    if (action === 'copy') {
      void this.copyEntries([...this.selected]);
      return;
    }
    if (action === 'paste') {
      void this.pasteAt(this.primarySelected ?? (this.displayMode === 'icons' ? this.iconDirectory : ''));
      return;
    }
    if (action === 'delete') void this.deleteEntries([...this.selected]);
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
    // Window activation refreshes the tree asynchronously. Keep its floating
    // menu interactive while those directory responses rerender the rows.
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

    if (!this.entriesByDirectory.has('')) {
      const status = document.createElement('div');
      status.className = 'workspace-empty';
      status.textContent = this.rootLoadError ?? 'Loading files...';
      if (this.rootLoadError) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => {
          this.rootLoadError = null;
          this.render();
          void this.loadDirectory('');
        });
        status.appendChild(retry);
      }
      this.container.appendChild(status);
      return;
    }

    const tree = document.createElement('div');
    tree.className = `workspace-tree${this.displayMode === 'icons' ? ' workspace-icon-view' : ''}`;
    if (this.displayMode === 'icons') {
      tree.appendChild(this.renderIconDirectory());
    } else {
      tree.setAttribute('role', 'tree');
      tree.appendChild(this.renderDirectory('', 0));
    }
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

    this.appendSortMenuItem(menu, {
      icon: 'viewList',
      label: 'View as List',
      checked: this.displayMode === 'list',
      onClick: () => { void this.changeDisplayMode('list'); },
    });
    this.appendSortMenuItem(menu, {
      icon: 'viewIcons',
      label: 'View as Icons',
      checked: this.displayMode === 'icons',
      onClick: () => { void this.changeDisplayMode('icons'); },
    });
    const viewSeparator = document.createElement('div');
    viewSeparator.className = 'workspace-sort-menu-separator';
    menu.appendChild(viewSeparator);

    for (const mode of ['created', 'name', 'custom'] as const) {
      this.appendSortMenuItem(menu, {
        icon: SORT_MODE_ICONS[mode],
        label: SORT_MODE_LABELS[mode],
        checked: this.sortMode === mode,
        onClick: () => { void this.changeSortMode(mode); },
      });
    }
    const separator = document.createElement('div');
    separator.className = 'workspace-sort-menu-separator';
    menu.appendChild(separator);
    this.appendSortMenuItem(menu, {
      icon: 'showCreated',
      label: 'Show Created Time',
      checked: this.showCreatedAt,
      onClick: () => { void this.changeShowCreatedAt(!this.showCreatedAt); },
    });
    this.appendSortMenuItem(menu, {
      icon: 'showUpdated',
      label: 'Show Updated Time',
      checked: this.showUpdatedAt,
      onClick: () => { void this.changeShowUpdatedAt(!this.showUpdatedAt); },
    });
    this.appendSortMenuItem(menu, {
      icon: 'showTimeOnHover',
      label: 'Show Time on Hover',
      checked: this.showTimestampHover,
      onClick: () => { void this.changeShowTimestampHover(!this.showTimestampHover); },
    });
    const dotSeparator = document.createElement('div');
    dotSeparator.className = 'workspace-sort-menu-separator';
    menu.appendChild(dotSeparator);
    this.appendSortMenuItem(menu, {
      icon: 'showDotEntries',
      label: 'Show Dotfiles and Folders',
      checked: this.showDotEntries,
      onClick: () => { void this.changeShowDotEntries(!this.showDotEntries); },
    });
    return menu;
  }

  private async navigateIconDirectory(relativePath: string): Promise<void> {
    const scroll = this.container.querySelector<HTMLElement>('.workspace-tree');
    if (scroll) scroll.scrollTop = 0;
    this.iconDirectory = normalizeRelativePath(relativePath);
    this.selected.clear();
    this.anchor = null;
    this.primarySelected = null;
    this.post({ type: 'setSelection', relativePaths: [], anchorRelativePath: null });
    this.saveDisplayState();
    await this.loadDirectory(this.iconDirectory);
  }

  private renderIconDirectory(): HTMLElement {
    const content = document.createElement('div');
    content.className = 'workspace-icon-content';
    const navigation = document.createElement('div');
    navigation.className = 'workspace-icon-navigation';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'workspace-icon-back';
    back.textContent = '‹';
    back.title = 'Back to parent folder';
    back.setAttribute('aria-label', back.title);
    back.disabled = this.iconDirectory === '';
    back.addEventListener('click', () => { void this.navigateIconDirectory(parentRelativePath(this.iconDirectory)); });
    const pathLabel = document.createElement('span');
    pathLabel.className = 'workspace-icon-path';
    pathLabel.textContent = this.iconDirectory.split('/').at(-1) || this.rootName || 'Files';
    pathLabel.title = this.iconDirectory || this.rootName || 'Files';
    navigation.append(back, pathLabel);
    content.appendChild(navigation);

    const grid = document.createElement('div');
    grid.className = 'workspace-icon-grid';
    grid.setAttribute('role', 'grid');
    grid.setAttribute('aria-label', `Files in ${pathLabel.textContent}`);
    const entries = filterWorkspaceEntriesByDotVisibility(
      this.entriesByDirectory.get(this.iconDirectory) ?? [], this.showDotEntries,
    );
    if (entries.length === 0 && !this.pendingCreate) {
      const empty = document.createElement('p');
      empty.className = 'workspace-icon-empty';
      empty.textContent = 'Folder is empty';
      grid.appendChild(empty);
    }
    for (const entry of entries) {
      const tile = document.createElement('div');
      tile.className = 'workspace-icon-tile';
      tile.dataset.relativePath = entry.relativePath;
      tile.tabIndex = 0;
      tile.setAttribute('role', 'gridcell');
      tile.setAttribute('aria-selected', String(this.selected.has(entry.relativePath)));
      tile.classList.toggle('selected', this.selected.has(entry.relativePath));
      const icon = document.createElement('span');
      icon.className = entry.kind === 'directory' ? 'workspace-icon-large is-folder' : 'workspace-icon-large';
      if (entry.kind !== 'directory') {
        const descriptor = resolveWorkspaceTreeIcon({ kind: entry.kind, name: entry.name });
        icon.dataset.icon = descriptor.id;
        icon.innerHTML = descriptor.svg;
      }
      tile.appendChild(icon);
      if (this.renamePath === entry.relativePath) tile.appendChild(this.renderRenameInput(entry));
      else {
        const label = document.createElement('span');
        label.className = 'workspace-icon-label';
        label.textContent = entry.name;
        label.title = entry.name;
        tile.appendChild(label);
      }
      this.appendEntryTimestamps(tile, entry);
      tile.addEventListener('click', (event) => {
        this.selectionFollowsActive = false;
        this.select(entry.relativePath, {
          shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey,
        }, false);
      });
      tile.addEventListener('dblclick', (event) => {
        event.preventDefault();
        if (entry.kind === 'directory') void this.navigateIconDirectory(entry.relativePath);
        else {
          this.selectionFollowsActive = true;
          this.activeRelativePath = entry.relativePath;
          this.post({ type: 'open', relativePath: entry.relativePath });
        }
      });
      tile.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this.selectionFollowsActive = false;
        if (!this.selected.has(entry.relativePath)) this.select(entry.relativePath, undefined, false);
        void this.openContextMenu(event.clientX, event.clientY, entry);
      });
      this.attachIconDragHandlers(tile, entry);
      grid.appendChild(tile);
    }
    if (this.pendingCreate?.parentRelativePath === this.iconDirectory) {
      grid.appendChild(this.renderCreateInput(0));
    }
    grid.addEventListener('dragover', (event) => {
      if (this.dragRelativePath && parentRelativePath(this.dragRelativePath) === this.iconDirectory) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      } else if (isExternalWorkspaceFileDrag(event.dataTransfer, this.dragRelativePath !== null)) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      }
    });
    grid.addEventListener('drop', (event) => {
      if (this.dragRelativePath && parentRelativePath(this.dragRelativePath) === this.iconDirectory) {
        if (event.target instanceof Element && event.target.closest('.workspace-icon-tile')) return;
        event.preventDefault();
        event.stopPropagation();
        void this.reorderIcon(this.dragRelativePath);
      } else if (event.dataTransfer && isExternalWorkspaceFileDrag(event.dataTransfer, false)) {
        event.preventDefault();
        event.stopPropagation();
        void this.importExternalDrop(event.dataTransfer, this.iconDirectory);
      }
    });
    content.appendChild(grid);
    return content;
  }

  private attachIconDragHandlers(tile: HTMLElement, entry: WorkspaceExplorerEntry): void {
    if (!entry.writable) return;
    tile.draggable = true;
    tile.addEventListener('dragstart', (event) => {
      this.dragRelativePath = entry.relativePath;
      event.dataTransfer?.setData('text/plain', entry.relativePath);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      tile.classList.add('is-dragging');
    });
    tile.addEventListener('dragend', () => {
      this.dragRelativePath = null;
      tile.classList.remove('is-dragging');
      this.container.querySelectorAll('.workspace-icon-tile').forEach((item) => item.classList.remove('is-drop-before', 'is-drop-after'));
    });
    tile.addEventListener('dragover', (event) => {
      if (!this.dragRelativePath || this.dragRelativePath === entry.relativePath
        || parentRelativePath(this.dragRelativePath) !== this.iconDirectory) return;
      event.preventDefault();
      event.stopPropagation();
      this.container.querySelectorAll('.workspace-icon-tile').forEach((item) => item.classList.remove('is-drop-before', 'is-drop-after'));
      tile.classList.add(event.clientX < tile.getBoundingClientRect().left + tile.getBoundingClientRect().width / 2
        ? 'is-drop-before' : 'is-drop-after');
    });
    tile.addEventListener('drop', (event) => {
      if (!this.dragRelativePath || this.dragRelativePath === entry.relativePath
        || parentRelativePath(this.dragRelativePath) !== this.iconDirectory) return;
      event.preventDefault();
      event.stopPropagation();
      const after = tile.classList.contains('is-drop-after');
      void this.reorderIcon(this.dragRelativePath, entry.name, after);
    });
  }

  private async reorderIcon(sourceRelativePath: string, targetName?: string, after = false): Promise<void> {
    if (!(await this.ensureCustomSort())) return;
    const siblings = (this.entriesByDirectory.get(this.iconDirectory) ?? []).map((entry) => entry.name);
    const targetIndex = targetName ? siblings.indexOf(targetName) : -1;
    const beforeName = targetIndex < 0 ? undefined : after ? siblings[targetIndex + 1] : targetName;
    const result = await this.requestOp((requestId) => ({
      type: 'reorder', requestId, parentRelativePath: this.iconDirectory,
      movedName: sourceRelativePath.split('/').at(-1)!, siblingNames: siblings, beforeName,
    }));
    if (!result.ok) this.showError(result.message);
    else await this.loadDirectory(this.iconDirectory);
  }

  private async changeDisplayMode(mode: WorkspaceDisplayMode): Promise<void> {
    this.sortMenuOpen = false;
    this.closeSortMenu();
    if (mode === this.displayMode) return;
    this.displayMode = mode;
    if (mode === 'icons') {
      this.iconDirectory = this.primarySelectedDirectory() ?? '';
      if (this.primarySelected && parentRelativePath(this.primarySelected) !== this.iconDirectory) {
        this.selected.clear();
        this.primarySelected = null;
        this.anchor = null;
        this.post({ type: 'setSelection', relativePaths: [], anchorRelativePath: null });
      }
      this.saveDisplayState();
      await this.loadDirectory(this.iconDirectory);
    } else {
      this.saveDisplayState();
      const segments = this.iconDirectory.split('/').filter(Boolean);
      for (let index = 1; index <= segments.length; index += 1) {
        const path = segments.slice(0, index).join('/');
        if (!this.expanded.has(path)) {
          this.expanded.add(path);
          this.post({ type: 'setExpanded', relativePath: path, expanded: true });
        }
      }
      await this.refreshExpanded();
    }
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
      row.classList.toggle('selected', this.selected.has(entry.relativePath));
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-selected', String(this.selected.has(entry.relativePath)));
      const expanded = entry.kind === 'directory' && this.expanded.has(entry.relativePath);
      if (entry.kind === 'directory') row.setAttribute('aria-expanded', String(expanded));

      // Inputs must not be nested in buttons: Space keyup activates the parent
      // button, selecting/rerendering the row and committing the input on blur.
      const name: HTMLElement = document.createElement(this.renamePath === entry.relativePath ? 'div' : 'button');
      if (name instanceof HTMLButtonElement) name.type = 'button';
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
        void this.openContextMenu(event.clientX, event.clientY, entry);
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
    options: { icon: WorkspaceTreeMenuIconId; label: string; checked: boolean; onClick: () => void },
  ): void {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'workspace-sort-menu-item';
    button.setAttribute('role', 'menuitemcheckbox');
    button.setAttribute('aria-checked', String(options.checked));
    const icon = document.createElement('span');
    icon.className = 'workspace-menu-item-icon';
    icon.innerHTML = workspaceTreeMenuIconSvg(options.icon);
    button.appendChild(icon);
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

  private async openContextMenu(x: number, y: number, entry: WorkspaceExplorerEntry): Promise<void> {
    this.closeContextMenu();
    const focused = await this.requestOp((requestId) => ({ type: 'focusContextMenu', requestId }));
    if (!focused.ok) {
      this.showError(focused.message);
      return;
    }
    this.container.focus({ preventScroll: true });
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
    window.addEventListener('pointermove', this.handleContextMenuPointerMove, true);
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${Math.max(0, x - rect.width)}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(0, y - rect.height)}px`;
  }

  private closeContextMenu(): void {
    window.removeEventListener('pointermove', this.handleContextMenuPointerMove, true);
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
      if (/\.(pdf|docx|doc)$/i.test(entry.name)) {
        items.push({ label: 'Export to Markdown (.md)', action: () => this.post({ type: 'convertToMarkdown', relativePath: entry.relativePath }) });
      }
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
      input.setSelectionRange(...workspaceEntryNameSelectionRange(input.value));
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
    this.renamePath = null;
    const result = await this.requestOp((requestId) => ({
      type: 'rename',
      requestId,
      relativePath,
      newName: trimmed,
    }));
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
      const external = isExternalWorkspaceFileDrag(event.dataTransfer, this.dragRelativePath !== null);
      if (!external && (!this.dragRelativePath || this.dragRelativePath === entry.relativePath)) return;
      if (
        !external
        && entry.kind === 'directory'
        && (
          this.dragRelativePath === entry.relativePath
          || entry.relativePath.startsWith(`${this.dragRelativePath}/`)
        )
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = external ? 'copy' : 'move';
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
      const external = isExternalWorkspaceFileDrag(event.dataTransfer, this.dragRelativePath !== null);
      const intent = this.dropIntent;
      const mode = intent?.targetRelativePath === entry.relativePath
        ? intent.mode
        : this.resolveDropMode(entry, event.clientY, row);
      this.clearDropVisuals();
      if (external && event.dataTransfer) {
        void this.importExternalDrop(event.dataTransfer, workspaceTreeDropParentRelativePath(entry, mode));
        return;
      }
      const source = this.dragRelativePath ?? event.dataTransfer?.getData('text/plain');
      if (!source || source === entry.relativePath) return;
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

  private readonly handleContainerDragOver = (event: DragEvent): void => {
    if (!this.hasRoot() || !isExternalWorkspaceFileDrag(event.dataTransfer, this.dragRelativePath !== null)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };

  private readonly handleContainerDrop = (event: DragEvent): void => {
    if (!this.hasRoot() || !event.dataTransfer) return;
    if (!isExternalWorkspaceFileDrag(event.dataTransfer, this.dragRelativePath !== null)) return;
    event.preventDefault();
    this.clearDropVisuals();
    void this.importExternalDrop(event.dataTransfer, '');
  };

  private async importExternalDrop(dataTransfer: DataTransfer, targetParentRelativePath: string): Promise<void> {
    const sources = await collectWorkspaceExternalDropSources(dataTransfer);
    const items = sources.items.map((item) => ({
      kind: item.kind,
      relativePath: item.relativePath,
      ...(item.bytes ? { dataBase64: bytesToBase64(item.bytes) } : {}),
    }));
    if (sources.sourceUris.length === 0 && items.length === 0) return;
    const result = await this.requestOp((requestId) => ({
      type: 'importExternal',
      requestId,
      targetParentRelativePath,
      sourceUris: sources.sourceUris,
      items,
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
    }
    if (targetParentRelativePath && !this.expanded.has(targetParentRelativePath)) {
      this.expanded.add(targetParentRelativePath);
      this.post({ type: 'setExpanded', relativePath: targetParentRelativePath, expanded: true });
    }
    await this.loadDirectory(targetParentRelativePath);
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
