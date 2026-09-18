import type { DesktopWorkspaceState, WorkspaceEntry } from '../../contracts';
import type { EasyViewDesktopApi } from '../../preload/desktopApi';
import { resolveWorkspaceTreeIcon } from '@easyview/contracts';

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

  constructor(private readonly options: WorkspaceExplorerOptions) {}

  async initialize(): Promise<DesktopWorkspaceState> {
    const result = await this.options.api.workspace.getState();
    if (!result.ok) throw new Error(result.message);
    this.state = result.value;
    this.activeRelativePath = null;
    this.subscriptions.push(this.options.api.workspace.onChanged((paths) => { void this.refreshChanged(paths); }));
    this.subscriptions.push(this.options.api.workspace.onContextCommand((command, relativePath) => {
      this.select(relativePath);
      if (command === 'rename') this.beginRename(relativePath);
      if (command === 'paste') void this.refreshChanged([parentRelativePath(relativePath)]);
    }));
    this.options.container.tabIndex = 0;
    this.options.container.addEventListener('keydown', this.handleKeyDown);
    this.render();
    if (this.state.rootPath) await this.loadDirectory('');
    return this.state;
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    this.options.container.removeEventListener('keydown', this.handleKeyDown);
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
    this.selectedRelativePath = null;
    this.selectedRelativePaths.clear();
    this.selectionAnchorRelativePath = null;
    this.entriesByDirectory.clear();
    this.pendingCreate = null;
    this.renameRelativePath = null;
    this.render();
    await this.loadDirectory('');
  }

  setOutlineVisible(visible: boolean): void {
    if (this.state?.outlineVisible !== visible) this.updateState({ outlineVisible: visible });
  }

  setActiveDocument(filePath: string | null): void { this.setActiveRelativePath(this.relativePathFor(filePath)); }

  setActiveRelativePath(relativePath: string | null): void {
    if (!this.state || this.activeRelativePath === relativePath) return;
    const expanded = new Set(this.state.expandedRelativePaths);
    this.activeRelativePath = relativePath;
    this.select(relativePath);
    if (relativePath) {
      const segments = relativePath.split('/');
      segments.pop();
      for (let index = 1; index <= segments.length; index += 1) expanded.add(segments.slice(0, index).join('/'));
    }
    this.updateState({ expandedRelativePaths: [...expanded] });
    void this.refreshChanged([...expanded, '']);
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if ((event.key === 'F2' || event.key === 'Enter') && this.selectedRelativePath) {
      event.preventDefault();
      this.beginRename(this.selectedRelativePath);
      return;
    }
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === 'c' && this.selectedRelativePath) {
      event.preventDefault();
      void this.options.api.workspace.copyClipboard(this.selectedRelativePath);
      return;
    }
    if (modifier && event.key.toLowerCase() === 'v') {
      event.preventDefault();
      void this.pasteEntry(this.selectedRelativePath ?? '');
      return;
    }
    const deleteShortcut = event.key === 'Delete' || (event.key === 'Backspace' && event.metaKey);
    const deleteTargets = [...this.selectedRelativePaths];
    if (!deleteShortcut || deleteTargets.length === 0) return;
    event.preventDefault();
    void this.deleteEntries(deleteTargets);
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
    const shiftKey = Boolean(options?.shiftKey);
    const toggleKey = Boolean(options?.metaKey || options?.ctrlKey);

    if (shiftKey && this.selectionAnchorRelativePath) {
      const visible = this.visibleRelativePaths();
      const anchorIndex = visible.indexOf(this.selectionAnchorRelativePath);
      const targetIndex = visible.indexOf(relativePath);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const [from, to] = anchorIndex < targetIndex
          ? [anchorIndex, targetIndex]
          : [targetIndex, anchorIndex];
        this.selectedRelativePaths = new Set(visible.slice(from, to + 1));
      } else {
        this.selectedRelativePaths = new Set([relativePath]);
        this.selectionAnchorRelativePath = relativePath;
      }
    } else if (toggleKey) {
      if (this.selectedRelativePaths.has(relativePath)) this.selectedRelativePaths.delete(relativePath);
      else this.selectedRelativePaths.add(relativePath);
      this.selectionAnchorRelativePath = relativePath;
    } else {
      this.selectedRelativePaths = new Set([relativePath]);
      this.selectionAnchorRelativePath = relativePath;
    }

    this.selectedRelativePath = relativePath;
    this.options.container.focus({ preventScroll: true });
    this.render();
  }

  private visibleRelativePaths(): string[] {
    const paths: string[] = [];
    const walk = (directoryRelativePath: string): void => {
      for (const entry of this.entriesByDirectory.get(directoryRelativePath) ?? []) {
        paths.push(entry.relativePath);
        if (
          entry.kind === 'directory'
          && this.state?.expandedRelativePaths.includes(entry.relativePath)
        ) {
          walk(entry.relativePath);
        }
      }
    };
    walk('');
    return paths;
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
    container.classList.toggle('is-hidden', !state?.explorerVisible);
    if (state) container.style.width = `${state.explorerWidth}px`;
    container.replaceChildren();
    if (!state?.rootPath) {
      const empty = document.createElement('button');
      empty.type = 'button'; empty.className = 'workspace-empty'; empty.textContent = '打开文件夹';
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
      ['＋', '新建文件', () => this.beginCreate('', 'file')],
      ['▣', '新建文件夹', () => this.beginCreate('', 'directory')],
      ['↻', '刷新', () => { this.entriesByDirectory.clear(); void this.refreshExpanded(); }],
    ] as const) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'workspace-action';
      button.textContent = label; button.title = titleText;
      button.addEventListener('click', action);
      header.appendChild(button);
    }
    container.appendChild(header);

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
    const entries = this.entriesByDirectory.get(relativePath) ?? [];
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
        this.select(entry.relativePath, {
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
        });
        if (event.shiftKey || event.metaKey || event.ctrlKey) return;
        if (entry.kind === 'directory') this.toggleDirectory(entry.relativePath);
        else void this.options.onOpenFile(entry.relativePath).then((opened) => { if (opened) this.setActiveRelativePath(entry.relativePath); });
      });
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        if (!this.selectedRelativePaths.has(entry.relativePath)) this.select(entry.relativePath);
        void this.options.api.workspace.showContextMenu(entry.relativePath, entry.kind);
      });
      row.appendChild(name);
      if (entry.kind === 'directory') {
        const create = document.createElement('button');
        create.type = 'button'; create.className = 'workspace-entry-create'; create.textContent = '＋'; create.title = '新建';
        create.addEventListener('click', (event) => { event.stopPropagation(); this.beginCreate(entry.relativePath, 'file'); });
        row.appendChild(create);
      }
      fragment.appendChild(row);
      if (entry.kind === 'directory' && expanded) fragment.appendChild(this.renderDirectory(entry.relativePath, depth + 1));
    }
    if (this.pendingCreate?.parentRelativePath === relativePath) fragment.appendChild(this.renderCreateInput(depth));
    return fragment;
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
    requestAnimationFrame(() => { input.focus(); selectFileName(input); });
    return input;
  }

  private beginRename(relativePath: string): void {
    this.pendingCreate = null;
    this.renameRelativePath = relativePath;
    this.render();
  }

  private async renameEntry(relativePath: string, newName: string): Promise<void> {
    if (this.renameRelativePath !== relativePath) return;
    const result = await this.options.api.workspace.rename({ relativePath, newName: newName.trim() });
    if (!result.ok) { window.alert(result.message); this.render(); return; }
    this.renameRelativePath = null;
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
}

function normalizeRelativePath(value: string): string { return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, ''); }
function parentRelativePath(value: string): string { const normalized = normalizeRelativePath(value); const index = normalized.lastIndexOf('/'); return index < 0 ? '' : normalized.slice(0, index); }
function selectFileName(input: HTMLInputElement): void { const dot = input.value.lastIndexOf('.'); input.setSelectionRange(0, dot > 0 ? dot : input.value.length); }
function workspaceRelativePath(rootPath: string, targetPath: string): string | null {
  const root = rootPath.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  const target = targetPath.replace(/\\/g, '/');
  if (!target.startsWith(`${root}/`)) return null;
  return target.slice(root.length + 1);
}
