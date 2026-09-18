import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomically } from '@easyview/node-runtime';
import type { PreviewDescriptor, PreviewRouteDefinition, PreviewTextResult } from '../../../contracts';
import { resolvePreviewRoute } from '../../../contracts';

const TEXT_READ_LIMIT = 4 * 1024 * 1024;

export class PreviewSessionError extends Error {
  constructor(
    readonly kind: 'invalid' | 'not-found' | 'permission' | 'unsupported' | 'stale',
    message: string,
  ) {
    super(message);
    this.name = 'PreviewSessionError';
  }
}

interface VirtualContent {
  sessionId: string;
  bytes: Buffer;
  mimeType: string;
}

export type PreviewContent =
  | { kind: 'file'; filePath: string; size: number; mimeType: string }
  | { kind: 'memory'; bytes: Buffer; mimeType: string };

interface PreviewSession {
  id: string;
  rootPath: string;
  realPath: string;
  relativePath: string;
  fileName: string;
  route: PreviewRouteDefinition;
  size: number;
  mtimeMs: number;
}

export class PreviewSessionStore {
  private readonly sessions = new Map<string, PreviewSession>();
  private readonly virtualContents = new Map<string, VirtualContent>();

  async open(rootPath: string, relativePath: string): Promise<PreviewDescriptor> {
    const session = await this.createSession(rootPath, relativePath);
    this.sessions.set(session.id, session);
    return this.toDescriptor(session);
  }

  close(sessionId: string): boolean {
    assertSessionId(sessionId);
    const closed = this.sessions.delete(sessionId);
    for (const [contentId, content] of this.virtualContents) {
      if (content.sessionId === sessionId) this.virtualContents.delete(contentId);
    }
    return closed;
  }

  closeAll(): void {
    this.sessions.clear();
    this.virtualContents.clear();
  }

  async registerVirtualContent(sessionId: string, bytes: Buffer, mimeType: string): Promise<string> {
    await this.requireFresh(sessionId);
    if (!Buffer.isBuffer(bytes) || bytes.length > TEXT_READ_LIMIT) {
      throw new PreviewSessionError('invalid', '压缩包条目超过可安全预览的大小上限');
    }
    if (typeof mimeType !== 'string' || !mimeType) throw new PreviewSessionError('invalid', '预览内容类型无效');
    const contentId = randomUUID();
    this.virtualContents.set(contentId, { sessionId, bytes, mimeType });
    return `easyview-preview://content/${contentId}`;
  }

  async resolveContent(contentId: string): Promise<PreviewContent> {
    assertSessionId(contentId);
    const virtual = this.virtualContents.get(contentId);
    if (virtual) {
      await this.requireFresh(virtual.sessionId);
      return { kind: 'memory', bytes: virtual.bytes, mimeType: virtual.mimeType };
    }
    const session = await this.requireFresh(contentId);
    return { kind: 'file', filePath: session.realPath, size: session.size, mimeType: session.route.mimeType };
  }

  async filePath(sessionId: string): Promise<string> {
    return (await this.requireFresh(sessionId)).realPath;
  }

  async descriptor(sessionId: string): Promise<PreviewDescriptor> {
    return this.toDescriptor(await this.requireFresh(sessionId));
  }

