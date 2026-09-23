import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gunzip, inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import type { ArchiveEntry, ArchiveEntryPreview } from '../../../contracts';
import { PreviewSessionError, PreviewSessionStore } from './PreviewSession';

const inflateRawAsync = promisify(inflateRaw);
const gunzipAsync = promisify(gunzip);
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_PREVIEW_BYTES = 4 * 1024 * 1024;

interface InternalZipEntry extends ArchiveEntry {
  compressionMethod: number;
  localHeaderOffset: number;
}

export class ArchivePreviewService {
  constructor(private readonly sessions: PreviewSessionStore) {}

  async list(sessionId: string): Promise<ArchiveEntry[]> {
    const fileName = await this.fileName(sessionId);
    const { bytes } = await this.readArchive(sessionId, fileName);
    return this.parseEntries(bytes, fileName);
  }

  async openEntry(sessionId: string, entryPath: string): Promise<ArchiveEntryPreview> {
    const { entry, content } = await this.readEntry(sessionId, entryPath);
    const mimeType = mimeTypeForEntry(entry.path);
    return { ...entry, mimeType, contentUrl: await this.sessions.registerVirtualContent(sessionId, content, mimeType) };
  }

  async exportEntry(sessionId: string, entryPath: string, targetPath: string): Promise<void> {
    const { content } = await this.readEntry(sessionId, entryPath);
    await fs.writeFile(targetPath, content);
  }

  private async readEntry(sessionId: string, entryPath: string): Promise<{ entry: ArchiveEntry; content: Buffer }> {
    if (typeof entryPath !== 'string' || !entryPath || entryPath.includes('\0')) throw new PreviewSessionError('invalid', '压缩包条目路径无效');
    const fileName = await this.fileName(sessionId);
    const { bytes } = await this.readArchive(sessionId, fileName);
    const extension = archiveExtension(fileName);
    let entry: ArchiveEntry;
    let content: Buffer;
    if (extension === '.zip' || extension === '.epub') {
      const entries = parseZipEntries(bytes);
      const zipEntry = entries.find((candidate) => candidate.path === entryPath);
      if (!zipEntry) throw new PreviewSessionError('not-found', '压缩包条目不存在');
      entry = zipEntry;
      content = await extractZipEntry(bytes, zipEntry);
    } else if (extension === '.tar' || extension === '.tar.gz' || extension === '.tgz') {
      const tarEntry = findTarEntry(bytes, entryPath);
      if (!tarEntry) throw new PreviewSessionError('not-found', '压缩包条目不存在');
      entry = tarEntry.entry;
      content = tarEntry.content;
    } else if (extension === '.gz') {
      const expectedPath = fileName.slice(0, -3) || 'content';
      if (entryPath !== expectedPath) throw new PreviewSessionError('not-found', '压缩包条目不存在');
      entry = { path: expectedPath, directory: false, compressedSize: 0, uncompressedSize: bytes.length };
      content = bytes;
    } else {
      throw new PreviewSessionError('unsupported', `暂不支持读取 ${extension} 压缩包条目；需要对应的解压运行时`);
    }
    if (entry.directory) throw new PreviewSessionError('invalid', '目录条目不能直接预览');
    if (content.length > MAX_ENTRY_PREVIEW_BYTES) throw new PreviewSessionError('invalid', '压缩包条目超过 4 MiB 安全预览上限');
    return { entry, content };
  }

