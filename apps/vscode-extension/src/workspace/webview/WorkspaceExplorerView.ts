import { TimelinePanel } from '@easyview/editor-core/timeline';
import {
  WorkspaceSearchPanel,
  openWorkspaceSettingsDialog,
  openFolderIconPicker,
  type WorkspaceSettingsDialogHandle,
  type WorkspaceSettingsValues,
} from '@easyview/editor-core/workspace';
import type { TimelineClient, WorkspaceSearchResult } from '@easyview/contracts';
import {
  describeWorkspaceEntryTimestamps,
  formatWorkspaceSize,
  getCustomFolderIcon,
  setCustomFolderIcon,
  getFolderIconDefinition,
  type FolderIconTheme,
  type FolderIconVariant,
  filterWorkspaceEntriesByDotVisibility,
  normalizeWorkspaceViewRelativePath as normalizeRelativePath,
  parentOfWorkspaceViewRelativePath as parentRelativePath,
  collectVisibleWorkspaceTreeRelativePaths,
  computeNextWorkspaceTreeSelection,
  resolveWorkspaceTreeKeyAction,
  resolveWorkspaceTreeDropTarget,
  resolveWorkspaceTreeRowDropZone,
  workspaceTreeDepthFromPointer,
  workspaceTreeDropLineOffset,
  workspaceTreeGapBeforeName,
  isExternalWorkspaceFileDrag,
  collectWorkspaceExternalDropSources,
  resolveWorkspaceTreeIcon,
  type WorkspaceTreeDropTarget,
  workspaceEntryNameSelectionRange,
  type WorkspaceTreeSortMode,
  clampWorkspaceFontSizeOffset,
  WORKSPACE_CREATABLE_FILE_TYPES,
  unusedWorkspaceCreateFileName,
  unusedWorkspaceCreateFolderName,
  type WorkspaceCreatableFileTypeId,
} from '@easyview/contracts';
import type {
  WorkspaceExplorerEntry,
  WorkspaceExplorerEvent,
  WorkspaceExplorerRequest,
  WorkspaceExplorerSortConfig,
} from './workspace-explorer-messages';
import { tExplorer } from './workspaceExplorer.i18n';

export interface WorkspaceExplorerVsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
}

type PendingOpResolve = (result: Extract<WorkspaceExplorerEvent, { type: 'opResult' }>) => void;
type PendingListResolve = (result: Extract<WorkspaceExplorerEvent, { type: 'listChildrenResult' }>) => void;
const DIRECTORY_LOAD_TIMEOUT_MS = 8_000;

interface ContextMenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  /** When set, item opens a flyout instead of running action. */
  submenu?: ContextMenuItem[];
  action: () => void;
}

type WorkspaceDisplayMode = 'list' | 'icons';
interface SavedDisplayState {
  displayMode?: WorkspaceDisplayMode;
  iconDirectory?: string;
  rootUri?: string | null;
  fontSizeOffset?: number;
  showNameHover?: boolean;
}

