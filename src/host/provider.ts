import * as vscode from 'vscode';
import * as path from 'path';
import { SETTINGS_COMMENT_RE, extractSettings, type EditorSettings } from './providerUtils';
import { buildImagePathMap } from './providerImageManager';
import { handleWebviewMessage, MessageHandlerContext } from './providerMessageHandler';
import { computeGitLineRanges, type GitLineRange } from './gitChangeTracker';

/**
 * CustomTextEditorProvider for WYSIWYG Markdown editing.
 * Uses ProseMirror in a webview to provide rich editing while
 * keeping the underlying TextDocument as the source of truth.
 */
export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'inlineMd.markdownEditor';

  /** The most recently focused webview panel (for command-triggered actions). */
  private activePanel: vscode.WebviewPanel | undefined;

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new MarkdownEditorProvider(context);

    const editorDisposable = vscode.window.registerCustomEditorProvider(
      MarkdownEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      }
    );

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

    return vscode.Disposable.from(editorDisposable, exportHtmlLightCommand, exportHtmlDarkCommand, exportPdfLightCommand, exportPdfDarkCommand, undoCommand, redoCommand);
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

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
    webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) {
        this.activePanel = webviewPanel;
      }
    });

    // Track whether we are currently pushing an update to avoid loops
    let isUpdatingWebview = false;
    let isUpdatingDocument = false;
    let lastKnownContent = document.getText();

    // Sequential operation queue — prevents edit/save interleaving via await
    let operationQueue: Promise<void> = Promise.resolve();
    let lastGitLineRangesJson = '';

    const postGitChanges = async (contentOverride?: string) => {
      const content = contentOverride ?? document.getText();
      let lineRanges: GitLineRange[] = [];
      try {
        lineRanges = await computeGitLineRanges(document.uri, content);
      } catch (error) {
        console.warn('[InLineMd] Failed to compute Git changes:', error);
      }

      const nextJson = JSON.stringify(lineRanges);
      if (nextJson === lastGitLineRangesJson) return;
      lastGitLineRangesJson = nextJson;
      webviewPanel.webview.postMessage({
        type: 'gitStatusChanged',
        lineRanges,
      });
    };

    // Helper: get filename without extension
    const getFilename = () => {
      const basename = path.basename(document.uri.fsPath);
      return basename.replace(/\.(md|markdown|mdx)$/i, '');
    };

    const settingsKey = `mdpre-zalman.editorSettings:${document.uri.toString()}`;
    const readStoredSettings = (rawContent: string): EditorSettings => {
      const legacySettings = extractSettings(rawContent);
      const stored = this.context.workspaceState.get<Partial<EditorSettings>>(settingsKey);
      return {
        fullWidth: stored?.fullWidth ?? legacySettings.fullWidth,
        tocVisible: stored?.tocVisible ?? legacySettings.tocVisible,
        tableWrap: stored?.tableWrap ?? legacySettings.tableWrap,
      };
    };

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
    };

    // Extension -> Webview: sync on external document changes
    const changeSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (isUpdatingDocument) return;

      const newContent = document.getText();
      if (newContent === lastKnownContent) return;

      lastKnownContent = newContent;

      // Remove settings comment and normalize to LF before sending to webview
      const contentWithoutComment = newContent.replace(SETTINGS_COMMENT_RE, '').replace(/\r\n/g, '\n');

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
    const rawContent = document.getText();
    console.log(`[InLineMd perf] getText: ${(performance.now() - t1).toFixed(1)}ms`);

    const t2 = performance.now();
    const settings = readStoredSettings(rawContent);
    const contentWithoutComment = rawContent.replace(SETTINGS_COMMENT_RE, '').replace(/\r\n/g, '\n');
    console.log(`[InLineMd perf] extractSettings+strip: ${(performance.now() - t2).toFixed(1)}ms`);

    const t3 = performance.now();
    const imagePathMap = buildImagePathMap(contentWithoutComment, webviewPanel.webview, document.uri);
    console.log(`[InLineMd perf] buildImagePathMap: ${(performance.now() - t3).toFixed(1)}ms`);

    const initialGitLineRanges = await computeGitLineRanges(document.uri, rawContent);

    const initialData = {
      type: 'init',
      content: contentWithoutComment,
      filename: getFilename(),
      fullWidth: settings.fullWidth,
      tocVisible: settings.tocVisible,
      tableWrap: settings.tableWrap,
      imagePathMap,
      gitLineRanges: initialGitLineRanges,
    };
    lastGitLineRangesJson = JSON.stringify(initialGitLineRanges);

    // Set HTML with embedded initial data — no postMessage needed for first load
    const t4 = performance.now();
    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, initialData);
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
      changeSubscription.dispose();
      messageSubscription.dispose();
      saveSubscription.dispose();
      clearInterval(gitRefreshInterval);
      if (this.activePanel === webviewPanel) {
        this.activePanel = undefined;
      }
    });
  }

  private getHtmlForWebview(webview: vscode.Webview, initialData?: any): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css')
    );
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
        connect-src https: http:;
        worker-src 'none';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${styleUri}" rel="stylesheet">
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
