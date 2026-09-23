/** Workspace and web-search tools available to EasyView Agent mode. */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { applyAiTextPatches, type AiTextPatch } from '@easyview/contracts';
import { writeFileAtomically } from '../filesystem/file-write';

const execFileAsync = promisify(execFile);
const MAX_FILE_BYTES = 1_000_000;
const MAX_LIST_ENTRIES = 500;
const BRAVE_WEB_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

export interface ActiveAgentDocument {
  path: string;
  content: string;
  applyPatches: (patches: AiTextPatch[]) => Promise<void> | void;
}

export interface CreateAiAgentToolsOptions {
  workspaceRootPath: string | null;
  activeDocument?: ActiveAgentDocument;
  includeWorkspaceTools?: boolean;
  webSearchApiKey?: string | null;
  fetchImpl?: typeof fetch;
}

interface EditBaseline {
  id: string;
  path: string;
  content: string;
}

type WorkspaceFileEntry = { path: string; type: 'file' | 'directory'; size?: number };

function ensureRelativePath(value: string, field = 'path'): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized === '.') throw new Error(`${field} 不能为空`);
  if (path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`${field} 必须是工作区内的相对路径`);
  }
  return normalized;
}

function ensureWithinRoot(rootPath: string, candidatePath: string): void {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new Error('路径不能超出当前工作区');
}

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

function numberedLines(content: string, startLine: number, endLine: number): string {
  return content.split('\n').slice(startLine - 1, endLine).map((line, index) => `${startLine + index}\t${line}`).join('\n');
}

async function workspaceRoot(rootPath: string): Promise<string> {
  const stat = await fs.stat(rootPath);
  if (!stat.isDirectory()) throw new Error('当前工作区根目录不可用');
  return fs.realpath(rootPath);
}

async function resolveExistingPath(rootPath: string, relativePath: string): Promise<string> {
  const candidate = path.resolve(rootPath, ensureRelativePath(relativePath));
  ensureWithinRoot(rootPath, candidate);
  const stat = await fs.lstat(candidate);
  if (stat.isSymbolicLink()) throw new Error('不支持访问符号链接');
  const realPath = await fs.realpath(candidate);
  ensureWithinRoot(rootPath, realPath);
  return realPath;
}

async function resolveCreationPath(rootPath: string, relativePath: string): Promise<string> {
  const candidate = path.resolve(rootPath, ensureRelativePath(relativePath));
  ensureWithinRoot(rootPath, candidate);
  const parentPath = path.dirname(candidate);
  const parentStat = await fs.lstat(parentPath);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('目标父目录不可用');
  const realParent = await fs.realpath(parentPath);
  ensureWithinRoot(rootPath, realParent);
  const targetPath = path.join(realParent, path.basename(candidate));
  ensureWithinRoot(rootPath, targetPath);
  return targetPath;
}

function assertContentSize(content: string): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error(`单次文件内容不能超过 ${MAX_FILE_BYTES} 字节`);
}

async function gitBaseline(rootPath: string, relativePath: string): Promise<{ repository: boolean; status: string; diff: string }> {
  try {
    const [{ stdout: status }, { stdout: diff }] = await Promise.all([
      execFileAsync('git', ['status', '--short'], { cwd: rootPath, maxBuffer: MAX_FILE_BYTES }),
      execFileAsync('git', ['diff', '--', relativePath], { cwd: rootPath, maxBuffer: MAX_FILE_BYTES }),
    ]);
    return { repository: true, status: status.trimEnd(), diff: diff.trimEnd() };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const exitCode = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : undefined;
    if (code === 'ENOENT' || exitCode === 128) return { repository: false, status: '', diff: '' };
    throw error;
  }
}

