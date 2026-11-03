import {
  WorkspaceSearchPanel,
  WORKSPACE_SEARCH_ICON_SVG,
  maxPanelWidth,
  openWorkspaceSettingsDialog,
  openFolderIconPicker,
  type WorkspaceSettingsDialogHandle,
  type WorkspaceSettingsValues,
} from '@easyview/editor-core/workspace';
import {
  getCustomFolderIcon,
  setCustomFolderIcon,
  getFolderIconDefinition,
  type FolderIconTheme,
  type FolderIconVariant,
} from '@easyview/contracts';
import type {
  DesktopExplorerDisplayMode,
  DesktopPanelLayout,
  DesktopWorkspaceState,
  WorkspaceEntry,
  WorkspaceTreeSortMode,
} from '../../contracts';
import { DOCK_GRIP_ICON_SVG } from '../panelDock';
import type { EasyViewDesktopApi } from '../../preload/desktopApi';
import {
  describeWorkspaceEntryTimestamps,
  formatWorkspaceSize,
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
  clampWorkspaceFontSizeOffset,
  unusedWorkspaceCreateFileName,
  unusedWorkspaceCreateFolderName,
} from '@easyview/contracts';
import { tExplorer } from './workspaceExplorer.i18n';

const WORKSPACE_SETTINGS_ICON_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="2"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.13 1.13M11.47 11.47l1.13 1.13M3.4 12.6l1.13-1.13M11.47 4.53l1.13-1.13"/><circle cx="8" cy="8" r="4.6"/></svg>';
const WORKSPACE_NEW_FILE_ICON_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11"/></svg>';
const WORKSPACE_NEW_FOLDER_ICON_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.75 4.25a1 1 0 0 1 1-1h3.1l1.4 1.5h5.98a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z"/><path d="M8 7.4v3.7M6.15 9.25h3.7"/></svg>';
const WORKSPACE_REFRESH_ICON_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.46-3.54"/><path d="M11.8 1.8v2.9H8.9"/></svg>';

const FONT_SIZE_OFFSET_KEY = 'easyview.workspace.fontSizeOffset';
/** Must match the base `--workspace-font-size` in desktop.css. */
const DESKTOP_TREE_FONT_SIZE = 16;

const SHOW_NAME_HOVER_KEY = 'easyview.workspace.showNameHover';

function readFontSizeOffset(): number {
  try { return clampWorkspaceFontSizeOffset(Number(localStorage.getItem(FONT_SIZE_OFFSET_KEY))); } catch { return 0; }
}

function readShowNameHover(): boolean {
  try { return localStorage.getItem(SHOW_NAME_HOVER_KEY) !== 'false'; } catch { return true; }
}

function isClipped(element: HTMLElement): boolean {
  return element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;
}

interface WorkspaceExplorerOptions {
  footer?: HTMLElement;
  onSelectionChanged?(filePath: string | null, visible: boolean): void;
  api: EasyViewDesktopApi;
  container: HTMLElement;
  onStateChange(state: DesktopWorkspaceState): void;
  onOpenFile(relativePath: string): Promise<boolean>;
  onOpenWithDefaultApp(relativePath: string): void;
  onRevealInFolder(relativePath: string): void;
}

const FOLDER_TREE_ICON_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 1.75v9a1.25 1.25 0 0 0 1.25 1.25H7.5M2.5 3.25a1.25 1.25 0 0 0 1.25 1.25H7.5"/><path d="M8.5 1.75h1.6l1 1.1h2.15a1 1 0 0 1 1 1v2.4a1 1 0 0 1-1 1H8.5a1 1 0 0 1-1-1v-3.5a1 1 0 0 1 1-1z"/><path d="M8.5 9.25h1.6l1 1.1h2.15a1 1 0 0 1 1 1v2.4a1 1 0 0 1-1 1H8.5a1 1 0 0 1-1-1v-3.5a1 1 0 0 1 1-1z"/></svg>';

export class WorkspaceExplorer {
  private state: DesktopWorkspaceState | null = null;
  private readonly entriesByDirectory = new Map<string, WorkspaceEntry[]>();
  private pendingCreate: { parentRelativePath: string; kind: 'file' | 'directory'; extension?: string; draftName?: string } | null = null;
  private renameRelativePath: string | null = null;
  private selectedRelativePath: string | null = null;
  private selectedRelativePaths = new Set<string>();
  private selectionAnchorRelativePath: string | null = null;
  private resizing = false;
  private readonly subscriptions: Array<{ unsubscribe(): void }> = [];
  private activeRelativePath: string | null = null;
  /** When true, selection tracks the active tab. User tree clicks turn this off until the tab changes. */
  private selectionFollowsActive = true;
  private sortMode: WorkspaceTreeSortMode = 'name';
  private showSize = false;
  private showSizeHover = false;
  private sizeRequests = new Map<string, Promise<number | undefined>>();
  private showCreatedAt = false;
  private showUpdatedAt = false;
  private showDotEntries = true;
  private showTimestampHover = true;
  private showNameHover = readShowNameHover();
  private settingsDialog: WorkspaceSettingsDialogHandle | null = null;
  private settingsQueue: Promise<void> = Promise.resolve();
  private fontSizeOffset = readFontSizeOffset();
  private searchOpen = false;
  private searchPanel: WorkspaceSearchPanel | null = null;
  private timestampTooltipEl: HTMLElement | null = null;
  private dragRelativePath: string | null = null;
  private dropIndicator: HTMLElement | null = null;
  private dropHoverExpandTimer: number | undefined;
  private dropIntent: { targetRelativePath: string; target: WorkspaceTreeDropTarget } | null = null;

  constructor(private readonly options: WorkspaceExplorerOptions) {}

  private get displayMode(): DesktopExplorerDisplayMode {
    return this.state?.explorerDisplayMode ?? 'list';
  }

  private get iconDirectory(): string {
    return this.state?.explorerIconDirectory ?? '';
  }

  /** Folder that root-level actions (new file, paste, external drop) target in the current view. */
  private get currentDirectory(): string {
    return this.displayMode === 'icons' ? this.iconDirectory : '';
  }

  async initialize(): Promise<DesktopWorkspaceState> {
    const result = await this.options.api.workspace.getState();
    if (!result.ok) throw new Error(result.message);
    this.state = result.value;
    this.activeRelativePath = null;
    this.selectionFollowsActive = true;
    this.subscriptions.push(this.options.api.workspace.onChanged((paths) => { void this.refreshChanged(paths); }));
    this.subscriptions.push(this.options.api.workspace.onRootChanged((next) => { void this.applyOpenedRoot(next); }));
    this.subscriptions.push(this.options.api.workspace.onContextCommand((command, relativePath, detail) => {
      this.selectionFollowsActive = false;
      if (command === 'beginCreateFile') {
        this.beginCreate(relativePath, 'file', detail);
        return;
      }
      if (command === 'beginCreateFolder') {
        this.beginCreate(relativePath, 'directory');
        return;
      }
      if (command === 'customizeIcon') {
        this.openIconPicker(relativePath);
        return;
      }
      if (command === 'paste') {
        void this.loadDirectory(parentRelativePath(relativePath));
        return;
      }
      if (relativePath) this.select(relativePath);
      if (command === 'rename') this.beginRename(relativePath);
    }));
    this.options.container.tabIndex = 0;
    this.options.container.addEventListener('keydown', this.handleKeyDown);
    this.options.container.addEventListener('dragover', this.handleContainerDragOver);
    this.options.container.addEventListener('drop', this.handleContainerDrop);
    this.render();
    if (this.state.rootPath) {
      await this.loadSortMode();
      await this.refreshExpanded();
    }
    return this.state;
  }

