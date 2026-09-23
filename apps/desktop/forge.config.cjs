const path = require('node:path');
const { MakerSquirrel } = require('@electron-forge/maker-squirrel');
const { MakerZIP } = require('@electron-forge/maker-zip');

const appDir = __dirname;

/**
 * Keep only the runtime-required contents inside app.asar.
 *
 * The renderer/main bundles are produced by esbuild (bundle: true) into dist/,
 * so the only external module needed at runtime is node-pty (native addon),
 * which is staged into apps/desktop/node_modules by scripts/prepare-runtime.mjs.
 * Everything else (src/ sources, scripts, tests, historical single-file
 * artifacts, build tooling) is compile-time only and must not be packaged.
 */
// Runtime contents only. icon / java-decompiler are read via packager
// options (icon / extraResource) from the source tree, not from app.asar.
const KEEP_TOP_LEVEL = new Set(['dist', 'node_modules', 'package.json']);

function shouldIgnore(filePath) {
  // electron-packager passes paths relative to the app dir with a leading
  // slash, e.g. "/package.json", "/dist/main/main.js" (see copy-filter.js).
  // That leading slash must NOT be treated as a filesystem absolute path —
  // path.isAbsolute("/package.json") is true on POSIX and would wrongly
  // resolve outside the app directory.
  const relative = String(filePath ?? '').replace(/^[\\/]+/, '');
  if (!relative) return false; // app root itself
  const top = relative.split(/[\\/]+/).filter(Boolean)[0];
  return !KEEP_TOP_LEVEL.has(top);
}

module.exports = {
  packagerConfig: {
    asar: { unpack: '**/node_modules/node-pty/**/*' },
    prune: false,
    ignore: shouldIgnore,
    extraResource: [path.resolve(appDir, 'resources/java-decompiler')],
    name: 'EasyView_Md',
    appBundleId: 'com.easyview.md',
    icon: path.resolve(appDir, 'assets/icon'),
    extendInfo: {
      CFBundleDisplayName: 'EasyView_Md',
      CFBundleName: 'EasyView_Md',
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: 'Markdown Document',
          CFBundleTypeRole: 'Editor',
          LSHandlerRank: 'Alternate',
          CFBundleTypeExtensions: ['md', 'markdown', 'mdx'],
        },
      ],
    },
  },
  rebuildConfig: {
    onlyModules: [],
  },
  makers: [
    new MakerZIP({}, ['darwin', 'win32']),
    new MakerSquirrel(
      {
        name: 'easyview_md',
        authors: 'EasyView_Md',
        description: 'EasyView_Md Markdown Editor',
      },
      ['win32'],
    ),
  ],
};
