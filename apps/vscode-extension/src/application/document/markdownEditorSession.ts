import * as path from 'path';
import * as vscode from 'vscode';
import { isEditorToHostMessage } from '@easyview/contracts/protocol';
import type { EditorToHostMessage, HostToEditorMessage, EditorUiStatePayload } from '@easyview/contracts/protocol';
import { applyTextPatches, createCanonicalDocument, DocumentSyncSession, hashContent, type TextOffsetPatch } from '@easyview/editor-sync';
import { handleVscodeEditorHostAction, handleWebviewMessage, type MessageHandlerContext } from './editorMessageHandler';
import { isVscodeEditorHostActionMessage } from '../../adapters/vscode/vscodeProtocol';
import { buildImagePathMap } from '../../adapters/vscode/providerImageManager';
import { repairSerializedMarkdownContent, type EditorSettings } from '../../adapters/vscode/providerUtils';
import { computeGitLineRanges } from '../git/gitChangeTracker';
import { consumePendingCursorForUri } from './openCursorContext';
import { consumePendingDocumentContentForUri } from './openDocumentSnapshot';
import { watchEasyViewMarkdownDiskFile } from './markdownFileSystem';
import { resolveMarkdownDiskUri } from './openMarkdownEditor';
import { registerMarkdownThemePanel, readProductTheme } from '../../theme/productThemeBridge';
import { createPanelAiChatHost } from '../ai/createPanelAiChatHost';
import { disposeTerminalForPanel } from '../terminal/terminalSessionManager';
import { VscodeCanonicalDocumentAdapter } from './vscodeCanonicalDocumentAdapter';

export interface MarkdownEditorSessionOptions {
  context: vscode.ExtensionContext;
  document: vscode.TextDocument;
  panel: vscode.WebviewPanel;
  onDisposed: (session: MarkdownEditorSession) => void;
  getTableFirstRowStickyDefault: () => boolean;
  getEditorSettings: () => EditorSettings;
  updateEditorSettings: (settings: EditorSettings) => Promise<void>;
  onActive: () => void;
  setTableFirstRowStickyDefault: (value: boolean) => Promise<void>;
  getHtml: (webview: vscode.Webview) => string;
}

function terminalAppearance(): { fontFamily: string; fontSize: number; lineHeight: number; fontWeight: string; fontWeightBold: string; letterSpacing: number } {
  const config = vscode.workspace.getConfiguration('terminal.integrated');
  return {
    fontFamily: config.get('fontFamily', '') || (process.platform === 'darwin' ? 'Menlo, Monaco, "Courier New", monospace' : '"DejaVu Sans Mono", monospace'),
    fontSize: config.get('fontSize', 13),
    lineHeight: config.get('lineHeight', 1),
    fontWeight: config.get('fontWeight', 'normal'),
    fontWeightBold: config.get('fontWeightBold', 'bold'),
    letterSpacing: config.get('letterSpacing', 0),
  };
}

export class MarkdownEditorSession implements vscode.Disposable {
  readonly documentId: string;
  private readonly adapter: VscodeCanonicalDocumentAdapter;
  private readonly sync: DocumentSyncSession;
  private readonly disposables: vscode.Disposable[] = [];
  private operationQueue: Promise<void> = Promise.resolve();
  private gitTimer: ReturnType<typeof setTimeout> | undefined;
  private gitTimerResolve: (() => void) | undefined;
  private gitTask = 0;
  private disposed = false;
  private visible = true;
  private uiState: EditorUiStatePayload = {};
  private readonly aiChatHost: ReturnType<typeof createPanelAiChatHost>;
  private readonly pendingInitialContent: string | undefined;
  private lastPatchMs = 0;
  private lastGitMs = 0;
  private lastSnapshotReason: 'initial' | 'visible' | 'resync' | 'reload' = 'initial';
  private lastConflictReason = '';
  private gitInFlight = false;

