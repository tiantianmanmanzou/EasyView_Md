#!/usr/bin/env node
/**
 * Local preview harness for Excel / PPT / PDF / DOCX E2E checks.
 * Serves extension dist + test files, bootstraps preview-webview.js.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'apps/vscode-extension/dist');
const testDir = path.join(root, '测试文件夹');
const port = Number(process.env.PREVIEW_HARNESS_PORT || 8765);

if (!fs.existsSync(testDir)) {
  console.error('[preview-harness] testDir missing:', testDir, 'root=', root, '__dirname=', __dirname);
  process.exit(1);
}
console.log('[preview-harness] root=', root, 'testDir=', testDir);

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
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.map': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.pdf': 'application/pdf',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }[ext] || 'application/octet-stream';
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function safeJoin(base, requestPath) {
  const decoded = decodeURIComponent(requestPath.split('?')[0]);
  const full = path.normalize(path.join(base, decoded));
  if (!full.startsWith(base)) return null;
  return full;
}

function previewHtml(kind) {
  const fileName = FILES[kind];
  const meta = ROUTE[kind];
  const filePath = path.join(testDir, fileName);
  const stat = fs.statSync(filePath);
  const contentUrl = `/files/${encodeURIComponent(fileName)}`;
  const descriptor = {
    sessionId: randomUUID(),
    relativePath: `测试文件夹/${fileName}`,
    fileName,
    route: meta.route,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mimeType: meta.mimeType,
    contentUrl,
  };
  const assets = {
    fileViewerAssetBaseUrl: '/dist/preview/vendor/file-viewer/',
    pptAssetBaseUrl: '/dist/preview/vendor/file-viewer/vendor/ppt/',
    docWorkerUrl: '/dist/preview/workers/doc-worker.js',
  };
  const bootstrap = {
    type: 'init',
    descriptor,
    assets,
    productTheme: 'light',
    fileTheme: null,
  };
  return `<!DOCTYPE html>
<html lang="zh-CN" data-easyview-theme="light">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="/dist/preview/preview.css" />
  <title>EasyView Preview Harness · ${kind}</title>
  <style>
    html, body, #root { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body {
      color: #1f2328;
      background: #ffffff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
  </style>
</head>
<body data-easyview-theme="light">
  <div id="root" class="preview-root"></div>
  <script>
    window.acquireVsCodeApi = function () {
      return {
        postMessage(message) {
          if (!message || typeof message !== 'object') return;
          if (message.type === 'writeBytes') {
            const size = typeof message.bytes === 'string'
              ? Math.floor(message.bytes.length * 0.75)
              : (message.bytes?.byteLength || 0);
            window.postMessage({
              type: 'writeBytesResult',
              id: message.id,
              ok: true,
              value: { size: size || 1024, mtimeMs: Date.now() },
            }, '*');
          }
          if (message.type === 'writePreviewFileTheme') {
            // no-op for harness
          }
        },
      };
    };
    window.__EASYVIEW_PREVIEW_BOOTSTRAP__ = ${JSON.stringify(bootstrap)};
  </script>
  <script type="module" src="/dist/preview-webview.js"></script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  const pathname = url.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    return send(res, 200, `<!doctype html><meta charset="utf-8"><ul>
      ${Object.keys(FILES).map((k) => `<li><a href="/preview/${k}">${k} · ${FILES[k]}</a></li>`).join('')}
    </ul>`, 'text/html; charset=utf-8');
  }

  const previewMatch = pathname.match(/^\/preview\/(xlsx|pptx|pdf|docx)$/);
  if (previewMatch) {
    try {
      return send(res, 200, previewHtml(previewMatch[1]), 'text/html; charset=utf-8');
    } catch (error) {
      console.error(error);
      return send(res, 500, String(error?.stack || error));
    }
  }

  if (pathname.startsWith('/files/')) {
    const name = decodeURIComponent(pathname.slice('/files/'.length));
    const full = path.join(testDir, name);
    if (!full.startsWith(testDir) || !fs.existsSync(full)) return send(res, 404, 'file not found');
    return send(res, 200, fs.readFileSync(full), contentType(full));
  }

  if (pathname.startsWith('/dist/')) {
    const full = safeJoin(dist, pathname.slice('/dist/'.length));
    if (!full || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      return send(res, 404, `missing ${pathname}`);
    }
    return send(res, 200, fs.readFileSync(full), contentType(full));
  }

  send(res, 404, 'not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[preview-harness] http://127.0.0.1:${port}/`);
  for (const kind of Object.keys(FILES)) {
    console.log(`  - http://127.0.0.1:${port}/preview/${kind}`);
  }
});