function fileTools(rootPath: string, activeDocument?: ActiveAgentDocument): ToolSet {
  const baselines = new Map<string, EditBaseline>();
  const activePath = activeDocument ? path.resolve(activeDocument.path) : undefined;
  const activeRelativePath = activePath ? path.relative(rootPath, activePath).split(path.sep).join('/') : undefined;

  const inspectPath = async (requestedPath?: string): Promise<{ path: string; content: string; diskPath?: string; active: boolean }> => {
    if (!requestedPath && activeDocument && activeRelativePath && !activeRelativePath.startsWith('..')) {
      return { path: activeRelativePath, content: activeDocument.content, active: true };
    }
    if (!requestedPath) throw new Error('未打开当前文档时必须提供 path');
    const normalized = ensureRelativePath(requestedPath);
    const filePath = await resolveExistingPath(rootPath, normalized);
    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) throw new Error('只能检查普通文件');
    if (stat.size > MAX_FILE_BYTES) throw new Error(`文件大小为 ${stat.size} 字节，超过读取上限 ${MAX_FILE_BYTES} 字节`);
    const content = await fs.readFile(filePath, 'utf8');
    if (content.includes('\0')) throw new Error('不支持检查二进制文件');
    return { path: normalized, content, diskPath: filePath, active: activePath === path.resolve(filePath) };
  };

  return {
    list_files: tool({
      description: '列出当前工作区某个目录的直接子项。路径必须是相对工作区根目录的目录路径。',
      inputSchema: z.object({ path: z.string().optional().describe('相对工作区根目录的目录路径；不传表示工作区根目录') }),
      execute: async ({ path: relativePath = '.' }): Promise<{ path: string; entries: WorkspaceFileEntry[] }> => {
        const directoryPath = relativePath === '.' ? rootPath : await resolveExistingPath(rootPath, relativePath);
        const stat = await fs.lstat(directoryPath);
        if (!stat.isDirectory()) throw new Error('path 必须指向目录');
        const entries = await fs.readdir(directoryPath, { withFileTypes: true });
        if (entries.length > MAX_LIST_ENTRIES) throw new Error(`目录包含 ${entries.length} 项，超过 ${MAX_LIST_ENTRIES} 项；请指定更具体的目录`);
        const result = await Promise.all(entries.filter((entry) => !entry.isSymbolicLink()).map(async (entry): Promise<WorkspaceFileEntry> => {
          const entryPath = path.join(directoryPath, entry.name);
          const relative = path.relative(rootPath, entryPath).split(path.sep).join('/');
          if (entry.isDirectory()) return { path: relative, type: 'directory' };
          return { path: relative, type: 'file', size: (await fs.stat(entryPath)).size };
        }));
        result.sort((left, right) => left.type.localeCompare(right.type) || left.path.localeCompare(right.path));
        return { path: relativePath, entries: result };
      },
    }),

    inspect_file: tool({
      description: '建立既有文本文件的编辑基线。修改前必须调用：返回当前内容、行号范围、Git 工作区状态与该文件未提交 diff。',
      inputSchema: z.object({
        path: z.string().optional().describe('相对工作区根目录的文件路径；省略时检查当前打开的文档'),
        startLine: z.number().int().min(1).optional().describe('需要查看的起始行，默认第 1 行'),
        endLine: z.number().int().min(1).optional().describe('需要查看的结束行，默认文件末行'),
      }),
      execute: async ({ path: requestedPath, startLine = 1, endLine }): Promise<{ baselineId: string; path: string; totalLines: number; selectedLines: string; git: { repository: boolean; status: string; diff: string } }> => {
        const inspected = await inspectPath(requestedPath);
        const totalLines = inspected.content.split('\n').length;
        const finalEndLine = Math.min(endLine ?? totalLines, totalLines);
        if (startLine > finalEndLine) throw new Error('起始行不能大于结束行');
        const baselineId = `${inspected.path}:${contentHash(inspected.content)}`;
        baselines.set(baselineId, { id: baselineId, path: inspected.path, content: inspected.content });
        return {
          baselineId,
          path: inspected.path,
          totalLines,
          selectedLines: numberedLines(inspected.content, startLine, finalEndLine),
          git: await gitBaseline(rootPath, inspected.path),
        };
      },
    }),

    read_file: tool({
      description: '读取工作区文本文件。编辑已有文件前应改用 inspect_file 建立含 Git 状态的编辑基线。',
      inputSchema: z.object({ path: z.string().describe('相对工作区根目录的文件路径') }),
      execute: async ({ path: requestedPath }): Promise<{ path: string; content: string }> => {
        const inspected = await inspectPath(requestedPath);
        return { path: inspected.path, content: inspected.content };
      },
    }),

    apply_patch: tool({
      description: '在 inspect_file 建立的编辑基线上，对已有文本文件应用小范围精确补丁。每个 patch 是一个完整且独立的语义改动。',
      inputSchema: z.object({
        baselineId: z.string().min(1).describe('inspect_file 返回的 baselineId'),
        patches: z.array(z.object({
          description: z.string().min(1).describe('本 patch 的完整语义说明'),
          expectedText: z.string().min(1).describe('当前文件中唯一且精确的锚点文本'),
          replacement: z.string().describe('替换后的文本；空字符串表示删除'),
        })).min(1),
      }),
      execute: async ({ baselineId, patches }): Promise<{ path: string; changed: number }> => {
        const baseline = baselines.get(baselineId);
        if (!baseline) throw new Error('编辑基线不存在；请先调用 inspect_file');
        const inspected = await inspectPath(baseline.path);
        if (inspected.content !== baseline.content) throw new Error('文件自建立基线后已变化；请重新调用 inspect_file');
        const nextContent = applyAiTextPatches(baseline.content, patches);
        if (inspected.active) {
          if (!activeDocument) throw new Error('当前文档编辑上下文不可用');
          await activeDocument.applyPatches(patches);
        } else {
          if (!inspected.diskPath) throw new Error('目标文件路径不可用');
          await writeFileAtomically(inspected.diskPath, nextContent);
        }
        return { path: baseline.path, changed: patches.length };
      },
    }),

    create_file: tool({
      description: '在当前工作区内创建一个新的文本文件。目标父目录必须已存在，且目标文件不能存在。',
      inputSchema: z.object({ path: z.string().describe('相对工作区根目录的新文件路径'), content: z.string().describe('新文件的完整初始内容') }),
      execute: async ({ path: relativePath, content }): Promise<{ path: string; bytes: number }> => {
        assertContentSize(content);
        const filePath = await resolveCreationPath(rootPath, relativePath);
        await fs.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
        return { path: ensureRelativePath(relativePath), bytes: Buffer.byteLength(content, 'utf8') };
      },
    }),
  };
}

