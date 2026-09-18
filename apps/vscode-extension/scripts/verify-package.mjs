import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(appDir, 'package.json'), 'utf8'));
const vsixPath = path.join(appDir, `easyview-md-${packageJson.version}.vsix`);
const archive = await JSZip.loadAsync(await readFile(vsixPath));
const files = Object.keys(archive.files).filter((name) => !archive.files[name].dir);
const fileSet = new Set(files);

const required = [
  'extension/package.json',
  'extension/readme.md',
  'extension/LICENSE.txt',
  'extension/dist/extension.js',
  'extension/dist/preview-webview.js',
  'extension/dist/preview/preview.css',
  'extension/dist/preview/workers/doc-worker.js',
  'extension/dist/preview/vendor/file-viewer/flyfish-viewer-manifest.json',
  'extension/dist/preview/vendor/file-viewer/vendor/ppt/LICENSE',
  'extension/dist/preview/vendor/file-viewer/vendor/libarchive/worker-bundle.js',
  'extension/dist/preview/vendor/file-viewer/vendor/libarchive/libarchive.wasm',
  'extension/dist/brand/logo.png',
  'extension/dist/brand/easyview-editor-light.svg',
  'extension/dist/brand/easyview-editor-dark.svg',
  'extension/dist/media/xterm.css',
  'extension/dist/media/SourceHanSansCN-Normal.otf',
  'extension/dist/media/SourceHanSansCN-Heavy.otf',
  'extension/dist/media/NotoSansSymbols2-Regular.ttf',
  'extension/dist/runtime/node-pty/package.json',
  'extension/dist/runtime/node-pty/lib/index.js',
  'extension/dist/runtime/node-pty/prebuilds/darwin-arm64/pty.node',
  'extension/dist/runtime/node-pty/prebuilds/darwin-x64/pty.node',
  'extension/dist/runtime/node-pty/prebuilds/win32-arm64/pty.node',
  'extension/dist/runtime/node-pty/prebuilds/win32-x64/pty.node',
  'extension/dist/runtime/node-pty/prebuilds/darwin-arm64/spawn-helper',
  'extension/dist/runtime/node-pty/prebuilds/darwin-x64/spawn-helper',
];
for (const file of required) {
  if (!fileSet.has(file)) throw new Error(`Missing VSIX runtime file: ${file}`);
}

const forbidden = files.filter((file) =>
  file.includes('/src/')
  || file.endsWith('.map')
  || file.includes('../')
  || file.includes('/node_modules/@easyview/'),
);
if (forbidden.length > 0) throw new Error(`Forbidden VSIX files: ${forbidden.join(', ')}`);

const require = createRequire(import.meta.url);
const nodePty = require(path.join(appDir, 'dist/runtime/node-pty/lib/index.js'));
if (typeof nodePty.spawn !== 'function') throw new Error('Packaged node-pty runtime did not load.');
console.log(`verified ${vsixPath}: ${files.length} files and node-pty runtime`);
