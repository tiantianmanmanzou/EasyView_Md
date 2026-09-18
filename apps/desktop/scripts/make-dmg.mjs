import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, readlink, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  throw new Error('DMG can only be created on macOS');
}

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(appDir, 'package.json'), 'utf8'));
const appBundle = path.join(appDir, 'out', `EasyView_Md-darwin-${process.arch}`, 'EasyView_Md.app');
const outputDir = path.join(appDir, 'out', 'make', 'dmg', process.arch);
const stagingDir = path.join(appDir, 'out', `.dmg-staging-${process.arch}`);
const outputPath = path.join(outputDir, `EasyView_Md-${packageJson.version}-${process.arch}.dmg`);

await rm(stagingDir, { recursive: true, force: true });
await rm(outputPath, { force: true });
await mkdir(stagingDir, { recursive: true });
await mkdir(outputDir, { recursive: true });
execFileSync('/usr/bin/ditto', [appBundle, path.join(stagingDir, 'EasyView_Md.app')], { stdio: 'inherit' });
await symlink('/Applications', path.join(stagingDir, 'Applications'));

async function findAbsoluteSymlinks(root) {
  const result = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await readlink(fullPath);
        if (path.isAbsolute(target)) result.push({ path: fullPath, target });
      } else if (entry.isDirectory()) {
        await walk(fullPath);
      }
    }
  }
  await walk(root);
  return result;
}

const absoluteSymlinks = await findAbsoluteSymlinks(path.join(stagingDir, 'EasyView_Md.app'));
if (absoluteSymlinks.length > 0) {
  throw new Error(`DMG staging contains absolute symlinks: ${absoluteSymlinks.map((item) => item.path).join(', ')}`);
}

try {
  execFileSync('/usr/bin/hdiutil', [
    'create',
    '-volname', 'EasyView_Md',
    '-srcfolder', stagingDir,
    '-ov',
    '-format', 'UDZO',
    outputPath,
  ], { stdio: 'inherit' });
} finally {
  await rm(stagingDir, { recursive: true, force: true });
}

console.log(outputPath);