  private async readArchive(sessionId: string, fileName: string): Promise<{ bytes: Buffer }> {
    const descriptor = await this.sessions.descriptor(sessionId);
    if (descriptor.route !== 'archive' && descriptor.route !== 'epub') throw new PreviewSessionError('invalid', '当前文件不是压缩包');
    const source = await fs.readFile(await this.sessions.filePath(sessionId));
    const extension = archiveExtension(fileName);
    if (extension === '.tar.gz' || extension === '.tgz' || extension === '.gz') {
      try {
        return { bytes: await gunzipAsync(source, { maxOutputLength: MAX_EXPANDED_BYTES }) };
      } catch (error) {
        if (error instanceof RangeError || (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new PreviewSessionError('invalid', 'GZIP 解压后大小超过安全上限');
        throw new PreviewSessionError('invalid', 'GZIP 文件损坏或无法解压');
      }
    }
    return { bytes: source };
  }

  private async fileName(sessionId: string): Promise<string> {
    return (await this.sessions.descriptor(sessionId)).fileName;
  }

  private parseEntries(bytes: Buffer, fileName: string): ArchiveEntry[] {
    const extension = archiveExtension(fileName);
    if (extension === '.zip' || extension === '.epub') return parseZipEntries(bytes).map(toArchiveEntry);
    if (extension === '.tar' || extension === '.tar.gz' || extension === '.tgz') return parseTarEntries(bytes).map(({ entry }) => entry);
    if (extension === '.gz') {
      const entryPath = fileName.slice(0, -3) || 'content';
      return [{ path: entryPath, directory: false, compressedSize: 0, uncompressedSize: bytes.length }];
    }
    throw new PreviewSessionError('unsupported', `暂不支持读取 ${extension} 压缩包目录；需要对应的解压运行时`);
  }
}

function archiveExtension(fileName: string): string {
  const normalized = fileName.toLowerCase();
  if (normalized.endsWith('.tar.gz')) return '.tar.gz';
  if (normalized.endsWith('.tgz')) return '.tgz';
  const extension = path.extname(normalized);
  if (['.jar', '.war', '.ear', '.vsix', '.apk', '.cbz'].includes(extension)) return '.zip';
  return extension;
}

function parseZipEntries(bytes: Buffer): InternalZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(bytes);
  if (eocdOffset < 0) throw new PreviewSessionError('invalid', '不是有效的 ZIP 文件');
  const disk = bytes.readUInt16LE(eocdOffset + 4);
  const centralDirectoryDisk = bytes.readUInt16LE(eocdOffset + 6);
  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = bytes.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = bytes.readUInt32LE(eocdOffset + 16);
  if (disk !== 0 || centralDirectoryDisk !== 0 || entryCount === 0xffff || centralDirectoryOffset === 0xffffffff) throw new PreviewSessionError('unsupported', '暂不支持 ZIP64 或分卷 ZIP 文件');
  if (entryCount > MAX_ARCHIVE_ENTRIES) throw new PreviewSessionError('invalid', '压缩包条目数超过安全上限');
  if (centralDirectoryOffset + centralDirectorySize > bytes.length) throw new PreviewSessionError('invalid', 'ZIP 中央目录损坏');

  const entries: InternalZipEntry[] = [];
  let offset = centralDirectoryOffset;
  let expandedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new PreviewSessionError('invalid', 'ZIP 中央目录损坏');
    const flags = bytes.readUInt16LE(offset + 8);
    const compressionMethod = bytes.readUInt16LE(offset + 10);
    const dosTime = bytes.readUInt16LE(offset + 12);
    const dosDate = bytes.readUInt16LE(offset + 14);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localHeaderOffset = bytes.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length) throw new PreviewSessionError('invalid', 'ZIP 条目损坏');
    if ((flags & 0x1) !== 0) throw new PreviewSessionError('unsupported', '不支持读取加密 ZIP 文件');
    const name = decodeZipName(bytes.subarray(offset + 46, offset + 46 + nameLength), (flags & 0x800) !== 0);
    assertSafeArchivePath(name);
    expandedBytes += uncompressedSize;
    if (expandedBytes > MAX_EXPANDED_BYTES) throw new PreviewSessionError('invalid', '压缩包解压后总大小超过安全上限');
    if (compressedSize > 0 && uncompressedSize / compressedSize > 100) throw new PreviewSessionError('invalid', '压缩包条目压缩比超过安全上限');
    const lastModified = dosDateTimeToIso(dosDate, dosTime);
    entries.push({
      path: name,
      directory: name.endsWith('/'),
      compressedSize,
      uncompressedSize,
      ...(lastModified ? { lastModified } : {}),
      compressionMethod,
      localHeaderOffset,
    });
    offset = end;
  }
  return entries;
}

async function extractZipEntry(bytes: Buffer, entry: InternalZipEntry): Promise<Buffer> {
  if (entry.directory) return Buffer.alloc(0);
  if (entry.uncompressedSize > MAX_ENTRY_PREVIEW_BYTES || entry.compressedSize > MAX_ENTRY_PREVIEW_BYTES) throw new PreviewSessionError('invalid', '压缩包条目超过 4 MiB 安全预览上限');
  const offset = entry.localHeaderOffset;
  if (offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== 0x04034b50) throw new PreviewSessionError('invalid', 'ZIP 本地文件头损坏');
  const nameLength = bytes.readUInt16LE(offset + 26);
  const extraLength = bytes.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw new PreviewSessionError('invalid', 'ZIP 条目数据损坏');
  const compressed = bytes.subarray(start, end);
  if (entry.compressionMethod === 0) return Buffer.from(compressed);
  if (entry.compressionMethod !== 8) throw new PreviewSessionError('unsupported', 'ZIP 条目使用了暂不支持的压缩算法');
  const inflated = await inflateRawAsync(compressed, { maxOutputLength: MAX_ENTRY_PREVIEW_BYTES });
  if (inflated.length !== entry.uncompressedSize) throw new PreviewSessionError('invalid', 'ZIP 条目大小校验失败');
  return inflated;
}

