import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(appDir, '../..');
const source = path.join(repositoryRoot, 'node_modules', 'node-pty');
const target = path.join(appDir, 'node_modules', 'node-pty');

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await Promise.all([
  cp(path.join(source, 'package.json'), path.join(target, 'package.json')),
  cp(path.join(source, 'LICENSE'), path.join(target, 'LICENSE')),
  cp(path.join(source, 'lib'), path.join(target, 'lib'), {
    recursive: true,
    filter(entry) {
      return !entry.endsWith('.map') && !entry.endsWith('.test.js');
    },
  }),
  cp(
    path.join(source, 'node_modules', 'node-addon-api'),
    path.join(target, 'node_modules', 'node-addon-api'),
    { recursive: true },
  ),
  cp(path.join(source, 'prebuilds'), path.join(target, 'prebuilds'), {
    recursive: true,
    filter(entry) {
      return !entry.endsWith('.pdb');
    },
  }),
]);