function isClipped(element: HTMLElement): boolean {
  return element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;
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
  private timeline?: TimelinePanel;
  setTimelineVisible(visible: boolean): void { this.timeline?.setVisible(visible); }
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
  private showSize = false;
  private showSizeHover = false;
  private sizeRequests = new Map<string, Promise<number | undefined>>();
  private showCreatedAt = false;
  private showUpdatedAt = false;
  private showDotEntries = true;
  private showTimestampHover = true;
  private showNameHover = true;
  private pendingCreate: { parentRelativePath: string; kind: 'file' | 'directory'; extension?: string; draftName?: string } | null = null;
  private renamePath: string | null = null;
  private settingsDialog: WorkspaceSettingsDialogHandle | null = null;
  private settingsQueue: Promise<void> = Promise.resolve();
  private fontSizeOffset = 0;
  private searchOpen = false;
  private searchPanel: WorkspaceSearchPanel | null = null;
  private readonly pendingSearches = new Map<string, (result: WorkspaceSearchResult | null) => void>();
  private dragRelativePath: string | null = null;
  private dropIntent: { targetRelativePath: string; target: WorkspaceTreeDropTarget } | null = null;
  private dropIndicator: HTMLElement | null = null;
  private contextMenuEl: HTMLElement | null = null;
  private typeMenuEl: HTMLElement | null = null;
  private contextSubmenuEl: HTMLElement | null = null;
  private contextSubmenuOwner: HTMLButtonElement | null = null;
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
    if (this.contextSubmenuEl?.contains(event.target)) return;
    if (this.typeMenuEl?.contains(event.target)) return;
    this.closeContextMenu();
  };
  private readonly handleContextMenuPointerMove = (event: PointerEvent): void => {
    const menu = this.contextMenuEl;
    if (!menu) return;
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const hovered = hit?.closest<HTMLButtonElement>('button');
    if (hovered && hovered !== this.contextSubmenuOwner && menu.contains(hovered)) this.closeContextSubmenu();
    for (const button of menu.querySelectorAll<HTMLButtonElement>(':scope > button')) {
      const active = button === hovered || button === this.contextSubmenuOwner;
      button.classList.toggle('is-hovered', active && !button.disabled);
    }
  };

  constructor(
    private readonly container: HTMLElement,
    private readonly vscodeApi: WorkspaceExplorerVsCodeApi,
    timelineClient?: TimelineClient,
  ) {
    if (timelineClient) this.timeline = new TimelinePanel(timelineClient);
    const saved = this.vscodeApi.getState() as SavedDisplayState | undefined;
    if (saved?.displayMode === 'icons') this.displayMode = 'icons';
    this.fontSizeOffset = clampWorkspaceFontSizeOffset(saved?.fontSizeOffset);
    this.showNameHover = saved?.showNameHover !== false;
    this.applyFontSizeOffset();
    this.container.classList.add('workspace-explorer');
    this.container.tabIndex = 0;
    // Capture so Enter on a focused name <button> renames instead of activating click.
    this.container.addEventListener('keydown', this.handleKeyDown, true);
    this.container.addEventListener('dragover', this.handleContainerDragOver);
    this.container.addEventListener('dragleave', this.handleContainerDragLeave);
    this.container.addEventListener('drop', this.handleContainerDrop);
    // The webview host steals OS file drags on any dragenter that is not default-prevented.
    document.addEventListener('dragenter', this.handleDocumentDragEnter);
    window.addEventListener('pointerdown', this.handleWindowPointerDown, true);
    this.render();
  }

  dispose(): void {
    this.settingsDialog?.close();
    this.timeline?.dispose();
    this.container.removeEventListener('keydown', this.handleKeyDown, true);
    this.container.removeEventListener('dragover', this.handleContainerDragOver);
    this.container.removeEventListener('dragleave', this.handleContainerDragLeave);
    this.container.removeEventListener('drop', this.handleContainerDrop);
    document.removeEventListener('dragenter', this.handleDocumentDragEnter);
    window.removeEventListener('pointerdown', this.handleWindowPointerDown, true);
    this.closeContextMenu();
    this.hideTimestampTooltip();
    this.timestampTooltipEl?.remove();
    this.timestampTooltipEl = null;
    this.clearDropVisuals();
    this.searchPanel?.dispose();
    this.searchPanel = null;
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
      case 'entriesDeleted':
        this.forgetEntries(event.relativePaths);
        this.render();
        break;
      case 'reveal':
        void this.onReveal(event.relativePath, event.force === true);
        break;
      case 'sortConfig':
        this.applySortConfig(event.sort);
        this.render();
        break;
      case 'clipboardChanged':
        this.hasClipboard = event.hasClipboard;
        break;
      case 'contextCommand':
        void this.onContextCommand(event.command, event.relativePath, event.extension);
        break;
      case 'listChildrenResult': {
        const pending = this.pendingLists.get(event.requestId);
        if (pending) {
          this.pendingLists.delete(event.requestId);
          pending(event);
        }
        break;
      }
      case 'searchResult': {
        const pending = this.pendingSearches.get(event.requestId);
        if (pending) {
          this.pendingSearches.delete(event.requestId);
          pending(event.ok ? { entries: event.entries, truncated: event.truncated } : null);
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
    this.showSize = sort.showSize === true;
    this.showSizeHover = sort.showSizeHover === true;
    this.showCreatedAt = sort.showCreatedAt;
    this.showUpdatedAt = sort.showUpdatedAt;
    this.showDotEntries = sort.showDotEntries !== false;
    this.showTimestampHover = sort.showTimestampHover !== false;
  }

  private saveDisplayState(): void {
    const previous = this.vscodeApi.getState();
    const state = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
    this.vscodeApi.setState({
      ...state,
      displayMode: this.displayMode,
      iconDirectory: this.iconDirectory,
      rootUri: this.rootUri,
      fontSizeOffset: this.fontSizeOffset,
      showNameHover: this.showNameHover,
    });
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
    this.sizeRequests.clear();
    this.entriesByDirectory.clear();
    this.expanded.clear();
    for (const relativePath of event.expandedRelativePaths) this.expanded.add(relativePath);
    this.selected.clear();
    this.anchor = null;
    this.primarySelected = null;
    this.activeRelativePath = null;
    this.selectionFollowsActive = true;
    this.pendingCreate = null;
    this.renamePath = null;
    this.setEditing(false);
    this.settingsDialog?.close();
    this.resetSearch();
    this.render();
    if (this.rootUri !== null || this.rootName !== null) {
      void this.refreshExpanded().then(() => {
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
    this.sizeRequests.clear();
    this.entriesByDirectory.clear();
    this.expanded.clear();
    this.selected.clear();
    this.anchor = null;
    this.primarySelected = null;
    this.activeRelativePath = null;
    this.pendingCreate = null;
    this.renamePath = null;
    this.setEditing(false);
    this.settingsDialog?.close();
    this.resetSearch();
    this.clearDropVisuals();
    this.closeContextMenu();
    this.render();
  }

  private async onFsChanged(relativePaths: string[]): Promise<void> {
    if (!this.hasRoot()) return;
    this.sizeRequests.clear();
    if (this.showSize) this.render();
    if (this.searchOpen) this.searchPanel?.refresh();
    if (this.editing || this.pendingCreate || this.renamePath) return;
    const targets = [...new Set(relativePaths.map(normalizeRelativePath))].filter(
      (value) => value === '' || this.expanded.has(value) || (this.displayMode === 'icons' && value === this.iconDirectory),
    );
    if (targets.length === 0) return;
    await Promise.all(targets.map((relativePath) => this.loadDirectory(relativePath)));
  }

  private async onReveal(relativePath: string, force = false): Promise<void> {
    if (!this.hasRoot() || !relativePath) return;
    if (!force && this.activeRelativePath === relativePath
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
      row?.scrollIntoView({ block: force ? 'center' : 'nearest' });
    });
  }

  private async onContextCommand(
    command: Extract<WorkspaceExplorerEvent, { type: 'contextCommand' }>['command'],
    relativePath?: string,
    extension?: string,
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
      case 'beginCreateFile': {
        const parent = relativePath ?? this.primarySelectedDirectory() ?? (this.displayMode === 'icons' ? this.iconDirectory : '');
        if (extension) this.beginCreate(parent, 'file', extension);
        else this.openNewFileTypeMenuForParent(parent);
        break;
      }
      case 'beginCreateFolder':
        this.beginCreate(relativePath ?? this.primarySelectedDirectory() ?? (this.displayMode === 'icons' ? this.iconDirectory : ''), 'directory');
        break;
      case 'toggleSortMenu':
        if (this.settingsDialog) this.settingsDialog.close();
        else this.openSettings();
        break;
      case 'toggleSearch':
        if (this.searchOpen) this.closeSearch();
        else this.openSearch();
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
    if (!this.primarySelected) return null;
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
        resolve({ type: 'listChildrenResult', requestId, ok: false, relativePath, message: tExplorer('directoryLoadTimeout') });
      }, DIRECTORY_LOAD_TIMEOUT_MS);
      this.pendingLists.set(requestId, (event) => {
        clearTimeout(timer);
        resolve(event);
      });
      this.post({ type: 'listChildren', requestId, relativePath });
    });
    if (revision !== this.rootRevision) return;
    if (!result.ok) {
      if (relativePath === '' && attempt === 0 && result.message === tExplorer('directoryLoadTimeout')) {
        await this.loadDirectory(relativePath, 1);
        return;
      }
      if (relativePath === '') {
        this.rootLoadError = result.message;
        this.render();
      } else if (result.missing) {
        this.forgetEntries([relativePath]);
        this.render();
        return;
      }
      this.showError(result.message);
      return;
    }
    if (relativePath === '') this.rootLoadError = null;
    for (const entry of result.entries) this.sizeRequests.delete(entry.relativePath);
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

  private clearSelection(): void {
    this.selectionFollowsActive = false;
    this.container.focus({ preventScroll: true });
    if (this.selected.size === 0 && this.primarySelected === null) return;
    this.selected.clear();
    this.anchor = null;
    this.primarySelected = null;
    this.post({ type: 'setSelection', relativePaths: [], anchorRelativePath: null });
    this.render();
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
    if (action === 'copyPath' || action === 'copyRelativePath') {
      this.post({ type: action, relativePaths: [...this.selected] });
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
    const scrollTop = previousTree?.scrollTop ?? 0, scrollLeft = previousTree?.scrollLeft ?? 0;
    this.renderTree();
    if (this.timeline) {
      this.container.append(this.timeline.element);
      const tree = this.container.querySelector<HTMLElement>('.workspace-tree');
      if (tree) { tree.scrollTop = scrollTop; tree.scrollLeft = scrollLeft; }
      const selected = this.primarySelected;
      const entry = this.entriesByDirectory.get(selected?.includes('/') ? selected.slice(0, selected.lastIndexOf('/')) : '')?.find((entry) => entry.relativePath === selected);
      this.timeline.setFile(this.hasRoot() && selected && entry?.kind !== 'directory' ? selected : null);
    }
  }

  private renderTree(): void {
    const previousTree = this.container.querySelector<HTMLElement>('.workspace-tree');
    const previousScrollTop = previousTree?.scrollTop ?? 0;
    const previousScrollLeft = previousTree?.scrollLeft ?? 0;
    this.clearDropVisuals();
    this.dropIndicator = null;
    this.hideTimestampTooltip();
    // Window activation refreshes the tree asynchronously. Keep its floating
    // menu interactive while those directory responses rerender the rows.
    // Keep floating sort menu on body (outside overflow:hidden tree) while open.
    const searchFocused = this.searchPanel?.hasFocus() ?? false;
    this.container.replaceChildren();

    if (!this.hasRoot()) {
      this.settingsDialog?.close();
      const empty = document.createElement('div');
      empty.className = 'workspace-empty';
      empty.textContent = tExplorer('noRoot');
      this.container.appendChild(empty);
      return;
    }

    if (!this.entriesByDirectory.has('')) {
      const status = document.createElement('div');
      status.className = 'workspace-empty';
      status.textContent = this.rootLoadError ?? tExplorer('loading');
      if (this.rootLoadError) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = tExplorer('retry');
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

    if (this.searchOpen && this.searchPanel) {
      this.container.appendChild(this.searchPanel.element);
      if (searchFocused) this.searchPanel.focus();
      if (this.searchPanel.hasQuery) return;
    }

    const tree = document.createElement('div');
    tree.className = `workspace-tree${this.displayMode === 'icons' ? ' workspace-icon-view' : ''}`;
    if (this.displayMode === 'icons') {
      tree.appendChild(this.renderIconDirectory());
    } else {
      tree.setAttribute('role', 'tree');
      tree.appendChild(this.renderDirectory('', 0));
    }
    const dropHint = document.createElement('div');
    dropHint.className = 'workspace-drop-hint';
    dropHint.textContent = tExplorer(IS_MAC ? 'dropHint.finder' : 'dropHint.fileExplorer');
    tree.appendChild(dropHint);
    tree.addEventListener('click', (event) => {
      if (event.target instanceof Element
        && event.target.closest('.workspace-entry, .workspace-icon-tile, .workspace-create-row, .workspace-icon-navigation')) return;
      this.clearSelection();
    });
    tree.addEventListener('contextmenu', (event) => {
      if (event.target instanceof Element
        && event.target.closest('.workspace-entry, .workspace-icon-tile, .workspace-create-row, .workspace-icon-navigation')) return;
      event.preventDefault();
      this.selectionFollowsActive = false;
      const parent = this.displayMode === 'icons' ? this.iconDirectory : '';
      void this.openBackgroundContextMenu(event.clientX, event.clientY, parent);
    });
    this.container.appendChild(tree);
    tree.scrollTop = previousScrollTop;
    tree.scrollLeft = previousScrollLeft;
  }

  private openSearch(): void {
    if (!this.hasRoot()) return;
    if (!this.searchPanel) {
      const panel = new WorkspaceSearchPanel({
        search: (query) => this.requestSearch(query),
        onOpen: (entry) => { void this.openSearchResult(entry as WorkspaceExplorerEntry); },
        onClose: () => this.closeSearch(),
        onQueryActiveChange: () => this.render(),
      });
      // VS Code keybindings (Enter → rename, Backspace → delete) must not fire while typing a query.
      panel.element.addEventListener('focusin', () => this.post({ type: 'setInputFocus', focused: true }));
      panel.element.addEventListener('focusout', () => this.post({ type: 'setInputFocus', focused: this.editing }));
      this.searchPanel = panel;
    }
    this.settingsDialog?.close();
    this.searchOpen = true;
    this.render();
    this.searchPanel.focus(true);
  }

  private closeSearch(): void {
    if (!this.searchOpen) return;
    this.resetSearch();
    this.render();
    this.container.focus({ preventScroll: true });
    this.container.querySelector('.workspace-entry.selected')?.scrollIntoView({ block: 'nearest' });
  }

  private resetSearch(): void {
    const hadFocus = this.searchPanel?.hasFocus() ?? false;
    this.searchOpen = false;
    this.searchPanel?.reset();
    for (const resolve of this.pendingSearches.values()) resolve(null);
    this.pendingSearches.clear();
    if (hadFocus) this.post({ type: 'setInputFocus', focused: this.editing });
  }

  private requestSearch(query: string): Promise<WorkspaceSearchResult | null> {
    const requestId = this.nextRequestId();
    return new Promise((resolve) => {
      this.pendingSearches.set(requestId, resolve);
      this.post({ type: 'search', requestId, query });
    });
  }

  private async openSearchResult(entry: WorkspaceExplorerEntry): Promise<void> {
    if (entry.kind !== 'directory') {
      this.post({ type: 'open', relativePath: entry.relativePath });
      return;
    }
    this.closeSearch();
    if (this.displayMode === 'icons') {
      await this.navigateIconDirectory(entry.relativePath);
      return;
    }
    await this.onReveal(entry.relativePath, true);
    if (!this.expanded.has(entry.relativePath)) this.toggleDirectory(entry.relativePath);
  }

  private openSettings(): void {
    if (this.settingsDialog || !this.hasRoot()) return;
    this.settingsDialog = openWorkspaceSettingsDialog({
      values: {
        displayMode: this.displayMode,
        sortMode: this.sortMode,
        showCreatedAt: this.showCreatedAt,
        showUpdatedAt: this.showUpdatedAt,
        showSize: this.showSize,
        showSizeHover: this.showSizeHover,
        showTimestampHover: this.showTimestampHover,
        showNameHover: this.showNameHover,
        showDotEntries: this.showDotEntries,
        fontSizeOffset: this.fontSizeOffset,
      },
      baseFontSize: Math.round(parseFloat(getComputedStyle(document.body).fontSize) || 13),
      onPreview: (values) => this.queueSettings(values),
      onSave: (values) => this.queueSettings(values),
      onClose: () => { this.settingsDialog = null; },
    });
  }

  private queueSettings(values: WorkspaceSettingsValues): void {
    this.settingsQueue = this.settingsQueue.catch(() => undefined).then(() => this.applySettings(values));
  }

  private async applySettings(values: WorkspaceSettingsValues): Promise<void> {
    if (values.fontSizeOffset !== this.fontSizeOffset) this.changeFontSizeOffset(values.fontSizeOffset);
    if (values.showCreatedAt !== this.showCreatedAt) await this.changeShowCreatedAt(values.showCreatedAt);
    if (values.showUpdatedAt !== this.showUpdatedAt) await this.changeShowUpdatedAt(values.showUpdatedAt);
    if (values.showSize !== this.showSize) await this.changeShowSize(values.showSize);
    if (values.showSizeHover !== this.showSizeHover) await this.changeShowSizeHover(values.showSizeHover);
    if (values.showTimestampHover !== this.showTimestampHover) await this.changeShowTimestampHover(values.showTimestampHover);
    if (values.showNameHover !== this.showNameHover) this.changeShowNameHover(values.showNameHover);
    if (values.showDotEntries !== this.showDotEntries) await this.changeShowDotEntries(values.showDotEntries);
    if (values.sortMode !== this.sortMode) await this.changeSortMode(values.sortMode);
    if (values.displayMode !== this.displayMode) await this.changeDisplayMode(values.displayMode);
  }

  private changeFontSizeOffset(offset: number): void {
    this.fontSizeOffset = clampWorkspaceFontSizeOffset(offset);
    this.applyFontSizeOffset();
    this.saveDisplayState();
  }

  private changeShowNameHover(showNameHover: boolean): void {
    this.hideTimestampTooltip();
    this.showNameHover = showNameHover;
    this.saveDisplayState();
  }

  private applyFontSizeOffset(): void {
    document.documentElement.style.setProperty('--workspace-font-offset', `${this.fontSizeOffset}px`);
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
    back.title = tExplorer('icons.back');
    back.setAttribute('aria-label', back.title);
    back.disabled = this.iconDirectory === '';
    back.addEventListener('click', () => { void this.navigateIconDirectory(parentRelativePath(this.iconDirectory)); });
    const pathLabel = document.createElement('span');
    pathLabel.className = 'workspace-icon-path';
    pathLabel.textContent = this.iconDirectory.split('/').at(-1) || this.rootName || tExplorer('icons.rootFallback');
    pathLabel.title = this.iconDirectory || this.rootName || tExplorer('icons.rootFallback');
    navigation.append(back, pathLabel);
    content.appendChild(navigation);

    const grid = document.createElement('div');
    grid.className = 'workspace-icon-grid';
    grid.setAttribute('role', 'grid');
    grid.setAttribute('aria-label', tExplorer('icons.gridLabel', { name: pathLabel.textContent }));
    const entries = filterWorkspaceEntriesByDotVisibility(
      this.entriesByDirectory.get(this.iconDirectory) ?? [], this.showDotEntries,
    );
    if (entries.length === 0 && !this.pendingCreate) {
      const empty = document.createElement('p');
      empty.className = 'workspace-icon-empty';
      empty.textContent = tExplorer('icons.emptyFolder');
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
      
      // Check for custom folder icon
      if (entry.kind === 'directory' && this.rootUri) {
        const customIcon = getCustomFolderIcon(this.rootUri, entry.relativePath);
        if (customIcon) {
          const customDef = getFolderIconDefinition(customIcon.theme, customIcon.variant);
          icon.classList.remove('is-folder');
          icon.classList.add('is-custom-icon');
          icon.innerHTML = customDef.svg;
        }
      } else if (entry.kind !== 'directory') {
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
        tile.appendChild(label);
        this.attachHoverInfo(tile, entry, label);
      }
      this.appendEntryTimestamps(tile, entry);
    this.appendEntrySize(tile, entry);
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
      row.dataset.kind = entry.kind;
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
      
      // Check for custom folder icon
      let iconDesc;
      if (entry.kind === 'directory' && this.rootUri) {
        const customIcon = getCustomFolderIcon(this.rootUri, entry.relativePath);
        if (customIcon) {
          const customDef = getFolderIconDefinition(customIcon.theme, customIcon.variant);
          iconDesc = {
            id: `custom-${customIcon.theme}-${customIcon.variant}`,
            codicon: 'folder',
            color: '#dcb67a',
            svg: customDef.svg,
          };
          icon.classList.add('is-custom-folder-icon');
        } else {
          iconDesc = resolveWorkspaceTreeIcon({
            kind: entry.kind,
            name: entry.name,
            expanded,
          });
        }
      } else {
        iconDesc = resolveWorkspaceTreeIcon({
          kind: entry.kind,
          name: entry.name,
          expanded: entry.kind === 'directory' ? expanded : false,
        });
      }
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
      if (this.renamePath !== entry.relativePath) this.attachHoverInfo(row, entry, name);
      this.appendEntryTimestamps(row, entry);
      this.appendEntrySize(row, entry);
      if (entry.kind === 'directory') {
        const create = document.createElement('button');
        create.type = 'button';
        create.className = 'workspace-entry-create';
        create.textContent = '＋';
        create.title = tExplorer('entry.newFile');
        create.disabled = !entry.writable;
        create.setAttribute('aria-haspopup', 'menu');
        create.addEventListener('click', (event) => {
          event.stopPropagation();
          this.openNewFileTypeMenuAt(create, entry.relativePath);
        });
        row.appendChild(create);
      } else if (this.showCreatedAt || this.showUpdatedAt || this.showSize) {
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

  private getEntrySize(entry: WorkspaceExplorerEntry): Promise<number | undefined> {
    let request = this.sizeRequests.get(entry.relativePath);
    if (!request && entry.kind === 'file' && entry.sizeBytes !== undefined) {
      request = Promise.resolve(entry.sizeBytes);
      this.sizeRequests.set(entry.relativePath, request);
    }
    if (!request) {
      request = this.requestOp((requestId) => ({ type: 'getEntrySize', requestId, relativePath: entry.relativePath })).then((result) => result.ok ? result.sizeBytes : undefined).catch(() => undefined);
      this.sizeRequests.set(entry.relativePath, request);
    }
    return request;
  }

  private appendEntrySize(row: HTMLElement, entry: WorkspaceExplorerEntry): void {
    if (!this.showSize || entry.kind === 'symlink') return;
    const value = document.createElement('span');
    value.className = 'workspace-entry-size';
    row.classList.add('has-timestamps');
    if (entry.kind === 'directory') row.classList.add('has-directory-size');
    let meta = row.querySelector<HTMLElement>('.workspace-entry-timestamps');
    if (!meta) {
      meta = document.createElement('span');
      meta.className = 'workspace-entry-timestamps';
      row.appendChild(meta);
    }
    meta.appendChild(value);
    const request = this.getEntrySize(entry);
    void request.then((size) => {
      if (this.sizeRequests.get(entry.relativePath) === request && size !== undefined) value.textContent = formatWorkspaceSize(size);
    });
  }

  private appendEntryTimestamps(row: HTMLElement, entry: WorkspaceExplorerEntry): void {
    const display = describeWorkspaceEntryTimestamps(entry, {
      showCreatedAt: this.showCreatedAt,
      showUpdatedAt: this.showUpdatedAt,
    });
    if (!display || display.parts.length === 0) return;
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

  /** Shows the full name when `nameBox` clips it, plus timestamps, decided at hover time. */
  private attachHoverInfo(target: HTMLElement, entry: WorkspaceExplorerEntry, nameBox: HTMLElement): void {
    let hovering = false;
    target.addEventListener('pointerenter', (event) => {
      hovering = true;
      const lines: string[] = [];
      if (this.showNameHover && isClipped(nameBox)) lines.push(entry.name);
      const timestamps = this.showTimestampHover ? describeWorkspaceEntryTimestamps(entry)?.title : undefined;
      if (timestamps) lines.push(timestamps);
      if (lines.length > 0) this.showTimestampTooltip(lines.join('\n'), event.clientX, event.clientY);
      if (this.showSizeHover && entry.kind !== 'symlink') {
        const request = this.getEntrySize(entry);
        void request.then((size) => {
          if (!hovering || !target.isConnected || !this.showSizeHover || this.sizeRequests.get(entry.relativePath) !== request || size === undefined) return;
          lines.push(tExplorer('sizeLabel', { size: formatWorkspaceSize(size) }));
          this.showTimestampTooltip(lines.join('\n'), event.clientX, event.clientY);
        });
      }
    });
    target.addEventListener('pointerleave', () => { hovering = false; this.hideTimestampTooltip(); });
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

  private appendSubmenuItem(menu: HTMLElement, item: ContextMenuItem): void {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'workspace-menu-has-submenu';
    button.setAttribute('aria-haspopup', 'menu');
    const label = document.createElement('span');
    label.className = 'workspace-menu-item-label';
    label.textContent = item.label;
    const chevron = document.createElement('span');
    chevron.className = 'workspace-menu-item-chevron';
    chevron.textContent = '›';
    button.append(label, chevron);
    const show = () => {
      if (this.contextSubmenuOwner === button) return;
      this.closeContextSubmenu();
      const sub = document.createElement('div');
      sub.className = 'workspace-file-context-menu workspace-context-submenu';
      sub.setAttribute('role', 'menu');
      for (const child of item.submenu ?? []) {
        this.appendMenuItem(sub, {
          label: child.label,
          onClick: () => {
            this.closeContextMenu();
            child.action();
          },
        });
      }
      document.body.appendChild(sub);
      this.contextSubmenuEl = sub;
      this.contextSubmenuOwner = button;
      const pad = 4;
      const parentRect = button.getBoundingClientRect();
      const { width, height } = sub.getBoundingClientRect();
      let left = parentRect.right - pad;
      let top = parentRect.top;
      if (left + width > window.innerWidth - pad) {
        const flipped = parentRect.left - width + pad;
        if (flipped >= pad) {
          left = flipped;
        } else {
          // Too narrow for either side: hug the right edge and drop below the item so it stays visible.
          left = Math.max(pad, window.innerWidth - width - pad);
          top = parentRect.bottom;
        }
      }
      if (top + height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - height - pad);
      sub.style.left = `${left}px`;
      sub.style.top = `${top}px`;
    };
    button.addEventListener('mouseenter', show);
    button.addEventListener('focus', show);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      show();
    });
    menu.appendChild(button);
  }

  private async openBackgroundContextMenu(x: number, y: number, parentRelativePath: string): Promise<void> {
    this.closeContextMenu();
    const focused = await this.requestOp((requestId) => ({ type: 'focusContextMenu', requestId }));
    if (!focused.ok) {
      this.showError(focused.message);
      return;
    }
    this.container.focus({ preventScroll: true });
    const items: ContextMenuItem[] = [
      {
        label: tExplorer('context.newFile'),
        submenu: this.newFileTypeMenuItems(parentRelativePath),
        action: () => undefined,
      },
      { label: tExplorer('context.newFolder'), action: () => this.beginCreate(parentRelativePath, 'directory') },
    ];
    const menu = document.createElement('div');
    menu.className = 'workspace-file-context-menu';
    menu.setAttribute('role', 'menu');
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    for (const item of items) {
      if (item.submenu && item.submenu.length > 0) this.appendSubmenuItem(menu, item);
      else {
        this.appendMenuItem(menu, {
          label: item.label,
          onClick: () => {
            this.closeContextMenu();
            item.action();
          },
        });
      }
    }
    document.body.appendChild(menu);
    this.contextMenuEl = menu;
    window.addEventListener('pointermove', this.handleContextMenuPointerMove, true);
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${Math.max(0, x - rect.width)}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(0, y - rect.height)}px`;
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
      if (item.submenu && item.submenu.length > 0) {
        this.appendSubmenuItem(menu, item);
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
    this.closeContextSubmenu();
    this.contextMenuEl?.remove();
    this.contextMenuEl = null;
    this.closeTypeMenu();
  }

  private closeContextSubmenu(): void {
    this.contextSubmenuEl?.remove();
    this.contextSubmenuEl = null;
    this.contextSubmenuOwner = null;
  }

  private closeTypeMenu(): void {
    this.typeMenuEl?.remove();
    this.typeMenuEl = null;
  }

  private createTypeLabel(id: WorkspaceCreatableFileTypeId): string {
    switch (id) {
      case 'markdown': return tExplorer('create.type.markdown');
      case 'word': return tExplorer('create.type.word');
      case 'excel': return tExplorer('create.type.excel');
      case 'text': return tExplorer('create.type.text');
    }
  }

  private newFileTypeMenuItems(parentRelativePath: string): ContextMenuItem[] {
    return WORKSPACE_CREATABLE_FILE_TYPES.map((type) => ({
      label: this.createTypeLabel(type.id),
      action: () => this.beginCreate(parentRelativePath, 'file', type.extension),
    }));
  }

  private openNewFileTypeMenuForParent(parentRelativePath: string): void {
    // Host command without a pre-chosen type: show a type menu near the tree top.
    const tree = this.container.querySelector<HTMLElement>('.workspace-tree');
    const rect = (tree ?? this.container).getBoundingClientRect();
    this.openNewFileTypeMenu(parentRelativePath, rect.left + 8, rect.top + 8);
  }

  private openNewFileTypeMenuAt(anchor: HTMLElement, parentRelativePath: string): void {
    const rect = anchor.getBoundingClientRect();
    this.openNewFileTypeMenu(parentRelativePath, rect.left, rect.bottom);
  }

  private openNewFileTypeMenu(parentRelativePath: string, x: number, y: number): void {
    this.closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'workspace-file-context-menu workspace-new-file-type-menu';
    menu.setAttribute('role', 'menu');
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    for (const item of this.newFileTypeMenuItems(parentRelativePath)) {
      this.appendMenuItem(menu, {
        label: item.label,
        onClick: () => {
          this.closeTypeMenu();
          item.action();
        },
      });
    }
    document.body.appendChild(menu);
    this.typeMenuEl = menu;
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${Math.max(0, x - rect.width)}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(0, y - rect.height)}px`;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && menu.contains(event.target)) return;
      this.closeTypeMenu();
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
  }

  private buildContextMenuItems(entry: WorkspaceExplorerEntry): ContextMenuItem[] {
    const writable = entry.writable;
    const isFile = entry.kind === 'file' || entry.kind === 'symlink';
    const items: ContextMenuItem[] = [];

    if (isFile) {
      items.push(
        { label: tExplorer('context.openPreview'), action: () => this.post({ type: 'open', relativePath: entry.relativePath }) },
        { label: tExplorer('context.openWithDefaultApp'), action: () => this.post({ type: 'openExternal', relativePath: entry.relativePath }) },
      );
      if (/\.(pdf|docx|doc)$/i.test(entry.name)) {
        items.push({ label: tExplorer('context.exportToMarkdown'), action: () => this.post({ type: 'convertToMarkdown', relativePath: entry.relativePath }) });
      }
    } else if (writable) {
      items.push(
        {
          label: tExplorer('context.newFile'),
          submenu: this.newFileTypeMenuItems(entry.relativePath),
          action: () => undefined,
        },
        { label: tExplorer('context.newFolder'), action: () => this.beginCreate(entry.relativePath, 'directory') },
      );
    }

    items.push({
      label: /mac|iphone|ipad/i.test(navigator.platform) || (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform === 'macOS'
        ? tExplorer('context.revealInFinder')
        : tExplorer('context.revealInFileExplorer'),
      action: () => this.post({ type: 'revealInOS', relativePath: entry.relativePath }),
    });
    
    if (entry.kind === 'directory') {
      items.push({ label: '---', action: () => undefined });
      items.push({
        label: tExplorer('context.customizeIcon'),
        action: () => this.openIconPicker(entry.relativePath),
      });
    }
    
    items.push({ label: '---', action: () => undefined });

    if (writable) {
      items.push({
        label: tExplorer('context.copy'),
        shortcut: `${modKey()}C`,
        action: () => { void this.copyEntries([...this.selected].length ? [...this.selected] : [entry.relativePath]); },
      });
    }
    items.push({
      label: tExplorer('context.copyFile'),
      action: () => this.post({
        type: 'copyFile',
        relativePaths: [...this.selected].length ? [...this.selected] : [entry.relativePath],
      }),
    });
    items.push({
      label: tExplorer('context.paste'),
      shortcut: `${modKey()}V`,
      disabled: !this.hasClipboard || !writable,
      action: () => { void this.pasteAt(entry.relativePath); },
    });
    items.push(
      {
        label: tExplorer('context.copyPath'),
        shortcut: IS_MAC ? '⌥⌘C' : 'Shift+Alt+C',
        action: () => this.post({
          type: 'copyPath',
          relativePaths: [...this.selected].length ? [...this.selected] : [entry.relativePath],
        }),
      },
      {
        label: tExplorer('context.copyRelativePath'),
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
          label: tExplorer('context.rename'),
          shortcut: 'Enter',
          action: () => this.beginRename(entry.relativePath),
        },
        {
          label: tExplorer('context.delete'),
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

  private openIconPicker(relativePath: string): void {
    if (!this.rootUri) return;
    const rootPath = this.rootUri;
    const current = getCustomFolderIcon(rootPath, relativePath);

    const tabLabels: Record<FolderIconTheme, string> = {
      default: tExplorer('iconTab.default'),
      outline: tExplorer('iconTab.outline'),
      'filled-line': tExplorer('iconTab.filledLine'),
      flat: tExplorer('iconTab.flat'),
      glyph: tExplorer('iconTab.glyph'),
      gradient: tExplorer('iconTab.gradient'),
      macos: tExplorer('iconTab.macos'),
      windows: tExplorer('iconTab.windows'),
      christmas: tExplorer('iconTab.christmas'),
      lunar: tExplorer('iconTab.lunar'),
      valentine: tExplorer('iconTab.valentine'),
    };

    try {
      openFolderIconPicker({
        title: tExplorer('customizeIconTitle'),
        resetLabel: tExplorer('resetIcon'),
        tabLabels,
        layout: 'sections',
        selected: current,
        onSelect: (theme: FolderIconTheme, variant: FolderIconVariant) => {
          // Picking the Default group clears any custom mapping (same as reset).
          if (theme === 'default') setCustomFolderIcon(rootPath, relativePath, null);
          else setCustomFolderIcon(rootPath, relativePath, { theme, variant });
          this.render();
          void this.loadDirectory(parentRelativePath(relativePath));
          if (relativePath === '') void this.refreshExpanded();
        },
        onReset: () => {
          setCustomFolderIcon(rootPath, relativePath, null);
          this.render();
          void this.loadDirectory(parentRelativePath(relativePath));
          if (relativePath === '') void this.refreshExpanded();
        },
        onClose: () => {
          // Dialog closed without selection
        },
      });
    } catch (error) {
      console.error('[EasyView] openFolderIconPicker failed', error);
      this.showError(error instanceof Error ? error.message : String(error));
    }
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
      // Match a normal tree click: selection alone is not enough — open the file.
      if (result.entry.kind !== 'directory') {
        this.post({ type: 'open', relativePath: result.entry.relativePath });
      }
      return;
    }
    await this.loadDirectory(parentRelativePath(relativePath));
  }

  /** Drop removed entries and everything beneath them from local tree state. */
  private forgetEntries(relativePaths: readonly string[]): void {
    const removed = relativePaths.filter(Boolean);
    if (removed.length === 0) return;
    const covers = (value: string | null) => value !== null
      && removed.some((path) => value === path || value.startsWith(`${path}/`));
    for (const value of [...this.expanded]) {
      if (!covers(value)) continue;
      this.expanded.delete(value);
      this.post({ type: 'setExpanded', relativePath: value, expanded: false });
    }
    for (const value of [...this.entriesByDirectory.keys()]) {
      if (covers(value)) this.entriesByDirectory.delete(value);
    }
    let selectionChanged = false;
    for (const value of [...this.selected]) {
      if (covers(value)) {
        this.selected.delete(value);
        selectionChanged = true;
      }
    }
    if (covers(this.primarySelected)) this.primarySelected = null;
    if (covers(this.anchor)) this.anchor = null;
    if (this.displayMode === 'icons' && covers(this.iconDirectory)) {
      const top = removed.find((path) => this.iconDirectory === path || this.iconDirectory.startsWith(`${path}/`))!;
      this.iconDirectory = parentRelativePath(top);
      this.saveDisplayState();
    }
    if (selectionChanged) {
      this.post({ type: 'setSelection', relativePaths: [...this.selected], anchorRelativePath: this.anchor });
    }
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
    this.forgetEntries(unique);
    const parents = [...new Set(unique.map(parentRelativePath))];
    await Promise.all(parents.map((parent) => this.loadDirectory(parent)));
  }

  private beginCreate(parentRelativePathValue: string, kind: 'file' | 'directory', extension?: string): void {
    if (parentRelativePathValue) {
      this.expanded.add(parentRelativePathValue);
      this.post({ type: 'setExpanded', relativePath: parentRelativePathValue, expanded: true });
      void this.loadDirectory(parentRelativePathValue);
    }
    this.renamePath = null;
    const normalizedExt = kind === 'file'
      ? (extension && extension.startsWith('.') ? extension : extension ? `.${extension}` : '.md')
      : undefined;
    this.pendingCreate = { parentRelativePath: parentRelativePathValue, kind, extension: normalizedExt };
    this.setEditing(true);
    this.render();
  }

  private defaultCreateName(kind: 'file' | 'directory', extension?: string): string {
    const existing = (this.entriesByDirectory.get(this.pendingCreate?.parentRelativePath ?? '') ?? []).map((entry) => entry.name);
    if (kind === 'directory') {
      return unusedWorkspaceCreateFolderName(tExplorer('create.defaultFolderName'), existing);
    }
    const ext = extension && extension.startsWith('.') ? extension : `.${extension || 'md'}`;
    return unusedWorkspaceCreateFileName(tExplorer('create.defaultFileStem'), ext, existing);
  }

  private renderCreateInput(depth: number): HTMLElement {
    const wrapper = document.createElement('form');
    wrapper.className = 'workspace-create-row';
    wrapper.style.paddingInlineStart = `${28 + depth * 16}px`;
    const input = document.createElement('input');
    input.autofocus = true;
    const pending = this.pendingCreate;
    input.value = pending
      ? pending.draftName ?? this.defaultCreateName(pending.kind, pending.extension)
      : unusedWorkspaceCreateFileName(tExplorer('create.defaultFileStem'), '.md', []);
    wrapper.appendChild(input);
    let submitting = false;
    const commit = (): void => {
      if (submitting || !pending || this.pendingCreate !== pending) return;
      submitting = true;
      void this.createEntry(pending, input.value);
    };
    wrapper.addEventListener('submit', (event) => {
      event.preventDefault();
      commit();
    });
    input.addEventListener('input', () => {
      if (pending) pending.draftName = input.value;
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
    // Re-rendering (e.g. the parent folder finishing its load) replaces this input, and Chromium
    // blurs a focused node while removing it; only a blur that leaves the input mounted commits.
    input.addEventListener('blur', () => {
      queueMicrotask(() => {
        if (input.isConnected) commit();
      });
    });
    requestAnimationFrame(() => {
      if (!input.isConnected || document.activeElement === input) return;
      input.focus();
      if (pending?.draftName === undefined) input.setSelectionRange(...workspaceEntryNameSelectionRange(input.value));
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
    // Confirming the create name must select AND open (same as clicking an existing file).
    if (result.entry && result.entry.kind !== 'directory') {
      this.post({ type: 'open', relativePath: result.entry.relativePath });
    }
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

  private async changeShowSizeHover(showSizeHover: boolean): Promise<void> {
    this.hideTimestampTooltip();
    const result = await this.requestOp((requestId) => ({ type: 'setShowSizeHover', requestId, showSizeHover }));
    if (!result.ok) { this.showError(result.message); return; }
    if (result.sort) this.applySortConfig(result.sort);
    else this.showSizeHover = showSizeHover;
    this.render();
  }

  private async changeShowSize(showSize: boolean): Promise<void> {
    const result = await this.requestOp((requestId) => ({ type: 'setShowSize', requestId, showSize }));
    if (!result.ok) { this.showError(result.message); return; }
    if (result.sort) this.applySortConfig(result.sort);
    else this.showSize = showSize;
    this.sizeRequests.clear();
    this.render();
  }

  private async changeShowCreatedAt(showCreatedAt: boolean): Promise<void> {
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
      const target = this.resolveDropTarget(row, event, external);
      if (!target) {
        this.clearDropVisuals();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = external ? 'copy' : 'move';
      this.dropIntent = { targetRelativePath: entry.relativePath, target };
      this.renderDropVisuals(target);
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
      const target = intent?.targetRelativePath === entry.relativePath
        ? intent.target
        : this.resolveDropTarget(row, event, external);
      this.clearDropVisuals();
      if (!target) return;
      if (external && event.dataTransfer) {
        void this.importExternalDrop(
          event.dataTransfer,
          target.kind === 'into' ? target.relativePath : target.placement.parentRelativePath,
        );
        return;
      }
      const source = this.dragRelativePath ?? event.dataTransfer?.getData('text/plain');
      if (!source) return;
      void this.handleDrop(source, target);
    });
  }

  private treeRows(): HTMLElement[] {
    return [...this.container.querySelectorAll<HTMLElement>('.workspace-tree .workspace-entry')];
  }

  private resolveDropTarget(row: HTMLElement, event: DragEvent, external: boolean): WorkspaceTreeDropTarget | null {
    const rows = this.treeRows();
    const rect = row.getBoundingClientRect();
    const kind = (row.dataset.kind ?? 'file') as WorkspaceExplorerEntry['kind'];
    return resolveWorkspaceTreeDropTarget({
      rows: rows.map((element) => ({
        relativePath: element.dataset.relativePath ?? '',
        kind: (element.dataset.kind ?? 'file') as WorkspaceExplorerEntry['kind'],
      })),
      index: rows.indexOf(row),
      zone: resolveWorkspaceTreeRowDropZone(kind, event.clientY, rect.top, rect.height),
      pointerDepth: workspaceTreeDepthFromPointer(event.clientX - rect.left),
      draggedRelativePath: external ? null : this.dragRelativePath,
    });
  }

  private renderDropVisuals(target: WorkspaceTreeDropTarget): void {
    this.setRootDropHighlight(false);
    this.container.querySelectorAll('.workspace-entry.is-drop-into').forEach((node) => {
      node.classList.remove('is-drop-into');
    });
    if (!this.dropIndicator) {
      this.dropIndicator = document.createElement('div');
      this.dropIndicator.className = 'workspace-drop-indicator';
      this.container.appendChild(this.dropIndicator);
    }
    const rows = this.treeRows();

    if (target.kind === 'into') {
      this.dropIndicator.classList.remove('is-visible');
      rows.find((element) => element.dataset.relativePath === target.relativePath)?.classList.add('is-drop-into');
      return;
    }

    const lineRow = rows[target.lineRowIndex];
    const tree = this.container.querySelector('.workspace-tree');
    if (!lineRow || !tree) return;
    const containerRect = this.container.getBoundingClientRect();
    const rowRect = lineRow.getBoundingClientRect();
    const treeRect = tree.getBoundingClientRect();
    // The line starts at the target level's indent so the user can see which folder receives the drop.
    const left = rowRect.left - containerRect.left + workspaceTreeDropLineOffset(target.placement.depth);
    const right = treeRect.left - containerRect.left + tree.clientWidth - 8;
    const edge = target.lineEdge === 'top' ? rowRect.top : rowRect.bottom;
    this.dropIndicator.style.left = `${Math.max(0, left)}px`;
    this.dropIndicator.style.width = `${Math.max(24, right - left)}px`;
    this.dropIndicator.style.top = `${edge - containerRect.top - 1}px`;
    this.dropIndicator.classList.add('is-visible');
  }

  private clearDropVisuals(): void {
    this.dropIntent = null;
    this.setRootDropHighlight(false);
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

  private readonly handleDocumentDragEnter = (event: DragEvent): void => {
    if (!this.hasRoot() || !isExternalWorkspaceFileDrag(event.dataTransfer, this.dragRelativePath !== null)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };

  private readonly handleContainerDragOver = (event: DragEvent): void => {
    if (!this.hasRoot() || !isExternalWorkspaceFileDrag(event.dataTransfer, this.dragRelativePath !== null)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    if (this.displayMode === 'list') {
      this.clearDropVisuals();
      this.setRootDropHighlight(true);
    }
  };

  private readonly handleContainerDragLeave = (event: DragEvent): void => {
    const related = event.relatedTarget;
    if (related instanceof Node && this.container.contains(related)) return;
    this.clearDropVisuals();
  };

  private readonly handleContainerDrop = (event: DragEvent): void => {
    if (!this.hasRoot() || !event.dataTransfer) return;
    if (!isExternalWorkspaceFileDrag(event.dataTransfer, this.dragRelativePath !== null)) return;
    event.preventDefault();
    this.clearDropVisuals();
    void this.importExternalDrop(event.dataTransfer, this.displayMode === 'icons' ? this.iconDirectory : '');
  };

  private setRootDropHighlight(active: boolean): void {
    this.container.querySelector('.workspace-tree')?.classList.toggle('is-drop-root', active);
  }

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
    dropTarget: WorkspaceTreeDropTarget,
  ): Promise<void> {
    const sourceParent = parentRelativePath(sourceRelativePath);
    const sourceName = sourceRelativePath.split('/').at(-1)!;

    if (dropTarget.kind === 'into') {
      const target = { relativePath: dropTarget.relativePath };
      if (
        sourceRelativePath === target.relativePath
        || target.relativePath.startsWith(`${sourceRelativePath}/`)
      ) {
        this.showError(tExplorer('move.intoSelf'));
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

    const { placement } = dropTarget;
    const targetParent = placement.parentRelativePath;
    const siblingNames = (this.entriesByDirectory.get(targetParent) ?? []).map((entry) => entry.name);
    const beforeName = workspaceTreeGapBeforeName(placement, siblingNames);
    if (sourceParent === targetParent) {
      await this.reorderBefore(sourceParent, sourceName, beforeName);
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
    const siblings = [...siblingNames];
    if (!siblings.includes(movedName)) siblings.push(movedName);
    const reorderResult = await this.requestOp((requestId) => ({
      type: 'reorder',
      requestId,
      parentRelativePath: targetParent,
      movedName,
      siblingNames: siblings,
      beforeName,
    }));
    if (!reorderResult.ok) {
      this.showError(reorderResult.message);
      return;
    }
    if (targetParent && !this.expanded.has(targetParent)) {
      this.expanded.add(targetParent);
      this.post({ type: 'setExpanded', relativePath: targetParent, expanded: true });
    }
    await Promise.all([
      this.loadDirectory(sourceParent),
      this.loadDirectory(targetParent),
    ]);
  }

  private async reorderBefore(
    parentRelativePathValue: string,
    movedName: string,
    /** Undefined appends to the end of the folder. */
    beforeName: string | undefined,
  ): Promise<void> {
    if (movedName === beforeName) return;
    const siblings = (this.entriesByDirectory.get(parentRelativePathValue) ?? []).map((entry) => entry.name);
    // Dropping right after itself (or at the end while already last) keeps the current order.
    const index = siblings.indexOf(movedName);
    if (index >= 0 && siblings[index + 1] === beforeName) return;
    if (!(await this.ensureCustomSort())) return;
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
