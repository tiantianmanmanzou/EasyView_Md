import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cssInjectPlugin } from '../../packages/preview-ui/esbuild-css-inject.mjs';

const execFileAsync = promisify(execFile);
const appDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.resolve(appDir, '../..');
const distDir = path.join(appDir, 'dist');
const rendererDir = path.join(distDir, 'renderer');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

await rm(distDir, { recursive: true, force: true });
await mkdir(rendererDir, { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  sourcemap: !production,
  external: ['electron', 'node-pty'],
  logLevel: 'info',
};

const buildResults = await Promise.all([
  build({
    ...common,
    entryPoints: [path.join(appDir, 'src/main/entry/main.ts')],
    outfile: path.join(distDir, 'main/main.js'),
    format: 'cjs',
  }),
  build({
    ...common,
    entryPoints: [path.join(appDir, 'src/preload/preload.ts')],
    outfile: path.join(distDir, 'preload/preload.js'),
    format: 'cjs',
  }),
  build({
    bundle: true,
    entryPoints: [path.join(appDir, 'src/renderer/preview/heic-host.ts')],
    outfile: path.join(rendererDir, 'heic-host.js'),
    format: 'iife',
    platform: 'browser',
    target: 'chrome128',
    sourcemap: !production,
    logLevel: 'info',
  }),
  build({
    bundle: true,
    entryPoints: {
      renderer: path.join(appDir, 'src/renderer/renderer.ts'),
      'workers/doc-worker': path.join(appDir, 'src/renderer/preview/workers/doc-worker.ts'),
    },
    outdir: rendererDir,
    entryNames: '[name]',
    chunkNames: 'chunks/[name]-[hash]',
    assetNames: 'assets/[name]-[hash]',
    format: 'esm',
    splitting: true,
    platform: 'browser',
    target: 'chrome128',
    sourcemap: !production,
    metafile: production,
    logLevel: 'info',
    plugins: [cssInjectPlugin()],
    loader: {
      '.svg': 'dataurl',
      '.png': 'dataurl',
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.ttf': 'dataurl',
      '.eot': 'dataurl',
    },
  }),
]);

const rendererBuild = buildResults[3];
if (production && rendererBuild.metafile) {
  await writeFile(path.join(rendererDir, 'build-meta.json'), JSON.stringify(rendererBuild.metafile, null, 2));
}

await Promise.all([
  cp(path.join(appDir, 'src/renderer/index.html'), path.join(rendererDir, 'index.html')),
  cp(path.join(appDir, 'src/renderer/desktop.css'), path.join(rendererDir, 'desktop.css')),
  cp(path.join(appDir, 'src/renderer/preview/heic-host.html'), path.join(rendererDir, 'heic-host.html')),
  cp(path.join(workspaceDir, 'packages/editor-core/src/webview.css'), path.join(rendererDir, 'webview.css')),
  cp(path.join(workspaceDir, 'packages/preview-ui/src/preview.css'), path.join(rendererDir, 'preview.css')),
  cp(path.join(workspaceDir, 'resources/editor/styles/xterm.css'), path.join(rendererDir, 'xterm.css')),
]);
await mkdir(path.join(rendererDir, 'fonts'), { recursive: true });
for (const font of ['SourceHanSansCN-Normal.otf', 'SourceHanSansCN-Heavy.otf', 'NotoSansSymbols2-Regular.ttf']) {
  await cp(path.join(workspaceDir, 'resources/editor/fonts', font), path.join(rendererDir, 'fonts', font));
}
for (const [source, target] of [
  ['inter-latin-wght-normal.woff2', 'Inter.var.woff2'],
  ['inter-latin-wght-italic.woff2', 'Inter-italic.var.woff2'],
]) {
  await cp(path.join(workspaceDir, 'node_modules/@fontsource-variable/inter/files', source), path.join(rendererDir, 'fonts', target));
}

// File Viewer full-preset assets are loaded only by their lazy Viewer chunks.
await execFileAsync(process.execPath, [
  path.join(workspaceDir, 'node_modules/file-viewer-copy-assets/dist/cli.js'),
  path.join(rendererDir, 'vendor/file-viewer'),
  '--renderers', 'pdf,office-word-openxml,office-presentation-binary,office-presentation,spreadsheet-openxml,archive,photoshop-design,drawing',
]);

// The legacy PPT binary engine has a public-watermarked licence. Copy all
// runtime assets and notices unmodified; PresentationViewer keeps its watermark.
const pptSource = path.join(workspaceDir, 'node_modules/@file-viewer/ppt');
const pptTarget = path.join(rendererDir, 'vendor/file-viewer-ppt');
await mkdir(pptTarget, { recursive: true });
for (const asset of ['ppt-native.wasm', 'ppt-font-cjk.otf', 'worker.mjs', 'frame-cache.mjs', 'LICENSE', 'NOTICE', 'manifest.json']) {
  await cp(path.join(pptSource, asset), path.join(pptTarget, asset));
}

if (watch) console.log('Desktop build completed. Use the Electron dev runner to reload the application.');
