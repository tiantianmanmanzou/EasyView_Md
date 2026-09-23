import * as vscode from 'vscode';
import * as path from 'path';
import { type EditorSettings, extractSettings } from './providerUtils';
import { registerNativeOutlineNavigationGuard } from '../../native-editor/nativeOutlineNavigation';
import { productThemeBootstrapScript, readProductTheme } from '../../theme/productThemeBridge';
import { resolveMarkdownDiskUri } from '../../application/document/openMarkdownEditor';
import { MarkdownEditorSession } from '../../application/document/markdownEditorSession';
import {
  sameMarkdownResource,
  toDiskFileUri,
  toEasyViewMarkdownUri,
} from '../../application/document/markdownUri';

/**
 * CustomTextEditorProvider for WYSIWYG Markdown editing.
 * Uses ProseMirror in a webview to provide rich editing while
 * keeping the underlying TextDocument as the source of truth.
 */
export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'easyviewMd.markdownEditor';
  private static instance: MarkdownEditorProvider | undefined;

  /** The most recently focused webview panel (for command-triggered actions). */
  private activePanel: vscode.WebviewPanel | undefined;
  private readonly panelsByDocumentUri = new Map<string, Set<vscode.WebviewPanel>>();
  private readonly sessionsByDocumentUri = new Map<string, Set<MarkdownEditorSession>>();

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new MarkdownEditorProvider(context);
    MarkdownEditorProvider.instance = provider;

    const editorDisposable = vscode.window.registerCustomEditorProvider(
      MarkdownEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: false },
        supportsMultipleEditorsPerDocument: false,
      }
    );
    const outlineNavigationGuard = registerNativeOutlineNavigationGuard(context, MarkdownEditorProvider.viewType);

    const exportHtmlLightCommand = vscode.commands.registerCommand('easyviewMd.exportHtmlLight', () => {
      if (provider.activePanel) {
        provider.activePanel.webview.postMessage({ type: 'requestExportHtml', theme: 'light' });
      } else {
        vscode.window.showInformationMessage('Open a Markdown file in EasyView_Md first.');
      }
    });

    const exportHtmlDarkCommand = vscode.commands.registerCommand('easyviewMd.exportHtmlDark', () => {
      if (provider.activePanel) {
        provider.activePanel.webview.postMessage({ type: 'requestExportHtml', theme: 'dark' });
      } else {
        vscode.window.showInformationMessage('Open a Markdown file in EasyView_Md first.');
      }
    });

    const exportPdfLightCommand = vscode.commands.registerCommand('easyviewMd.exportPdfLight', () => {
      if (provider.activePanel) {
        provider.activePanel.webview.postMessage({ type: 'requestExportPdf', theme: 'light' });
      } else {
        vscode.window.showInformationMessage('Open a Markdown file in EasyView_Md first.');
      }
    });

    const exportPdfDarkCommand = vscode.commands.registerCommand('easyviewMd.exportPdfDark', () => {
      if (provider.activePanel) {
        provider.activePanel.webview.postMessage({ type: 'requestExportPdf', theme: 'dark' });
      } else {
        vscode.window.showInformationMessage('Open a Markdown file in EasyView_Md first.');
      }
    });

    // Override VS Code's undo/redo for our custom editor — prevents VS Code's
    // TextDocument undo from conflicting with ProseMirror's internal undo.
    // The webview handles Ctrl+Z/Y keyboard events directly via ProseMirror keymap,
    // so these commands are intentionally no-ops.
    const undoCommand = vscode.commands.registerCommand('easyviewMd.undo', () => {});
    const redoCommand = vscode.commands.registerCommand('easyviewMd.redo', () => {});
    const revealCursorCommand = vscode.commands.registerCommand(
      'easyviewMd.revealCursorInEasyView',
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

  public static notifyActivePanel(message: { type: string; [key: string]: unknown }): boolean {
    const panel = MarkdownEditorProvider.instance?.activePanel;
    if (!panel) return false;
    void panel.webview.postMessage(message);
    return true;
  }

  public static getDiagnostics(): Record<string, unknown> {
    return MarkdownEditorProvider.instance?.collectDiagnostics() ?? {
      editorSessions: 0,
      visibleEditors: 0,
      hiddenEditors: 0,
      sessions: [],
    };
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
    const keys = new Set<string>([uri.toString()]);
    try {
      keys.add(toDiskFileUri(uri).toString());
      keys.add(toEasyViewMarkdownUri(toDiskFileUri(uri)).toString());
      keys.add(resolveMarkdownDiskUri(uri).toString());
    } catch {
      // ignore URI mapping failures
    }
    for (const key of keys) {
      const panels = this.panelsByDocumentUri.get(key);
      if (panels && panels.size > 0) return true;
    }
    return false;
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
    const keys = new Set([uri.toString(), toDiskFileUri(uri).toString(), toEasyViewMarkdownUri(toDiskFileUri(uri)).toString()]);
    const sessions = [...keys].flatMap((key) => [...(this.sessionsByDocumentUri.get(key) ?? [])]);
    if (sessions.length === 0) return false;
    await Promise.all(sessions.map((session) => session.refreshSnapshot('reload', contentOverride)));
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
    const diskUri = resolveMarkdownDiskUri(document.uri);
    const documentDir = vscode.Uri.file(path.dirname(diskUri.fsPath));
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(diskUri);
    const localResourceRoots = [
      vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'media'),
      documentDir,
    ];
    if (workspaceFolder) localResourceRoots.push(workspaceFolder.uri);
    webviewPanel.webview.options = { enableScripts: true, localResourceRoots };

    const documentUriKey = document.uri.toString();
    const panelSet = this.panelsByDocumentUri.get(documentUriKey) ?? new Set<vscode.WebviewPanel>();
    panelSet.add(webviewPanel);
    this.panelsByDocumentUri.set(documentUriKey, panelSet);
    this.activePanel = webviewPanel;

    const session = new MarkdownEditorSession({
      context: this.context,
      document,
      panel: webviewPanel,
      getHtml: (webview) => this.getHtmlForWebview(webview),
      getTableFirstRowStickyDefault: () => this.getTableFirstRowStickyDefault(),
      getEditorSettings: () => this.readStoredSettings(document, document.getText()),
      updateEditorSettings: (settings) => Promise.resolve(this.context.workspaceState.update(this.getSettingsKey(document), settings)),
      onActive: () => { this.activePanel = webviewPanel; },
      setTableFirstRowStickyDefault: (value) => this.setTableFirstRowStickyDefault(value),
      onDisposed: () => {
        const sessions = this.sessionsByDocumentUri.get(documentUriKey);
        sessions?.delete(session);
        if (sessions?.size === 0) this.sessionsByDocumentUri.delete(documentUriKey);
        if (this.activePanel === webviewPanel) this.activePanel = undefined;
        const panels = this.panelsByDocumentUri.get(documentUriKey);
        panels?.delete(webviewPanel);
        if (panels?.size === 0) this.panelsByDocumentUri.delete(documentUriKey);
      },
    });
    const sessions = this.sessionsByDocumentUri.get(documentUriKey) ?? new Set<MarkdownEditorSession>();
    sessions.add(session);
    this.sessionsByDocumentUri.set(documentUriKey, sessions);
    await session.start();
  }

  private collectDiagnostics(): Record<string, unknown> {
    const sessions = [...this.sessionsByDocumentUri.values()].flatMap((items) => [...items]);
    const details = sessions.map((session) => session.getDiagnostics());
    const visibleEditors = details.filter((item) => item.visible === true).length;
    return {
      editorSessions: sessions.length,
      visibleEditors,
      hiddenEditors: sessions.length - visibleEditors,
      sessions: details,
    };
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const assetVersion = String(this.context.extension.packageJSON.version ?? 'dev');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')
    ).with({ query: `v=${assetVersion}` });
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css')
    ).with({ query: `v=${assetVersion}` });
    const xtermStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'media', 'xterm.css')
    ).with({ query: `v=${assetVersion}` });
    const pdfCjkNormalFontUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'media', 'SourceHanSansCN-Normal.otf')
    ).with({ query: `v=${assetVersion}` });
    const pdfCjkBoldFontUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'media', 'SourceHanSansCN-Heavy.otf')
    ).with({ query: `v=${assetVersion}` });
    const pdfSymbolsFontUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'media', 'NotoSansSymbols2-Regular.ttf')
    ).with({ query: `v=${assetVersion}` });
    const nonce = getNonce();

    // Get CSV delimiter setting from configuration
    const config = vscode.workspace.getConfiguration('easyviewMd');
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
<html lang="en" data-easyview-theme="${readProductTheme(this.context)}">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
        style-src ${webview.cspSource} 'unsafe-inline';
        script-src 'nonce-${nonce}' ${webview.cspSource};
        img-src ${webview.cspSource} https: http: data:;
        font-src ${webview.cspSource};
        connect-src ${webview.cspSource} https: http:;
        worker-src 'none';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${styleUri}" rel="stylesheet">
    <link href="${xtermStyleUri}" rel="stylesheet">
    <title>EasyView_Md</title>
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
      ${productThemeBootstrapScript(readProductTheme(this.context))}
    </script>
</head>
<body class="inlinemd-booting" data-easyview-theme="${readProductTheme(this.context)}">
    <div id="title-bar"></div>
    <div id="editor-body">
      <div id="editor-scroll-area">
        <div id="editor"></div>
      </div>
    </div>
    <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
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