  constructor(private readonly options: MarkdownEditorSessionOptions) {
    this.documentId = options.document.uri.toString();
    this.adapter = new VscodeCanonicalDocumentAdapter(options.document);
    this.pendingInitialContent = consumePendingDocumentContentForUri(options.document.uri);
    this.sync = new DocumentSyncSession({
      documentId: this.documentId,
      initialContent: this.adapter.content,
    });
    const diskUri = this.diskUri;
    const workspaceRoot = vscode.workspace.getWorkspaceFolder(diskUri)?.uri.fsPath ?? null;
    this.aiChatHost = createPanelAiChatHost(options.context, (message) => this.post(message as HostToEditorMessage), workspaceRoot);
  }

  private get document(): vscode.TextDocument { return this.options.document; }
  private get panel(): vscode.WebviewPanel { return this.options.panel; }
  private get diskUri(): vscode.Uri {
    return resolveMarkdownDiskUri(this.document.uri);
  }

  async start(): Promise<void> {
    const { panel } = this.options;
    this.disposables.push(
      panel.onDidChangeViewState((event) => {
        this.visible = event.webviewPanel.visible;
        if (event.webviewPanel.active) this.options.onActive();
        if (this.visible) this.scheduleGit();
      }),
      panel.onDidDispose(() => this.dispose()),
      vscode.workspace.onDidChangeTextDocument((event) => this.onDocumentChanged(event)),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.toString() === this.document.uri.toString()) this.scheduleGit();
      }),
      watchEasyViewMarkdownDiskFile(this.document.uri),
      registerMarkdownThemePanel(panel),
    );
    this.disposables.push(this.aiChatHost);
    this.disposables.push(panel.webview.onDidReceiveMessage((message) => this.onMessage(message)));
    if (this.pendingInitialContent !== undefined) {
      const canonicalPending = createCanonicalDocument(repairSerializedMarkdownContent(this.pendingInitialContent)).content;
      const result = await this.adapter.replaceCanonicalContent(canonicalPending);
      if (result.applied) this.sync.applySnapshot(result.content, this.sync.snapshot.revision + 1);
    }
    panel.webview.html = this.options.getHtml(panel.webview);
    this.options.onActive();
    this.scheduleGit();
    void this.registerGitRepositoryListener();
  }

  private readonly messageContext = (): MessageHandlerContext => ({
    webviewPanel: this.panel,
    document: this.document,
    extensionContext: this.options.context,
    getFilename: () => path.basename(this.diskUri.fsPath).replace(/\.(md|markdown|mdx)$/i, ''),
    getCanonicalContent: () => this.adapter.content,
    applyCanonicalContent: async (content, settings) => {
      await this.updateSettings(settings);
      await this.applyCanonicalReplacement(content, 'formatter');
    },
    getSyncRevision: () => this.sync.snapshot.revision,
    postSnapshot: (reason) => this.postSnapshot(reason),
    getEditorSettings: () => this.readSettings(),
    updateEditorSettings: (settings) => this.updateSettings(settings),
    getTableFirstRowStickyDefault: this.options.getTableFirstRowStickyDefault,
    setTableFirstRowStickyDefault: this.options.setTableFirstRowStickyDefault,
    enqueueOperation: (name, operation, onError) => this.enqueue(name, operation, onError),
    refreshGitChanges: () => this.scheduleGit(),
  });

  private async onMessage(message: unknown): Promise<void> {
    if (message && typeof message === 'object' && (message as { type?: string }).type === 'applyEdits') {
      await this.enqueue('apply edits', () => this.applyEdits(message as Extract<EditorToHostMessage, { type: 'applyEdits' }>));
      return;
    }
    if (message && typeof message === 'object' && (message as { type?: string }).type === 'updateUiState') {
      const update = message as Extract<EditorToHostMessage, { type: 'updateUiState' }>;
      if (update.documentId !== this.documentId) return;
      this.uiState = update.state;
      const current = this.readSettings();
      await this.updateSettings({
        fullWidth: this.uiState.fullWidth ?? current.fullWidth,
        tocVisible: this.uiState.tocVisible ?? current.tocVisible,
        tableWrap: this.uiState.tableWrap ?? current.tableWrap,
      });
      return;
    }
    if (message && typeof message === 'object' && (message as { type?: string }).type === 'snapshotApplied') {
      const applied = message as Extract<EditorToHostMessage, { type: 'snapshotApplied' }>;
      if (applied.documentId !== this.documentId || applied.revision !== this.sync.snapshot.revision || applied.contentHash !== hashContent(this.adapter.content)) {
        this.lastConflictReason = 'Snapshot acknowledgement mismatch';
        this.post({ type: 'resyncRequired', documentId: this.documentId, revision: this.sync.snapshot.revision, reason: this.lastConflictReason });
      }
      return;
    }
    if (message && typeof message === 'object' && (message as { type?: string }).type === 'requestResync') {
      this.lastConflictReason = String((message as Extract<EditorToHostMessage, { type: 'requestResync' }>).reason || 'Webview requested resync');
      this.postSnapshot('resync');
      return;
    }
    if (isVscodeEditorHostActionMessage(message)) {
      await handleVscodeEditorHostAction(this.messageContext(), message);
      return;
    }
    if (!isEditorToHostMessage(message)) return;
    if (this.aiChatHost.handles(message)) {
      await this.aiChatHost.handle(message);
      return;
    }
    await handleWebviewMessage(this.messageContext(), message);
  }

  private async onDocumentChanged(event: vscode.TextDocumentChangeEvent): Promise<void> {
    if (this.disposed || event.document.uri.toString() !== this.document.uri.toString()) return;
    if (this.adapter.matchesExpectedChange()) {
      this.adapter.refresh();
      this.scheduleGit();
      return;
    }
    const previous = this.adapter.content;
    this.adapter.refresh();
    const current = this.adapter.content;
    const edits = this.diff(previous, current);
    if (edits.length === 0) return;
    const source = event.reason === vscode.TextDocumentChangeReason.Undo ? 'undo'
      : event.reason === vscode.TextDocumentChangeReason.Redo ? 'redo' : 'external';
    const revision = this.sync.snapshot.revision + 1;
    this.sync.applySnapshot(current, revision);
    const message: HostToEditorMessage = {
      type: 'documentPatched', documentId: this.documentId, baseRevision: revision - 1,
      revision, edits, resultHash: hashContent(current), source,
      imagePathMap: buildImagePathMap(current, this.panel.webview, this.diskUri),
      skipAutoScroll: source !== 'external',
    };
    if (this.visible) this.post(message);
    this.scheduleGit();
  }

  private diff(before: string, after: string): TextOffsetPatch[] {
    if (before === after) return [];
    const start = (() => { let i = 0; while (i < before.length && i < after.length && before[i] === after[i]) i++; return i; })();
    let oldEnd = before.length; let newEnd = after.length;
    while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
    return [{ from: start, to: oldEnd, insert: after.slice(start, newEnd) }];
  }

  private async applyCanonicalReplacement(content: string, source: 'formatter' | 'external'): Promise<void> {
    const before = this.adapter.content;
    const edits = this.diff(before, content);
    const result = await this.adapter.replaceCanonicalContent(content);
    if (!result.applied) return;
    const revision = this.sync.snapshot.revision + 1;
    this.sync.applySnapshot(result.content, revision);
    this.post({ type: 'documentPatched', documentId: this.documentId, baseRevision: revision - 1, revision, edits, resultHash: hashContent(result.content), source, skipAutoScroll: true });
  }

  private async applyEdits(message: Extract<EditorToHostMessage, { type: 'applyEdits' }>): Promise<void> {
    if (message.documentId !== this.documentId || message.baseRevision !== this.sync.snapshot.revision) {
      this.post({ type: 'resyncRequired', documentId: this.documentId, revision: this.sync.snapshot.revision, reason: 'Stale document revision' });
      return;
    }
    let expectedContent: string;
    try {
      expectedContent = applyTextPatches(this.adapter.content, message.edits);
    } catch (error) {
      this.lastConflictReason = error instanceof Error ? error.message : 'Invalid document patch';
      this.post({ type: 'resyncRequired', documentId: this.documentId, revision: this.sync.snapshot.revision, reason: this.lastConflictReason });
      return;
    }
    if (hashContent(expectedContent) !== message.resultHash) {
      this.lastConflictReason = 'Result hash mismatch';
      this.post({ type: 'resyncRequired', documentId: this.documentId, revision: this.sync.snapshot.revision, reason: this.lastConflictReason });
      return;
    }
    const startedAt = performance.now();
    const result = await this.adapter.applyPatches(message.edits);
    this.lastPatchMs = performance.now() - startedAt;
    if (!result.applied) {
      this.lastConflictReason = 'WorkspaceEdit was not applied';
      this.post({ type: 'resyncRequired', documentId: this.documentId, revision: this.sync.snapshot.revision, reason: this.lastConflictReason });
      return;
    }
    const revision = this.sync.snapshot.revision + 1;
    this.sync.applySnapshot(result.content, revision);
    await this.updateSettings({ fullWidth: message.fullWidth, tocVisible: message.tocVisible, tableWrap: message.tableWrap });
    this.post({ type: 'editsApplied', documentId: this.documentId, clientEditId: message.clientEditId, revision, resultHash: message.resultHash });
    this.scheduleGit();
  }

  private post(message: HostToEditorMessage): void {
    if (!this.disposed) void this.panel.webview.postMessage(message);
  }

  async refreshSnapshot(reason: 'initial' | 'visible' | 'resync' | 'reload' = 'initial', contentOverride?: string): Promise<void> {
    if (contentOverride !== undefined) {
      const canonical = createCanonicalDocument(repairSerializedMarkdownContent(contentOverride)).content;
      await this.applyCanonicalReplacement(canonical, 'external');
    }
    this.postSnapshot(reason);
  }

  private postSnapshot(reason: 'initial' | 'visible' | 'resync' | 'reload' = 'initial'): void {
    this.lastSnapshotReason = reason;
    const settings = this.readSettings();
    const pendingCursor = consumePendingCursorForUri(this.document.uri);
    const editor = vscode.window.visibleTextEditors.find((candidate) => candidate.document.uri.toString() === this.document.uri.toString());
    const content = this.adapter.content;
    this.post({
      type: 'documentSnapshot', documentId: this.documentId, revision: this.sync.snapshot.revision,
      content, contentHash: hashContent(content), filename: path.basename(this.diskUri.fsPath).replace(/\.(md|markdown|mdx)$/i, ''),
      filePath: this.diskUri.fsPath, fullWidth: settings.fullWidth, tocVisible: settings.tocVisible, tableWrap: settings.tableWrap,
      tableFirstRowStickyDefault: this.options.getTableFirstRowStickyDefault(),
      initialCursorLine: pendingCursor?.line ?? editor?.selection.active.line ?? 0,
      initialCursorCharacter: pendingCursor?.character ?? editor?.selection.active.character ?? 0,
      initialTotalLines: Math.max(1, this.document.lineCount), terminalAppearance: terminalAppearance(),
      imagePathMap: buildImagePathMap(content, this.panel.webview, this.diskUri), uiState: this.uiState, reason,
    });
    this.post({ type: 'setProductTheme', mode: readProductTheme(this.options.context) });
  }

  private readSettings(): EditorSettings {
    return this.options.getEditorSettings();
  }
  private async updateSettings(settings: EditorSettings): Promise<void> {
    await this.options.updateEditorSettings(settings);
  }
  private enqueue(name: string, operation: () => Promise<void>, onError?: (message: string) => void): Promise<void> {
    this.operationQueue = this.operationQueue.catch(() => undefined).then(operation).catch((error) => {
      onError?.(String(error));
      if (!onError) console.error(`[EasyView_Md] ${name} failed`, error);
    });
    return this.operationQueue;
  }
  private scheduleGit(): Promise<void> {
    if (this.gitTimer) clearTimeout(this.gitTimer);
    this.gitTimerResolve?.();
    return new Promise((resolve) => {
      this.gitTimerResolve = resolve;
      this.gitTimer = setTimeout(() => {
        this.gitTimer = undefined;
        const finish = this.gitTimerResolve;
        this.gitTimerResolve = undefined;
        void this.refreshGit().finally(() => finish?.());
      }, 500);
    });
  }

  private async registerGitRepositoryListener(): Promise<void> {
    try {
      const extension = vscode.extensions.getExtension('vscode.git');
      const exports = extension?.isActive ? extension.exports : await extension?.activate();
      const api = exports?.getAPI?.(1);
      const attach = (repository: any) => {
        const rootUri = repository?.rootUri as vscode.Uri | undefined;
        if (!rootUri || !this.diskUri.fsPath.startsWith(rootUri.fsPath)) return;
        const disposable = repository.state?.onDidChange?.(() => this.scheduleGit());
        if (disposable) this.disposables.push(disposable);
      };
      for (const repository of api?.repositories ?? []) attach(repository);
      const openDisposable = api?.onDidOpenRepository?.(attach);
      if (openDisposable) this.disposables.push(openDisposable);
    } catch {
      // Git extension is optional; document/save events still drive refreshes.
    }
  }
  private async refreshGit(): Promise<void> {
    if (!this.visible || this.disposed) return;
    const revision = this.sync.snapshot.revision;
    const taskId = ++this.gitTask;
    try {
      this.gitInFlight = true;
      const startedAt = performance.now();
      const result = await computeGitLineRanges(this.diskUri, this.document.getText(), revision, String(taskId));
      this.lastGitMs = performance.now() - startedAt;
      if (this.disposed || !this.visible || result.revision !== this.sync.snapshot.revision || result.taskId !== String(this.gitTask)) return;
      this.post({ type: 'gitStatusChanged', documentId: this.documentId, revision, lineRanges: result.lineRanges });
    } catch (error) { console.warn('[EasyView_Md] Git status refresh failed', error); } finally { this.gitInFlight = false; }
  }

  getDiagnostics(): Record<string, unknown> {
    const content = this.adapter.content;
    const lines = content.split('\n');
    return {
      documentKey: hashContent(this.documentId),
      visible: this.visible,
      revision: this.sync.snapshot.revision,
      syncState: this.sync.snapshot.state,
      inFlightEdits: this.sync.snapshot.inFlight ? 1 : 0,
      bufferedEdits: this.sync.snapshot.bufferedEdits,
      gitDebounced: Boolean(this.gitTimer),
      gitInFlight: this.gitInFlight,
      topLevelBlocks: Math.max(0, content.split(/\n\s*\n/).length),
      headings: lines.filter((line) => /^\s{0,3}#{1,6}\s/.test(line)).length,
      tables: lines.filter((line, index) => index + 1 < lines.length && /^\s*\|/.test(line) && /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+/.test(lines[index + 1])).length,
      lastPatchMs: Number(this.lastPatchMs.toFixed(2)),
      lastGitMs: Number(this.lastGitMs.toFixed(2)),
      lastSnapshotReason: this.lastSnapshotReason,
      lastConflictReason: this.lastConflictReason || null,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.gitTimer) clearTimeout(this.gitTimer);
    this.gitTimerResolve?.();
    this.gitTimerResolve = undefined;
    disposeTerminalForPanel(this.panel);
    this.aiChatHost.dispose();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.sync.dispose();
    this.options.onDisposed(this);
  }
}
