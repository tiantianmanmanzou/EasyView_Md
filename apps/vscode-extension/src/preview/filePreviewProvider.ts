import * as vscode from 'vscode';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import {
  isEasyViewThemeMode,
  isWritablePreviewRoute,
  resolvePreviewRoute,
  type EasyViewThemeMode,
  type PreviewDescriptor,
  type PreviewTextResult,
} from '@easyview/contracts';
import { extractArchive } from '@easyview/node-runtime';
import { isDesktopOnlyPreviewRoute, isPhase1PreviewRoute, PHASE1_FILENAME_PATTERNS } from '@easyview/preview-ui/phase1';
import {
  productThemeBootstrapScript,
  readPreviewFileTheme,
  readProductTheme,
  registerPreviewThemePanel,
  writePreviewFileTheme,
} from '../theme/productThemeBridge';
import { resolveHtmlPreviewRoot, startHtmlPreviewServer, type HtmlPreviewServer } from './htmlPreviewServer';
import { getLocale } from '@easyview/contracts/i18n';
import { tPreview } from './preview.i18n';
import { FilePreviewDocument } from './filePreviewDocument';

const TEXT_READ_LIMIT = 4 * 1024 * 1024;
const VIEW_TYPE = 'easyviewMd.filePreview';
/** Routes whose parse cost justifies keeping the webview alive while its tab is hidden; others are released. */
const KEEP_ALIVE_ROUTES: ReadonlySet<string> = new Set(['word', 'spreadsheet', 'powerpoint']);
const EXTERNAL_CHANGE_DEBOUNCE_MS = 150;
const RELEASED_HTML = '<!DOCTYPE html><html><body></body></html>';

export class FilePreviewProvider implements vscode.CustomEditorProvider<FilePreviewDocument> {
  static readonly viewType = VIEW_TYPE;
  private static readonly activePanels = new Set<vscode.WebviewPanel>();
  private static lastHtmlReady: { title: string; text: string } | null = null;
  private static lastHtmlContentUrl: string | null = null;
  static readonly filenamePatterns = PHASE1_FILENAME_PATTERNS;

  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<FilePreviewDocument>>();
  readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  static getHtmlPreviewState(): {
    title: string;
    text: string;
    contentUrl: string;
    panels: number;
    visible: number;
  } | null {
    const panels = [...FilePreviewProvider.activePanels];
    return {
      title: FilePreviewProvider.lastHtmlReady?.title ?? '',
      text: FilePreviewProvider.lastHtmlReady?.text ?? '',
      contentUrl: FilePreviewProvider.lastHtmlContentUrl ?? '',
      panels: panels.length,
      visible: panels.filter((panel) => panel.visible).length,
    };
  }

  static async clickHtmlPreviewMenu(text: string): Promise<boolean> {
    const panel = [...FilePreviewProvider.activePanels].find((item) => item.visible)
      ?? [...FilePreviewProvider.activePanels][0];
    if (!panel) return false;
    await panel.webview.postMessage({ type: 'htmlPreviewClick', text });
    return true;
  }

