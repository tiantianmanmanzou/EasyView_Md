import esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  sourcemap: true,
  minify: production,
  logLevel: 'info',
};

async function ensureDistAssets() {
  await fs.mkdir('dist', { recursive: true });
  try {
    await fs.access('dist/webview.css');
  } catch {
    throw new Error('dist/webview.css is required. This fork keeps the recovered package CSS as the stylesheet source.');
  }

  const fontsDir = path.join('dist', 'fonts');
  try {
    await fs.access(fontsDir);
  } catch {
    await fs.mkdir(fontsDir, { recursive: true });
  }
}

const hostConfig = {
  ...common,
  entryPoints: ['src/host/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
};

const webviewConfig = {
  ...common,
  entryPoints: ['src/webview/index.ts'],
  outfile: 'dist/webview.js',
  platform: 'browser',
  format: 'iife',
  target: ['chrome114'],
};

await ensureDistAssets();

if (watch) {
  const host = await esbuild.context(hostConfig);
  const webview = await esbuild.context(webviewConfig);
  await host.watch();
  await webview.watch();
  console.log('[watch] building extension and webview bundles');
} else {
  await Promise.all([
    esbuild.build(hostConfig),
    esbuild.build(webviewConfig),
  ]);
}

