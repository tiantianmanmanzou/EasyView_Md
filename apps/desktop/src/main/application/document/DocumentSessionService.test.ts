import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashContent, minimalTextPatch } from '@easyview/editor-sync';
import {
  DocumentSessionService,
  toOperationResult,
} from './DocumentSessionService';
import type { CompareAndWriteResult, DocumentFileSystem, DocumentFileStat } from './documentFileSystem';
import type { DocumentGitPort } from './documentGit';

// The app stores platform-absolute paths (path.resolve), e.g. D:\tmp\a.md on Windows.
const p = (filePath: string): string => path.resolve(filePath);

class FakeDocumentFileSystem implements DocumentFileSystem {
  readonly files = new Map<string, { raw: string; mtimeMs: number }>();
  beforeCompareAndWrite?: (filePath: string) => void;
  writeStarted?: () => void;
  private writeGate: Promise<void> = Promise.resolve();
  private releaseWriteGate?: () => void;

  holdNextWrites(): Promise<void> {
    this.writeGate = new Promise((resolve) => {
      this.releaseWriteGate = resolve;
    });
    return this.writeGate;
  }

  releaseWrites(): void {
    this.releaseWriteGate?.();
    this.releaseWriteGate = undefined;
    this.writeGate = Promise.resolve();
  }

  seed(filePath: string, raw: string, mtimeMs = 1): void {
    this.files.set(filePath, { raw, mtimeMs });
  }

  async readFile(filePath: string): Promise<string> {
    const file = this.files.get(filePath);
    if (!file) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return file.raw;
  }

  async writeFileAtomically(filePath: string, content: string): Promise<void> {
    this.writeStarted?.();
    await this.writeGate;
    const previous = this.files.get(filePath);
    this.files.set(filePath, { raw: content, mtimeMs: (previous?.mtimeMs ?? 0) + 1 });
  }

  async compareAndWrite(filePath: string, expectedHash: string, content: string): Promise<CompareAndWriteResult> {
    this.beforeCompareAndWrite?.(filePath);
    const current = this.files.get(filePath);
    if (!current || hashContent(current.raw) !== expectedHash) return 'conflict';
    this.writeStarted?.();
    await this.writeGate;
    this.files.set(filePath, { raw: content, mtimeMs: current.mtimeMs + 1 });
    return 'ok';
  }

