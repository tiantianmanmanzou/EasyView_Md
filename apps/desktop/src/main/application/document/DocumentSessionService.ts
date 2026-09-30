import path from 'node:path';
import {
  operationFailure,
  operationSuccess,
  type OperationResult,
} from '@easyview/contracts';
import { applyTextPatches, hashContent, validatePatches, type TextOffsetPatch } from '@easyview/editor-sync';
import type { SaveDocumentResult } from '../../../contracts';
import type { DocumentFileSystem } from './documentFileSystem';
import type { DocumentGitContext, DocumentGitPort } from './documentGit';
import {
  createDocumentSession,
  filePathKey,
  type DocumentSession,
} from './documentSession';

export type { DocumentGitContext, DocumentGitPort } from './documentGit';

export type { DocumentSession } from './documentSession';
export { createDocumentSession, createEmptySession, filePathKey } from './documentSession';

export interface OpenDocumentSessionInput {
  tabId: string;
  filePath: string;
  fileName: string;
  raw: string;
  mtimeMs: number;
}

export interface ApplyEditsInput {
  documentId: string;
  baseRevision: number;
  edits: readonly TextOffsetPatch[];
  resultHash: string;
}

export interface ApplyEditsSuccess {
  revision: number;
  resultHash: string;
  dirtyChanged: boolean;
}

export type DocumentSaveOutcome =
  | { kind: 'saved'; value: SaveDocumentResult }
  | { kind: 'needs-save-as'; session: DocumentSession }
  | { kind: 'error'; error: OperationResult<never> };

/**
 * Owns every open document session. Callers pass sessionId; the service never
 * falls back to an implicit "current" session.
 */
