import type { DesktopWorkspaceState, WorkspaceEntry, WorkspaceTreeSortMode } from '../../contracts';
import type { EasyViewDesktopApi } from '../../preload/desktopApi';
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
} from '@easyview/contracts';

interface WorkspaceExplorerOptions {
  api: EasyViewDesktopApi;
  container: HTMLElement;
  onStateChange(state: DesktopWorkspaceState): void;
  onOpenFile(relativePath: string): Promise<boolean>;
  onOpenWithDefaultApp(relativePath: string): void;
  onRevealInFolder(relativePath: string): void;
}

export class WorkspaceExplorer {
  private state: DesktopWorkspaceState | null = null;
  private readonly entriesByDirectory = new Map<string, WorkspaceEntry[]>();
  private pendingCreate: { parentRelativePath: string; kind: 'file' | 'directory' } | null = null;
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
  private showCreatedAt = false;
  private showUpdatedAt = false;
  private showDotEntries = true;
  private showTimestampHover = true;
  private sortMenuOpen = false;
  private timestampTooltipEl: HTMLElement | null = null;
  private dragRelativePath: string | null = null;
  private dropIndicator: HTMLElement | null = null;
  private dropHoverExpandTimer: number | undefined;
  private dropIntent: {
    mode: 'before' | 'into';
    targetRelativePath: string;
  } | null = null;

  constructor(private readonly options: WorkspaceExplorerOptions) {}

  async initialize(): Promise<DesktopWorkspaceState> {
    const result = await this.options.api.workspace.getState();
    if (!result.ok) throw new Error(result.message);
    this.state = result.value;
    this.activeRelativePath = null;
    this.selectionFollowsActive = true;
    this.subscriptions.push(this.options.api.workspace.onChanged((paths) => { void this.refreshChanged(paths); }));
    this.subscriptions.push(this.options.api.workspace.onContextCommand((command, relativePath) => {
      this.selectionFollowsActive = false;
      this.select(relativePath);
      if (command === 'rename') this.beginRename(relativePath);
      if (command === 'paste') void this.refreshChanged([parentRelativePath(relativePath)]);
    }));
    this.options.container.tabIndex = 0;
    this.options.container.addEventListener('keydown', this.handleKeyDown);
    this.options.container.addEventListener('dragover', this.handleContainerDragOver);
    this.options.container.addEventListener('drop', this.handleContainerDrop);
    this.render();
    if (this.state.rootPath) {
      await this.loadSortMode();
      await this.loadDirectory('');
    }
    return this.state;
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    this.options.container.removeEventListener('keydown', this.handleKeyDown);
    this.options.container.removeEventListener('dragover', this.handleContainerDragOver);
    this.options.container.removeEventListener('drop', this.handleContainerDrop);
    this.hideTimestampTooltip();
    this.timestampTooltipEl?.remove();
    this.timestampTooltipEl = null;
  }

  toggle(): void {
    if (!this.state) return;
    if (!this.state.rootPath) { void this.openFolder(); return; }
    this.updateState({ explorerVisible: !this.state.explorerVisible });
  }

  async openFolder(): Promise<void> {
    const result = await this.options.api.workspace.openFolder();
    if (!result.ok || !result.value) return;
    this.state = result.value;
    this.activeRelativePath = null;
    this.selectionFollowsActive = true;
    this.selectedRelativePath = null;
    this.selectedRelativePaths.clear();
    this.selectionAnchorRelativePath = null;
    this.entriesByDirectory.clear();
    this.pendingCreate = null;
    this.renameRelativePath = null;
    this.render();
    await this.loadSortMode();
    await this.loadDirectory('');
  }

  setOutlineVisible(visible: boolean): void {
    if (this.state?.outlineVisible !== visible) this.updateState({ outlineVisible: visible });
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
    if (relativePath) {
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

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
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
    if (action === 'copy' && this.selectedRelativePath) {
      void this.options.api.workspace.copyClipboard(this.selectedRelativePath);
      return;
    }
    if (action === 'paste') {
      void this.pasteEntry(this.selectedRelativePath ?? '');
      return;
    }
    if (action === 'delete') void this.deleteEntries([...this.selectedRelativePaths]);
  };

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
    if (!result.ok) return;
    this.entriesByDirectory.set(relativePath, result.value);
    this.render();
  }

