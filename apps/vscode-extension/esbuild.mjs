import esbuild from 'esbuild';
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
const previewDir = path.join(distDir, 'preview');
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const metafileDir = path.join(distDir, 'metafile');

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await mkdir(previewDir, { recursive: true });
await mkdir(metafileDir, { recursive: true });

async function buildBundle(name, options) {
  const result = await esbuild.build({ ...options, metafile: production });
  if (production && result.metafile) {
    await writeFile(path.join(metafileDir, `${name}.json`), JSON.stringify(result.metafile, null, 2));
  }
}

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

await Promise.all([
  buildBundle('extension', {
    ...common,
    entryPoints: [path.join(appDir, 'src/entry/extension.ts')],
    outfile: path.join(distDir, 'extension.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode', 'node-pty'],
  }),
  buildBundle('webview', {
    ...common,
    entryPoints: { webview: path.join(appDir, 'src/adapters/vscode/vscodeEntry.ts') },
    outdir: distDir,
    entryNames: '[name]',
    chunkNames: 'editor/chunks/[name]-[hash]',
    assetNames: 'editor/assets/[name]-[hash]',
    platform: 'browser',
    format: 'esm',
    splitting: true,
    target: ['chrome114'],
  }),
  buildBundle('preview-webview', {
    ...common,
    entryPoints: {
      'preview-webview': path.join(appDir, 'src/preview/previewWebview.ts'),
    },
    outdir: distDir,
    entryNames: '[name]',
    chunkNames: 'preview/chunks/[name]-[hash]',
    assetNames: 'preview/assets/[name]-[hash]',
    platform: 'browser',
    format: 'esm',
    splitting: true,
    target: ['chrome114'],
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
  buildBundle('workspace-webview', {
    ...common,
    entryPoints: {
      'workspace-webview': path.join(appDir, 'src/workspace/webview/workspaceWebviewEntry.ts'),
    },
    outdir: distDir,
    entryNames: '[name]',
    platform: 'browser',
    format: 'esm',
    target: ['chrome114'],
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
  buildBundle('doc-worker', {
    ...common,
    entryPoints: [path.join(workspaceDir, 'packages/preview-ui/src/workers/doc-worker.ts')],
    outfile: path.join(previewDir, 'workers', 'doc-worker.js'),
    platform: 'browser',
    format: 'esm',
    target: ['chrome114'],
  }),
]);

await cp(path.join(appDir, '../../packages/editor-core/src/webview.css'), path.join(distDir, 'webview.css'));
await cp(path.join(workspaceDir, 'packages/preview-ui/src/preview.css'), path.join(previewDir, 'preview.css'));
await cp(path.join(appDir, '../../resources/brand'), path.join(distDir, 'brand'), { recursive: true });
await mkdir(path.join(distDir, 'media'), { recursive: true });
for (const file of [
  'xterm.css',
  'SourceHanSansCN-Normal.otf',
  'SourceHanSansCN-Heavy.otf',
  'NotoSansSymbols2-Regular.ttf',
]) {
  const sourceDirectory = file === 'xterm.css'
    ? path.join(appDir, '../../resources/editor/styles')
    : path.join(appDir, '../../resources/editor/fonts');
  await cp(path.join(sourceDirectory, file), path.join(distDir, 'media', file));
}

// webview.css references ./fonts/* (Inter + KaTeX). Keep them next to webview.css.
const webviewFontsDir = path.join(distDir, 'fonts');
await mkdir(webviewFontsDir, { recursive: true });
for (const [source, target] of [
  ['inter-latin-wght-normal.woff2', 'Inter.var.woff2'],
  ['inter-latin-wght-italic.woff2', 'Inter-italic.var.woff2'],
]) {
  await cp(
    path.join(workspaceDir, 'node_modules/@fontsource-variable/inter/files', source),
    path.join(webviewFontsDir, target),
  );
}
await cp(
  path.join(workspaceDir, 'node_modules/katex/dist/fonts'),
  webviewFontsDir,
  { recursive: true },
);

// Phase-1 file-viewer assets for the Extension preview webview.
await execFileAsync(process.execPath, [
  path.join(workspaceDir, 'node_modules/file-viewer-copy-assets/dist/cli.js'),
  path.join(previewDir, 'vendor/file-viewer'),
  '--renderers', 'pdf,office-word-openxml,office-presentation-binary,office-presentation,spreadsheet-openxml,archive',
]);

// Legacy PPT assets are already published under vendor/file-viewer/vendor/ppt by copy-assets.

const nodePtySource = path.join(appDir, '../../node_modules/node-pty');
const nodePtyTarget = path.join(distDir, 'runtime/node-pty');
await mkdir(nodePtyTarget, { recursive: true });
await Promise.all([
  cp(path.join(nodePtySource, 'package.json'), path.join(nodePtyTarget, 'package.json')),
  cp(path.join(nodePtySource, 'LICENSE'), path.join(nodePtyTarget, 'LICENSE')),
  cp(path.join(nodePtySource, 'lib'), path.join(nodePtyTarget, 'lib'), {
    recursive: true,
    filter(entry) {
      return !entry.endsWith('.map') && !entry.endsWith('.test.js');
    },
  }),
  cp(path.join(nodePtySource, 'node_modules/node-addon-api'), path.join(nodePtyTarget, 'node_modules/node-addon-api'), { recursive: true }),
  cp(path.join(nodePtySource, 'prebuilds'), path.join(nodePtyTarget, 'prebuilds'), {
    recursive: true,
    filter(entry) {
      return !entry.endsWith('.pdb');
    },
  }),
]);

if (watch) {
  console.log('[watch] VS Code extension bundles rebuilt; use a VS Code task to rerun this command.');
}