  async stat(filePath: string): Promise<DocumentFileStat> {
    const file = this.files.get(filePath);
    if (!file) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { mtimeMs: file.mtimeMs, isFile: true };
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    const file = this.files.get(existingPath);
    if (!file) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    if (this.files.has(newPath)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    this.files.set(newPath, { ...file });
  }

  async unlink(filePath: string): Promise<void> {
    this.files.delete(filePath);
  }
}

function openTwoSessions(fs: FakeDocumentFileSystem): DocumentSessionService {
  fs.seed(p('/tmp/a.md'), '# A\n');
  fs.seed(p('/tmp/b.md'), '# B\n');
  const service = new DocumentSessionService(fs);
  service.open({ tabId: 'tab-a', filePath: p('/tmp/a.md'), fileName: 'a.md', raw: '# A\n', mtimeMs: 1 });
  service.open({ tabId: 'tab-b', filePath: p('/tmp/b.md'), fileName: 'b.md', raw: '# B\n', mtimeMs: 1 });
  return service;
}

function editSession(service: DocumentSessionService, sessionId: string, content: string): void {
  const session = service.get(sessionId)!;
  expect(service.applyEdits(sessionId, {
    documentId: session.documentId,
    baseRevision: session.sync.snapshot.revision,
    edits: minimalTextPatch(session.content, content),
    resultHash: hashContent(content),
  }).ok).toBe(true);
}

describe('DocumentSessionService save snapshots', () => {
  it.each(['save', 'save-as'] as const)('preserves edits made while %s writes its snapshot', async (operation) => {
    const fs = new FakeDocumentFileSystem();
    const rawPrefix = '<!-- fullWidth: true tocVisible: false -->\r\n';
    const raw = `${rawPrefix}# A\r\n`;
    fs.seed(p('/tmp/a.md'), raw);
    const service = new DocumentSessionService(fs);
    const session = service.open({ tabId: 'tab-a', filePath: p('/tmp/a.md'), fileName: 'a.md', raw, mtimeMs: 1 });
    const savedContent = '# A saved\n';
    const latestContent = '# A saved later\n';
    editSession(service, session.tabId, savedContent);
    fs.holdNextWrites();
    const started = new Promise<void>((resolve) => { fs.writeStarted = resolve; });
    const targetPath = operation === 'save' ? p('/tmp/a.md') : p('/tmp/saved-as.md');
    const saving = operation === 'save'
      ? service.save(session.tabId, savedContent)
      : service.writeToPath(session.tabId, targetPath, savedContent, '\r\n');
    await started;
    editSession(service, session.tabId, latestContent);
    fs.releaseWrites();

    expect((await saving).kind).toBe('saved');
    expect(fs.files.get(targetPath)?.raw).toBe(`${rawPrefix}# A saved\r\n`);
    expect(session.filePath).toBe(targetPath);
    expect(session.content).toBe(latestContent);
    expect(session.rawContent).toBe(`${rawPrefix}# A saved later\r\n`);
    expect(session.documentAdapter.content).toBe(latestContent);
    expect(session.diskContent).toBe(savedContent);
    expect(session.diskContentHash).toBe(hashContent(`${rawPrefix}# A saved\r\n`));
    expect(session.sync.snapshot).toMatchObject({ canonicalContent: latestContent, revision: 2 });
    expect(session.dirty).toBe(true);

    expect((await service.save(session.tabId, latestContent)).kind).toBe('saved');
    expect(fs.files.get(targetPath)?.raw).toBe(`${rawPrefix}# A saved later\r\n`);
    expect(session.dirty).toBe(false);
    editSession(service, session.tabId, '# A saved later again\n');
    expect(session.documentAdapter.content).toBe('# A saved later again\n');
    expect(session.dirty).toBe(true);
  });

  it('keeps newer edits when older snapshots wait in the save queue', async () => {
    const fs = new FakeDocumentFileSystem();
    const service = openTwoSessions(fs);
    editSession(service, 'tab-a', '# first\n');
    fs.holdNextWrites();
    const started = new Promise<void>((resolve) => { fs.writeStarted = resolve; });
    const first = service.save('tab-a', '# first\n');
    await started;
    editSession(service, 'tab-a', '# second\n');
    const second = service.save('tab-a', '# second\n');
    editSession(service, 'tab-a', '# third\n');
    fs.releaseWrites();

    expect((await first).kind).toBe('saved');
    expect((await second).kind).toBe('saved');
    expect(fs.files.get(p('/tmp/a.md'))?.raw).toBe('# second\n');
    expect(service.get('tab-a')?.content).toBe('# third\n');
    expect(service.get('tab-a')?.documentAdapter.content).toBe('# third\n');
    expect(service.get('tab-a')?.sync.snapshot.revision).toBe(3);
    expect(service.get('tab-a')?.dirty).toBe(true);
  });
});

describe('DocumentSessionService save targeting (problem 7)', () => {
  it('returns NOT_FOUND and does not fall back to another open session', async () => {
    const fs = new FakeDocumentFileSystem();
    const service = openTwoSessions(fs);

    const missing = await service.save('missing-tab', '# stolen\n');
    expect(missing.kind).toBe('error');
    if (missing.kind === 'error' && !missing.error.ok) {
      expect(missing.error.code).toBe('NOT_FOUND');
    }
    expect(fs.files.get(p('/tmp/a.md'))?.raw).toBe('# A\n');
    expect(fs.files.get(p('/tmp/b.md'))?.raw).toBe('# B\n');
  });

  it('writes the queued session even if another tab is saved afterwards', async () => {
    const fs = new FakeDocumentFileSystem();
    const service = openTwoSessions(fs);
    fs.holdNextWrites();

    const first = service.save('tab-a', '# A saved\n');
    const second = service.save('tab-b', '# B saved\n');
    fs.releaseWrites();

    const firstOutcome = await first;
    const secondOutcome = await second;
    expect(firstOutcome.kind).toBe('saved');
    expect(secondOutcome.kind).toBe('saved');
    if (firstOutcome.kind === 'saved') {
      expect(firstOutcome.value.filePath).toBe(p('/tmp/a.md'));
    }
    if (secondOutcome.kind === 'saved') {
      expect(secondOutcome.value.filePath).toBe(p('/tmp/b.md'));
    }
    expect(fs.files.get(p('/tmp/a.md'))?.raw).toBe('# A saved\n');
    expect(fs.files.get(p('/tmp/b.md'))?.raw).toBe('# B saved\n');
  });
});

describe('DocumentSessionService external conflict (problem 8)', () => {
  it('does not overwrite disk when an external write lands after the hash check starts', async () => {
    const fs = new FakeDocumentFileSystem();
    const service = openTwoSessions(fs);
    fs.beforeCompareAndWrite = (filePath) => {
      if (filePath === p('/tmp/a.md')) fs.seed(p('/tmp/a.md'), '# changed on disk\n', 99);
    };

    const outcome = await service.save('tab-a', '# A local\n');
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error' && !outcome.error.ok) {
      expect(outcome.error.code).toBe('CONFLICT');
    }
    expect(fs.files.get(p('/tmp/a.md'))?.raw).toBe('# changed on disk\n');
    expect(service.get('tab-a')?.content).toBe('# A\n');
    expect(service.get('tab-a')?.externalConflict).not.toBeNull();
  });

  it('rejects a second tab save of the same file after the first tab already wrote', async () => {
    const fs = new FakeDocumentFileSystem();
    fs.seed(p('/tmp/shared.md'), '# shared\n');
    const service = new DocumentSessionService(fs);
    service.open({ tabId: 'tab-1', filePath: p('/tmp/shared.md'), fileName: 'shared.md', raw: '# shared\n', mtimeMs: 1 });
    service.open({ tabId: 'tab-2', filePath: p('/tmp/shared.md'), fileName: 'shared.md', raw: '# shared\n', mtimeMs: 1 });

    const first = await service.save('tab-1', '# from tab 1\n');
    expect(first.kind).toBe('saved');
    expect(fs.files.get(p('/tmp/shared.md'))?.raw).toBe('# from tab 1\n');

    const second = await service.save('tab-2', '# from tab 2\n');
    expect(second.kind).toBe('error');
    if (second.kind === 'error' && !second.error.ok) {
      expect(second.error.code).toBe('CONFLICT');
    }
    expect(fs.files.get(p('/tmp/shared.md'))?.raw).toBe('# from tab 1\n');
    expect(toOperationResult(second).ok).toBe(false);
  });
});

