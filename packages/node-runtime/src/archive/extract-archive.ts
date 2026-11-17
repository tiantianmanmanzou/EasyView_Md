import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import JSZip from 'jszip';
import { archiveExtractFolderName, extractableArchiveSuffix } from '@easyview/contracts';
import { tArchiveExtract } from './archive.i18n';

/** Entries stream straight to disk, so the only limit is disk space; stop while this much is still free. */
export const FREE_SPACE_RESERVE_BYTES = 1024 * 1024 * 1024;

/**
 * Extracts an archive into a new folder next to it named after the archive (`docs.zip` → `docs/`,
 * `docs 2/` when taken) and returns that folder's absolute path. Content lands in a hidden staging
 * folder first, so a failure leaves nothing behind. Links, devices and macOS `__MACOSX` metadata are skipped.
 */
export async function extractArchive(archivePath: string): Promise<string> {
  const fileName = path.basename(archivePath);
  const suffix = extractableArchiveSuffix(fileName);
  if (!suffix) throw new Error(tArchiveExtract('unsupported', { name: fileName }));
  const parent = path.dirname(archivePath);
  const folderName = archiveExtractFolderName(fileName);
  const staging = await fs.mkdtemp(path.join(parent, `.${folderName}.extracting-`));
  try {
    const space = await fs.statfs(parent);
    const output = new ExtractionOutput(staging, space.bavail * space.bsize - FREE_SPACE_RESERVE_BYTES);
    if (suffix === '.gz') await output.file(fileName.slice(0, -suffix.length), () => createReadStream(archivePath).pipe(createGunzip()));
    else if (suffix === '.tar') await extractTar(output, createReadStream(archivePath));
    else if (suffix === '.tar.gz' || suffix === '.tgz') await extractTar(output, createReadStream(archivePath).pipe(createGunzip()));
    else await extractZip(output, await fs.readFile(archivePath));
    const target = await availableFolder(parent, folderName);
    await fs.rename(staging, target);
    return target;
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw String((error as NodeJS.ErrnoException).code).startsWith('Z_') ? unreadable(error) : error;
  }
}

class ExtractionOutput {
  private written = 0;
  constructor(private readonly root: string, private readonly budget: number) {}

  async directory(entryPath: string): Promise<void> {
    const target = this.resolve(entryPath);
    if (target) await fs.mkdir(target, { recursive: true });
  }

  /** `open` is only called for entries that are kept. */
  async file(entryPath: string, open: () => AsyncIterable<Buffer | string>, executable = false): Promise<void> {
    const target = this.resolve(entryPath);
    if (!target) return;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await pipeline(open(), (source: AsyncIterable<Buffer | string>) => this.meter(source), createWriteStream(target, executable ? { mode: 0o755 } : undefined));
  }

  private async *meter(source: AsyncIterable<Buffer | string>): AsyncGenerator<Buffer | string> {
    for await (const chunk of source) {
      this.written += Buffer.byteLength(chunk);
      if (this.written > this.budget) throw new Error(tArchiveExtract('diskFull', { reserve: '1 GiB' }));
      yield chunk;
    }
  }

  /** Absolute target inside the staging folder; `undefined` for entries that are skipped. */
  private resolve(entryPath: string): string | undefined {
    const normalized = entryPath.replace(/\\/g, '/');
    const parts = normalized.split('/').filter((part) => part && part !== '.');
    if (normalized.includes('\0') || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || parts.includes('..')) {
      throw new Error(tArchiveExtract('unsafePath', { path: entryPath }));
    }
    if (parts.length === 0 || parts[0] === '__MACOSX') return undefined;
    return path.join(this.root, ...parts);
  }
}

async function extractZip(output: ExtractionOutput, source: Buffer): Promise<void> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(source, { decodeFileName: decodeZipName });
  } catch (error) {
    throw unreadable(error);
  }
  for (const entry of Object.values(zip.files)) {
    // JSZip quietly rewrites `../x` to `x`; judge the name the archive actually carries.
    const name = entry.unsafeOriginalName ?? entry.name;
    if (entry.dir) { await output.directory(name); continue; }
    const mode = typeof entry.unixPermissions === 'number' ? entry.unixPermissions : 0;
    if ((mode & 0o170000) === 0o120000) continue;
    await output.file(name, () => entry.nodeStream('nodebuffer'), (mode & 0o111) !== 0);
  }
}

