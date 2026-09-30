import * as http from 'node:http';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { isPathInsideRoot } from './htmlPreviewPath';

export interface HtmlPreviewServer {
  readonly origin: string;
  contentUrlFor(fileUri: vscode.Uri): Promise<string>;
  dispose(): void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

export function resolveHtmlPreviewRoot(fileUri: vscode.Uri): vscode.Uri {
  const folder = vscode.workspace.getWorkspaceFolder(fileUri);
  if (folder) return folder.uri;
  if (fileUri.scheme === 'file') return vscode.Uri.file(path.dirname(fileUri.fsPath));
  return vscode.Uri.joinPath(fileUri, '..');
}

export async function startHtmlPreviewServer(rootUri: vscode.Uri): Promise<HtmlPreviewServer> {
  if (rootUri.scheme !== 'file') throw new Error('HTML 预览服务仅支持本地文件');
  const root = await fsp.realpath(rootUri.fsPath);
  const token = randomBytes(16).toString('hex');

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, root, token);
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('HTML 预览服务启动失败'));
    });
    server.on('error', reject);
  });

  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    async contentUrlFor(fileUri: vscode.Uri): Promise<string> {
      const relative = path.relative(root, fileUri.fsPath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('HTML 不在预览根目录内');
      }
      const encoded = relative.split(path.sep).map(encodeURIComponent).join('/');
      const local = `${origin}/${token}/${encoded}`;
      try {
        return (await vscode.env.asExternalUri(vscode.Uri.parse(local))).toString();
      } catch {
        return local;
      }
    },
    dispose(): void {
      server.close();
    },
  };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  root: string,
  token: string,
): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end();
    return;
  }
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    if (parts[0] !== token) {
      res.writeHead(404);
      res.end();
      return;
    }
    const relative = parts.slice(1).join(path.sep);
    const candidate = path.resolve(root, relative);
    if (!isPathInsideRoot(root, candidate)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const real = await fsp.realpath(candidate);
    if (!isPathInsideRoot(root, real)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const stat = await fsp.stat(real);
    if (!stat.isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    const mime = MIME[path.extname(real).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': String(stat.size) });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(real).pipe(res);
  } catch {
    res.writeHead(404);
    res.end();
  }
}