describe('DocumentSessionService split aliases', () => {
  it('lets a second tabId save and delete through the same session', async () => {
    const fs = new FakeDocumentFileSystem();
    fs.seed(p('/tmp/shared.md'), '# shared\n');
    const service = new DocumentSessionService(fs);
    service.open({ tabId: 'tab-1', filePath: p('/tmp/shared.md'), fileName: 'shared.md', raw: '# shared\n', mtimeMs: 1 });
    expect(service.alias('tab-1-split', 'tab-1')?.tabId).toBe('tab-1');
    expect(service.get('tab-1-split')).toBe(service.get('tab-1'));

    editSession(service, 'tab-1-split', '# from split\n');
    const saved = await service.save('tab-1-split', '# from split\n');
    expect(saved.kind).toBe('saved');
    expect(fs.files.get(p('/tmp/shared.md'))?.raw).toBe('# from split\n');

    expect(service.delete('tab-1-split')).toBeUndefined();
    expect(service.get('tab-1')?.content).toBe('# from split\n');
    expect(service.delete('tab-1')?.tabId).toBe('tab-1');
    expect(service.get('tab-1')).toBeUndefined();
  });

  it('promotes the remaining alias when the canonical tab is closed first', () => {
    const fs = new FakeDocumentFileSystem();
    fs.seed(p('/tmp/shared.md'), '# shared\n');
    const service = new DocumentSessionService(fs);
    service.open({ tabId: 'tab-1', filePath: p('/tmp/shared.md'), fileName: 'shared.md', raw: '# shared\n', mtimeMs: 1 });
    service.alias('tab-1-split', 'tab-1');
    expect(service.delete('tab-1')).toBeUndefined();
    expect(service.get('tab-1-split')?.tabId).toBe('tab-1-split');
    expect(service.delete('tab-1-split')?.tabId).toBe('tab-1-split');
  });
});

