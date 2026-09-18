#!/usr/bin/env node
/**
 * Start preview harness + Playwright checks for xlsx / pptx / pdf / docx.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'apps/vscode-extension/dist');
const testDir = path.join(root, '测试文件夹');
const outDir = '/tmp/easyview-preview-e2e';
const port = 8765;

const FILES = {
  xlsx: '数据安全运营平台-功能清单-20260416.xlsx',
  pptx: '数据安全中台二期规划_20210715.pptx',
  pdf: '星环可信数据流通整体能力与解决方案v2.pdf',
  docx: '中国移动数智领域数据安全管控能力技术规范4.0（分册二：数据安全运营）-正式版.docx',
};

const ROUTE = {
  xlsx: { route: 'spreadsheet', mimeType: 'application/octet-stream' },
  pptx: { route: 'powerpoint', mimeType: 'application/octet-stream' },
  pdf: { route: 'pdf', mimeType: 'application/pdf' },
  docx: { route: 'word', mimeType: 'application/octet-stream' },
};

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.pdf': 'application/pdf',
    '.xlsx': 'application/octet-stream',
    '.pptx': 'application/octet-stream',
    '.docx': 'application/octet-stream',
  }[ext] || 'application/octet-stream';
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function safeJoin(base, requestPath) {
  const decoded = decodeURIComponent(requestPath.split('?')[0]);
  const full = path.normalize(path.join(base, decoded));
  return full.startsWith(base) ? full : null;
}

function previewHtml(kind) {
  const fileName = FILES[kind];
  const meta = ROUTE[kind];
  const filePath = path.join(testDir, fileName);
  const stat = fs.statSync(filePath);
  const bootstrap = {
    type: 'init',
    descriptor: {
      sessionId: randomUUID(),
      relativePath: `测试文件夹/${fileName}`,
      fileName,
      route: meta.route,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      mimeType: meta.mimeType,
      contentUrl: `/files/${encodeURIComponent(fileName)}`,
    },
    assets: {
      fileViewerAssetBaseUrl: '/dist/preview/vendor/file-viewer/',
      pptAssetBaseUrl: '/dist/preview/vendor/file-viewer/vendor/ppt/',
      docWorkerUrl: '/dist/preview/workers/doc-worker.js',
    },
    productTheme: 'light',
    fileTheme: null,
  };
  return `<!DOCTYPE html>
<html lang="zh-CN" data-easyview-theme="light">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="/dist/preview/preview.css" />
  <title>EasyView Preview · ${kind}</title>
  <style>html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}</style>
</head>
<body data-easyview-theme="light">
  <div id="root" class="preview-root"></div>
  <script>
    window.acquireVsCodeApi = () => ({
      postMessage(message) {
        if (message?.type === 'writeBytes') {
          window.postMessage({
            type: 'writeBytesResult',
            id: message.id,
            ok: true,
            value: { size: 1024, mtimeMs: Date.now() },
          }, '*');
        }
      },
    });
    window.__EASYVIEW_PREVIEW_BOOTSTRAP__ = ${JSON.stringify(bootstrap)};
  </script>
  <script type="module" src="/dist/preview-webview.js"></script>
</body>
</html>`;
}

function startServer() {
  if (!fs.existsSync(testDir)) throw new Error(`testDir missing: ${testDir}`);
  if (!fs.existsSync(dist)) throw new Error(`dist missing: ${dist}`);

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      const pathname = url.pathname;
      const previewMatch = pathname.match(/^\/preview\/(xlsx|pptx|pdf|docx)$/);
      if (previewMatch) return send(res, 200, previewHtml(previewMatch[1]), 'text/html; charset=utf-8');
      if (pathname.startsWith('/files/')) {
        const name = decodeURIComponent(pathname.slice('/files/'.length));
        const full = path.join(testDir, name);
        if (!full.startsWith(testDir) || !fs.existsSync(full)) return send(res, 404, 'missing file');
        return send(res, 200, fs.readFileSync(full), contentType(full));
      }
      if (pathname.startsWith('/dist/')) {
        const full = safeJoin(dist, pathname.slice('/dist/'.length));
        if (!full || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, `missing ${pathname}`);
        return send(res, 200, fs.readFileSync(full), contentType(full));
      }
      return send(res, 404, 'not found');
    } catch (error) {
      console.error(error);
      return send(res, 500, String(error?.stack || error));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

fs.mkdirSync(outDir, { recursive: true });
const server = await startServer();
console.log(`[e2e] harness on http://127.0.0.1:${port}`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const results = [];

for (const kind of Object.keys(FILES)) {
  const url = `http://127.0.0.1:${port}/preview/${kind}`;
  const consoleErrors = [];
  const pageErrors = [];
  page.removeAllListeners('console');
  page.removeAllListeners('pageerror');
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  const started = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Wait until shell mounts or error surfaces.
  await page.waitForFunction(() => {
    const root = document.querySelector('#root');
    if (!root || !root.children.length) return false;
    if (document.querySelector('.preview-viewer-error')) return true;
    if (document.querySelector('.preview-shell-toolbar-actions, .preview-toolbar-toggle')) return true;
    if (document.querySelector('.x-spreadsheet, [data-testid="docx-editor"], canvas, .file-viewer-host')) return true;
    return false;
  }, { timeout: 45_000 }).catch(() => {});

  // Extra settle for heavy PDF/PPT renderers.
  await page.waitForTimeout(kind === 'pdf' || kind === 'pptx' ? 6000 : 2500);

  const shot = path.join(outDir, `${kind}.png`);
  await page.screenshot({ path: shot, fullPage: false });

  const diag = await page.evaluate(() => {
    const root = document.querySelector('#root');
    return {
      title: document.title,
      rootClass: root?.firstElementChild?.className || '',
      toolbarPinned: Boolean(document.querySelector('.is-toolbar-pinned')),
      shellActions: Boolean(document.querySelector('.preview-shell-toolbar-actions')),
      themeBtn: Boolean(document.querySelector('.preview-toolbar-theme')),
      toggleBtn: Boolean(document.querySelector('.preview-toolbar-toggle')),
      saveBtn: Boolean(document.querySelector('.preview-document-route-save')),
      spreadsheet: Boolean(document.querySelector('.x-spreadsheet')),
      docxEditor: Boolean(document.querySelector('[data-testid="docx-editor"]')),
      fileViewerHost: Boolean(document.querySelector('.file-viewer-host')),
      canvasCount: document.querySelectorAll('canvas').length,
      errorText: Array.from(document.querySelectorAll('.preview-viewer-error, .preview-viewer-message'))
        .map((el) => (el.textContent || '').trim())
        .filter(Boolean)
        .slice(0, 8),
      bodySample: (root?.innerText || '').replace(/\s+/g, ' ').slice(0, 240),
      injectedEvCss: Array.from(document.querySelectorAll('style[id^="ev-css-"]')).map((el) => el.id),
    };
  });

  const entry = {
    kind,
    ms: Date.now() - started,
    shot,
    consoleErrors: [...new Set(consoleErrors)].slice(0, 25),
    pageErrors: [...new Set(pageErrors)].slice(0, 15),
    diag,
  };
  results.push(entry);
  console.log(JSON.stringify(entry, null, 2));
}

fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(results, null, 2));
await browser.close();
server.close();
console.log('report:', path.join(outDir, 'report.json'));
