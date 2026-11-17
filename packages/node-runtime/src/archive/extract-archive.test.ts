import { afterEach, expect, it, vi } from 'vitest';
import { promises } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import JSZip from 'jszip';
import { extractArchive, FREE_SPACE_RESERVE_BYTES } from './extract-archive';

const temps: string[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function folder(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'extract-archive-test-'))); temps.push(dir);
  return dir;
}
async function tree(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    out.push(`${path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')}${entry.isDirectory() ? '/' : ''}`);
  }
  return out.sort();
}
function tarEntry(name: string, content: string | null, extra: { type?: string; mode?: number } = {}): Buffer {
  const data = Buffer.from(content ?? '');
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, 'utf8');
  header.write(`${(extra.mode ?? 0o644).toString(8).padStart(7, '0')}\0`, 100);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write(extra.type ?? (content === null ? '5' : '0'), 156);
  header.write('ustar\0', 257);
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
function pax(pathValue: string): Buffer {
  let record = ` path=${pathValue}\n`;
  let length = Buffer.byteLength(record);
  length += String(length + String(length).length).length;
  record = `${length}${record}`;
  return tarEntry('PaxHeader', record, { type: 'x' });
}

it('extracts a zip into a sibling folder named after it, keeping Chinese names and skipping macOS metadata', async () => {
  const dir = await folder();
  const zip = new JSZip();
  zip.file('报告/摘要.md', '# 摘要');
  zip.file('run.sh', '#!/bin/sh', { unixPermissions: 0o755 });
  zip.folder('空目录');
  zip.file('__MACOSX/._run.sh', 'junk');
  await writeFile(path.join(dir, '资料.zip'), await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));

  const target = await extractArchive(path.join(dir, '资料.zip'));
  expect(target).toBe(path.join(dir, '资料'));
  expect(await tree(target)).toEqual(['run.sh', '报告/', '报告/摘要.md', '空目录/']);
  expect(await readFile(path.join(target, '报告', '摘要.md'), 'utf8')).toBe('# 摘要');
  if (process.platform !== 'win32') expect((await stat(path.join(target, 'run.sh'))).mode & 0o111).not.toBe(0);

  // A second extraction never touches the first folder.
  expect(await extractArchive(path.join(dir, '资料.zip'))).toBe(path.join(dir, '资料 2'));
  expect((await readdir(dir)).sort()).toEqual(['资料', '资料 2', '资料.zip']);
});

it('decodes GB18030 zip names written by Chinese Windows tools', async () => {
  const dir = await folder();
  const zip = new JSZip();
  zip.file('中文.txt', 'x');
  const bytes = await zip.generateAsync({ type: 'nodebuffer', encodeFileName: (name) => Buffer.from([0xd6, 0xd0, 0xce, 0xc4, ...Buffer.from(name.slice(2))]) as unknown as string });
  await writeFile(path.join(dir, 'gbk.zip'), bytes);
  expect(await tree(await extractArchive(path.join(dir, 'gbk.zip')))).toEqual(['中文.txt']);
});

it('extracts tar, tar.gz and single-file gz, including long pax names', async () => {
  const dir = await folder();
  const longName = `${'深'.repeat(60)}/file.txt`;
  const large = Array.from({ length: 40_000 }, (_, index) => `line ${index}\n`).join('');
  const tar = Buffer.concat([
    tarEntry('pkg/', null),
    tarEntry('pkg/a.txt', 'A'),
    tarEntry('pkg/large.txt', large),
    tarEntry('pkg/bin', '#!', { mode: 0o755 }),
    tarEntry('pkg/link', '', { type: '2' }),
    pax(longName), tarEntry('ignored-short-name', 'long'),
    Buffer.alloc(1024),
  ]);
  await writeFile(path.join(dir, 'pkg.tar'), tar);
  await writeFile(path.join(dir, 'pkg.tar.gz'), gzipSync(tar));
  await writeFile(path.join(dir, 'notes.txt.gz'), gzipSync('hello'));

  const expected = ['pkg/', 'pkg/a.txt', 'pkg/bin', 'pkg/large.txt', `${'深'.repeat(60)}/`, longName].sort();
  for (const name of ['pkg.tar', 'pkg.tar.gz']) {
    const target = await extractArchive(path.join(dir, name));
    expect(await tree(target)).toEqual(expected);
    expect(await readFile(path.join(target, 'pkg', 'large.txt'), 'utf8')).toBe(large);
    expect(await readFile(path.join(target, longName), 'utf8')).toBe('long');
  }
  const notes = await extractArchive(path.join(dir, 'notes.txt.gz'));
  expect(notes).toBe(path.join(dir, 'notes.txt'));
  expect(await readFile(path.join(notes, 'notes.txt'), 'utf8')).toBe('hello');
});

it('refuses unsafe paths and corrupt archives without leaving anything behind', async () => {
  const dir = await folder();
  await mkdir(path.join(dir, 'keep'));
  const zip = new JSZip();
  zip.file('ok.txt', 'fine');
  zip.file('../escape.txt', 'bad', { createFolders: false });
  await writeFile(path.join(dir, 'evil.zip'), await zip.generateAsync({ type: 'nodebuffer' }));
  await writeFile(path.join(dir, 'broken.zip'), 'not a zip');
  await writeFile(path.join(dir, 'broken.tgz'), 'not gzip');
  await writeFile(path.join(dir, 'archive.7z'), 'x');

  await expect(extractArchive(path.join(dir, 'evil.zip'))).rejects.toThrow('../escape.txt');
  await expect(extractArchive(path.join(dir, 'broken.zip'))).rejects.toThrow('无法读取压缩包');
  await expect(extractArchive(path.join(dir, 'broken.tgz'))).rejects.toThrow('无法读取压缩包');
  await expect(extractArchive(path.join(dir, 'archive.7z'))).rejects.toThrow('archive.7z');
  expect((await readdir(dir)).sort()).toEqual(['archive.7z', 'broken.tgz', 'broken.zip', 'evil.zip', 'keep']);
  expect(await readdir(path.dirname(dir))).not.toContain('escape.txt');
});

it('has no fixed size cap but stops before the disk would drop below the free-space reserve', async () => {
  const dir = await folder();
  const zip = new JSZip();
  zip.file('a.bin', Buffer.alloc(3000));
  zip.file('b.bin', Buffer.alloc(3000));
  await writeFile(path.join(dir, 'data.zip'), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const statfs = vi.spyOn(promises, 'statfs').mockResolvedValue({ bavail: FREE_SPACE_RESERVE_BYTES + 5000, bsize: 1 } as never);
  try {
    await expect(extractArchive(path.join(dir, 'data.zip'))).rejects.toThrow('磁盘空间不足');
    expect(await readdir(dir)).toEqual(['data.zip']);
    statfs.mockResolvedValue({ bavail: FREE_SPACE_RESERVE_BYTES + 6000, bsize: 1 } as never);
    expect(await tree(await extractArchive(path.join(dir, 'data.zip')))).toEqual(['a.bin', 'b.bin']);
  } finally {
    statfs.mockRestore();
  }
});
