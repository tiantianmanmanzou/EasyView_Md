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

const installedExecutable = `${installApp}/Contents/MacOS/EasyView_Md`;

function isInstalledAppRunning() {
  return spawnSync('pgrep', ['-f', installedExecutable], { stdio: 'ignore' }).status === 0;
}

/** A running app keeps reading the old app.asar by its cached offsets, so it must be gone before the bundle is replaced. */
function quitInstalledApp() {
  spawnSync('osascript', ['-e', 'quit app "EasyView_Md"'], { stdio: 'ignore' });
  spawnSync('pkill', ['-f', installedExecutable], { stdio: 'ignore' });
  const deadline = Date.now() + 15_000;
  while (isInstalledAppRunning() && Date.now() < deadline) {
    spawnSync('sleep', ['0.5']);
  }
  return !isInstalledAppRunning();
}

run('npm', ['run', 'package:desktop']);

if (!fs.existsSync(packagedApp)) {
  console.error(`[easyview-desktop] Packaged app missing: ${packagedApp}`);
  process.exit(1);
}

if (!quitInstalledApp()) {
  console.error('[easyview-desktop] EasyView_Md is still running (unsaved files may be blocking quit). Save or close them, quit the app, then rerun this command.');
  process.exit(1);
}

fs.rmSync(installApp, { recursive: true, force: true });
run('/usr/bin/ditto', [packagedApp, installApp]);
console.log(`[easyview-desktop] Installed ${installApp}`);
console.log('[easyview-desktop] Relaunch EasyView_Md from Applications / Dock.');
