import * as vscode from 'vscode';
import * as path from 'path';
import { SETTINGS_COMMENT_RE, extractSettings, repairSerializedMarkdownContent, type EditorSettings } from './providerUtils';
import { buildImagePathMap } from './providerImageManager';
import { handleWebviewMessage, MessageHandlerContext } from './providerMessageHandler';
import { computeGitLineRanges, type GitLineRange } from './gitChangeTracker';
import { consumePendingCursorForUri } from './openCursorContext';
import { consumePendingDocumentContentForUri } from './openDocumentSnapshot';
import { logOpenWithDebug } from './openWithDebug';
import { disposeTerminalForPanel } from './terminalSessionManager';
import { registerNativeOutlineNavigationGuard } from './nativeOutlineNavigation';

function getDefaultTerminalFontFamily(): string {
  if (process.platform === 'darwin') {
    return 'Menlo, Monaco, "Courier New", monospace';
  }
  if (process.platform === 'win32') {
    return 'Cascadia Mono, Consolas, "Courier New", monospace';
  }
  return '"DejaVu Sans Mono", "Liberation Mono", monospace';
}

function readTerminalAppearance(): { fontFamily: string; fontSize: number; lineHeight: number; fontWeight: string; fontWeightBold: string; letterSpacing: number } {
  const terminalConfig = vscode.workspace.getConfiguration('terminal.integrated');
  const terminalFontFamily = terminalConfig.get<string>('fontFamily', '').trim();
  return {
    fontFamily: terminalFontFamily || getDefaultTerminalFontFamily(),
    fontSize: terminalConfig.get<number>('fontSize', 13),
    lineHeight: terminalConfig.get<number>('lineHeight', 1),
    fontWeight: terminalConfig.get<string>('fontWeight', 'normal'),
    fontWeightBold: terminalConfig.get<string>('fontWeightBold', 'bold'),
    letterSpacing: terminalConfig.get<number>('letterSpacing', 0),
  };
}

/**
 * CustomTextEditorProvider for WYSIWYG Markdown editing.
 * Uses ProseMirror in a webview to provide rich editing while
 * keeping the underlying TextDocument as the source of truth.
 */
