#!/usr/bin/env node
/**
 * Package EasyView Desktop and install into /Applications/EasyView_Md.app.
 * `npm run build:desktop` only refreshes apps/desktop/dist (for `start:desktop`);
 * the Applications bundle used from Finder/Dock needs this path.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(appDir, '..');
const workspaceRoot = path.resolve(desktopRoot, '../..');
const arch = process.arch;
const packagedApp = path.join(
  desktopRoot,
  'out',
  `EasyView_Md-darwin-${arch}`,
  'EasyView_Md.app',
);
const installApp = '/Applications/EasyView_Md.app';

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd: workspaceRoot, ...opts });
}

// Soft-quit so ditto can replace the bundle.
spawnSync('osascript', ['-e', 'quit app "EasyView_Md"'], { stdio: 'ignore' });
spawnSync('pkill', ['-f', '/Applications/EasyView_Md.app'], { stdio: 'ignore' });

run('npm', ['run', 'package:desktop']);

if (!fs.existsSync(packagedApp)) {
  console.error(`[easyview-desktop] Packaged app missing: ${packagedApp}`);
  process.exit(1);
}

fs.rmSync(installApp, { recursive: true, force: true });
run('/usr/bin/ditto', [packagedApp, installApp]);
console.log(`[easyview-desktop] Installed ${installApp}`);
console.log('[easyview-desktop] Relaunch EasyView_Md from Applications / Dock.');
