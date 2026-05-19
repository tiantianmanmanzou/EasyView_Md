/**
 * Minimal HTTP server for E2E tests.
 * Serves the webview bundle inside a test harness that mocks VS Code API.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const distDir = join(__dirname, '..', 'dist');
const e2eDir = __dirname;
const fixturesDir = join(e2eDir, 'fixtures');

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serveFile(res, filePath) {
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  const ext = extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  res.end(readFileSync(filePath));
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Main test harness page
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const markdown = url.searchParams.get('md') || '';
    const html = buildHarness(markdown);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // Serve dist assets
  if (url.pathname.startsWith('/dist/')) {
    const filePath = join(distDir, url.pathname.slice(6));
    serveFile(res, filePath);
    return;
  }

  // Serve fonts from dist/fonts
  if (url.pathname.startsWith('/fonts/')) {
    const filePath = join(distDir, 'fonts', url.pathname.slice(7));
    serveFile(res, filePath);
    return;
  }

  // Serve test fixture files
  if (url.pathname.startsWith('/fixtures/')) {
    const filePath = join(fixturesDir, url.pathname.slice(10));
    serveFile(res, filePath);
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(9876, () => {
  console.log('E2E test server running on http://localhost:9876');
});

/**
 * Build the test harness HTML that mocks VS Code API and loads the webview bundle.
 */
function buildHarness(initialMarkdown) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="/dist/webview.css" rel="stylesheet">
  <title>InLineMd E2E Test</title>
  <style>
    /* VS Code theme variable defaults for testing */
    :root {
      --vscode-editor-background: #1e1e1e;
      --vscode-editor-foreground: #d4d4d4;
      --vscode-editorCursor-foreground: #fff;
      --vscode-editor-selectionBackground: rgba(64,128,208,0.3);
      --vscode-editor-lineHighlightBackground: rgba(255,255,255,0.04);
      --vscode-editorLineNumber-foreground: rgba(128,128,128,0.45);
      --vscode-editorLineNumber-activeForeground: #c6c6c6;
      --vscode-editorWidget-border: rgba(128,128,128,0.2);
      --vscode-editor-font-family: Consolas, monospace;
      --vscode-font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      --vscode-font-size: 13px;
      --vscode-button-background: #0e639c;
      --vscode-button-foreground: #fff;
      --vscode-input-background: #3c3c3c;
      --vscode-input-foreground: #cccccc;
      --vscode-input-border: #3c3c3c;
      --vscode-focusBorder: #007fd4;
      --vscode-dropdown-background: #3c3c3c;
      --vscode-dropdown-foreground: #cccccc;
      --vscode-sideBar-background: #252526;
      --vscode-panel-border: rgba(128,128,128,0.35);
    }
    body {
      margin: 0;
      padding: 0;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
    }
  </style>
  <script>
    // Mock VS Code webview API
    window.acquireVsCodeApi = function() {
      const state = {};
      const api = {
        postMessage: function(msg) {
          // Capture messages for test assertions
          window.__vscodeMessages = window.__vscodeMessages || [];
          window.__vscodeMessages.push(msg);
        },
        getState: function() { return state; },
        setState: function(s) { Object.assign(state, s); return s; },
      };
      return api;
    };

    // Embed initial data the same way VS Code provider does —
    // the webview's bootstrap code picks this up from __INITIAL_DATA__
    window.__INITIAL_DATA__ = {
      type: 'init',
      content: ${JSON.stringify(initialMarkdown)},
      filename: 'test',
      fullWidth: false,
      tocVisible: false,
      tableWrap: true,
      imagePathMap: {},
    };

    // Set defaults that webview expects
    window.systemLocale = 'en-US';
    window.csvDelimiterSetting = 'auto';
  </script>
</head>
<body>
  <div id="title-bar"></div>
  <div id="editor-body">
    <div id="editor-scroll-area">
      <div id="editor"></div>
    </div>
  </div>
  <script src="/dist/webview.js"></script>
</body>
</html>`;
}