describe('DocumentSessionService workspace rename', () => {
  it('waits for an in-flight save and routes a queued save to the renamed path', async () => {
    const fs = new FakeDocumentFileSystem();
    const service = openTwoSessions(fs);
    const session = service.get('tab-a')!;
    const documentId = session.documentId;
    fs.holdNextWrites();
    const started = new Promise<void>((resolve) => { fs.writeStarted = resolve; });
    editSession(service, 'tab-a', '# saved before rename\n');
    const saving = service.save('tab-a', session.content);
    await started;
    let renamed = false;
    const renaming = service.renamePath(p('/tmp/a.md'), p('/tmp/renamed.md'), async () => {
      renamed = true;
      await fs.link(p('/tmp/a.md'), p('/tmp/renamed.md'));
      await fs.unlink(p('/tmp/a.md'));
    });
    editSession(service, 'tab-a', '# saved after rename\n');
    const queuedSave = service.save('tab-a', session.content);
    await Promise.resolve();
    expect(renamed).toBe(false);
    fs.releaseWrites();
    expect((await saving).kind).toBe('saved');
    await renaming;
    expect((await queuedSave).kind).toBe('saved');
    expect(fs.files.has(p('/tmp/a.md'))).toBe(false);
    expect(fs.files.get(p('/tmp/renamed.md'))?.raw).toBe('# saved after rename\n');
    expect(session.filePath).toBe(p('/tmp/renamed.md'));
    expect(session.documentId).toBe(documentId);
  });

  it('migrates folder descendants and split aliases without losing dirty content', async () => {
    const fs = new FakeDocumentFileSystem();
    const service = new DocumentSessionService(fs);
    fs.seed(p('/tmp/docs/nested/a.md'), '# A\n');
    const session = service.open({ tabId: 'tab-a', filePath: p('/tmp/docs/nested/a.md'), fileName: 'a.md', raw: '# A\n', mtimeMs: 1 });
    service.alias('split-a', 'tab-a');
    editSession(service, 'split-a', '# unsaved\n');
    await service.renamePath(p('/tmp/docs'), p('/tmp/renamed'), async () => {
      await fs.link(p('/tmp/docs/nested/a.md'), p('/tmp/renamed/nested/a.md'));
      await fs.unlink(p('/tmp/docs/nested/a.md'));
    });
    expect(session.content).toBe('# unsaved\n');
    expect(session.dirty).toBe(true);
    expect(service.get('split-a')?.filePath).toBe(p('/tmp/renamed/nested/a.md'));
    expect((await service.save('split-a', session.content)).kind).toBe('saved');
    expect(fs.files.has(p('/tmp/docs/nested/a.md'))).toBe(false);
  });

  it('leaves document paths unchanged when rename fails and releases the save queue', async () => {
    const fs = new FakeDocumentFileSystem();
    const service = openTwoSessions(fs);
    await expect(service.renamePath(p('/tmp/a.md'), p('/tmp/b.md'), () => fs.link(p('/tmp/a.md'), p('/tmp/b.md'))))
      .rejects.toMatchObject({ code: 'EEXIST' });
    expect(service.get('tab-a')?.filePath).toBe(p('/tmp/a.md'));
    expect((await service.save('tab-a', '# still original\n')).kind).toBe('saved');
    expect(fs.files.get(p('/tmp/b.md'))?.raw).toBe('# B\n');
  });
});

