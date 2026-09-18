import { access, readdir, readFile, readlink, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import asar from '@electron/asar';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platform = process.platform;
const arch = process.arch;
const bundleRoot = path.join(appDir, 'out', `EasyView_Md-${platform}-${arch}`);
const resourcesDir = platform === 'darwin'
  ? path.join(bundleRoot, 'EasyView_Md.app', 'Contents', 'Resources')
  : path.join(bundleRoot, 'resources');
const asarPath = path.join(resourcesDir, 'app.asar');
const unpackedRoot = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'node-pty');


async function collectSymlinks(root) {
  const result = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        result.push({ path: fullPath, target: await readlink(fullPath) });
      } else if (entry.isDirectory()) {
        await walk(fullPath);
      }
    }
  }
  await walk(root);
  return result;
}

const requiredAsarFiles = [
  '/dist/main/main.js',
  '/dist/preload/preload.js',
  '/dist/renderer/index.html',
  '/dist/renderer/renderer.js',
  '/dist/renderer/build-meta.json',
  '/dist/renderer/webview.css',
  '/dist/renderer/xterm.css',
  '/dist/renderer/desktop.css',
  '/dist/renderer/preview.css',
  '/dist/renderer/doc-worker.js',
  '/dist/renderer/heic-host.html',
  '/dist/renderer/heic-host.js',
  '/dist/renderer/vendor/file-viewer/flyfish-viewer-manifest.json',
  '/dist/renderer/vendor/file-viewer/vendor/drawio/viewer-static.min.js',
  '/dist/renderer/vendor/file-viewer-ppt/LICENSE',
  '/dist/renderer/vendor/file-viewer-ppt/NOTICE',
  '/dist/renderer/vendor/file-viewer-ppt/ppt-native.wasm',
  '/dist/renderer/vendor/file-viewer-ppt/worker.mjs',
  '/dist/renderer/fonts/SourceHanSansCN-Normal.otf',
  '/dist/renderer/fonts/SourceHanSansCN-Heavy.otf',
  '/dist/renderer/fonts/NotoSansSymbols2-Regular.ttf',
  '/dist/renderer/fonts/Inter.var.woff2',
  '/dist/renderer/fonts/Inter-italic.var.woff2',
];

await access(asarPath);
const packagedFiles = new Set(asar.listPackage(asarPath));
for (const file of requiredAsarFiles) {
  if (!packagedFiles.has(file)) throw new Error(`Missing packaged resource: ${file}`);
}

const duplicateMediaResource = path.join(resourcesDir, 'media');
try {
  await access(duplicateMediaResource);
  throw new Error(`Unused duplicate media resource must not be packaged: ${duplicateMediaResource}`);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const duplicateAsarMediaFiles = [...packagedFiles].filter((file) => file === '/media' || file.startsWith('/media/'));
if (duplicateAsarMediaFiles.length > 0) {
  throw new Error(`Unused duplicate media resources must not be packaged in app.asar: ${duplicateAsarMediaFiles.join(', ')}`);
}

const rendererFontFiles = [...packagedFiles].filter((file) => file.startsWith('/dist/renderer/fonts/'));
const expectedRendererFontFiles = requiredAsarFiles.filter((file) => file.startsWith('/dist/renderer/fonts/'));
if (rendererFontFiles.length !== expectedRendererFontFiles.length || expectedRendererFontFiles.some((file) => !rendererFontFiles.includes(file))) {
  throw new Error(`Renderer font resources must contain exactly the bundled editor fonts: ${rendererFontFiles.join(', ')}`);
}

const nativeDir = `${platform}-${arch}`;
for (const file of ['package.json', 'lib/index.js', `prebuilds/${nativeDir}/pty.node`]) {
  const filePath = path.join(unpackedRoot, file);
  const info = await stat(filePath);
  if (!info.isFile() || info.size === 0) throw new Error(`Invalid node-pty runtime file: ${filePath}`);
}
if (platform === 'darwin') {
  await access(path.join(unpackedRoot, 'prebuilds', nativeDir, 'spawn-helper'));
}


const javaDecompilerRoot = path.join(resourcesDir, 'java-decompiler');
for (const file of ['java-decompiler.jar', 'LICENSE.txt', 'NOTICE.txt', 'README.md', 'SHA256SUMS']) {
  const filePath = path.join(javaDecompilerRoot, file);
  const info = await stat(filePath);
  if (!info.isFile() || info.size === 0) throw new Error(`Invalid Java decompiler runtime file: ${filePath}`);
}

if (platform === 'darwin') {
  const absoluteSymlinks = (await collectSymlinks(bundleRoot))
    .filter(({ target }) => path.isAbsolute(target));
  if (absoluteSymlinks.length > 0) {
    throw new Error(`Absolute symlinks make the macOS bundle non-portable: ${absoluteSymlinks.map((item) => item.path).join(', ')}`);
  }
}

if (platform === 'darwin') {
  const execFileAsync = promisify(execFile);
  const plistPath = path.join(bundleRoot, 'EasyView_Md.app', 'Contents', 'Info.plist');
  const { stdout } = await execFileAsync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath]);
  const plist = JSON.parse(stdout);
  if (plist.CFBundleDisplayName !== 'EasyView_Md' || plist.CFBundleName !== 'EasyView_Md') {
    throw new Error('Packaged macOS app name must be EasyView_Md.');
  }
  const packagedIcon = await readFile(path.join(resourcesDir, plist.CFBundleIconFile));
  const sourceIcon = await readFile(path.join(appDir, 'assets', 'icon.icns'));
  if (!packagedIcon.equals(sourceIcon)) throw new Error('Packaged app icon does not match the shared-brand Desktop icon.');
}

console.log(`verified ${bundleRoot}`);
