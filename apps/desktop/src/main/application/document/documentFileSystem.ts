import { promises as fs } from 'node:fs';
import { writeFileAtomically } from '@easyview/node-runtime';
import { hashContent } from '@easyview/editor-sync';

export type CompareAndWriteResult = 'ok' | 'conflict';

export interface DocumentFileStat {
  mtimeMs: number;
  isFile: boolean;
}

/**
 * Filesystem boundary for document save/rename. Tests inject a fake so the
 * check-then-write window can be controlled without touching the real disk.
 */
export interface DocumentFileSystem {
  readFile(filePath: string): Promise<string>;
  writeFileAtomically(filePath: string, content: string): Promise<void>;
  /**
   * Read, compare against the expected raw-content hash, and write without
   * exposing a caller-visible gap. Production still has a tiny OS-level
   * TOCTOU window; the in-process file lock plus this single entry point is
   * the contract tests assert against.
   */
  compareAndWrite(filePath: string, expectedHash: string, content: string): Promise<CompareAndWriteResult>;
  stat(filePath: string): Promise<DocumentFileStat>;
  link(existingPath: string, newPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
}

export function createNodeDocumentFileSystem(): DocumentFileSystem {
  return {
    readFile(filePath) {
      return fs.readFile(filePath, 'utf8');
    },
    writeFileAtomically(filePath, content) {
      return writeFileAtomically(filePath, content);
    },
    async compareAndWrite(filePath, expectedHash, content) {
      let current: string;
      try {
        current = await fs.readFile(filePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'conflict';
        throw error;
      }
      if (hashContent(current) !== expectedHash) return 'conflict';
      // Re-read immediately before replacement so an external writer that
      // lands during the initial read is detected before we publish bytes.
      const beforeWrite = await fs.readFile(filePath, 'utf8');
      if (hashContent(beforeWrite) !== expectedHash) return 'conflict';
      await writeFileAtomically(filePath, content);
      // A non-cooperating external writer can still race the rename. Verify
      // the published bytes and surface that race as a conflict.
      const afterWrite = await fs.readFile(filePath, 'utf8');
      if (hashContent(afterWrite) !== hashContent(content)) return 'conflict';
      return 'ok';
    },
    async stat(filePath) {
      const stats = await fs.stat(filePath);
      return { mtimeMs: stats.mtimeMs, isFile: stats.isFile() };
    },
    link(existingPath, newPath) {
      return fs.link(existingPath, newPath);
    },
    unlink(filePath) {
      return fs.unlink(filePath);
    },
  };
}