  async readText(sessionId: string): Promise<PreviewTextResult> {
    const session = await this.requireFresh(sessionId);
    if (session.route.route !== 'text' && session.route.route !== 'html' && session.route.route !== 'svg' && session.route.route !== 'http') {
      throw new PreviewSessionError('invalid', '当前文件不是可读取文本预览');
    }
    const limit = Math.min(TEXT_READ_LIMIT, session.route.maxSourceBytes);
    const handle = await fs.open(session.realPath, 'r');
    try {
      const bytesToRead = Math.min(session.size, limit + 1);
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
      const content = stripUtf8Bom(buffer.subarray(0, Math.min(bytesRead, limit)).toString('utf8'));
      return { content, truncated: bytesRead > limit || session.size > limit };
    } finally {
      await handle.close();
    }
  }

async writeBytes(sessionId: string, bytes: Buffer): Promise<PreviewDescriptor> {
    const session = await this.requireFresh(sessionId);
    if (session.route.route !== 'spreadsheet' && session.route.route !== 'word') {
      throw new PreviewSessionError('invalid', '当前文件不支持写入保存');
    }
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new PreviewSessionError('invalid', '写入内容无效');
    }
    if (bytes.length > session.route.maxSourceBytes) {
      throw new PreviewSessionError('invalid', `写入内容超过 ${formatMiB(session.route.maxSourceBytes)} 上限`);
    }
    await writeFileAtomically(session.realPath, bytes);
    const stat = await fs.stat(session.realPath);
    session.size = stat.size;
    session.mtimeMs = stat.mtimeMs;
    return this.toDescriptor(session);
  }

  private async createSession(rootPath: string, relativePath: string): Promise<PreviewSession> {
    const root = await realWorkspaceRoot(rootPath);
    const normalizedRelativePath = normalizeRelativePath(relativePath);
    const candidatePath = path.resolve(root, normalizedRelativePath);
    ensureWithinRoot(root, candidatePath);

    let lstat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      lstat = await fs.lstat(candidatePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new PreviewSessionError('not-found', '预览文件不存在');
      throw error;
    }
    if (lstat.isSymbolicLink()) throw new PreviewSessionError('permission', '不允许通过符号链接预览工作区外文件');
    if (!lstat.isFile()) throw new PreviewSessionError('invalid', '只能预览普通文件');

    const realPath = await fs.realpath(candidatePath);
    ensureWithinRoot(root, realPath);
    const stat = await fs.stat(realPath);
    const route = resolvePreviewRoute(path.basename(realPath));
    if (!route) throw new PreviewSessionError('unsupported', '此文件类型暂不支持预览');
    if (stat.size > route.maxSourceBytes) {
      throw new PreviewSessionError('invalid', `文件超过 ${formatMiB(route.maxSourceBytes)} 的 ${route.route} 预览上限`);
    }

    return {
      id: randomUUID(),
      rootPath: root,
      realPath,
      relativePath: normalizedRelativePath,
      fileName: path.basename(realPath),
      route,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  }

  private async requireFresh(sessionId: string): Promise<PreviewSession> {
    assertSessionId(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) throw new PreviewSessionError('not-found', '预览会话已关闭或不存在');

    let lstat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      lstat = await fs.lstat(session.realPath);
    } catch (error) {
      this.sessions.delete(sessionId);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new PreviewSessionError('stale', '预览文件已被删除，请重新打开');
      throw error;
    }
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
      this.sessions.delete(sessionId);
      throw new PreviewSessionError('stale', '预览文件类型已变化，请重新打开');
    }
    const resolved = await fs.realpath(session.realPath);
    try {
      ensureWithinRoot(session.rootPath, resolved);
    } catch {
      this.sessions.delete(sessionId);
      throw new PreviewSessionError('permission', '预览文件不再位于当前工作区内');
    }
    const stat = await fs.stat(resolved);
    if (resolved !== session.realPath || stat.size !== session.size || stat.mtimeMs !== session.mtimeMs) {
      this.sessions.delete(sessionId);
      throw new PreviewSessionError('stale', '预览文件已发生变化，请重新打开');
    }
    return session;
  }

  private toDescriptor(session: PreviewSession): PreviewDescriptor {
    return {
      sessionId: session.id,
      relativePath: session.relativePath,
      fileName: session.fileName,
      route: session.route.route,
      size: session.size,
      mtimeMs: session.mtimeMs,
      mimeType: session.route.mimeType,
      contentUrl: `easyview-preview://content/${session.id}`,
    };
  }
}

function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new PreviewSessionError('invalid', '预览会话标识无效');
  }
}

function normalizeRelativePath(relativePath: string): string {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0')) {
    throw new PreviewSessionError('invalid', '工作区相对路径无效');
  }
  if (path.isAbsolute(relativePath)) throw new PreviewSessionError('permission', '不允许使用绝对路径预览');
  const normalized = path.normalize(relativePath);
  if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new PreviewSessionError('permission', '预览路径不能超出工作区根目录');
  }
  return normalized.split(path.sep).join('/');
}

async function realWorkspaceRoot(rootPath: string): Promise<string> {
  try {
    const root = await fs.realpath(rootPath);
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new PreviewSessionError('invalid', '当前工作区不可用');
    return root;
  } catch (error) {
    if (error instanceof PreviewSessionError) throw error;
    throw new PreviewSessionError('not-found', '当前工作区不存在');
  }
}

function ensureWithinRoot(rootPath: string, candidatePath: string): void {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new PreviewSessionError('permission', '路径不能超出工作区根目录');
  }
}

function formatMiB(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

function stripUtf8Bom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}
