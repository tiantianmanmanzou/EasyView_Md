import * as vscode from 'vscode';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import {
  isEasyViewThemeMode,
  resolvePreviewRoute,
  type EasyViewThemeMode,
  type PreviewDescriptor,
  type PreviewTextResult,
} from '@easyview/contracts';
import { isPhase1PreviewRoute, PHASE1_FILENAME_PATTERNS } from '@easyview/preview-ui/phase1';
import {
  productThemeBootstrapScript,
  readPreviewFileTheme,
  readProductTheme,
  registerPreviewThemePanel,
  writePreviewFileTheme,
} from '../theme/productThemeBridge';

const TEXT_READ_LIMIT = 4 * 1024 * 1024;
const VIEW_TYPE = 'easyviewMd.filePreview';

class FilePreviewDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}
  dispose(): void {}
}

export class FilePreviewProvider implements vscode.CustomReadonlyEditorProvider<FilePreviewDocument> {
  static readonly viewType = VIEW_TYPE;
  private static readonly activePanels = new Set<vscode.WebviewPanel>();
  static readonly filenamePatterns = PHASE1_FILENAME_PATTERNS;

  static getDiagnostics(): { previewSessions: number; visiblePreviews: number; hiddenPreviews: number } {
    const panels = [...FilePreviewProvider.activePanels];
    const visiblePreviews = panels.filter((panel) => panel.visible).length;
    return { previewSessions: panels.length, visiblePreviews, hiddenPreviews: panels.length - visiblePreviews };
  }

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      VIEW_TYPE,
      new FilePreviewProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: false },
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
    return new FilePreviewDocument(uri);
  }

  async resolveCustomEditor(
    document: FilePreviewDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    FilePreviewProvider.activePanels.add(webviewPanel);
    webviewPanel.onDidDispose(() => FilePreviewProvider.activePanels.delete(webviewPanel));
    const fileName = path.basename(document.uri.fsPath || document.uri.path);
    const route = resolvePreviewRoute(fileName);
    const localRoots = [
      this.context.extensionUri,
      vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'preview'),
    ];
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
      webviewPanel.webview.html = errorHtml('当前文件类型不在 EasyView 一期预览范围内。');
      return;
    }

    let size = 0;
    let mtimeMs = Date.now();
    try {
      const stat = await vscode.workspace.fs.stat(document.uri);
      size = stat.size;
      mtimeMs = stat.mtime;
    } catch {
      webviewPanel.webview.html = errorHtml('无法读取预览文件。');
      return;
    }

    if (size > route.maxSourceBytes) {
      webviewPanel.webview.html = errorHtml(
        `文件超过 ${(route.maxSourceBytes / (1024 * 1024)).toFixed(0)} MiB 的 ${route.route} 预览上限。`,
      );
      return;
    }

    const sessionId = randomUUID();
    const contentUrl = webviewPanel.webview.asWebviewUri(document.uri).toString();
    const relativePath = vscode.workspace.asRelativePath(document.uri, false);
    const descriptor: PreviewDescriptor = {
      sessionId,
      relativePath: relativePath === document.uri.fsPath ? fileName : relativePath,
      fileName,
      route: route.route,
      size,
      mtimeMs,
      mimeType: route.mimeType,
      contentUrl,
    };

    const productTheme = readProductTheme(this.context);
    const fileTheme = readPreviewFileTheme(this.context, descriptor.relativePath);
    const assets = {
      fileViewerAssetBaseUrl: webviewPanel.webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'preview', 'vendor', 'file-viewer'),
      ).toString().replace(/\/?$/, '/'),
      pptAssetBaseUrl: webviewPanel.webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'preview', 'vendor', 'file-viewer', 'vendor', 'ppt'),
      ).toString().replace(/\/?$/, '/'),
      docWorkerUrl: webviewPanel.webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'preview', 'workers', 'doc-worker.js'),
      ).toString(),
    };

    webviewPanel.webview.html = this.getHtml(webviewPanel.webview, descriptor, assets, productTheme, fileTheme);

    const themePanelSub = registerPreviewThemePanel(webviewPanel);
    const messageSub = webviewPanel.webview.onDidReceiveMessage(async (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'readText' && typeof message.id === 'string') {
        try {
          const result = await readPreviewText(document.uri, route.maxSourceBytes);
          await webviewPanel.webview.postMessage({ type: 'readTextResult', id: message.id, ok: true, value: result });
        } catch (error) {
          await webviewPanel.webview.postMessage({
            type: 'readTextResult',
            id: message.id,
            ok: false,
            message: error instanceof Error ? error.message : '文本读取失败',
          });
        }
        return;
      }
      if (message.type === 'writeBytes' && typeof message.id === 'string') {
        try {
          if (route.route !== 'spreadsheet' && route.route !== 'word') {
            throw new Error('当前文件不支持写入保存');
          }
          const bytes = decodePreviewBytes(message.bytes, message.encoding);
          if (!bytes || bytes.byteLength === 0) throw new Error('写入内容无效');
          if (bytes.byteLength > route.maxSourceBytes) {
            throw new Error(`写入内容超过 ${(route.maxSourceBytes / (1024 * 1024)).toFixed(0)} MiB 上限`);
          }
          await vscode.workspace.fs.writeFile(document.uri, bytes);
          const stat = await vscode.workspace.fs.stat(document.uri);
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
            message: error instanceof Error ? error.message : '表格保存失败',
          });
        }
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
      themePanelSub.dispose();
      messageSub.dispose();
    });
  }

  private getHtml(
    webview: vscode.Webview,
    descriptor: PreviewDescriptor,
    assets: { fileViewerAssetBaseUrl: string; pptAssetBaseUrl: string; docWorkerUrl: string },
    productTheme: EasyViewThemeMode,
    fileTheme: EasyViewThemeMode | null,
  ): string {
    const nonce = getNonce();
    const resourceVersion = getStableResourceVersion(this.context);
    const scriptUri = withResourceVersion(webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'preview-webview.js'),
    ), resourceVersion);
    const styleUri = withResourceVersion(webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'preview', 'preview.css'),
    ), resourceVersion);
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: blob:`,
      `media-src ${webview.cspSource} blob:`,
      `font-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}' ${webview.cspSource} 'wasm-unsafe-eval'`,
      `worker-src ${webview.cspSource} blob:`,
      `connect-src ${webview.cspSource} blob: data:`,
      `frame-src ${webview.cspSource} blob: data:`,
    ].join('; ');

    const bootstrap = {
      type: 'init',
      descriptor,
      assets,
      productTheme,
      fileTheme,
    };

    return `<!DOCTYPE html>
<html lang="zh-CN" data-easyview-theme="${productTheme}">
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