  private async refreshChanged(relativeDirectories: string[] | null): Promise<void> {
    if (!this.state?.rootPath) return;
    if (relativeDirectories === null) {
      this.entriesByDirectory.clear();
      await this.refreshExpanded();
      return;
    }
    const expanded = new Set(['', ...this.state.expandedRelativePaths]);
    const targets = [...new Set(relativeDirectories.map(normalizeRelativePath))].filter((value) => expanded.has(value));
    await Promise.all(targets.map((relativePath) => this.loadDirectory(relativePath)));
  }

  private async refreshExpanded(): Promise<void> {
    if (!this.state?.rootPath) return;
    await Promise.all(['', ...this.state.expandedRelativePaths].map((relativePath) => this.loadDirectory(relativePath)));
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
    const expanded = new Set(this.state?.expandedRelativePaths ?? []);
    return collectVisibleWorkspaceTreeRelativePaths(this.entriesByDirectory, (path) => expanded.has(path));
  }

  private updateState(patch: Partial<DesktopWorkspaceState>): void {
    if (!this.state) return;
    this.state = { ...this.state, ...patch };
    this.render();
    this.options.onStateChange(this.state);
    void this.options.api.workspace.setState(this.state);
  }

  private render(): void {
    const { container } = this.options;
    const state = this.state;
    const previousTree = container.querySelector<HTMLElement>('.workspace-tree');
    const previousScrollTop = previousTree?.scrollTop ?? 0;
    const previousScrollLeft = previousTree?.scrollLeft ?? 0;
    this.clearDropVisuals();
    this.dropIndicator = null;
    this.hideTimestampTooltip();
    container.classList.toggle('is-hidden', !state?.explorerVisible);
    if (state) container.style.width = `${state.explorerWidth}px`;
    container.replaceChildren();
    if (!state?.rootPath) {
      const empty = document.createElement('button');
      empty.type = 'button'; empty.className = 'workspace-empty'; empty.textContent = 'Open Folder';
      empty.addEventListener('click', () => { void this.openFolder(); });
      container.appendChild(empty);
      return;
    }

    const header = document.createElement('div');
    header.className = 'workspace-header';
    const title = document.createElement('span');
    title.textContent = state.rootPath.split(/[\\/]/).at(-1) || state.rootPath;
    header.appendChild(title);
    for (const [label, titleText, action] of [
      ['⇅', 'Sort', () => { this.sortMenuOpen = !this.sortMenuOpen; this.render(); }],
      ['＋', 'New File', () => this.beginCreate('', 'file')],
      ['▣', 'New Folder', () => this.beginCreate('', 'directory')],
      ['↻', '刷新', () => { this.entriesByDirectory.clear(); void this.refreshExpanded(); }],
    ] as const) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'workspace-action';
      button.textContent = label; button.title = titleText;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        action();
      });
      header.appendChild(button);
    }
    container.appendChild(header);

    if (this.sortMenuOpen) {
      const menu = document.createElement('div');
      menu.className = 'workspace-sort-menu';
      const appendToggle = (iconId: WorkspaceTreeMenuIconId, text: string, checked: boolean, onClick: () => void) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'workspace-sort-menu-item';
        item.setAttribute('role', 'menuitemcheckbox');
        item.setAttribute('aria-checked', String(checked));
        const icon = document.createElement('span');
        icon.className = 'workspace-menu-item-icon';
        icon.innerHTML = workspaceTreeMenuIconSvg(iconId);
        item.appendChild(icon);
        const label = document.createElement('span');
        label.className = 'workspace-menu-item-label';
        label.textContent = text;
        item.appendChild(label);
        const check = document.createElement('span');
        check.className = 'workspace-menu-item-check';
        check.setAttribute('aria-hidden', 'true');
        check.textContent = checked ? '✓' : '';
        item.appendChild(check);
        item.addEventListener('click', onClick);
        menu.appendChild(item);
      };
      for (const mode of ['created', 'name', 'custom'] as const) {
        appendToggle(SORT_MODE_ICONS[mode], SORT_MODE_LABELS[mode], this.sortMode === mode, () => {
          void this.changeSortMode(mode);
        });
      }
      const separator = document.createElement('div');
      separator.className = 'workspace-sort-menu-separator';
      menu.appendChild(separator);
      appendToggle('showCreated', 'Show Created Time', this.showCreatedAt, () => {
        void this.changeShowCreatedAt(!this.showCreatedAt);
      });
      appendToggle('showUpdated', 'Show Updated Time', this.showUpdatedAt, () => {
        void this.changeShowUpdatedAt(!this.showUpdatedAt);
      });
      appendToggle('showTimeOnHover', 'Show Time on Hover', this.showTimestampHover, () => {
        void this.changeShowTimestampHover(!this.showTimestampHover);
      });
      const dotSeparator = document.createElement('div');
      dotSeparator.className = 'workspace-sort-menu-separator';
      menu.appendChild(dotSeparator);
      appendToggle('showDotEntries', 'Show Dotfiles and Folders', this.showDotEntries, () => {
        void this.changeShowDotEntries(!this.showDotEntries);
      });
      container.appendChild(menu);
    }

    const tree = document.createElement('div');
    tree.className = 'workspace-tree';
    tree.setAttribute('role', 'tree');
    tree.appendChild(this.renderDirectory('', 0));
    container.appendChild(tree);
    tree.scrollTop = previousScrollTop;
    tree.scrollLeft = previousScrollLeft;

    const resizer = document.createElement('div');
    resizer.className = 'workspace-resizer';
    resizer.addEventListener('pointerdown', (event) => this.beginResize(event));
    container.appendChild(resizer);
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
      } const icon = document.createElement('span');
      icon.className = 'workspace-entry-icon';
      const iconDesc = resolveWorkspaceTreeIcon({
        kind: entry.kind,
        name: entry.name,
        expanded: entry.kind === 'directory' ? expanded : false,
      });
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
        void this.options.api.workspace.showContextMenu(entry.relativePath, entry.kind);
      });
      this.attachDragHandlers(row, entry);
      row.appendChild(name);
      this.appendEntryTimestamps(row, entry);
      if (entry.kind === 'directory') {
        const create = document.createElement('button');
        create.type = 'button'; create.className = 'workspace-entry-create'; create.textContent = '＋'; create.title = 'New File';
        create.addEventListener('click', (event) => { event.stopPropagation(); this.beginCreate(entry.relativePath, 'file'); });
        row.appendChild(create);
      } else if (this.showCreatedAt || this.showUpdatedAt) {
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

  private appendEntryTimestamps(row: HTMLElement, entry: WorkspaceEntry): void {
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
    requestAnimationFrame(() => { input.focus(); input.setSelectionRange(...workspaceEntryNameSelectionRange(input.value)); });
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
    this.selectedRelativePaths.delete(relativePath);
    this.selectedRelativePaths.add(result.value.relativePath);
    this.selectedRelativePath = result.value.relativePath;
    this.selectionAnchorRelativePath = result.value.relativePath;
    await this.loadDirectory(parentRelativePath(result.value.relativePath));
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

  private beginCreate(parentRelativePath: string, kind: 'file' | 'directory'): void {
    if (!this.state) return;
    const expanded = new Set(this.state.expandedRelativePaths);
    if (parentRelativePath) expanded.add(parentRelativePath);
    this.renameRelativePath = null;
    this.pendingCreate = { parentRelativePath, kind };
    this.updateState({ expandedRelativePaths: [...expanded] });
    if (parentRelativePath) void this.loadDirectory(parentRelativePath);
  }

  private renderCreateInput(depth: number): HTMLElement {
    const wrapper = document.createElement('form');
    wrapper.className = 'workspace-create-row'; wrapper.style.paddingInlineStart = `${28 + depth * 16}px`;
    const input = document.createElement('input');
    input.autofocus = true; input.value = this.pendingCreate?.kind === 'file' ? 'untitled.md' : 'untitled';
    wrapper.appendChild(input);
    wrapper.addEventListener('submit', (event) => { event.preventDefault(); const pending = this.pendingCreate; if (pending) void this.createEntry(pending, input.value); });
    input.addEventListener('keydown', (event) => { if (event.key === 'Escape') { this.pendingCreate = null; this.render(); } });
    requestAnimationFrame(() => input.select());
    return wrapper;
  }

  private async createEntry(pending: NonNullable<WorkspaceExplorer['pendingCreate']>, name: string): Promise<void> {
    const result = await this.options.api.workspace.create({ parentRelativePath: pending.parentRelativePath, name, kind: pending.kind });
    if (!result.ok) { window.alert(result.message); return; }
    this.pendingCreate = null;
    this.selectedRelativePath = result.value.relativePath;
    await this.loadDirectory(pending.parentRelativePath);
  }

  private beginResize(event: PointerEvent): void {
    if (!this.state) return;
    event.preventDefault(); this.resizing = true;
    const onMove = (moveEvent: PointerEvent) => {
      if (!this.resizing) return;
      this.updateState({ explorerWidth: Math.max(220, Math.min(520, Math.round(moveEvent.clientX))) });
    };
    const onEnd = () => { this.resizing = false; window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onEnd); };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onEnd);
  }

  private async loadSortMode(): Promise<void> {
    const [sortResult, createdResult, updatedResult, hoverResult, dotResult] = await Promise.all([
      this.options.api.workspace.getSortMode(),
      this.options.api.workspace.getShowCreatedAt(),
      this.options.api.workspace.getShowUpdatedAt(),
      this.options.api.workspace.getShowTimestampHover(),
      this.options.api.workspace.getShowDotEntries(),
    ]);
    if (sortResult.ok) this.sortMode = sortResult.value;
    if (createdResult.ok) this.showCreatedAt = createdResult.value;
    if (updatedResult.ok) this.showUpdatedAt = updatedResult.value;
    if (hoverResult.ok) this.showTimestampHover = hoverResult.value;
    if (dotResult.ok) this.showDotEntries = dotResult.value;
  }

  private async changeSortMode(sortMode: WorkspaceTreeSortMode): Promise<void> {
    this.sortMenuOpen = false;
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

  private async changeShowCreatedAt(showCreatedAt: boolean): Promise<void> {
    this.sortMenuOpen = false;
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
    this.sortMenuOpen = false;
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
    this.sortMenuOpen = false;
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
    this.sortMenuOpen = false;
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
      event.dataTransfer!.dropEffect = external ? 'copy' : 'move';
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
    entry: WorkspaceEntry,
    clientY: number,
    row: HTMLElement,
  ): 'before' | 'into' {
    const rect = row.getBoundingClientRect();
    return resolveWorkspaceTreeDropMode(entry.kind, clientY, rect.top, rect.height);
  }

  private updateDropIntent(row: HTMLElement, entry: WorkspaceEntry, clientY: number): void {
    const mode = this.resolveDropMode(entry, clientY, row);
    this.dropIntent = { mode, targetRelativePath: entry.relativePath };
    this.renderDropVisuals(row, entry, mode);
  }

  private renderDropVisuals(row: HTMLElement, entry: WorkspaceEntry, mode: 'before' | 'into'): void {
    this.options.container.querySelectorAll('.workspace-entry.is-drop-into').forEach((node) => {
      node.classList.remove('is-drop-into');
    });
    if (!this.dropIndicator) {
      this.dropIndicator = document.createElement('div');
      this.dropIndicator.className = 'workspace-drop-indicator';
      this.options.container.appendChild(this.dropIndicator);
    }

    if (mode === 'into') {
      this.dropIndicator.classList.remove('is-visible');
      row.classList.add('is-drop-into');
      return;
    }

    row.classList.remove('is-drop-into');
    const tree = this.options.container.querySelector('.workspace-tree');
    const containerRect = this.options.container.getBoundingClientRect();
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
    void this.importExternalDrop(event.dataTransfer, '');
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
    target: WorkspaceEntry,
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
        window.alert('Cannot move a folder into itself or its descendants.');
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

    // Insert before target (same or different parent).
    if (sourceParent === targetParent) {
      await this.reorderBefore(sourceParent, sourceName, target.name);
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
    const siblings = (this.entriesByDirectory.get(targetParent) ?? []).map((entry) => entry.name);
    if (!siblings.includes(result.value.name)) siblings.push(result.value.name);
    await this.options.api.workspace.reorder({
      parentRelativePath: targetParent,
      movedName: result.value.name,
      siblingNames: siblings,
      beforeName: target.name,
    });
    await this.refreshChanged([sourceParent, targetParent]);
  }

  private async reorderBefore(parentRelativePathValue: string, movedName: string, beforeName: string): Promise<void> {
    if (this.sortMode !== 'custom') {
      const sortResult = await this.options.api.workspace.setSortMode('custom');
      if (!sortResult.ok) {
        window.alert(sortResult.message);
        return;
      }
      this.sortMode = 'custom';
    }
    if (movedName === beforeName) return;
    const siblings = (this.entriesByDirectory.get(parentRelativePathValue) ?? []).map((entry) => entry.name);
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