/** Names without the UTF-8 flag: valid UTF-8 as is, otherwise GB18030, the usual encoding of Chinese Windows zips. */
function decodeZipName(bytes: string[] | Uint8Array | Buffer): string {
  const data = Uint8Array.from(bytes as Uint8Array);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return new TextDecoder('gb18030').decode(data);
  }
}

async function extractTar(output: ExtractionOutput, source: AsyncIterable<Buffer>): Promise<void> {
  const reader = new TarReader(source);
  let longName: string | undefined;
  for (;;) {
    const header = await reader.read(512);
    if (!header || header.every((value) => value === 0)) break;
    const size = tarOctal(header.subarray(124, 136));
    const padding = Math.ceil(size / 512) * 512 - size;
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    if (type === 'L' || type === 'x') {
      const data = (await reader.read(size)) ?? Buffer.alloc(0);
      await reader.skip(padding);
      longName = type === 'L' ? tarString(data) : paxPath(data) ?? longName;
      continue;
    }
    if (type === 'g') { await reader.skip(size + padding); continue; }
    const prefix = header.subarray(257, 262).toString('latin1') === 'ustar' ? tarString(header.subarray(345, 500)) : '';
    const shortName = tarString(header.subarray(0, 100));
    const name = longName ?? (prefix ? `${prefix}/${shortName}` : shortName);
    longName = undefined;
    const body = reader.take(size);
    if (type === '5') await output.directory(name);
    else if (type === '0' || type === '7') await output.file(name, () => body, (tarOctal(header.subarray(100, 108)) & 0o111) !== 0);
    for await (const _ of body) { /* drain skipped or link entries */ }
    await reader.skip(padding);
  }
}

/** Pulls exact byte counts out of a chunked stream, so tar entries go to disk without buffering the archive. */
class TarReader {
  private pending: Buffer = Buffer.alloc(0);
  private readonly chunks: AsyncIterator<Buffer>;
  constructor(source: AsyncIterable<Buffer>) { this.chunks = source[Symbol.asyncIterator](); }

  /** Exactly `size` bytes, or `null` when the stream ends cleanly first. */
  async read(size: number): Promise<Buffer | null> {
    while (this.pending.length < size) {
      const next = await this.chunks.next();
      if (next.done) {
        if (this.pending.length === 0) return null;
        throw unreadable(new Error('truncated tar entry'));
      }
      this.pending = Buffer.concat([this.pending, next.value]);
    }
    const head = this.pending.subarray(0, size);
    this.pending = this.pending.subarray(size);
    return head;
  }

  async *take(size: number): AsyncGenerator<Buffer> {
    let left = size;
    while (left > 0) {
      if (this.pending.length === 0) {
        const next = await this.chunks.next();
        if (next.done) throw unreadable(new Error('truncated tar entry'));
        this.pending = next.value;
      }
      const piece = this.pending.subarray(0, Math.min(left, this.pending.length));
      this.pending = this.pending.subarray(piece.length);
      left -= piece.length;
      yield piece;
    }
  }

  async skip(size: number): Promise<void> {
    for await (const _ of this.take(size)) { /* discard */ }
  }
}

function tarString(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString('utf8');
}

function tarOctal(bytes: Buffer): number {
  const value = tarString(bytes).trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) throw unreadable(new Error('invalid tar header'));
  return Number.parseInt(value, 8);
}

/** `path` from a pax extended header: records of `<length> <key>=<value>\n`, length counted in bytes. */
function paxPath(data: Buffer): string | undefined {
  let position = 0;
  let found: string | undefined;
  while (position < data.length) {
    const space = data.indexOf(0x20, position);
    const length = space < 0 ? 0 : Number(data.toString('latin1', position, space));
    if (!length) break;
    const record = data.toString('utf8', space + 1, position + length - 1);
    if (record.startsWith('path=')) found = record.slice('path='.length);
    position += length;
  }
  return found;
}

async function availableFolder(parent: string, name: string): Promise<string> {
  for (let index = 1; ; index += 1) {
    const candidate = path.join(parent, index === 1 ? name : `${name} ${index}`);
    try {
      await fs.lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate;
      throw error;
    }
  }
}

function unreadable(error: unknown): Error {
  return new Error(tArchiveExtract('unreadable', { message: error instanceof Error ? error.message : String(error) }));
}
