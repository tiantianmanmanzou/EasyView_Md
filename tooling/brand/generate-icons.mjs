import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

if (process.platform !== 'darwin') throw new Error('Desktop icon generation currently requires macOS sips and iconutil.');
const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.join(root, 'resources/brand/logo.png');
const outputDir = path.join(root, 'apps/desktop/assets');
const temp = await mkdtemp(path.join(os.tmpdir(), 'easyview-brand-'));
const iconset = path.join(temp, 'EasyView.iconset');
await mkdir(iconset, { recursive: true });

const resize = async (size, target) => {
  await execFileAsync('/usr/bin/sips', ['-z', String(size), String(size), source, '--out', target]);
};
const iconsetFiles = [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
];
for (const [size, name] of iconsetFiles) await resize(size, path.join(iconset, name));
await execFileAsync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(outputDir, 'icon.icns')]);
await resize(512, path.join(outputDir, 'icon.png'));

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const frames = [];
for (const size of icoSizes) {
  const file = path.join(temp, `icon-${size}.png`);
  await resize(size, file);
  frames.push({ size, data: await readFile(file) });
}
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
let offset = 6 + frames.length * 16;
const entries = frames.map(({ size, data }) => {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size === 256 ? 0 : size, 0); entry.writeUInt8(size === 256 ? 0 : size, 1);
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(data.length, 8); entry.writeUInt32LE(offset, 12);
  offset += data.length;
  return entry;
});
await writeFile(path.join(outputDir, 'icon.ico'), Buffer.concat([header, ...entries, ...frames.map(({ data }) => data)]));
const sourceHash = createHash('sha256').update(await readFile(source)).digest('hex');
await writeFile(path.join(outputDir, 'brand-source.sha256'), `${sourceHash}\n`);
await rm(temp, { recursive: true, force: true });
console.log(`generated Desktop icons from resources/brand/logo.png (${sourceHash})`);
