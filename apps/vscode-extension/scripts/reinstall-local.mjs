#!/usr/bin/env node
/** Rebuild, package, and install EasyView_Md into VS Code and/or Cursor. */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(extensionDir, '../..');

function readExtensionPackage() {
  return JSON.parse(readFileSync(path.join(extensionDir, 'package.json'), 'utf8'));
}

function parseArgs(argv) {
  const options = { target: 'both', bump: true };
  for (const arg of argv) {
    if (arg === '--bump') options.bump = true;
    else if (arg === '--no-bump') options.bump = false;
    else if (arg.startsWith('--target=')) options.target = arg.slice('--target='.length);
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  if (!['both', 'cursor', 'code', 'vscode'].includes(options.target)) {
    throw new Error(`Invalid --target=${options.target}. Use both|cursor|code`);
  }
  if (options.target === 'vscode') options.target = 'code';
  return options;
}

async function run(command, args, cwd = root) {
  console.log(`$ ${command} ${args.join(' ')}`);
  await execFileAsync(command, args, { cwd, maxBuffer: 20 * 1024 * 1024 });
}

async function commandExists(command) {
  try {
    await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [command]);
    return true;
  } catch {
    return false;
  }
}

async function packageExtension({ bump }) {
  if (bump) {
    await run('npm', ['version', 'patch', '--no-git-tag-version', '--workspace', 'easyview-md']);
  }
  await run('npm', ['run', 'package:vscode']);
  const { version } = readExtensionPackage();
  const file = path.join(extensionDir, `easyview-md-${version}.vsix`);
  if (!existsSync(file)) throw new Error(`VSIX not found: ${file}`);
  return file;
}

async function installTo(cli, file) {
  await run(cli, ['--install-extension', file, '--force']);
  console.log(`[easyview-md] Installed into ${cli}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node apps/vscode-extension/scripts/reinstall-local.mjs [--target=both|cursor|code] [--no-bump]');
    return;
  }

  const wantCursor = options.target === 'both' || options.target === 'cursor';
  const wantCode = options.target === 'both' || options.target === 'code';
  const hasCursor = wantCursor && await commandExists('cursor');
  const hasCode = wantCode && await commandExists('code');

  if (wantCursor && !hasCursor) console.warn('[easyview-md] cursor CLI not found; skip Cursor install');
  if (wantCode && !hasCode) console.warn('[easyview-md] code CLI not found; skip VS Code install');
  if (!hasCursor && !hasCode) throw new Error('Neither cursor nor code CLI is available on PATH');

  const file = await packageExtension(options);
  if (hasCursor) await installTo('cursor', file);
  if (hasCode) await installTo('code', file);
  console.log('[easyview-md] Done. Reload Window in the editor to load the new build.');
}

main().catch((error) => {
  console.error('[easyview-md] reinstall failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