class FakeDocumentGit implements DocumentGitPort {
  repositoryRoot: string | null = '/repo';
  modified = true;
  upstream: string | null = 'origin/main';
  ahead = 1;
  staged: string[] = [];
  committed: Array<{ filePath: string; message: string }> = [];
  pushed = 0;

  async findRepository(_filePath: string): Promise<{ rootPath: string } | null> {
    return this.repositoryRoot ? { rootPath: this.repositoryRoot } : null;
  }

  async getFileStatus(): Promise<{ isModified: boolean }> {
    return { isModified: this.modified };
  }

  async stageFile(_rootPath: string, filePath: string): Promise<void> {
    this.staged.push(filePath);
  }

  async commitFile(_rootPath: string, filePath: string, message: string): Promise<void> {
    this.committed.push({ filePath, message });
    this.modified = false;
  }

  async getUpstreamStatus(): Promise<{ upstream: string | null; ahead: number }> {
    return { upstream: this.upstream, ahead: this.ahead };
  }

  async push(): Promise<void> {
    this.pushed += 1;
    this.ahead = 0;
  }
}

describe('DocumentSessionService document identity', () => {
  it('keeps the logical document id stable across rename', async () => {
    const fs = new FakeDocumentFileSystem();
    fs.seed(p('/tmp/a.md'), '# A\n');
    const service = new DocumentSessionService(fs);
    const opened = service.open({ tabId: 'tab-a', filePath: p('/tmp/a.md'), fileName: 'a.md', raw: '# A\n', mtimeMs: 1 });

    const renamed = await service.rename('tab-a', 'renamed.md');

    expect(renamed.kind).toBe('saved');
    expect(service.get('tab-a')?.documentId).toBe(opened.documentId);
    expect(service.get('tab-a')?.filePath).toBe(p('/tmp/renamed.md'));
  });
});

describe('DocumentSessionService git operations', () => {
  it('stages, commits, and syncs through the injected git port', async () => {
    const fs = new FakeDocumentFileSystem();
    fs.seed(p('/tmp/a.md'), '# A\n');
    const git = new FakeDocumentGit();
    const service = new DocumentSessionService(fs, git);
    service.open({ tabId: 'tab-a', filePath: p('/tmp/a.md'), fileName: 'a.md', raw: '# A\n', mtimeMs: 1 });

    const staged = await service.stage('tab-a');
    expect(staged.ok).toBe(true);
    expect(git.staged).toEqual([p('/tmp/a.md')]);

    git.modified = true;
    const committed = await service.commit('tab-a', 'feat: a');
    expect(committed.ok).toBe(true);
    expect(git.committed).toEqual([{ filePath: p('/tmp/a.md'), message: 'feat: a' }]);

    git.modified = false;
    git.ahead = 1;
    const synced = await service.sync('tab-a', 'feat: a');
    expect(synced.ok).toBe(true);
    expect(git.pushed).toBe(1);
  });

  it('does not fall back to another session when the requested tab is missing', async () => {
    const fs = new FakeDocumentFileSystem();
    const git = new FakeDocumentGit();
    const service = new DocumentSessionService(fs, git);
    service.open({ tabId: 'tab-a', filePath: p('/tmp/a.md'), fileName: 'a.md', raw: '# A\n', mtimeMs: 1 });

    const missing = await service.stage('missing-tab');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('NOT_FOUND');
    expect(git.staged).toEqual([]);
  });

  it('rejects commit when the file has no git changes', async () => {
    const fs = new FakeDocumentFileSystem();
    fs.seed(p('/tmp/a.md'), '# A\n');
    const git = new FakeDocumentGit();
    git.modified = false;
    const service = new DocumentSessionService(fs, git);
    service.open({ tabId: 'tab-a', filePath: p('/tmp/a.md'), fileName: 'a.md', raw: '# A\n', mtimeMs: 1 });

    const result = await service.commit('tab-a', 'feat: a');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGUMENT');
    expect(git.committed).toEqual([]);
  });
});