  static getDiagnostics(): { previewSessions: number; visiblePreviews: number; hiddenPreviews: number } {
    const panels = [...FilePreviewProvider.activePanels];
    const visiblePreviews = panels.filter((panel) => panel.visible).length;
    return { previewSessions: panels.length, visiblePreviews, hiddenPreviews: panels.length - visiblePreviews };
  }

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new FilePreviewProvider(context);
    return vscode.window.registerCustomEditorProvider(
      VIEW_TYPE,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    );
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): Promise<FilePreviewDocument> {
    const document = new FilePreviewDocument(uri);
    document.onDidChangeCustomDocument((event) => this._onDidChangeCustomDocument.fire(event));
    return document;
  }

  async saveCustomDocument(
    document: FilePreviewDocument,
    cancellation: vscode.CancellationToken,
  ): Promise<void> {
    await document.saveFromHost(cancellation);
  }

  async saveCustomDocumentAs(
    document: FilePreviewDocument,
    destination: vscode.Uri,
    cancellation: vscode.CancellationToken,
  ): Promise<void> {
    await document.saveFromHost(cancellation);
    const bytes = await vscode.workspace.fs.readFile(document.uri);
    if (cancellation.isCancellationRequested) return;
    await vscode.workspace.fs.writeFile(destination, bytes);
  }

  async revertCustomDocument(
    document: FilePreviewDocument,
    _cancellation: vscode.CancellationToken,
  ): Promise<void> {
    await document.revert();
  }

  async backupCustomDocument(
    document: FilePreviewDocument,
    context: vscode.CustomDocumentBackupContext,
    cancellation: vscode.CancellationToken,
  ): Promise<vscode.CustomDocumentBackup> {
    await document.saveFromHost(cancellation);
    return {
      id: context.destination.toString(),
      delete: async () => {
        try { await vscode.workspace.fs.delete(context.destination); } catch { /* ignore */ }
      },
    };
  }

  async resolveCustomEditor(
    document: FilePreviewDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    FilePreviewProvider.activePanels.add(webviewPanel);
    FilePreviewProvider.lastHtmlReady = null;
    FilePreviewProvider.lastHtmlContentUrl = null;
    document.attachPanel(webviewPanel);
    webviewPanel.onDidDispose(() => FilePreviewProvider.activePanels.delete(webviewPanel));
    const fileName = path.basename(document.uri.fsPath || document.uri.path);
    const route = resolvePreviewRoute(fileName);
    const localRoots = [
      this.context.extensionUri,
      vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'preview'),
    ];
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (workspaceFolder) localRoots.push(workspaceFolder.uri);
    if (document.uri.scheme === 'file') {
      localRoots.push(vscode.Uri.file(path.dirname(document.uri.fsPath)));
    } else {
      localRoots.push(vscode.Uri.joinPath(document.uri, '..'));
    }

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: localRoots,
    };

    if (!route || !isPhase1PreviewRoute(route.route)) {
      const message = route && isDesktopOnlyPreviewRoute(route.route)
        ? tPreview('desktopOnlyType', { route: route.route })
        : tPreview('unsupportedType');
      webviewPanel.webview.html = errorHtml(message);
      return;
    }

    let size = 0;
    let mtimeMs = Date.now();
    try {
      const stat = await vscode.workspace.fs.stat(document.uri);
      size = stat.size;
      mtimeMs = stat.mtime;
    } catch {
      webviewPanel.webview.html = errorHtml(tPreview('readFileFailed'));
      return;
    }

    if (size > route.maxSourceBytes) {
      webviewPanel.webview.html = errorHtml(
        tPreview('fileTooLarge', { size: (route.maxSourceBytes / (1024 * 1024)).toFixed(0), route: route.route }),
      );
      return;
    }

    const sessionId = randomUUID();
    let htmlServer: HtmlPreviewServer | undefined;
    let contentUrl = webviewPanel.webview.asWebviewUri(document.uri).toString();
    if (route.route === 'html' && document.uri.scheme === 'file') {
      try {
        htmlServer = await startHtmlPreviewServer(resolveHtmlPreviewRoot(document.uri));
        contentUrl = await htmlServer.contentUrlFor(document.uri);
      } catch {
        htmlServer?.dispose();
        htmlServer = undefined;
      }
    }
    FilePreviewProvider.lastHtmlContentUrl = route.route === 'html' ? contentUrl : null;
    if (route.route === 'html') {
      try {
        const text = await readPreviewText(document.uri, route.maxSourceBytes);
        FilePreviewProvider.lastHtmlReady = { title: fileName, text: text.content };
      } catch {
        FilePreviewProvider.lastHtmlReady = { title: fileName, text: '' };
      }
    }
    const relativePath = vscode.workspace.asRelativePath(document.uri, false);
    let descriptor: PreviewDescriptor = {
      sessionId,
      relativePath: relativePath === document.uri.fsPath ? fileName : relativePath,
      fileName,
      route: route.route,
      size,
      mtimeMs,
      mimeType: route.mimeType,
      contentUrl,
    };

    const assets = {
      fileViewerAssetBaseUrl: webviewPanel.webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'preview', 'vendor', 'file-viewer'),
      ).toString().replace(/\/?$/, '/'),
      pptAssetBaseUrl: webviewPanel.webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'preview', 'vendor', 'file-viewer', 'vendor', 'ppt'),
      ).toString().replace(/\/?$/, '/'),
      spreadsheetWorkerUrl: webviewPanel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'preview', 'workers', 'spreadsheet-worker.js')).toString(),
      docWorkerUrl: webviewPanel.webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'preview', 'workers', 'doc-worker.js'),
      ).toString(),
    };

    let released = false;
    const render = () => {
      webviewPanel.webview.html = this.getHtml(
        webviewPanel.webview,
        descriptor,
        assets,
        readProductTheme(this.context),
        readPreviewFileTheme(this.context, descriptor.relativePath),
        previewFrameOrigins(descriptor.contentUrl, htmlServer?.origin),
      );
    };
    render();
    document.setReloader(render);

    const viewStateSub = webviewPanel.onDidChangeViewState(() => {
      if (KEEP_ALIVE_ROUTES.has(route.route)) return;
      if (!webviewPanel.visible && !released) {
        released = true;
        webviewPanel.webview.html = RELEASED_HTML;
      } else if (webviewPanel.visible && released) {
        released = false;
        render();
      }
    });

    let pendingWrites = 0;
    let externalChangeTimer: NodeJS.Timeout | undefined;
    const reloadIfChangedExternally = async () => {
      if (pendingWrites > 0) { scheduleExternalChangeCheck(); return; }
      let stat: vscode.FileStat;
      try {
        stat = await vscode.workspace.fs.stat(document.uri);
      } catch {
        return;
      }
      if (stat.size === descriptor.size && stat.mtime === descriptor.mtimeMs) return;
      const nextContentUrl = htmlServer
        ? await htmlServer.contentUrlFor(document.uri)
        : webviewPanel.webview.asWebviewUri(document.uri).with({ query: `v=${stat.mtime}` }).toString();
      descriptor = { ...descriptor, sessionId: randomUUID(), size: stat.size, mtimeMs: stat.mtime, contentUrl: nextContentUrl };
      if (!released) render();
    };
    const scheduleExternalChangeCheck = () => {
      if (externalChangeTimer) clearTimeout(externalChangeTimer);
      externalChangeTimer = setTimeout(() => { void reloadIfChangedExternally(); }, EXTERNAL_CHANGE_DEBOUNCE_MS);
    };
    const fileWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.joinPath(document.uri, '..'), '*'),
      false,
      false,
      true,
    );
    const onWatchedFile = (uri: vscode.Uri) => {
      if (uri.toString() === document.uri.toString()) scheduleExternalChangeCheck();
    };
    const fileChangeSub = fileWatcher.onDidChange(onWatchedFile);
    const fileCreateSub = fileWatcher.onDidCreate(onWatchedFile);

    const themePanelSub = registerPreviewThemePanel(webviewPanel);
    const messageSub = webviewPanel.webview.onDidReceiveMessage(async (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'setDirty' && typeof message.dirty === 'boolean') {
        document.notifyDirty(message.dirty);
        return;
      }
      if (message.type === 'requestSave') {
        await vscode.workspace.save(document.uri);
        return;
      }
      if (message.type === 'hostSaveResult' && typeof message.id === 'string') {
        document.completeSave(message.id, message.ok === true, typeof message.message === 'string' ? message.message : undefined);
        return;
      }
      if (message.type === 'readText' && typeof message.id === 'string') {
        try {
          const result = await readPreviewText(document.uri, route.maxSourceBytes);
          await webviewPanel.webview.postMessage({ type: 'readTextResult', id: message.id, ok: true, value: result });
        } catch (error) {
          await webviewPanel.webview.postMessage({
            type: 'readTextResult',
            id: message.id,
            ok: false,
            message: error instanceof Error ? error.message : tPreview('readTextFailed'),
          });
        }
        return;
      }
      if (message.type === 'extractArchive' && typeof message.id === 'string') {
        try {
          if (document.uri.scheme !== 'file') throw new Error(tPreview('extractLocalOnly'));
          const target = await extractArchive(document.uri.fsPath);
          await webviewPanel.webview.postMessage({ type: 'extractArchiveResult', id: message.id, ok: true, value: path.basename(target) });
        } catch (error) {
          await webviewPanel.webview.postMessage({
            type: 'extractArchiveResult',
            id: message.id,
            ok: false,
            message: error instanceof Error ? error.message : tPreview('extractFailed'),
          });
        }
        return;
      }
      if (message.type === 'writeBytes' && typeof message.id === 'string') {
        try {
          if (!isWritablePreviewRoute(route.route)) {
            throw new Error(tPreview('writeUnsupported'));
          }
          const bytes = decodePreviewBytes(message.bytes, message.encoding);
          if (!bytes || (bytes.byteLength === 0 && route.route !== 'text')) throw new Error(tPreview('writeInvalid'));
          if (bytes.byteLength > route.maxSourceBytes) {
            throw new Error(tPreview('writeTooLarge', { size: (route.maxSourceBytes / (1024 * 1024)).toFixed(0) }));
          }
          pendingWrites += 1;
          let stat: vscode.FileStat;
          try {
            await vscode.workspace.fs.writeFile(document.uri, bytes);
            stat = await vscode.workspace.fs.stat(document.uri);
            descriptor = { ...descriptor, size: stat.size, mtimeMs: stat.mtime };
          } finally {
            pendingWrites -= 1;
          }
          await webviewPanel.webview.postMessage({
            type: 'writeBytesResult',
            id: message.id,
            ok: true,
            value: { size: stat.size, mtimeMs: stat.mtime },
          });
        } catch (error) {
          await webviewPanel.webview.postMessage({
            type: 'writeBytesResult',
            id: message.id,
            ok: false,
            message: error instanceof Error ? error.message : tPreview('saveTableFailed'),
          });
        }
        return;
      }
      if (message.type === 'htmlPreviewReady' && typeof message.text === 'string') {
        FilePreviewProvider.lastHtmlReady = {
          title: typeof message.title === 'string' ? message.title : '',
          text: message.text,
        };
        return;
      }
      if (
        message.type === 'writePreviewFileTheme'
        && typeof message.relativePath === 'string'
        && isEasyViewThemeMode(message.mode)
      ) {
        await writePreviewFileTheme(this.context, message.relativePath, message.mode);
      }
    });

    webviewPanel.onDidDispose(() => {
      document.setReloader(undefined);
      if (externalChangeTimer) clearTimeout(externalChangeTimer);
      htmlServer?.dispose();
      themePanelSub.dispose();
      messageSub.dispose();
      viewStateSub.dispose();
      fileChangeSub.dispose();
      fileCreateSub.dispose();
      fileWatcher.dispose();
    });
  }

  private getHtml(
    webview: vscode.Webview,
    descriptor: PreviewDescriptor,
    assets: { fileViewerAssetBaseUrl: string; pptAssetBaseUrl: string; docWorkerUrl: string; spreadsheetWorkerUrl: string },
    productTheme: EasyViewThemeMode,
    fileTheme: EasyViewThemeMode | null,
    extraOrigins: string[] = [],
  ): string {
    const nonce = getNonce();
    const resourceVersion = getStableResourceVersion(this.context);
    const scriptUri = withResourceVersion(webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'preview-webview.js'),
    ), resourceVersion);
    const styleUri = withResourceVersion(webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'preview', 'preview.css'),
    ), resourceVersion);
    const extra = extraOrigins.filter(Boolean).join(' ');
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: blob: ${extra}`,
      `media-src ${webview.cspSource} blob: ${extra}`,
      `font-src ${webview.cspSource} data: ${extra}`,
      `style-src ${webview.cspSource} 'unsafe-inline' ${extra}`,
      `script-src 'nonce-${nonce}' ${webview.cspSource} 'unsafe-inline' 'wasm-unsafe-eval' ${extra}`,
      `worker-src ${webview.cspSource} blob: ${extra}`,
      `connect-src ${webview.cspSource} blob: data: ${extra}`,
      `frame-src ${webview.cspSource} blob: data: about: ${extra}`,
    ].join('; ');

    const bootstrap = {
      type: 'init',
      descriptor,
      assets,
      productTheme,
      fileTheme,
    };

    return `<!DOCTYPE html>
