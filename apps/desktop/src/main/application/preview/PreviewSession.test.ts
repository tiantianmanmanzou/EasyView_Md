import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PreviewSessionStore } from './PreviewSession';

const directories: string[] = [];

async function workspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyview-preview-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('PreviewSessionStore', () => {
  it('opens only supported regular files within the real workspace and reads bounded text', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'notes.txt'), '\ufeffhello');
    const sessions = new PreviewSessionStore();

    const descriptor = await sessions.open(root, 'notes.txt');
    expect(descriptor.route).toBe('text');
    expect(descriptor.contentUrl).toMatch(/^easyview-preview:\/\/content\/[0-9a-f-]+$/);
    await expect(sessions.readText(descriptor.sessionId)).resolves.toEqual({ content: 'hello', truncated: false });
  });

  it('opens HTML with a page URL and serves sibling assets from the same directory', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'page.html'), '<link rel="stylesheet" href="style.css"><h1>Hi</h1>');
    await fs.writeFile(path.join(root, 'style.css'), 'h1{color:red}');
    const sessions = new PreviewSessionStore();
    const descriptor = await sessions.open(root, 'page.html');
    expect(descriptor.route).toBe('html');
    expect(descriptor.contentUrl).toBe(`easyview-preview://content/${descriptor.sessionId}/page.html`);
    await fs.mkdir(path.join(root, 'dsmp', 'page'), { recursive: true });
    await fs.writeFile(path.join(root, 'dsmp', 'page', '库.html'), '<h1>库</h1>');
    const related = await sessions.resolveRelatedContent(descriptor.sessionId, 'style.css');
    expect(related).toMatchObject({ kind: 'file', mimeType: 'text/css; charset=utf-8' });
    if (related.kind === 'file') {
      expect(related.filePath).toBe(await fs.realpath(path.join(root, 'style.css')));
    }
    const nested = await sessions.resolveRelatedContent(descriptor.sessionId, 'dsmp/page/库.html');
    expect(nested).toMatchObject({ kind: 'file', mimeType: 'text/html; charset=utf-8' });
    if (nested.kind === 'file') {
      expect(nested.filePath).toBe(await fs.realpath(path.join(root, 'dsmp', 'page', '库.html')));
    }
  });

  it('rejects lexical traversal and symlinks rather than following them outside the workspace', async () => {
    const root = await workspace();
    const outside = await workspace();
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
    const sessions = new PreviewSessionStore();

    await expect(sessions.open(root, '../secret.txt')).rejects.toMatchObject({ kind: 'permission' });
    await expect(sessions.open(root, 'escape.txt')).rejects.toMatchObject({ kind: 'permission' });
  });

  it('invalidates a session if the file changes after it was opened', async () => {
    const root = await workspace();
    const file = path.join(root, 'notes.txt');
    await fs.writeFile(file, 'first');
    const sessions = new PreviewSessionStore();
    const descriptor = await sessions.open(root, 'notes.txt');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.writeFile(file, 'second');

    await expect(sessions.readText(descriptor.sessionId)).rejects.toMatchObject({ kind: 'stale' });
  });

  it('writes spreadsheet bytes and refreshes session metadata', async () => {
    const root = await workspace();
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Sheet1').getCell('A1').value = 'before';
    const initial = Buffer.from(await workbook.xlsx.writeBuffer());
    await fs.writeFile(path.join(root, 'table.xlsx'), initial);
    const sessions = new PreviewSessionStore();
    const descriptor = await sessions.open(root, 'table.xlsx');

    workbook.getWorksheet(1)!.getCell('A1').value = 'after';
    const next = Buffer.from(await workbook.xlsx.writeBuffer());
    const written = await sessions.writeBytes(descriptor.sessionId, next);
    expect(written.size).toBe(next.length);
    expect(written.mtimeMs).toBeGreaterThanOrEqual(descriptor.mtimeMs);

    const fresh = await sessions.descriptor(descriptor.sessionId);
    expect(fresh.size).toBe(next.length);
    const onDisk = await fs.readFile(path.join(root, 'table.xlsx'));
    expect(Buffer.compare(onDisk, next)).toBe(0);
  });

  it('allows word-route write-back for docx bytes', async () => {
    const root = await workspace();
    // Minimal zip-shaped placeholder is enough to exercise session write gating.
    const initial = Buffer.from('PK\u0003\u0004docx-before');
    const next = Buffer.from('PK\u0003\u0004docx-after-bytes');
    await fs.writeFile(path.join(root, 'note.docx'), initial);
    const sessions = new PreviewSessionStore();
    const descriptor = await sessions.open(root, 'note.docx');
    expect(descriptor.route).toBe('word');
    const written = await sessions.writeBytes(descriptor.sessionId, next);
    expect(written.size).toBe(next.length);
    expect(Buffer.compare(await fs.readFile(path.join(root, 'note.docx')), next)).toBe(0);
  });
});