function webSearchTool(apiKey: string, fetchImpl?: typeof fetch): ToolSet {
  return {
    web_search: tool({
      description: '使用 Brave Search 搜索公开网页，并返回标题、URL 与摘要。',
      inputSchema: z.object({ query: z.string().trim().min(1).max(400).describe('搜索关键词'), count: z.number().int().min(1).max(10).optional().describe('结果数量，默认 5') }),
      execute: async ({ query, count = 5 }): Promise<{ query: string; results: Array<{ title: string; url: string; snippet: string; publishedAt?: string }> }> => {
        const requestUrl = new URL(BRAVE_WEB_SEARCH_URL);
        requestUrl.searchParams.set('q', query);
        requestUrl.searchParams.set('count', String(count));
        const response = await (fetchImpl ?? fetch)(requestUrl, { headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey } });
        if (!response.ok) throw new Error(`Web Search 请求失败 (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`);
        const payload = await response.json() as { web?: { results?: Array<{ title?: unknown; url?: unknown; description?: unknown; age?: unknown }> } };
        const results = (payload.web?.results ?? []).filter((item): item is { title: string; url: string; description?: string; age?: string } => typeof item.title === 'string' && typeof item.url === 'string').map((item) => ({
          title: item.title,
          url: item.url,
          snippet: typeof item.description === 'string' ? item.description : '',
          ...(typeof item.age === 'string' ? { publishedAt: item.age } : {}),
        }));
        return { query, results };
      },
    }),
  };
}

/** Creates only the tools that can be executed in the current host context. */
export async function createAiAgentTools(options: CreateAiAgentToolsOptions): Promise<ToolSet> {
  const tools: ToolSet = {};
  if (options.includeWorkspaceTools && options.workspaceRootPath) {
    Object.assign(tools, fileTools(await workspaceRoot(options.workspaceRootPath), options.activeDocument));
  }
  if (options.webSearchApiKey?.trim()) Object.assign(tools, webSearchTool(options.webSearchApiKey.trim(), options.fetchImpl));
  return tools;
}
