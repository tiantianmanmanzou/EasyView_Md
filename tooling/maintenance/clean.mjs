import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
for (const relativePath of [
  'dist',
  'apps/vscode-extension/dist',
  'apps/desktop/dist',
]) {
  await rm(path.join(root, relativePath), { recursive: true, force: true });
}
