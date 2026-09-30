import { computeGitDiff } from '@easyview/markdown-core/git-diff';
import { hashContent } from '@easyview/editor-sync';
import {
  commitFile,
  findRepository,
  getFileStatus,
  getIndexFileContent,
  getIndexObjectId,
  getUpstreamStatus,
  push,
  stageFile,
  stageFileContent,
} from '@easyview/node-runtime';

export interface DocumentGitPort {
  findRepository(filePath: string): Promise<{ rootPath: string } | null>;
  getFileStatus(rootPath: string, filePath: string): Promise<{ isModified: boolean; isUntracked?: boolean }>;
  getChangeSnapshot?(rootPath: string, filePath: string, currentContent: string): Promise<{ lineRanges: Array<{ startLine: number; endLine: number; kind: 'added' | 'modified' }>; indexObjectId: string | null; baseContent: string; currentContentHash: string; isUntracked: boolean }>;
  stageFile(rootPath: string, filePath: string): Promise<void>;
  stageFileContent?(rootPath: string, filePath: string, content: string): Promise<void>;
  commitFile(rootPath: string, filePath: string, message: string): Promise<void>;
  getUpstreamStatus(rootPath: string): Promise<{ upstream: string | null; ahead: number }>;
  push(rootPath: string): Promise<void>;
}

export interface DocumentGitContext {
  rootPath: string;
  filePath: string;
  fileName: string;
}

export function createNodeDocumentGitPort(): DocumentGitPort {
  return {
    findRepository,
    getFileStatus,
    async getChangeSnapshot(rootPath, filePath, currentContent) {
      const status = await getFileStatus(rootPath, filePath);
      const indexObjectId = await getIndexObjectId(rootPath, filePath);
      const index = status.isUntracked ? '' : (await getIndexFileContent(rootPath, filePath) ?? '');
      const diff = computeGitDiff(index, currentContent);
      return { lineRanges: diff.lineRanges, indexObjectId, baseContent: index, currentContentHash: hashContent(currentContent), isUntracked: Boolean(status.isUntracked) };
    },
    async stageFile(rootPath, filePath) {
      await stageFile(rootPath, filePath);
    },
    async stageFileContent(rootPath, filePath, content) {
      await stageFileContent(rootPath, filePath, content);
    },
    async commitFile(rootPath, filePath, message) {
      await commitFile(rootPath, filePath, message);
    },
    getUpstreamStatus,
    async push(rootPath) {
      await push(rootPath);
    },
  };
}