  dispose(): void {
    this.settingsDialog?.close();
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    this.options.container.removeEventListener('keydown', this.handleKeyDown);
    this.options.container.removeEventListener('dragover', this.handleContainerDragOver);
    this.options.container.removeEventListener('drop', this.handleContainerDrop);
    this.hideTimestampTooltip();
    this.timestampTooltipEl?.remove();
    this.timestampTooltipEl = null;
    this.searchPanel?.dispose();
    this.searchPanel = null;
  }

  toggle(): void {
    if (!this.state) return;
    if (!this.state.rootPath) { void this.openFolder(); return; }
    this.updateState({ explorerVisible: !this.state.explorerVisible });
  }

  async openFolder(): Promise<boolean> {
    const result = await this.options.api.workspace.openFolder();
    if (!result.ok || !result.value) return false;
    await this.applyOpenedRoot(result.value);
    return true;
  }

  async openRecentFolder(folderPath: string): Promise<boolean> {
    const result = await this.options.api.workspace.openRecentFolder(folderPath);
    if (!result.ok) { window.alert(result.message); return false; }
    if (!result.value) return false;
    await this.applyOpenedRoot(result.value);
    return true;
  }

  /** Both the IPC reply and the `rootChanged` broadcast land here; only the first one reloads. */
  private async applyOpenedRoot(next: DesktopWorkspaceState): Promise<void> {
    if (this.state?.rootPath === next.rootPath) {
      if (this.state.explorerVisible !== next.explorerVisible) this.updateState({ explorerVisible: next.explorerVisible });
      return;
    }
    this.state = next;
    this.activeRelativePath = null;
    this.selectionFollowsActive = true;
    this.selectedRelativePath = null;
    this.selectedRelativePaths.clear();
    this.selectionAnchorRelativePath = null;
    this.entriesByDirectory.clear();
    this.sizeRequests.clear();
    this.pendingCreate = null;
    this.renameRelativePath = null;
    this.searchOpen = false;
    this.searchPanel?.reset();
    this.render();
    this.options.onStateChange(next);
    await this.loadSortMode();
    await this.refreshExpanded();
  }

  setOutlineVisible(visible: boolean): void {
    if (this.state?.outlineVisible !== visible) this.updateState({ outlineVisible: visible });
  }

  /** Panel layout rides on the explorer's state so its whole-state saves never overwrite it. */
  setVersionGuardState(visible: boolean, width: number): void {
    this.updateState({ versionGuardVisible: visible, versionGuardWidth: width });
  }

  setAiChatVisible(visible: boolean): void {
    if (this.state && (this.state.aiChatVisible === true) !== visible) this.updateState({ aiChatVisible: visible });
  }

  setPanelLayout(layout: DesktopPanelLayout): void {
    this.updateState({ panelLayout: layout });
  }

  setActiveDocument(filePath: string | null): void { this.setActiveRelativePath(this.relativePathFor(filePath)); }

  setActiveRelativePath(relativePath: string | null): void {
    if (!this.state) return;
    const changed = this.activeRelativePath !== relativePath;
    if (!changed) {
      // Same open file: never yank selection back while the user is browsing the tree.
      return;
    }

    this.activeRelativePath = relativePath;
    // Switching the active tab resumes follow-mode (default lock to the visible tab).
    this.selectionFollowsActive = true;
    if (relativePath && this.displayMode === 'icons') {
      void this.showInIconDirectory(relativePath);
    } else if (relativePath) {
      this.select(relativePath);
      const expanded = new Set(this.state.expandedRelativePaths);
      const segments = relativePath.split('/');
      segments.pop();
      for (let index = 1; index <= segments.length; index += 1) {
        expanded.add(segments.slice(0, index).join('/'));
      }
      this.updateState({ expandedRelativePaths: [...expanded] });
      void this.refreshChanged([...expanded, '']);
    } else {
      this.selectedRelativePath = null;
      this.selectedRelativePaths.clear();
      this.selectionAnchorRelativePath = null;
      this.render();
    }
  }

