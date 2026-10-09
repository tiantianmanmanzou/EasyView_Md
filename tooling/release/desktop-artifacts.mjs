import { appendFileSync, copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const version = JSON.parse(readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8')).version;
const [command, ...args] = process.argv.slice(2);

if (command === 'validate') {
  const [tag] = args;
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? '')) {
    throw new Error('Release tag must be vX.Y.Z (stable desktop release).');
  }
  if (tag !== `v${version}`) throw new Error(`Tag ${tag} does not match desktop package version ${version}`);
  console.log(`Validated ${tag}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\nversion=${version}\n`);
} else if (command === 'stage') {
  const [platform, arch, destination] = args;
  if (!destination || !((platform === 'darwin' && arch === 'arm64') || (platform === 'win32' && arch === 'x64'))) {
    throw new Error('Usage: desktop-artifacts.mjs stage <darwin arm64|win32 x64> <destination>');
  }
  if (process.platform !== platform || process.arch !== arch) throw new Error('Runner architecture does not match release target');
  const make = path.join(root, 'apps/desktop/out/make');
  const files = platform === 'darwin' ? [
    [`dmg/arm64/EasyView_Md-${version}-arm64.dmg`, 'EasyView_Md-mac-arm64.dmg'],
    [`zip/darwin/arm64/EasyView_Md-darwin-arm64-${version}.zip`, 'EasyView_Md-mac-arm64.zip'],
  ] : [
    [`squirrel.windows/x64/EasyView_Md-${version} Setup.exe`, 'EasyView_Md-win-x64-setup.exe'],
    [`zip/win32/x64/EasyView_Md-win32-x64-${version}.zip`, 'EasyView_Md-win-x64.zip'],
  ];
  for (const [source] of files) {
    const info = statSync(path.join(make, source));
    if (!info.isFile() || !info.size) throw new Error(`Missing or empty installer: ${source}`);
  }
  mkdirSync(destination, { recursive: true });
  for (const [source, target] of files) copyFileSync(path.join(make, source), path.join(destination, target));
} else {
  throw new Error('Expected validate or stage command');
}