export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'inlineMd.markdownEditor';
  private static instance: MarkdownEditorProvider | undefined;

  /** The most recently focused webview panel (for command-triggered actions). */
  private activePanel: vscode.WebviewPanel | undefined;
  private readonly panelsByDocumentUri = new Map<string, Set<vscode.WebviewPanel>>();

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new MarkdownEditorProvider(context);
    MarkdownEditorProvider.instance = provider;

    const editorDisposable = vscode.window.registerCustomEditorProvider(
      MarkdownEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      }
    );
    const outlineNavigationGuard = registerNativeOutlineNavigationGuard(context, MarkdownEditorProvider.viewType);

    const exportHtmlLightCommand = vscode.commands.registerCommand('inlineMd.exportHtmlLight', () => {
      if (provider.activePanel) {
        provider.activePanel.webview.postMessage({ type: 'requestExportHtml', theme: 'light' });
      } else {
        vscode.window.showInformationMessage('Open a Markdown file in InLineMd first.');
      }
    });

    const exportHtmlDarkCommand = vscode.commands.registerCommand('inlineMd.exportHtmlDark', () => {
      if (provider.activePanel) {
        provider.activePanel.webview.postMessage({ type: 'requestExportHtml', theme: 'dark' });
      } else {
        vscode.window.showInformationMessage('Open a Markdown file in InLineMd first.');
      }
    });

    const exportPdfLightCommand = vscode.commands.registerCommand('inlineMd.exportPdfLight', () => {
      if (provider.activePanel) {
        provider.activePanel.webview.postMessage({ type: 'requestExportPdf', theme: 'light' });
      } else {
        vscode.window.showInformationMessage('Open a Markdown file in InLineMd first.');
      }
    });

    const exportPdfDarkCommand = vscode.commands.registerCommand('inlineMd.exportPdfDark', () => {
      if (provider.activePanel) {
        provider.activePanel.webview.postMessage({ type: 'requestExportPdf', theme: 'dark' });
      } else {
        vscode.window.showInformationMessage('Open a Markdown file in InLineMd first.');
      }
    });

    // Override VS Code's undo/redo for our custom editor — prevents VS Code's
    // TextDocument undo from conflicting with ProseMirror's internal undo.
    // The webview handles Ctrl+Z/Y keyboard events directly via ProseMirror keymap,
    // so these commands are intentionally no-ops.
    const undoCommand = vscode.commands.registerCommand('inlineMd.undo', () => {});
    const redoCommand = vscode.commands.registerCommand('inlineMd.redo', () => {});
    const revealCursorCommand = vscode.commands.registerCommand(
      'inlineMd.revealCursorInEasyView',
      async (uri: vscode.Uri, line: number, character: number) => {
        await provider.revealCursorInEasyView(uri, line, character);
      }
    );

    return vscode.Disposable.from(editorDisposable, outlineNavigationGuard, exportHtmlLightCommand, exportHtmlDarkCommand, exportPdfLightCommand, exportPdfDarkCommand, undoCommand, redoCommand, revealCursorCommand);
  }

  public static async reloadPanelsForDocument(uri: vscode.Uri, contentOverride?: string): Promise<boolean> {
    return MarkdownEditorProvider.instance?.reloadPanelsForDocument(uri, contentOverride) ?? false;
  }

  public static hasPanelsForDocument(uri: vscode.Uri): boolean {
    return MarkdownEditorProvider.instance?.hasPanelsForDocument(uri) ?? false;
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  private getSettingsKey(document: vscode.TextDocument): string {
    return `mdpre-zalman.editorSettings:${document.uri.toString()}`;
  }

  private getTableFirstRowStickyDefault(): boolean {
    return this.context.workspaceState.get<boolean>('easyviewMd.tableFirstRowStickyDefault', false);
  }

  private async setTableFirstRowStickyDefault(sticky: boolean): Promise<void> {
    await this.context.workspaceState.update('easyviewMd.tableFirstRowStickyDefault', sticky);
  }

  private hasPanelsForDocument(uri: vscode.Uri): boolean {
    const panels = this.panelsByDocumentUri.get(uri.toString());
    return !!panels && panels.size > 0;
  }

  private readStoredSettings(document: vscode.TextDocument, rawContent: string): EditorSettings {
    const legacySettings = extractSettings(rawContent);
    const stored = this.context.workspaceState.get<Partial<EditorSettings>>(this.getSettingsKey(document));
    return {
      fullWidth: stored?.fullWidth ?? legacySettings.fullWidth,
      tocVisible: stored?.tocVisible ?? legacySettings.tocVisible,
      tableWrap: stored?.tableWrap ?? legacySettings.tableWrap,
    };
  }

  private async reloadPanelsForDocument(uri: vscode.Uri, contentOverride?: string): Promise<boolean> {
    const key = uri.toString();
    const panels = this.panelsByDocumentUri.get(key);
    if (!panels || panels.size === 0) {
      logOpenWithDebug('provider.reloadPanels.skipped', { path: uri.fsPath, reason: 'no-panels' });
      return false;
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const rawContent = contentOverride ?? document.getText();
    const settings = this.readStoredSettings(document, rawContent);
    const contentWithoutComment = repairSerializedMarkdownContent(rawContent.replace(SETTINGS_COMMENT_RE, '').replace(/\r\n/g, '\n'));
    const gitLineRanges = await computeGitLineRanges(document.uri, rawContent);
    const activeEditor = vscode.window.activeTextEditor;
    const initialCursorLine = activeEditor && activeEditor.document.uri.toString() === document.uri.toString()
      ? activeEditor.selection.active.line
      : 0;
    const initialCursorCharacter = activeEditor && activeEditor.document.uri.toString() === document.uri.toString()
      ? activeEditor.selection.active.character
      : 0;

    for (const panel of panels) {
      const imagePathMap = buildImagePathMap(contentWithoutComment, panel.webview, document.uri);
      panel.webview.postMessage({
        type: 'init',
        content: contentWithoutComment,
        filename: path.basename(document.uri.fsPath).replace(/\.(md|markdown|mdx)$/i, ''),
        filePath: document.uri.fsPath,
        fullWidth: settings.fullWidth,
        tocVisible: settings.tocVisible,
        tableWrap: settings.tableWrap,
        tableFirstRowStickyDefault: this.getTableFirstRowStickyDefault(),
        imagePathMap,
        gitLineRanges,
        initialCursorLine,
        initialCursorCharacter,
        initialTotalLines: Math.max(1, document.lineCount),
        terminalAppearance: readTerminalAppearance(),
      });
    }

    logOpenWithDebug('provider.reloadPanels.completed', {
      path: uri.fsPath,
      panelCount: panels.size,
      contentLength: contentWithoutComment.length,
      mode: 'soft-init-postMessage',
    });
    return true;
  }

  private async revealCursorInEasyView(uri: vscode.Uri, line: number, character: number): Promise<void> {
    const key = uri.toString();
    const panels = this.panelsByDocumentUri.get(key);
    if (!panels || panels.size === 0) return;
    const panel = [...panels].find((candidate) => candidate.visible) ?? [...panels][0];
    if (!panel) return;
    const textDocument = await vscode.workspace.openTextDocument(uri);
    panel.webview.postMessage({
      type: 'revealCursor',
      line,
      character,
      totalLines: Math.max(1, textDocument.lineCount),
    });
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const t0 = performance.now();
    console.log(`[InLineMd perf] resolveCustomTextEditor START`);

    // Get document directory and workspace folder for image access
    const documentDir = vscode.Uri.joinPath(document.uri, '..');
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

    const localResourceRoots = [
      vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
      vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      documentDir, // Allow images relative to document
    ];

    // Add workspace folder root if available
    if (workspaceFolder) {
      localResourceRoots.push(workspaceFolder.uri);
    }

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots,
    };

    // Track active panel for command-triggered actions
    this.activePanel = webviewPanel;
    const documentUriKey = document.uri.toString();
    const panelSet = this.panelsByDocumentUri.get(documentUriKey) ?? new Set<vscode.WebviewPanel>();
    panelSet.add(webviewPanel);
    this.panelsByDocumentUri.set(documentUriKey, panelSet);
    webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) {
        this.activePanel = webviewPanel;
      }
    });

    // Track whether we are currently pushing an update to avoid loops
    let isUpdatingWebview = false;
    let isUpdatingDocument = false;
    const pendingInitialContent = consumePendingDocumentContentForUri(document.uri);
    let lastKnownContent = pendingInitialContent ?? document.getText();
    logOpenWithDebug('provider.resolve.start', {
      path: document.uri.fsPath,
      pendingInitialLength: pendingInitialContent?.length ?? -1,
      documentTextLength: document.getText().length,
      initialLastKnownLength: lastKnownContent.length,
      isDirty: document.isDirty,
    });

    // Sequential operation queue — prevents edit/save interleaving via await
    let operationQueue: Promise<void> = Promise.resolve();
    let lastGitLineRangesJson = '';
    let latestGitRequestId = 0;

    const normalizeForWebview = (content: string) =>
      repairSerializedMarkdownContent(content.replace(SETTINGS_COMMENT_RE, '').replace(/\r\n/g, '\n'));

    const postGitChanges = async (contentOverride?: string) => {
      const requestId = ++latestGitRequestId;
      const content = contentOverride ?? lastKnownContent;
      const normalizedContent = normalizeForWebview(content);
      let lineRanges: GitLineRange[] = [];
      try {
        lineRanges = await computeGitLineRanges(document.uri, content);
      } catch (error) {
        console.warn('[InLineMd] Failed to compute Git changes:', error);
      }

      // Ignore stale async responses; only latest invocation may update UI.
      if (requestId !== latestGitRequestId) return;

      const nextJson = JSON.stringify({ lineRanges, content: normalizedContent });
      if (nextJson === lastGitLineRangesJson) return;
      lastGitLineRangesJson = nextJson;
      webviewPanel.webview.postMessage({
        type: 'gitStatusChanged',
        lineRanges,
        content: normalizedContent,
      });
    };

    // Helper: get filename without extension
    const getFilename = () => {
      const basename = path.basename(document.uri.fsPath);
      return basename.replace(/\.(md|markdown|mdx)$/i, '');
    };

    const settingsKey = this.getSettingsKey(document);
    const readStoredSettings = (rawContent: string): EditorSettings => this.readStoredSettings(document, rawContent);

    const updateStoredSettings = async (settings: EditorSettings) => {
      await this.context.workspaceState.update(settingsKey, settings);
    };

    // Build message handler context — bridges closure state to the extracted handler
    const messageCtx: MessageHandlerContext = {
      webviewPanel,
      document,
      getFilename,
      getLastKnownContent: () => lastKnownContent,
      setLastKnownContent: (content: string) => { lastKnownContent = content; },
      getIsUpdatingWebview: () => isUpdatingWebview,
      setIsUpdatingWebview: (value: boolean) => { isUpdatingWebview = value; },
      getIsUpdatingDocument: () => isUpdatingDocument,
      setIsUpdatingDocument: (value: boolean) => { isUpdatingDocument = value; },
      getOperationQueue: () => operationQueue,
      setOperationQueue: (queue: Promise<void>) => { operationQueue = queue; },
      refreshGitChanges: () => postGitChanges(),
      getEditorSettings: () => readStoredSettings(document.getText()),
      updateEditorSettings: updateStoredSettings,
      getTableFirstRowStickyDefault: () => this.getTableFirstRowStickyDefault(),
      setTableFirstRowStickyDefault: (sticky: boolean) => this.setTableFirstRowStickyDefault(sticky),
    };

    // Extension -> Webview: sync on external document changes
    const changeSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (isUpdatingDocument) return;

      const newContent = document.getText();
      if (newContent === lastKnownContent) return;

      logOpenWithDebug('provider.onDidChangeTextDocument', {
        path: document.uri.fsPath,
        newLength: newContent.length,
        previousLength: lastKnownContent.length,
        reason: e.reason ?? 'unknown',
        changeCount: e.contentChanges.length,
      });
      lastKnownContent = newContent;

      // Remove settings comment and normalize to LF before sending to webview
      const contentWithoutComment = normalizeForWebview(newContent);

      // Build image path mapping
      const imagePathMap = buildImagePathMap(contentWithoutComment, webviewPanel.webview, document.uri);

      const isUndoRedo = e.reason === vscode.TextDocumentChangeReason.Undo ||
                          e.reason === vscode.TextDocumentChangeReason.Redo;

      isUpdatingWebview = true;
      webviewPanel.webview.postMessage({
        type: 'documentChanged',
        content: contentWithoutComment,
        imagePathMap: imagePathMap,
        isUndoRedo,
      });
      void postGitChanges(newContent);
      setTimeout(() => { isUpdatingWebview = false; }, 100);
    });

    // Webview -> Extension: handle messages from ProseMirror
    const messageSubscription = webviewPanel.webview.onDidReceiveMessage(async (message) => {
      await handleWebviewMessage(messageCtx, message);
    });

    // Prepare initial data to embed directly in HTML (avoids postMessage race condition)
    const t1 = performance.now();
    const rawContent = lastKnownContent;
    console.log(`[InLineMd perf] getText: ${(performance.now() - t1).toFixed(1)}ms`);
    logOpenWithDebug('provider.initialDataPrepared', {
      path: document.uri.fsPath,
      rawLength: rawContent.length,
    });

    const t2 = performance.now();
    const settings = readStoredSettings(rawContent);
    const contentWithoutComment = normalizeForWebview(rawContent);
    console.log(`[InLineMd perf] extractSettings+strip: ${(performance.now() - t2).toFixed(1)}ms`);

    const t3 = performance.now();
    const imagePathMap = buildImagePathMap(contentWithoutComment, webviewPanel.webview, document.uri);
    console.log(`[InLineMd perf] buildImagePathMap: ${(performance.now() - t3).toFixed(1)}ms`);

    const initialGitLineRanges = await computeGitLineRanges(document.uri, rawContent);
    const pendingCursor = consumePendingCursorForUri(document.uri);
    const activeEditor = vscode.window.activeTextEditor;
    const initialCursorLine = pendingCursor
      ? pendingCursor.line
      : (activeEditor && activeEditor.document.uri.toString() === document.uri.toString()
        ? activeEditor.selection.active.line
        : 0);
    const initialCursorCharacter = pendingCursor
      ? pendingCursor.character
      : (activeEditor && activeEditor.document.uri.toString() === document.uri.toString()
        ? activeEditor.selection.active.character
        : 0);

    const initialData = {
      type: 'init',
      content: contentWithoutComment,
      filename: getFilename(),
      filePath: document.uri.fsPath,
      fullWidth: settings.fullWidth,
      tocVisible: settings.tocVisible,
      tableWrap: settings.tableWrap,
      tableFirstRowStickyDefault: this.getTableFirstRowStickyDefault(),
      imagePathMap,
      gitLineRanges: initialGitLineRanges,
      initialCursorLine,
      initialCursorCharacter,
      initialTotalLines: Math.max(1, document.lineCount),
      terminalAppearance: readTerminalAppearance(),
    };
    lastGitLineRangesJson = JSON.stringify({
      lineRanges: initialGitLineRanges,
      content: contentWithoutComment,
    });

    // Set HTML with embedded initial data — no postMessage needed for first load
    const t4 = performance.now();
    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, initialData);
    logOpenWithDebug('provider.webviewHtmlAssigned', {
      path: document.uri.fsPath,
      initContentLength: contentWithoutComment.length,
    });
    console.log(`[InLineMd perf] getHtmlForWebview+assign: ${(performance.now() - t4).toFixed(1)}ms`);
    console.log(`[InLineMd perf] resolveCustomTextEditor TOTAL: ${(performance.now() - t0).toFixed(1)}ms`);

    const gitRefreshInterval = setInterval(() => {
      void postGitChanges();
    }, 1500);

    const saveSubscription = vscode.workspace.onDidSaveTextDocument((savedDocument) => {
      if (savedDocument.uri.toString() === document.uri.toString()) {
        void postGitChanges(savedDocument.getText());
      }
    });

    // Cleanup
    webviewPanel.onDidDispose(() => {
      disposeTerminalForPanel(webviewPanel);
      changeSubscription.dispose();
      messageSubscription.dispose();
      saveSubscription.dispose();
      clearInterval(gitRefreshInterval);
      if (this.activePanel === webviewPanel) {
        this.activePanel = undefined;
      }
      const existing = this.panelsByDocumentUri.get(documentUriKey);
      if (existing) {
        existing.delete(webviewPanel);
        if (existing.size === 0) {
          this.panelsByDocumentUri.delete(documentUriKey);
        }
      }
    });
  }

  private getHtmlForWebview(webview: vscode.Webview, initialData?: any): string {
    const assetVersion = `${Date.now()}`;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')
    ).with({ query: `v=${assetVersion}` });
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css')
    ).with({ query: `v=${assetVersion}` });
    const xtermStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'xterm.css')
    ).with({ query: `v=${assetVersion}` });
    const pdfCjkNormalFontUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'SourceHanSansCN-Normal.otf')
    ).with({ query: `v=${assetVersion}` });
    const pdfCjkBoldFontUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'SourceHanSansCN-Heavy.otf')
    ).with({ query: `v=${assetVersion}` });
    const pdfSymbolsFontUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'NotoSansSymbols2-Regular.ttf')
    ).with({ query: `v=${assetVersion}` });
    const nonce = getNonce();

    // Get CSV delimiter setting from configuration
    const config = vscode.workspace.getConfiguration('inlineMd');
    const csvDelimiter = config.get<string>('csvDelimiter', 'auto');

    // Get system locale from Node.js Intl API (Windows locale, not VS Code locale)
    // Note: This often doesn't work in VS Code and returns 'en-US' even on non-English systems
    let systemLocale = 'en-US';
    try {
      systemLocale = new Intl.DateTimeFormat().resolvedOptions().locale;
    } catch (e) {
      // Fallback to VS Code locale if Intl fails
      systemLocale = vscode.env.language;
    }

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
        style-src ${webview.cspSource} 'unsafe-inline';
        script-src 'nonce-${nonce}';
        img-src ${webview.cspSource} https: http: data:;
        font-src ${webview.cspSource};
        connect-src ${webview.cspSource} https: http:;
        worker-src 'none';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${styleUri}" rel="stylesheet">
    <link href="${xtermStyleUri}" rel="stylesheet">
    <title>InLineMd</title>
    <script nonce="${nonce}">
      // CRITICAL: Prevent Service Worker registration BEFORE any other code runs
      // VS Code webview does not support Service Workers
      (function() {
        try {
          // Completely remove serviceWorker from navigator
          if ('serviceWorker' in navigator) {
            Object.defineProperty(navigator, 'serviceWorker', {
              get: function() { return undefined; },
              configurable: false,
              enumerable: false
            });
          }

          // Also prevent registration through other means
          if (window.ServiceWorkerContainer) {
            window.ServiceWorkerContainer.prototype.register = function() {
              return Promise.reject(new Error('Service Workers are not supported in VS Code webview'));
            };
          }
        } catch (e) {
          console.warn('Could not disable Service Worker:', e);
        }
      })();

      // Set system locale and CSV delimiter preference for webview
      window.systemLocale = '${systemLocale}';
      window.csvDelimiterSetting = '${csvDelimiter}';
      window.__easyviewPdfFonts = ${JSON.stringify({
        normal: pdfCjkNormalFontUri.toString(),
        bold: pdfCjkBoldFontUri.toString(),
        symbols: pdfSymbolsFontUri.toString(),
      })};
      ${initialData ? `window.__INITIAL_DATA__ = ${JSON.stringify(initialData)};` : ''}
    </script>
</head>
<body class="inlinemd-booting">
    <div id="title-bar"></div>
    <div id="editor-body">
      <div id="editor-scroll-area">
        <div id="editor"></div>
      </div>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}


function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