export class DocumentSessionService {
  private readonly sessions = new Map<string, DocumentSession>();
  private readonly aliases = new Map<string, string>();
  private readonly saveQueues = new Map<string, Promise<unknown>>();
  private readonly fileLocks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly fileSystem: DocumentFileSystem,
    private readonly git: DocumentGitPort | null = null,
  ) {}

  get(sessionId: string): DocumentSession | undefined {
    return this.sessions.get(this.canonicalId(sessionId));
  }

  has(sessionId: string): boolean {
    return this.get(sessionId) !== undefined;
  }

  require(sessionId: string | null | undefined): OperationResult<DocumentSession> {
    if (!sessionId) return operationFailure('NOT_FOUND', '文档会话不存在');
    const session = this.get(sessionId);
    if (!session) return operationFailure('NOT_FOUND', '文档会话不存在');
    return operationSuccess(session);
  }

  values(): Iterable<DocumentSession> {
    return this.sessions.values();
  }

  dirtySessions(): DocumentSession[] {
    return [...this.sessions.values()].filter((session) => session.dirty);
  }

  hasDirty(): boolean {
    return this.dirtySessions().length > 0;
  }

  findByDocumentId(documentId: string): DocumentSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.documentId === documentId) return session;
    }
    return undefined;
  }

  findByFilePath(filePath: string): DocumentSession[] {
    const key = filePathKey(filePath);
    return [...this.sessions.values()].filter((session) => (
      session.filePath !== null && filePathKey(session.filePath) === key
    ));
  }

  attach(session: DocumentSession): DocumentSession {
    this.sessions.set(session.tabId, session);
    return session;
  }

  /** Bind another tabId to an existing session (same-file split / second pane). */
  alias(aliasTabId: string, canonicalTabId: string): DocumentSession | undefined {
    const session = this.get(canonicalTabId);
    if (!session) return undefined;
    if (aliasTabId === session.tabId) return session;
    if (this.sessions.has(aliasTabId)) return this.sessions.get(aliasTabId);
    this.aliases.set(aliasTabId, session.tabId);
    return session;
  }

  async getChangeSnapshot(sessionId: string): Promise<OperationResult<Awaited<ReturnType<NonNullable<DocumentGitPort['getChangeSnapshot']>>>>> {
    const context = await this.resolveGitContext(sessionId);
    if (!context.ok) return context;
    if (!this.git?.getChangeSnapshot) return operationFailure('DEPENDENCY_MISSING', '当前环境未接入 Git 变更计算');
    try {
      const session = this.get(sessionId);
      if (!session) return operationFailure('NOT_FOUND', '文档会话不存在');
      return operationSuccess(await this.git.getChangeSnapshot(context.value.rootPath, context.value.filePath, session.content));
    } catch (error) {
      return operationFailure('UNKNOWN', error instanceof Error ? error.message : 'Git 变更计算失败');
    }
  }

  async resolveGitContext(sessionId: string): Promise<OperationResult<DocumentGitContext>> {
    const required = this.require(sessionId);
    if (!required.ok) return required;
    if (!this.git) return operationFailure('DEPENDENCY_MISSING', '当前环境未接入 Git');
    const session = required.value;
    if (!session.filePath) return operationFailure('INVALID_ARGUMENT', '请先保存 Markdown 文档。');
    try {
      const repository = await this.git.findRepository(session.filePath);
      if (!repository) return operationFailure('NOT_FOUND', '当前文档不属于 Git 仓库。');
      return operationSuccess({
        rootPath: repository.rootPath,
        filePath: session.filePath,
        fileName: session.fileName,
      });
    } catch (error) {
      return operationFailure('UNKNOWN', error instanceof Error ? error.message : '无法解析 Git 仓库');
    }
  }

  async stage(sessionId: string): Promise<OperationResult<{ fileName: string }>> {
    const context = await this.resolveGitContext(sessionId);
    if (!context.ok) return context;
    try {
      await this.git!.stageFile(context.value.rootPath, context.value.filePath);
      return operationSuccess({ fileName: context.value.fileName });
    } catch (error) {
      return operationFailure('UNKNOWN', error instanceof Error ? error.message : 'Git 暂存失败');
    }
  }

  async stageContent(sessionId: string, content: string): Promise<OperationResult<{ fileName: string }>> {
    const context = await this.resolveGitContext(sessionId);
    if (!context.ok) return context;
    try {
      if (this.git!.stageFileContent) await this.git!.stageFileContent(context.value.rootPath, context.value.filePath, content);
      else await this.git!.stageFile(context.value.rootPath, context.value.filePath);
      return operationSuccess({ fileName: context.value.fileName });
    } catch (error) {
      return operationFailure('UNKNOWN', error instanceof Error ? error.message : 'Git 暂存失败');
    }
  }

  async commit(sessionId: string, message: string): Promise<OperationResult<{ fileName: string }>> {
    if (!message.trim()) return operationFailure('INVALID_ARGUMENT', '提交信息不能为空。');
    const context = await this.resolveGitContext(sessionId);
    if (!context.ok) return context;
    try {
      const status = await this.git!.getFileStatus(context.value.rootPath, context.value.filePath);
      if (!status.isModified) return operationFailure('INVALID_ARGUMENT', '当前文件没有可提交的 Git 变更。');
      await this.git!.commitFile(context.value.rootPath, context.value.filePath, message.trim());
      return operationSuccess({ fileName: context.value.fileName });
    } catch (error) {
      return operationFailure('UNKNOWN', error instanceof Error ? error.message : 'Git 提交失败');
    }
  }

  async sync(sessionId: string, message: string): Promise<OperationResult<{ fileName: string }>> {
    if (!message.trim()) return operationFailure('INVALID_ARGUMENT', '提交信息不能为空。');
    const context = await this.resolveGitContext(sessionId);
    if (!context.ok) return context;
    try {
      const fileStatus = await this.git!.getFileStatus(context.value.rootPath, context.value.filePath);
      if (fileStatus.isModified) {
        await this.git!.commitFile(context.value.rootPath, context.value.filePath, message.trim());
      }
      const upstream = await this.git!.getUpstreamStatus(context.value.rootPath);
      if (!upstream.upstream) return operationFailure('INVALID_ARGUMENT', '当前分支未配置上游远端。');
      if (upstream.ahead <= 0) return operationFailure('INVALID_ARGUMENT', '当前分支没有待推送提交。');
      await this.git!.push(context.value.rootPath);
      return operationSuccess({ fileName: context.value.fileName });
    } catch (error) {
      return operationFailure('UNKNOWN', error instanceof Error ? error.message : 'Git 同步失败');
    }
  }

  open(input: OpenDocumentSessionInput): DocumentSession {
    return this.attach(createDocumentSession({
      tabId: input.tabId,
      filePath: path.resolve(input.filePath),
      fileName: input.fileName,
      raw: input.raw,
      mtimeMs: input.mtimeMs,
    }));
  }

  delete(sessionId: string): DocumentSession | undefined {
    if (this.aliases.has(sessionId)) {
      this.aliases.delete(sessionId);
      return undefined;
    }
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const remaining = [...this.aliases.entries()].filter(([, canon]) => canon === sessionId);
    if (remaining.length > 0) {
      const [nextId] = remaining[0];
      this.aliases.delete(nextId);
      this.sessions.delete(sessionId);
      session.tabId = nextId;
      this.sessions.set(nextId, session);
      for (const [alias] of remaining.slice(1)) this.aliases.set(alias, nextId);
      const queue = this.saveQueues.get(sessionId);
      if (queue) {
        this.saveQueues.delete(sessionId);
        this.saveQueues.set(nextId, queue);
      }
      return undefined;
    }
    this.sessions.delete(sessionId);
    this.saveQueues.delete(sessionId);
    return session;
  }

  clear(): void {
    this.sessions.clear();
    this.aliases.clear();
    this.saveQueues.clear();
  }

  applyEdits(sessionId: string, input: ApplyEditsInput): OperationResult<ApplyEditsSuccess> {
    const required = this.require(sessionId);
    if (!required.ok) return required;
    const session = required.value;
    if (input.documentId !== session.documentId || input.baseRevision !== session.sync.snapshot.revision) {
      return operationFailure('CONFLICT', 'Document revision is stale');
    }
    try {
      validatePatches(input.edits, session.content.length);
      const nextContent = applyTextPatches(session.content, input.edits);
      if (hashContent(nextContent) !== input.resultHash) {
        return operationFailure('CONFLICT', 'Edit result hash mismatch');
      }
      const previousDirty = session.dirty;
      const result = session.documentAdapter.apply(input.edits);
      session.content = result.canonicalContent;
      session.rawContent = result.rawContent;
      session.sync.applySnapshot(session.content, session.sync.snapshot.revision + 1);
      session.dirty = session.content !== session.diskContent;
      return operationSuccess({
        revision: session.sync.snapshot.revision,
        resultHash: result.resultHash,
        dirtyChanged: previousDirty !== session.dirty,
      });
    } catch (error) {
      return operationFailure('INVALID_ARGUMENT', error instanceof Error ? error.message : 'Invalid document patch');
    }
  }

  revertToDisk(session: DocumentSession): void {
    const reverted = session.documentAdapter.replaceRaw(session.diskContent);
    session.rawContent = reverted.rawContent;
    session.content = reverted.canonicalContent;
    session.sync.applySnapshot(session.content, session.sync.snapshot.revision + 1);
    session.dirty = false;
    session.externalConflict = null;
  }

  markExternalConflict(session: DocumentSession, content: string, contentHashValue: string | null): void {
    session.externalConflict = { content, contentHash: contentHashValue };
    session.sync.markConflict();
  }

  applyDiskReload(session: DocumentSession, raw: string, mtimeMs: number | null): void {
    const replaced = session.documentAdapter.replaceRaw(raw);
    session.rawContent = replaced.rawContent;
    session.content = replaced.canonicalContent;
    session.diskContent = replaced.canonicalContent;
    session.diskContentHash = hashContent(raw);
    session.lineEnding = session.documentAdapter.lineEnding;
    session.diskMtimeMs = mtimeMs;
    session.sync.applySnapshot(session.content, session.sync.snapshot.revision + 1);
    session.externalConflict = null;
    session.dirty = false;
  }

  save(sessionId: string, content: string, options: { overwrite?: boolean } = {}): Promise<DocumentSaveOutcome> {
    return this.enqueueSession(sessionId, async () => {
      const required = this.require(sessionId);
      if (!required.ok) return { kind: 'error', error: required };
      const session = required.value;
      if (!session.filePath) return { kind: 'needs-save-as', session };
      if (options.overwrite) session.externalConflict = null;
      return this.writeBoundPath(session, session.filePath, content, options.overwrite === true);
    });
  }

  writeToPath(sessionId: string, filePath: string, content: string, lineEnding: '\n' | '\r\n'): Promise<DocumentSaveOutcome> {
    return this.enqueueSession(sessionId, async () => {
      const required = this.require(sessionId);
      if (!required.ok) return { kind: 'error', error: required };
      const session = required.value;
      const resolved = path.resolve(filePath);
      const duplicate = this.findByFilePath(resolved).find((candidate) => candidate.tabId !== session.tabId);
      if (duplicate) {
        return { kind: 'error', error: operationFailure('CONFLICT', '该 Markdown 文件已在另一个标签中打开') };
      }
      session.lineEnding = lineEnding;
      return this.enqueueFile(resolved, () => this.performWrite(session, resolved, content, { skipConflictCheck: true }));
    });
  }

  rename(sessionId: string, fileName: string): Promise<DocumentSaveOutcome> {
    return this.enqueueSession(sessionId, async () => {
      const required = this.require(sessionId);
      if (!required.ok) return { kind: 'error', error: required };
      const session = required.value;
      if (!session.filePath) {
        return { kind: 'error', error: operationFailure('NOT_FOUND', '当前没有已打开的文件') };
      }
      const targetPath = path.join(path.dirname(session.filePath), fileName);
      if (targetPath === session.filePath) {
        return {
          kind: 'saved',
          value: {
            filePath: session.filePath,
            fileName,
            mtimeMs: session.diskMtimeMs ?? 0,
          },
        };
      }
      const oldPath = session.filePath;
      return this.enqueueFile(oldPath, () => this.enqueueFile(targetPath, async () => {
        try {
          await this.fileSystem.link(oldPath, targetPath);
          try {
            await this.fileSystem.unlink(oldPath);
          } catch (error) {
            await this.fileSystem.unlink(targetPath).catch(() => undefined);
            throw error;
          }
          session.filePath = targetPath;
          session.fileName = fileName;
          const stats = await this.fileSystem.stat(targetPath);
          session.diskMtimeMs = stats.mtimeMs;
          return {
            kind: 'saved' as const,
            value: { filePath: targetPath, fileName, mtimeMs: stats.mtimeMs },
          };
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EEXIST') {
            return { kind: 'error' as const, error: operationFailure('CONFLICT', '目标文件已存在') };
          }
          return {
            kind: 'error' as const,
            error: operationFailure('UNKNOWN', error instanceof Error ? error.message : '无法重命名文件'),
          };
        }
      }));
    });
  }

  private writeBoundPath(session: DocumentSession, filePath: string, content: string, overwrite = false): Promise<DocumentSaveOutcome> {
    return this.enqueueFile(filePath, () => this.performWrite(session, filePath, content, { skipConflictCheck: overwrite }));
  }

  private async performWrite(
    session: DocumentSession,
    filePath: string,
    content: string,
    options: { skipConflictCheck: boolean },
  ): Promise<DocumentSaveOutcome> {
    if (session.externalConflict && !options.skipConflictCheck) {
      return { kind: 'error', error: operationFailure('CONFLICT', '文件已在外部修改，请重新加载文件后再保存') };
    }
    const raw = session.documentAdapter.rawContentFor(content);
    try {
      if (session.diskContentHash && !options.skipConflictCheck) {
        const written = await this.fileSystem.compareAndWrite(filePath, session.diskContentHash, raw);
        if (written === 'conflict') {
          session.externalConflict = { contentHash: null, content: '' };
          return { kind: 'error', error: operationFailure('CONFLICT', '文件已被其他程序修改，请先处理磁盘版本') };
        }
      } else {
        await this.fileSystem.writeFileAtomically(filePath, raw);
      }
      const stats = await this.fileSystem.stat(filePath);
      const savedAdapter = session.documentAdapter.replaceRaw(raw);
      session.filePath = filePath;
      session.fileName = path.basename(filePath);
      session.rawContent = savedAdapter.rawContent;
      session.content = savedAdapter.canonicalContent;
      session.diskContent = savedAdapter.canonicalContent;
      session.diskContentHash = hashContent(raw);
      session.lineEnding = session.documentAdapter.lineEnding;
      session.sync.applySnapshot(session.content, session.sync.snapshot.revision);
      session.diskMtimeMs = stats.mtimeMs;
      session.externalConflict = null;
      session.dirty = false;
      return {
        kind: 'saved',
        value: { filePath, fileName: session.fileName, mtimeMs: stats.mtimeMs },
      };
    } catch (error) {
      return {
        kind: 'error',
        error: operationFailure('UNKNOWN', error instanceof Error ? error.message : '无法保存文件'),
      };
    }
  }

  private canonicalId(sessionId: string): string {
    return this.aliases.get(sessionId) ?? sessionId;
  }

  private enqueueSession<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    return enqueue(this.saveQueues, this.canonicalId(sessionId), operation);
  }

  private enqueueFile<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    return enqueue(this.fileLocks, filePathKey(filePath), operation);
  }
}

function enqueue<T>(queues: Map<string, Promise<unknown>>, key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  queues.set(key, next.then(() => undefined, () => undefined));
  return next;
}

export function toOperationResult(outcome: DocumentSaveOutcome): OperationResult<SaveDocumentResult | null> {
  if (outcome.kind === 'saved') return operationSuccess(outcome.value);
  if (outcome.kind === 'needs-save-as') return operationSuccess(null);
  return outcome.error;
}
