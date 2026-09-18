import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const logo = path.join(root, 'resources/brand/logo.png');
const actual = createHash('sha256').update(await readFile(logo)).digest('hex');
const recorded = (await readFile(path.join(root, 'apps/desktop/assets/brand-source.sha256'), 'utf8')).trim();
if (actual !== recorded) throw new Error('Desktop icons are not generated from the current shared brand logo.');
for (const file of ['icon.png', 'icon.icns', 'icon.ico']) await access(path.join(root, 'apps/desktop/assets', file));
const extensionPackage = JSON.parse(await readFile(path.join(root, 'apps/vscode-extension/package.json'), 'utf8'));
if (extensionPackage.icon !== 'dist/brand/logo.png') throw new Error('VS Code extension must package the shared brand logo.');
console.log(`verified shared brand source ${actual}`);
