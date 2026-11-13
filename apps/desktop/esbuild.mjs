import { build, transform } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cssInjectPlugin } from '../../packages/preview-ui/esbuild-css-inject.mjs';
import { spreadsheetLifecyclePlugin } from '../../packages/preview-ui/esbuild-spreadsheet.mjs';
import { copyDocxLicenses } from '../../tooling/build/copy-docx-licenses.mjs';

const execFileAsync = promisify(execFile);
const appDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.resolve(appDir, '../..');
const distDir = path.join(appDir, 'dist');
const rendererDir = path.join(distDir, 'renderer');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

await rm(distDir, { recursive: true, force: true });
await mkdir(rendererDir, { recursive: true });
await copyDocxLicenses(workspaceDir, distDir);

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  sourcemap: !production,
  external: ['electron', 'node-pty'],
  logLevel: 'info',
};

const [, , , , rendererBuild] = await Promise.all([
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
    ...common,
    entryPoints: [path.join(appDir, 'src/preload/updateDialogPreload.ts')],
    outfile: path.join(distDir, 'preload/updateDialogPreload.js'),
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
    plugins: [spreadsheetLifecyclePlugin(), cssInjectPlugin()],
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

await build({ bundle: true, entryPoints: [path.join(workspaceDir, 'packages/editor-core/src/timeline/history-diff-worker.ts')], outfile: path.join(rendererDir, 'history-diff-worker.js'), platform: 'browser', format: 'iife', target: 'chrome128', minify: production });

await build({ bundle: true, entryPoints: [path.join(workspaceDir, 'packages/preview-ui/src/workers/spreadsheet-worker.ts')], outfile: path.join(rendererDir, 'workers/spreadsheet-worker.js'), platform: 'browser', format: 'iife', target: 'chrome128', minify: production });

if (production && rendererBuild.metafile) {
  // The npm Word editor shipped pre-minified. Minify chunks containing its vendored source.
  for (const [output, metadata] of Object.entries(rendererBuild.metafile.outputs)) {
    if (!output.endsWith('.js') || !Object.keys(metadata.inputs).some((input) => /packages\/docx-(?:core|react|i18n|agents)\//.test(input))) continue;
    const file = path.resolve(appDir, output);
    const result = await transform(await readFile(file, 'utf8'), { minify: true, keepNames: true, target: 'chrome128', format: 'esm' });
    await writeFile(file, result.code);
    metadata.bytes = Buffer.byteLength(result.code);
  }
  await writeFile(path.join(rendererDir, 'build-meta.json'), JSON.stringify(rendererBuild.metafile, null, 2));
}

await Promise.all([
  cp(path.join(appDir, 'src/renderer/index.html'), path.join(rendererDir, 'index.html')),
  cp(path.join(appDir, 'src/renderer/desktop.css'), path.join(rendererDir, 'desktop.css')),
  writeHeicHostHtml(),
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

// The HEIC host runs in an `allow-scripts` sandbox (opaque origin), which Chromium forbids from
// loading file:// subresources, so the decoder is inlined and pinned by its CSP hash.
async function writeHeicHostHtml() {
  const template = await readFile(path.join(appDir, 'src/renderer/preview/heic-host.html'), 'utf8');
  const script = (await readFile(path.join(rendererDir, 'heic-host.js'), 'utf8')).replace(/<\/script/gi, '<\\/script');
  const hash = createHash('sha256').update(script).digest('base64');
  const html = template
    .replace("script-src 'self'", `script-src 'sha256-${hash}'`)
    .replace('<script src="./heic-host.js"></script>', () => `<script>${script}</script>`);
  if (!html.includes(hash) || html.includes('src="./heic-host.js"')) throw new Error('heic-host.html template no longer matches the inlining step');
  await writeFile(path.join(rendererDir, 'heic-host.html'), html);
}