  /** Reveal in IndexArea: open the panel, expand parents, select and scroll to the node. */
  async revealRelativePath(relativePath: string): Promise<void> {
    if (!this.state?.rootPath) return;
    if (this.displayMode === 'icons') {
      if (!this.state.explorerVisible) this.updateState({ explorerVisible: true });
      this.selectionFollowsActive = true;
      await this.showInIconDirectory(relativePath);
      return;
    }
    const expanded = new Set(this.state.expandedRelativePaths);
    const segments = relativePath.split('/');
    segments.pop();
    const parents: string[] = [];
    for (let index = 1; index <= segments.length; index += 1) parents.push(segments.slice(0, index).join('/'));
    parents.forEach((parent) => expanded.add(parent));
    this.updateState({ explorerVisible: true, expandedRelativePaths: [...expanded] });
    await Promise.all(['', ...parents].map((parent) => this.loadDirectory(parent)));
    this.selectionFollowsActive = true;
    this.select(relativePath);
    const row = [...this.options.container.querySelectorAll<HTMLElement>('.workspace-entry')]
      .find((element) => element.dataset.relativePath === relativePath);
    row?.scrollIntoView({ block: 'center' });
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.target instanceof Element && event.target.closest('.easyview-timeline')) return;
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f'
      && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) {
      event.preventDefault();
      this.openSearch();
      return;
    }
    const action = resolveWorkspaceTreeKeyAction(event, {
      targetIsEditable: event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement,
      hasSelection: this.selectedRelativePaths.size > 0,
      hasPrimarySelection: this.selectedRelativePath !== null,
    });
    if (!action) return;
    event.preventDefault();
    if (action === 'rename' && this.selectedRelativePath) {
      this.beginRename(this.selectedRelativePath);
      return;
    }
    if (action === 'copy' && this.selectedRelativePaths.size > 0) {
      void this.options.api.workspace.copyClipboard(this.orderedSelection());
      return;
    }
    if (action === 'copyPath' || action === 'copyRelativePath') {
      void this.copySelectionPaths(action === 'copyPath' ? 'absolutePath' : 'relativePath');
      return;
    }
    if (action === 'paste') {
      void this.pasteEntry(this.selectedRelativePath ?? this.currentDirectory);
      return;
    }
    if (action === 'delete') void this.deleteEntries([...this.selectedRelativePaths]);
  };

  private async copySelectionPaths(field: 'absolutePath' | 'relativePath'): Promise<void> {
    const results = await Promise.all(this.orderedSelection().map((relativePath) => this.options.api.workspace.getResourcePaths(relativePath)));
    const paths = results.flatMap((result) => (result.ok ? [result.value[field]] : []));
    if (paths.length > 0) await this.options.api.clipboard.writeText(paths.join('\n'));
  }

  private async pasteEntry(targetRelativePath: string): Promise<void> {
    const result = await this.options.api.workspace.pasteClipboard({ targetRelativePath });
    if (!result.ok) return;
    this.selectedRelativePath = result.value.relativePath;
    await this.refreshChanged([parentRelativePath(result.value.relativePath)]);
    this.render();
  }

  private async loadDirectory(relativePath: string): Promise<void> {
    if (!this.state?.rootPath) return;
    const result = await this.options.api.workspace.readDirectory(relativePath);
    if (!result.ok) {
      if (relativePath && relativePath === this.currentDirectory) await this.navigateIconDirectory(parentRelativePath(relativePath));
      return;
    }
    for (const entry of result.value) this.sizeRequests.delete(entry.relativePath);
    this.entriesByDirectory.set(relativePath, result.value);
    this.render();
  }

  private async refreshChanged(relativeDirectories: string[] | null): Promise<void> {
    if (!this.state?.rootPath) return;
    this.sizeRequests.clear();
    if (this.showSize) this.render();
    if (this.searchOpen) this.searchPanel?.refresh();
    if (relativeDirectories === null) {
      this.entriesByDirectory.clear();
      await this.refreshExpanded();
      return;
    }
    const expanded = new Set(['', this.currentDirectory, ...this.state.expandedRelativePaths]);
    const targets = [...new Set(relativeDirectories.map(normalizeRelativePath))].filter((value) => expanded.has(value));
    await Promise.all(targets.map((relativePath) => this.loadDirectory(relativePath)));
  }

  private async refreshExpanded(): Promise<void> {
    if (!this.state?.rootPath) return;
    const directories = new Set(['', this.currentDirectory, ...this.state.expandedRelativePaths]);
    await Promise.all([...directories].map((relativePath) => this.loadDirectory(relativePath)));
  }

  private toggleDirectory(relativePath: string): void {
    if (!this.state) return;
    const expanded = new Set(this.state.expandedRelativePaths);
    if (expanded.has(relativePath)) expanded.delete(relativePath);
    else expanded.add(relativePath);
    this.updateState({ expandedRelativePaths: [...expanded] });
    if (expanded.has(relativePath)) void this.loadDirectory(relativePath);
  }

  private select(
    relativePath: string,
    options?: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean },
  ): void {
    const next = computeNextWorkspaceTreeSelection(
      { selected: this.selectedRelativePaths, anchor: this.selectionAnchorRelativePath },
      {
        target: relativePath,
        visible: this.visibleRelativePaths(),
        shiftKey: Boolean(options?.shiftKey),
        toggleKey: Boolean(options?.metaKey || options?.ctrlKey),
      },
    );
    this.selectedRelativePaths = new Set(next.selected);
    this.selectionAnchorRelativePath = next.anchor;
    this.selectedRelativePath = relativePath;
    this.options.container.focus({ preventScroll: true });
    this.render();
  }

  private visibleRelativePaths(): string[] {
    if (this.displayMode === 'icons') {
      return filterWorkspaceEntriesByDotVisibility(this.entriesByDirectory.get(this.iconDirectory) ?? [], this.showDotEntries)
        .map((entry) => entry.relativePath);
    }
    const expanded = new Set(this.state?.expandedRelativePaths ?? []);
    return collectVisibleWorkspaceTreeRelativePaths(this.entriesByDirectory, (path) => expanded.has(path));
  }

  /** Selection in on-screen order, so copied paths read top to bottom. */
  private orderedSelection(): string[] {
    const visible = this.visibleRelativePaths().filter((path) => this.selectedRelativePaths.has(path));
    return [...visible, ...[...this.selectedRelativePaths].filter((path) => !visible.includes(path))];
  }

  private updateState(patch: Partial<DesktopWorkspaceState>): void {
    if (!this.state) return;
    this.state = { ...this.state, ...patch };
    this.render();
    this.options.onStateChange(this.state);
    void this.options.api.workspace.setState(this.state);
  }

  private render(): void {
    const previousTree = this.options.container.querySelector<HTMLElement>('.workspace-tree');
    const scrollTop = previousTree?.scrollTop ?? 0, scrollLeft = previousTree?.scrollLeft ?? 0;
    this.renderTree();
    if (this.options.footer) this.options.container.append(this.options.footer);
    const tree = this.options.container.querySelector<HTMLElement>('.workspace-tree');
    if (tree) { tree.scrollTop = scrollTop; tree.scrollLeft = scrollLeft; }
    const relative = this.selectedRelativePath;
    const entry = this.entriesByDirectory.get(relative ? parentRelativePath(relative) : '')?.find((entry) => entry.relativePath === relative);
    this.options.onSelectionChanged?.(this.state?.rootPath && relative && entry?.kind !== 'directory' ? `${this.state.rootPath}/${relative}` : null, this.state?.explorerVisible ?? false);
  }

  private renderTree(): void {
    const { container } = this.options;
    const state = this.state;
    const previousTree = container.querySelector<HTMLElement>('.workspace-tree');
    const previousScrollTop = previousTree?.scrollTop ?? 0;
    const previousScrollLeft = previousTree?.scrollLeft ?? 0;
    this.clearDropVisuals();
    this.dropIndicator = null;
    this.hideTimestampTooltip();
    container.classList.toggle('is-hidden', !state?.explorerVisible);
    document.documentElement.style.setProperty('--workspace-font-offset', `${this.fontSizeOffset}px`);
    if (state) container.style.width = `${state.explorerWidth}px`;
    const searchFocused = this.searchPanel?.hasFocus() ?? false;
    container.replaceChildren();
    if (!state?.rootPath) {
      const empty = document.createElement('button');
      empty.type = 'button'; empty.className = 'workspace-empty'; empty.textContent = tExplorer('openFolder');
      empty.addEventListener('click', () => { void this.openFolder(); });
      container.appendChild(empty);
      return;
    }

    const header = document.createElement('div');
    header.className = 'workspace-header';
    const grip = document.createElement('span');
    grip.className = 'workspace-dock-grip';
    grip.dataset.dockGrip = 'explorer';
    grip.title = tExplorer('dragToDock');
    grip.innerHTML = DOCK_GRIP_ICON_SVG;
    header.appendChild(grip);
    const panelIcon = document.createElement('span');
    panelIcon.className = 'workspace-header-icon';
    panelIcon.title = tExplorer('panelTitle');
    panelIcon.setAttribute('role', 'img');
    panelIcon.setAttribute('aria-label', tExplorer('panelTitle'));
    panelIcon.innerHTML = FOLDER_TREE_ICON_SVG;
    header.appendChild(panelIcon);
    const title = document.createElement('span');
    title.className = 'workspace-header-title';
    title.textContent = state.rootPath.split(/[\\/]/).at(-1) || state.rootPath;
    title.title = state.rootPath;
    header.appendChild(title);
    const searchButton = document.createElement('button');
    searchButton.type = 'button';
    searchButton.className = 'workspace-action workspace-search-toggle';
    searchButton.classList.toggle('is-active', this.searchOpen);
    searchButton.title = tExplorer('search');
    searchButton.setAttribute('aria-pressed', String(this.searchOpen));
    searchButton.innerHTML = WORKSPACE_SEARCH_ICON_SVG;
    searchButton.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.searchOpen) this.closeSearch();
      else this.openSearch();
    });
    header.appendChild(searchButton);
    const settingsButton = document.createElement('button');
    settingsButton.type = 'button';
    settingsButton.className = 'workspace-action workspace-settings-toggle';
    settingsButton.classList.toggle('is-active', this.settingsDialog !== null);
    settingsButton.title = tExplorer('settings');
    settingsButton.setAttribute('aria-haspopup', 'dialog');
    settingsButton.setAttribute('aria-expanded', String(this.settingsDialog !== null));
    settingsButton.innerHTML = WORKSPACE_SETTINGS_ICON_SVG;
    settingsButton.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.settingsDialog) this.settingsDialog.close();
      else this.openSettings();
    });
    const newFileButton = document.createElement('button');
    newFileButton.type = 'button';
    newFileButton.className = 'workspace-action';
    newFileButton.innerHTML = WORKSPACE_NEW_FILE_ICON_SVG;
    newFileButton.title = tExplorer('newFile');
    newFileButton.setAttribute('aria-haspopup', 'menu');
    newFileButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.popupNewFileTypes(this.currentDirectory, newFileButton);
    });
    header.appendChild(newFileButton);
    for (const [iconSvg, titleText, action] of [
      [WORKSPACE_NEW_FOLDER_ICON_SVG, tExplorer('newFolder'), () => this.beginCreate(this.currentDirectory, 'directory')],
      [WORKSPACE_REFRESH_ICON_SVG, tExplorer('refresh'), () => { this.entriesByDirectory.clear(); void this.refreshExpanded(); }],
    ] as const) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'workspace-action';
      button.innerHTML = iconSvg; button.title = titleText;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        action();
      });
      header.appendChild(button);
    }
    header.appendChild(settingsButton);
    container.appendChild(header);

    if (this.searchOpen && this.searchPanel) {
      container.appendChild(this.searchPanel.element);
      if (searchFocused) this.searchPanel.focus();
      if (this.searchPanel.hasQuery) {
        this.appendResizer(container);
        return;
      }
    }

    const tree = document.createElement('div');
    tree.className = 'workspace-tree';
    if (this.displayMode === 'icons') {
      tree.classList.add('workspace-icon-view');
      tree.appendChild(this.renderIconDirectory());
    } else {
      tree.setAttribute('role', 'tree');
      tree.appendChild(this.renderDirectory('', 0));
    }
    tree.addEventListener('click', (event) => {
      if (event.target instanceof Element
        && event.target.closest('.workspace-entry, .workspace-create-row, .workspace-icon-tile, .workspace-icon-navigation')) return;
      this.selectionFollowsActive = false;
      this.options.container.focus({ preventScroll: true });
      if (this.selectedRelativePaths.size === 0 && this.selectedRelativePath === null) return;
      this.selectedRelativePath = null;
      this.selectedRelativePaths.clear();
      this.selectionAnchorRelativePath = null;
      this.render();
    });
    tree.addEventListener('contextmenu', (event) => {
      if (event.target instanceof Element
        && event.target.closest('.workspace-entry, .workspace-icon-tile, .workspace-create-row, .workspace-icon-navigation')) return;
      event.preventDefault();
      this.selectionFollowsActive = false;
      void this.options.api.workspace.showContextMenu(this.currentDirectory, 'directory', []);
    });
    container.appendChild(tree);
    tree.scrollTop = previousScrollTop;
    tree.scrollLeft = previousScrollLeft;
    this.appendResizer(container);
  }

  private openSettings(): void {
    if (this.settingsDialog || !this.state?.rootPath) return;
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
      baseFontSize: DESKTOP_TREE_FONT_SIZE,
      onPreview: (values) => this.queueSettings(values),
      onSave: (values) => this.queueSettings(values),
      onClose: () => {
        this.settingsDialog = null;
        this.render();
      },
    });
    this.render();
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
    try { localStorage.setItem(FONT_SIZE_OFFSET_KEY, String(this.fontSizeOffset)); } catch { /* storage unavailable */ }
    this.render();
  }

  private changeShowNameHover(showNameHover: boolean): void {
    this.hideTimestampTooltip();
    this.showNameHover = showNameHover;
    try { localStorage.setItem(SHOW_NAME_HOVER_KEY, String(showNameHover)); } catch { /* storage unavailable */ }
  }

  private appendResizer(container: HTMLElement): void {
    const resizer = document.createElement('div');
    resizer.className = 'workspace-resizer';
    resizer.addEventListener('pointerdown', (event) => this.beginResize(event));
    container.appendChild(resizer);
  }

  openSearch(): void {
    if (!this.state?.rootPath) return;
    this.searchPanel ??= new WorkspaceSearchPanel({
      search: async (query) => {
        const result = await this.options.api.workspace.search(query);
        return result.ok ? result.value : null;
      },
      onOpen: (entry) => { void this.openSearchResult(entry); },
      onClose: () => this.closeSearch(),
      onQueryActiveChange: () => this.render(),
    });
    this.settingsDialog?.close();
    if (!this.state.explorerVisible) this.updateState({ explorerVisible: true });
    this.searchOpen = true;
    this.render();
    this.searchPanel.focus(true);
  }

  private closeSearch(): void {
    if (!this.searchOpen) return;
    this.searchOpen = false;
    this.searchPanel?.reset();
    this.render();
    this.options.container.focus({ preventScroll: true });
    this.options.container.querySelector('.workspace-entry.selected')?.scrollIntoView({ block: 'nearest' });
  }

  private async openSearchResult(entry: WorkspaceEntry): Promise<void> {
    if (entry.kind === 'directory') {
      this.closeSearch();
      if (this.displayMode === 'icons') {
        await this.navigateIconDirectory(entry.relativePath);
        return;
      }
      await this.revealRelativePath(entry.relativePath);
      if (!this.state?.expandedRelativePaths.includes(entry.relativePath)) this.toggleDirectory(entry.relativePath);
      return;
    }
    const opened = await this.options.onOpenFile(entry.relativePath);
    if (!opened) return;
    this.selectionFollowsActive = true;
    this.setActiveRelativePath(entry.relativePath);
  }

  private async changeDisplayMode(mode: DesktopExplorerDisplayMode): Promise<void> {
    if (!this.state || mode === this.displayMode) {
      this.render();
      return;
    }
    if (mode === 'icons') {
      const directory = this.selectedDirectory();
      if (this.selectedRelativePath && parentRelativePath(this.selectedRelativePath) !== directory) this.clearSelection();
      this.updateState({ explorerDisplayMode: 'icons', explorerIconDirectory: directory });
      await this.loadDirectory(directory);
      return;
    }
    const expanded = new Set(this.state.expandedRelativePaths);
    const segments = this.iconDirectory.split('/').filter(Boolean);
    for (let index = 1; index <= segments.length; index += 1) expanded.add(segments.slice(0, index).join('/'));
    this.updateState({ explorerDisplayMode: 'list', expandedRelativePaths: [...expanded] });
    await this.refreshExpanded();
  }

  /** The selected folder, or the folder holding the selected file. */
  private selectedDirectory(): string {
    const selected = this.selectedRelativePath;
    if (!selected) return '';
    const parent = parentRelativePath(selected);
    const entry = this.entriesByDirectory.get(parent)?.find((item) => item.relativePath === selected);
    return entry?.kind === 'directory' ? selected : parent;
  }

  private clearSelection(): void {
    this.selectedRelativePath = null;
    this.selectedRelativePaths.clear();
    this.selectionAnchorRelativePath = null;
  }

  private async navigateIconDirectory(relativePath: string): Promise<void> {
    const tree = this.options.container.querySelector<HTMLElement>('.workspace-tree');
    if (tree) tree.scrollTop = 0;
    this.clearSelection();
    this.pendingCreate = null;
    this.renameRelativePath = null;
    this.updateState({ explorerIconDirectory: normalizeRelativePath(relativePath) });
    await this.loadDirectory(this.iconDirectory);
  }

  private async showInIconDirectory(relativePath: string): Promise<void> {
    const directory = parentRelativePath(relativePath);
    if (directory !== this.iconDirectory) this.updateState({ explorerIconDirectory: directory });
    await this.loadDirectory(directory);
    this.select(relativePath);
    [...this.options.container.querySelectorAll<HTMLElement>('.workspace-icon-tile')]
      .find((tile) => tile.dataset.relativePath === relativePath)
      ?.scrollIntoView({ block: 'nearest' });
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
    back.title = tExplorer('iconsBack');
    back.setAttribute('aria-label', back.title);
    back.disabled = this.iconDirectory === '';
    back.addEventListener('click', () => { void this.navigateIconDirectory(parentRelativePath(this.iconDirectory)); });
    const rootName = this.state?.rootPath?.split(/[\\/]/).at(-1) || tExplorer('iconsRootFallback');
    const pathLabel = document.createElement('span');
    pathLabel.className = 'workspace-icon-path';
    pathLabel.textContent = this.iconDirectory.split('/').at(-1) || rootName;
    pathLabel.title = this.iconDirectory || rootName;
    navigation.append(back, pathLabel);
    content.appendChild(navigation);

    const grid = document.createElement('div');
    grid.className = 'workspace-icon-grid';
    grid.setAttribute('role', 'grid');
    grid.setAttribute('aria-label', tExplorer('iconsGridLabel', { name: pathLabel.textContent }));
    const entries = filterWorkspaceEntriesByDotVisibility(
      this.entriesByDirectory.get(this.iconDirectory) ?? [],
      this.showDotEntries,
    );
    if (entries.length === 0 && !this.pendingCreate) {
      const empty = document.createElement('p');
      empty.className = 'workspace-icon-empty';
      empty.textContent = tExplorer('iconsEmptyFolder');
      grid.appendChild(empty);
    }
    for (const entry of entries) grid.appendChild(this.renderIconTile(entry));
    if (this.pendingCreate?.parentRelativePath === this.iconDirectory) {
      const create = this.renderCreateInput(0);
      create.style.paddingInlineStart = '';
      grid.appendChild(create);
    }
    grid.addEventListener('dragover', (event) => {
      if (this.dragRelativePath && parentRelativePath(this.dragRelativePath) === this.iconDirectory) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      }
    });
    grid.addEventListener('drop', (event) => {
      if (!this.dragRelativePath || parentRelativePath(this.dragRelativePath) !== this.iconDirectory) return;
      if (event.target instanceof Element && event.target.closest('.workspace-icon-tile')) return;
      event.preventDefault();
      event.stopPropagation();
      void this.reorderBefore(this.iconDirectory, this.dragRelativePath.split('/').at(-1)!, undefined);
    });
    content.appendChild(grid);
    return content;
  }

  private renderIconTile(entry: WorkspaceEntry): HTMLElement {
    const tile = document.createElement('div');
    tile.className = 'workspace-icon-tile';
    tile.dataset.relativePath = entry.relativePath;
    tile.dataset.kind = entry.kind;
    tile.tabIndex = 0;
    tile.setAttribute('role', 'gridcell');
    const selected = this.selectedRelativePaths.has(entry.relativePath);
    tile.setAttribute('aria-selected', String(selected));
    tile.classList.toggle('selected', selected);
    tile.classList.toggle('active', entry.relativePath === this.activeRelativePath);
    const icon = document.createElement('span');
    icon.className = entry.kind === 'directory' ? 'workspace-icon-large is-folder' : 'workspace-icon-large';
    
    // Check for custom folder icon
    if (entry.kind === 'directory' && this.state?.rootPath) {
      const customIcon = getCustomFolderIcon(this.state.rootPath, entry.relativePath);
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
    if (this.renameRelativePath === entry.relativePath) tile.appendChild(this.renderRenameInput(entry));
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
      this.select(entry.relativePath, { shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey });
    });
    tile.addEventListener('dblclick', (event) => {
      event.preventDefault();
      if (entry.kind === 'directory') {
        void this.navigateIconDirectory(entry.relativePath);
        return;
      }
      void this.options.onOpenFile(entry.relativePath).then((opened) => {
        if (!opened) return;
        this.selectionFollowsActive = true;
        this.setActiveRelativePath(entry.relativePath);
      });
    });
    tile.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.selectionFollowsActive = false;
      if (!this.selectedRelativePaths.has(entry.relativePath)) this.select(entry.relativePath);
      void this.options.api.workspace.showContextMenu(entry.relativePath, entry.kind, this.orderedSelection());
    });
    this.attachIconDragHandlers(tile, entry);
    return tile;
  }

  private attachIconDragHandlers(tile: HTMLElement, entry: WorkspaceEntry): void {
    const clearMarkers = () => {
      this.options.container.querySelectorAll('.workspace-icon-tile')
        .forEach((item) => item.classList.remove('is-drop-before', 'is-drop-after'));
    };
    const reorderable = () => Boolean(this.dragRelativePath)
      && this.dragRelativePath !== entry.relativePath
      && parentRelativePath(this.dragRelativePath!) === this.iconDirectory;
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
      clearMarkers();
    });
    tile.addEventListener('dragover', (event) => {
      if (!reorderable()) return;
      event.preventDefault();
      event.stopPropagation();
      clearMarkers();
      const rect = tile.getBoundingClientRect();
      tile.classList.add(event.clientX < rect.left + rect.width / 2 ? 'is-drop-before' : 'is-drop-after');
    });
    tile.addEventListener('drop', (event) => {
      if (!reorderable()) return;
      event.preventDefault();
      event.stopPropagation();
      const siblings = (this.entriesByDirectory.get(this.iconDirectory) ?? []).map((item) => item.name);
      const targetIndex = siblings.indexOf(entry.name);
      const beforeName = tile.classList.contains('is-drop-after') ? siblings[targetIndex + 1] : entry.name;
      clearMarkers();
      void this.reorderBefore(this.iconDirectory, this.dragRelativePath!.split('/').at(-1)!, beforeName);
    });
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
      row.classList.toggle('active', entry.relativePath === this.activeRelativePath);
      row.classList.toggle('selected', this.selectedRelativePaths.has(entry.relativePath));
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-selected', String(this.selectedRelativePaths.has(entry.relativePath)));
      const expanded = entry.kind === 'directory' && Boolean(this.state?.expandedRelativePaths.includes(entry.relativePath));
      if (entry.kind === 'directory') row.setAttribute('aria-expanded', String(expanded));

      const name = document.createElement('button');
      name.type = 'button'; name.className = 'workspace-entry-name';
      const chevron = document.createElement('span');
      chevron.className = 'workspace-chevron';
      if (entry.kind === 'directory') {
        chevron.classList.add('is-directory');
        chevron.classList.toggle('is-expanded', expanded);
      }       const icon = document.createElement('span');
      icon.className = 'workspace-entry-icon';
      
      // Check for custom folder icon
      let iconDesc;
      if (entry.kind === 'directory' && this.state?.rootPath) {
        const customIcon = getCustomFolderIcon(this.state.rootPath, entry.relativePath);
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
      if (this.renameRelativePath === entry.relativePath) name.appendChild(this.renderRenameInput(entry));
      else {
        const label = document.createElement('span'); label.textContent = entry.name; name.appendChild(label);
      }
      name.addEventListener('click', (event) => {
        this.selectionFollowsActive = false;
        this.select(entry.relativePath, {
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
        });
        if (event.shiftKey || event.metaKey || event.ctrlKey) return;
        if (entry.kind === 'directory') this.toggleDirectory(entry.relativePath);
        else {
          void this.options.onOpenFile(entry.relativePath).then((opened) => {
            if (!opened) return;
            // Opening from the tree should lock selection to that file again.
            this.selectionFollowsActive = true;
            this.setActiveRelativePath(entry.relativePath);
          });
        }
      });
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this.selectionFollowsActive = false;
        if (!this.selectedRelativePaths.has(entry.relativePath)) this.select(entry.relativePath);
        void this.options.api.workspace.showContextMenu(entry.relativePath, entry.kind, this.orderedSelection());
      });
      this.attachDragHandlers(row, entry);
      row.appendChild(name);
      if (this.renameRelativePath !== entry.relativePath) this.attachHoverInfo(row, entry, name);
      this.appendEntryTimestamps(row, entry);
      this.appendEntrySize(row, entry);
      if (entry.kind === 'directory') {
        const create = document.createElement('button');
        create.type = 'button'; create.className = 'workspace-entry-create'; create.textContent = '＋'; create.title = tExplorer('newFile');
        create.setAttribute('aria-haspopup', 'menu');
        create.addEventListener('click', (event) => { event.stopPropagation(); this.popupNewFileTypes(entry.relativePath, create); });
        row.appendChild(create);
      } else if (this.showCreatedAt || this.showUpdatedAt || this.showSize) {
        const spacer = document.createElement('span');
        spacer.className = 'workspace-entry-create-spacer';
        row.appendChild(spacer);
      }
      fragment.appendChild(row);
      if (entry.kind === 'directory' && expanded) fragment.appendChild(this.renderDirectory(entry.relativePath, depth + 1));
    }
    if (this.pendingCreate?.parentRelativePath === relativePath) fragment.appendChild(this.renderCreateInput(depth));
    return fragment;
  }

  private getEntrySize(entry: WorkspaceEntry): Promise<number | undefined> {
    let request = this.sizeRequests.get(entry.relativePath);
    if (!request && entry.kind === 'file' && entry.sizeBytes !== undefined) {
      request = Promise.resolve(entry.sizeBytes);
      this.sizeRequests.set(entry.relativePath, request);
    }
    if (!request) {
      request = this.options.api.workspace.getEntrySize(entry.relativePath).then((result) => result.ok ? result.value : undefined).catch(() => undefined);
      this.sizeRequests.set(entry.relativePath, request);
    }
    return request;
  }

  private appendEntrySize(row: HTMLElement, entry: WorkspaceEntry): void {
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

  private appendEntryTimestamps(row: HTMLElement, entry: WorkspaceEntry): void {
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
  private attachHoverInfo(target: HTMLElement, entry: WorkspaceEntry, nameBox: HTMLElement): void {
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

  private openIconPicker(relativePath: string): void {
    if (!this.state?.rootPath) return;
    const rootPath = this.state.rootPath;
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

    openFolderIconPicker({
      title: tExplorer('customizeIconTitle'),
      resetLabel: tExplorer('resetIcon'),
      tabLabels,
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
  }

  private renderRenameInput(entry: WorkspaceEntry): HTMLInputElement {
    const input = document.createElement('input');
    input.className = 'workspace-rename-input';
    input.value = entry.name;
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') { this.renameRelativePath = null; this.render(); }
      if (event.key === 'Enter') { event.preventDefault(); void this.renameEntry(entry.relativePath, input.value); }
    });
    input.addEventListener('blur', () => { if (this.renameRelativePath === entry.relativePath) void this.renameEntry(entry.relativePath, input.value); });
    requestAnimationFrame(() => {
      // Editing may already have started before this frame (focus, select-all, typing).
      // Re-applying the stem selection then would replace only the stem and keep the
      // extension, turning "new.md" into "new.md.md".
      if (!input.isConnected || document.activeElement === input) return;
      input.focus();
      input.setSelectionRange(...workspaceEntryNameSelectionRange(input.value));
    });
    return input;
  }

  private beginRename(relativePath: string): void {
    this.pendingCreate = null;
    this.renameRelativePath = relativePath;
    this.render();
  }

  private async renameEntry(relativePath: string, newName: string): Promise<void> {
    if (this.renameRelativePath !== relativePath) return;
    this.renameRelativePath = null;
    const result = await this.options.api.workspace.rename({ relativePath, newName: newName.trim() });
    if (!result.ok) { window.alert(result.message); this.render(); return; }
    const renamed = result.value;
    this.selectedRelativePaths.delete(relativePath);
    this.selectedRelativePaths.add(renamed.relativePath);
    this.selectedRelativePath = renamed.relativePath;
    this.selectionAnchorRelativePath = renamed.relativePath;
    await this.loadDirectory(parentRelativePath(renamed.relativePath));
    // Match a normal tree click: selection highlight alone is not enough — open the file.
    if (renamed.kind === 'directory') return;
    const opened = await this.options.onOpenFile(renamed.relativePath);
    if (!opened) return;
    this.selectionFollowsActive = true;
    this.setActiveRelativePath(renamed.relativePath);
  }

  private async deleteEntry(relativePath: string): Promise<void> {
    await this.deleteEntries([relativePath]);
  }

  private async deleteEntries(relativePaths: string[]): Promise<void> {
    const unique = [...new Set(relativePaths.filter(Boolean))];
    for (const relativePath of unique) {
      const result = await this.options.api.workspace.delete({ relativePath });
      if (!result.ok && result.code !== 'CANCELLED') window.alert(result.message);
      if (result.ok) {
        this.selectedRelativePaths.delete(relativePath);
        if (this.selectedRelativePath === relativePath) this.selectedRelativePath = null;
        if (this.selectionAnchorRelativePath === relativePath) this.selectionAnchorRelativePath = null;
      }
    }
    this.render();
  }

  private relativePathFor(filePath: string | null): string | null {
    return this.state?.rootPath && filePath ? workspaceRelativePath(this.state.rootPath, filePath) : null;
  }

  private popupNewFileTypes(parentRelativePath: string, anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    void this.options.api.workspace.popupNewFileMenu(parentRelativePath, rect.left, rect.bottom);
  }

  private beginCreate(parentRelativePath: string, kind: 'file' | 'directory', extension?: string): void {
    if (!this.state) return;
    const expanded = new Set(this.state.expandedRelativePaths);
    if (parentRelativePath) expanded.add(parentRelativePath);
    this.renameRelativePath = null;
    const normalizedExt = kind === 'file'
      ? (extension && extension.startsWith('.') ? extension : extension ? `.${extension}` : '.md')
      : undefined;
    this.pendingCreate = { parentRelativePath, kind, extension: normalizedExt };
    this.updateState({ expandedRelativePaths: [...expanded] });
    if (parentRelativePath) void this.loadDirectory(parentRelativePath);
    else this.render();
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
    wrapper.className = 'workspace-create-row'; wrapper.style.paddingInlineStart = `${28 + depth * 16}px`;
    const input = document.createElement('input');
    input.autofocus = true;
    const pending = this.pendingCreate;
    input.value = pending
      ? pending.draftName ?? this.defaultCreateName(pending.kind, pending.extension)
      : unusedWorkspaceCreateFileName(tExplorer('create.defaultFileStem'), '.md', []);
    wrapper.appendChild(input);
    let submitting = false;
    const commit = async (): Promise<void> => {
      if (submitting || !pending || this.pendingCreate !== pending) return;
      submitting = true;
      await this.createEntry(pending, input.value);
      submitting = false;
    };
    wrapper.addEventListener('submit', (event) => { event.preventDefault(); void commit(); });
    input.addEventListener('input', () => { if (pending) pending.draftName = input.value; });
    // Re-rendering (e.g. the parent folder finishing its load) replaces this input, and Chromium
    // blurs a focused node while removing it; only a blur that leaves the input mounted commits.
    input.addEventListener('blur', () => { queueMicrotask(() => { if (input.isConnected) void commit(); }); });
    input.addEventListener('keydown', (event) => { if (event.key === 'Escape') { this.pendingCreate = null; this.render(); } });
    requestAnimationFrame(() => {
      if (!input.isConnected || document.activeElement === input) return;
      input.focus();
      if (pending?.draftName === undefined) input.setSelectionRange(...workspaceEntryNameSelectionRange(input.value));
    });
    return wrapper;
  }

  private async createEntry(pending: NonNullable<WorkspaceExplorer['pendingCreate']>, name: string): Promise<void> {
    const result = await this.options.api.workspace.create({ parentRelativePath: pending.parentRelativePath, name, kind: pending.kind });
    if (!result.ok) { window.alert(result.message); return; }
    this.pendingCreate = null;
    const created = result.value;
    await this.loadDirectory(pending.parentRelativePath);
    // Confirming the create name must select AND open (same as clicking an existing file).
    // Previously only selectedRelativePath was set — tree looked selected without opening preview.
    if (created.kind === 'directory') {
      this.select(created.relativePath);
      return;
    }
    const opened = await this.options.onOpenFile(created.relativePath);
    if (!opened) {
      this.select(created.relativePath);
      return;
    }
    this.selectionFollowsActive = true;
    this.setActiveRelativePath(created.relativePath);
  }

  private beginResize(event: PointerEvent): void {
    if (!this.state) return;
    event.preventDefault(); this.resizing = true; this.options.container.classList.add('resizing');
    const startX = event.clientX;
    const startWidth = this.state.explorerWidth;
    const maxWidth = maxPanelWidth(this.options.container, 220);
    const direction = this.options.container.dataset.dockSide === 'right' ? -1 : 1;
    const onMove = (moveEvent: PointerEvent) => {
      if (!this.resizing) return;
      this.updateState({ explorerWidth: Math.max(220, Math.min(maxWidth, Math.round(startWidth + direction * (moveEvent.clientX - startX)))) });
    };
    const onEnd = () => { this.resizing = false; this.options.container.classList.remove('resizing'); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onEnd); };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onEnd);
  }

  private async loadSortMode(): Promise<void> {
    const [sortResult, createdResult, updatedResult, hoverResult, dotResult, sizeResult, sizeHoverResult] = await Promise.all([
      this.options.api.workspace.getSortMode(),
      this.options.api.workspace.getShowCreatedAt(),
      this.options.api.workspace.getShowUpdatedAt(),
      this.options.api.workspace.getShowTimestampHover(),
      this.options.api.workspace.getShowDotEntries(),
      this.options.api.workspace.getShowSize(),
      this.options.api.workspace.getShowSizeHover(),
    ]);
    if (sortResult.ok) this.sortMode = sortResult.value;
    if (createdResult.ok) this.showCreatedAt = createdResult.value;
    if (updatedResult.ok) this.showUpdatedAt = updatedResult.value;
    if (hoverResult.ok) this.showTimestampHover = hoverResult.value;
    if (dotResult.ok) this.showDotEntries = dotResult.value;
    if (sizeResult.ok) this.showSize = sizeResult.value;
    if (sizeHoverResult.ok) this.showSizeHover = sizeHoverResult.value;
  }

  private async changeSortMode(sortMode: WorkspaceTreeSortMode): Promise<void> {
    if (sortMode === this.sortMode) {
      this.render();
      return;
    }
    const result = await this.options.api.workspace.setSortMode(sortMode);
    if (!result.ok) {
      window.alert(result.message);
      this.render();
      return;
    }
    this.sortMode = result.value;
    this.entriesByDirectory.clear();
    await this.refreshExpanded();
  }

  private async changeShowSizeHover(showSizeHover: boolean): Promise<void> {
    this.hideTimestampTooltip();
    const result = await this.options.api.workspace.setShowSizeHover(showSizeHover);
    if (!result.ok) { window.alert(result.message); return; }
    this.showSizeHover = result.value;
    this.render();
  }

  private async changeShowSize(showSize: boolean): Promise<void> {
    const result = await this.options.api.workspace.setShowSize(showSize);
    if (!result.ok) { window.alert(result.message); return; }
    this.showSize = result.value;
    this.sizeRequests.clear();
    this.render();
  }

  private async changeShowCreatedAt(showCreatedAt: boolean): Promise<void> {
    const result = await this.options.api.workspace.setShowCreatedAt(showCreatedAt);
    if (!result.ok) {
      window.alert(result.message);
      this.render();
      return;
    }
    this.showCreatedAt = result.value;
    this.render();
  }

  private async changeShowUpdatedAt(showUpdatedAt: boolean): Promise<void> {
    const result = await this.options.api.workspace.setShowUpdatedAt(showUpdatedAt);
    if (!result.ok) {
      window.alert(result.message);
      this.render();
      return;
    }
    this.showUpdatedAt = result.value;
    this.render();
  }

  private async changeShowTimestampHover(showTimestampHover: boolean): Promise<void> {
    this.hideTimestampTooltip();
    const result = await this.options.api.workspace.setShowTimestampHover(showTimestampHover);
    if (!result.ok) {
      window.alert(result.message);
      this.render();
      return;
    }
    this.showTimestampHover = result.value;
    this.render();
  }

  private async changeShowDotEntries(showDotEntries: boolean): Promise<void> {
    const result = await this.options.api.workspace.setShowDotEntries(showDotEntries);
    if (!result.ok) {
      window.alert(result.message);
      this.render();
      return;
    }
    this.showDotEntries = result.value;
    this.render();
  }

  private attachDragHandlers(row: HTMLElement, entry: WorkspaceEntry): void {
    row.draggable = true;
    row.addEventListener('dragstart', (event) => {
      this.dragRelativePath = entry.relativePath;
      event.dataTransfer?.setData('text/plain', entry.relativePath);
      event.dataTransfer!.effectAllowed = 'move';
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
      event.dataTransfer!.dropEffect = external ? 'copy' : 'move';
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
    return [...this.options.container.querySelectorAll<HTMLElement>('.workspace-tree .workspace-entry')];
  }

  private resolveDropTarget(row: HTMLElement, event: DragEvent, external: boolean): WorkspaceTreeDropTarget | null {
    const rows = this.treeRows();
    const rect = row.getBoundingClientRect();
    const kind = (row.dataset.kind ?? 'file') as WorkspaceEntry['kind'];
    return resolveWorkspaceTreeDropTarget({
      rows: rows.map((element) => ({
        relativePath: element.dataset.relativePath ?? '',
        kind: (element.dataset.kind ?? 'file') as WorkspaceEntry['kind'],
      })),
      index: rows.indexOf(row),
      zone: resolveWorkspaceTreeRowDropZone(kind, event.clientY, rect.top, rect.height),
      pointerDepth: workspaceTreeDepthFromPointer(event.clientX - rect.left),
      draggedRelativePath: external ? null : this.dragRelativePath,
    });
  }

  private renderDropVisuals(target: WorkspaceTreeDropTarget): void {
    this.options.container.querySelectorAll('.workspace-entry.is-drop-into').forEach((node) => {
      node.classList.remove('is-drop-into');
    });
    if (!this.dropIndicator) {
      this.dropIndicator = document.createElement('div');
      this.dropIndicator.className = 'workspace-drop-indicator';
      this.options.container.appendChild(this.dropIndicator);
    }
    const rows = this.treeRows();

    if (target.kind === 'into') {
      this.dropIndicator.classList.remove('is-visible');
      rows.find((element) => element.dataset.relativePath === target.relativePath)?.classList.add('is-drop-into');
      return;
    }

    const lineRow = rows[target.lineRowIndex];
    const tree = this.options.container.querySelector('.workspace-tree');
    if (!lineRow || !tree) return;
    const containerRect = this.options.container.getBoundingClientRect();
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
    window.clearTimeout(this.dropHoverExpandTimer);
    this.dropHoverExpandTimer = undefined;
    this.dropIntent = null;
    this.options.container.querySelectorAll('.workspace-entry.is-drop-into, .workspace-entry.is-drop-target').forEach((node) => {
      node.classList.remove('is-drop-into', 'is-drop-target');
    });
    if (this.dropIndicator) this.dropIndicator.classList.remove('is-visible');
  }

  private readonly handleContainerDragOver = (event: DragEvent): void => {
    if (!this.state?.rootPath || !isExternalWorkspaceFileDrag(event.dataTransfer, this.dragRelativePath !== null)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };

  private readonly handleContainerDrop = (event: DragEvent): void => {
    if (!this.state?.rootPath || !event.dataTransfer) return;
    if (!isExternalWorkspaceFileDrag(event.dataTransfer, this.dragRelativePath !== null)) return;
    event.preventDefault();
    this.clearDropVisuals();
    void this.importExternalDrop(event.dataTransfer, this.currentDirectory);
  };

  private async importExternalDrop(dataTransfer: DataTransfer, targetParentRelativePath: string): Promise<void> {
    if (!this.state?.rootPath) return;
    const sources = await collectWorkspaceExternalDropSources(dataTransfer);
    const items = sources.items.map((item) => ({
      kind: item.kind,
      relativePath: item.relativePath,
      ...(item.bytes ? { dataBase64: bytesToBase64(item.bytes) } : {}),
    }));
    if (sources.sourcePaths.length === 0 && sources.sourceUris.length === 0 && items.length === 0) return;
    const result = await this.options.api.workspace.importExternal({
      targetParentRelativePath,
      sourcePaths: sources.sourcePaths,
      sourceUris: sources.sourceUris,
      items,
    });
    if (!result.ok) {
      window.alert(result.message);
      return;
    }
    this.selectedRelativePath = result.value.relativePath;
    this.selectedRelativePaths = new Set([result.value.relativePath]);
    this.selectionAnchorRelativePath = result.value.relativePath;
    if (targetParentRelativePath && this.state) {
      const expanded = new Set(this.state.expandedRelativePaths);
      expanded.add(targetParentRelativePath);
      this.updateState({ expandedRelativePaths: [...expanded] });
    }
    await this.refreshChanged([targetParentRelativePath]);
    this.render();
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
        window.alert(tExplorer('moveIntoSelf'));
        return;
      }
      if (sourceParent === target.relativePath) {
        // Already inside: treat as reorder to end is not requested; no-op.
        return;
      }
      const result = await this.options.api.workspace.move({
        relativePath: sourceRelativePath,
        targetParentRelativePath: target.relativePath,
      });
      if (!result.ok) {
        window.alert(result.message);
        return;
      }
      if (this.sortMode !== 'custom') {
        // Moving into a folder should flip to custom so the new sibling order can be kept.
        await this.options.api.workspace.setSortMode('custom');
        this.sortMode = 'custom';
      }
      const siblings = (this.entriesByDirectory.get(target.relativePath) ?? [])
        .map((entry) => entry.name)
        .filter((name) => name !== sourceName);
      siblings.push(result.value.name);
      await this.options.api.workspace.reorder({
        parentRelativePath: target.relativePath,
        movedName: result.value.name,
        siblingNames: siblings,
      });
      const expanded = new Set(this.state?.expandedRelativePaths ?? []);
      expanded.add(target.relativePath);
      this.updateState({ expandedRelativePaths: [...expanded] });
      await this.refreshChanged([sourceParent, target.relativePath]);
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

    const result = await this.options.api.workspace.move({
      relativePath: sourceRelativePath,
      targetParentRelativePath: targetParent,
    });
    if (!result.ok) {
      window.alert(result.message);
      return;
    }
    if (this.sortMode !== 'custom') {
      await this.options.api.workspace.setSortMode('custom');
      this.sortMode = 'custom';
    }
    const siblings = [...siblingNames];
    if (!siblings.includes(result.value.name)) siblings.push(result.value.name);
    await this.options.api.workspace.reorder({
      parentRelativePath: targetParent,
      movedName: result.value.name,
      siblingNames: siblings,
      beforeName,
    });
    if (targetParent && this.state && !this.state.expandedRelativePaths.includes(targetParent)) {
      this.updateState({ expandedRelativePaths: [...this.state.expandedRelativePaths, targetParent] });
    }
    await this.refreshChanged([sourceParent, targetParent]);
  }

  /** `beforeName` undefined appends to the end of the folder. */
  private async reorderBefore(parentRelativePathValue: string, movedName: string, beforeName: string | undefined): Promise<void> {
    if (movedName === beforeName) return;
    const siblings = (this.entriesByDirectory.get(parentRelativePathValue) ?? []).map((entry) => entry.name);
    // Dropping right after itself (or at the end while already last) keeps the current order.
    const index = siblings.indexOf(movedName);
    if (index >= 0 && siblings[index + 1] === beforeName) return;
    if (this.sortMode !== 'custom') {
      const sortResult = await this.options.api.workspace.setSortMode('custom');
      if (!sortResult.ok) {
        window.alert(sortResult.message);
        return;
      }
      this.sortMode = 'custom';
    }
    const result = await this.options.api.workspace.reorder({
      parentRelativePath: parentRelativePathValue,
      movedName,
      siblingNames: siblings,
      beforeName,
    });
    if (!result.ok) {
      window.alert(result.message);
      return;
    }
    await this.loadDirectory(parentRelativePathValue);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((value) => {
    binary += String.fromCharCode(value);
  });
  return btoa(binary);
}

function workspaceRelativePath(rootPath: string, targetPath: string): string | null {
  const root = rootPath.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  const target = targetPath.replace(/\\/g, '/');
  if (!target.startsWith(`${root}/`)) return null;
  return target.slice(root.length + 1);
}