<html lang="${getLocale()}" data-easyview-theme="${productTheme}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>EasyView Preview</title>
  <style>
    html, body, #root {
      width: 100%;
      height: 100%;
      margin: 0 !important;
      padding: 0 !important;
      border: 0 !important;
      outline: none !important;
      overflow: hidden;
      scrollbar-gutter: auto;
      box-sizing: border-box;
    }
    body {
      color: var(--vscode-editor-foreground);
      background: var(--file-viewer-bg, var(--vscode-editor-background));
      font-family: var(--vscode-font-family);
    }
    html {
      background: var(--file-viewer-bg, var(--vscode-editor-background));
    }
  </style>
</head>
<body data-easyview-theme="${productTheme}">
  <div id="root" class="preview-root"></div>
  <script nonce="${nonce}">${productThemeBootstrapScript(productTheme)}</script>
  <script nonce="${nonce}">window.__EASYVIEW_PREVIEW_BOOTSTRAP__ = ${JSON.stringify(bootstrap)};</script>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

async function readPreviewText(uri: vscode.Uri, maxSourceBytes: number): Promise<PreviewTextResult> {
  const limit = Math.min(TEXT_READ_LIMIT, maxSourceBytes);
  const bytes = await vscode.workspace.fs.readFile(uri);
  const truncated = bytes.byteLength > limit;
  const slice = truncated ? bytes.subarray(0, limit) : bytes;
  let content = Buffer.from(slice).toString('utf8');
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  return { content, truncated: truncated || bytes.byteLength > limit };
}