function parseTarEntries(bytes: Buffer): Array<{ entry: ArchiveEntry; payloadOffset: number }> {
  const entries: Array<{ entry: ArchiveEntry; payloadOffset: number }> = [];
  let offset = 0;
  let expandedBytes = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = readTarString(header.subarray(0, 100));
    const prefix = readTarString(header.subarray(345, 500));
    const entryPath = prefix ? `${prefix}/${name}` : name;
    const size = parseTarOctal(header.subarray(124, 136));
    const type = header[156];
    assertSafeArchivePath(entryPath);
    expandedBytes += size;
    if (entries.length >= MAX_ARCHIVE_ENTRIES || expandedBytes > MAX_EXPANDED_BYTES) throw new PreviewSessionError('invalid', '压缩包内容超过安全上限');
    const payloadOffset = offset + 512;
    if (payloadOffset + size > bytes.length) throw new PreviewSessionError('invalid', 'TAR 条目数据损坏');
    entries.push({ entry: { path: entryPath, directory: type === 53 || entryPath.endsWith('/'), compressedSize: size, uncompressedSize: size }, payloadOffset });
    offset = payloadOffset + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function findTarEntry(bytes: Buffer, entryPath: string): { entry: ArchiveEntry; content: Buffer } | null {
  const item = parseTarEntries(bytes).find((candidate) => candidate.entry.path === entryPath);
  if (!item) return null;
  if (item.entry.uncompressedSize > MAX_ENTRY_PREVIEW_BYTES) throw new PreviewSessionError('invalid', '压缩包条目超过 4 MiB 安全预览上限');
  return { entry: item.entry, content: bytes.subarray(item.payloadOffset, item.payloadOffset + item.entry.uncompressedSize) };
}

function toArchiveEntry(entry: InternalZipEntry): ArchiveEntry {
  return {
    path: entry.path,
    directory: entry.directory,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize,
    ...(entry.lastModified ? { lastModified: entry.lastModified } : {}),
  };
}

function dosDateTimeToIso(dosDate: number, dosTime: number): string | undefined {
  if (!dosDate && !dosTime) return undefined;
  const year = ((dosDate >> 9) & 0x7f) + 1980;
  const month = (dosDate >> 5) & 0x0f;
  const day = dosDate & 0x1f;
  const hour = (dosTime >> 11) & 0x1f;
  const minute = (dosTime >> 5) & 0x3f;
  const second = (dosTime & 0x1f) * 2;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const start = Math.max(0, bytes.length - 0xffff - 22);
  for (let offset = bytes.length - 22; offset >= start; offset -= 1) if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  return -1;
}

function decodeZipName(bytes: Buffer, utf8: boolean): string { return bytes.toString(utf8 ? 'utf8' : 'latin1'); }

function assertSafeArchivePath(value: string): void {
  if (!value || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value)) throw new PreviewSessionError('invalid', '压缩包包含不安全路径');
  const normalized = path.posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../')) throw new PreviewSessionError('invalid', '压缩包包含路径穿越条目');
}

function readTarString(bytes: Buffer): string {
  const nulIndex = bytes.indexOf(0);
  return bytes.subarray(0, nulIndex < 0 ? bytes.length : nulIndex).toString('utf8').trim();
}

function parseTarOctal(bytes: Buffer): number {
  const value = readTarString(bytes).replace(/\0/g, '').trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) throw new PreviewSessionError('invalid', 'TAR 条目大小无效');
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new PreviewSessionError('invalid', 'TAR 条目大小无效');
  return parsed;
}

function mimeTypeForEntry(entryPath: string): string {
  const lower = entryPath.toLowerCase();
  if (/\.(txt|md|markdown|log|json|yaml|yml|xml|csv)$/i.test(lower)) return 'text/plain; charset=utf-8';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html; charset=utf-8';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.png')) return 'image/png';
  if (/\.(jpg|jpeg)$/i.test(lower)) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return 'application/octet-stream';
}