function decodePreviewBytes(bytes: unknown, encoding: unknown): Uint8Array | null {
  if (encoding === 'base64' && typeof bytes === 'string' && bytes.length > 0) {
    try {
      return Uint8Array.from(Buffer.from(bytes, 'base64'));
    } catch {
      return null;
    }
  }
  if (bytes instanceof Uint8Array) return bytes;
  return null;
}

function previewFrameOrigins(contentUrl: string, origin?: string): string[] {
  const origins = new Set<string>();
  if (origin) origins.add(origin);
  try {
    const url = new URL(contentUrl);
    origins.add(`${url.protocol}//${url.host}`);
  } catch {
    // Keep only the explicit server origin.
  }
  return [...origins];
}

function errorHtml(message: string): string {
  const safe = message.replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]!));
  return `<!DOCTYPE html><html><body style="margin:0;display:grid;place-items:center;height:100vh;font:13px var(--vscode-font-family);color:var(--vscode-errorForeground);background:var(--vscode-editor-background)"><p>${safe}</p></body></html>`;
}

function getStableResourceVersion(context: vscode.ExtensionContext): string {
  const version = context.extension.packageJSON?.version;
  return typeof version === 'string' && version.length > 0 ? version : 'dev';
}

function withResourceVersion(uri: vscode.Uri, version: string): vscode.Uri {
  return uri.with({ query: `v=${encodeURIComponent(version)}` });
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i += 1) value += chars.charAt(Math.floor(Math.random() * chars.length));
  return value;
}
