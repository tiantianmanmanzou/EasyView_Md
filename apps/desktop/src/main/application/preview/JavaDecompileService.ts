import { spawn } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { JavaDecompileResult } from '../../../contracts';
import { PreviewSessionError, PreviewSessionStore } from './PreviewSession';

const CONSOLE_DECOMPILER = 'org.jetbrains.java.decompiler.main.decompiler.ConsoleDecompiler';
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

export class JavaDecompileService {
  constructor(private readonly sessions: PreviewSessionStore) {}

  async decompile(sessionId: string): Promise<JavaDecompileResult> {
    const descriptor = await this.sessions.descriptor(sessionId);
    if (descriptor.route !== 'java-class') throw new PreviewSessionError('invalid', '当前文件不是 Java class 文件');
    const jarPath = await resolveDecompilerJar();
    const output = await runConsoleDecompiler(jarPath, await this.sessions.filePath(sessionId));
    return { engine: 'fernflower', output: output.content, truncated: output.truncated };
  }
}

async function resolveDecompilerJar(): Promise<string> {
  const candidates = decompilerJarCandidates();
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsConstants.R_OK);
      return candidate;
    } catch {
      // Continue to the next verified runtime location.
    }
  }
  throw new PreviewSessionError('unsupported', '未找到 Java Decompiler 运行时（java-decompiler.jar）');
}

function decompilerJarCandidates(): string[] {
  const suffix = path.join('java-decompiler', 'java-decompiler.jar');
  return uniquePaths([
    // Electron packaged app: Contents/Resources/java-decompiler/java-decompiler.jar.
    process.resourcesPath ? path.join(process.resourcesPath, suffix) : '',
    // Electron development build: apps/desktop/dist/main -> apps/desktop/resources.
    path.resolve(__dirname, '../../resources', suffix),
    // Direct source/test execution from either repository root or apps/desktop.
    path.resolve(process.cwd(), 'resources', suffix),
    path.resolve(process.cwd(), 'apps/desktop/resources', suffix),
  ]);
}

function uniquePaths(candidates: string[]): string[] {
  return [...new Set(candidates.filter(Boolean).map((candidate) => path.resolve(candidate)))];
}

async function runConsoleDecompiler(jarPath: string, filePath: string): Promise<{ content: string; truncated: boolean }> {
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyview-java-decompile-'));
  try {
    const processOutput = await runJava(jarPath, filePath, outputDirectory);
    const sourcePath = await findDecompiledSource(outputDirectory);
    if (!sourcePath) {
      throw new PreviewSessionError('unsupported', processOutput.trim() || 'Java Decompiler 没有生成源码');
    }
    const source = await readBoundedText(sourcePath);
    return source;
  } finally {
    await fs.rm(outputDirectory, { recursive: true, force: true });
  }
}

function runJava(jarPath: string, filePath: string, outputDirectory: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('java', ['-cp', jarPath, CONSOLE_DECOMPILER, filePath, outputDirectory], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const output: Buffer[] = [];
    let outputSize = 0;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TIMEOUT_MS);
    const append = (chunk: Buffer) => {
      const remaining = MAX_OUTPUT_BYTES - outputSize;
      if (remaining <= 0) return;
      output.push(chunk.subarray(0, remaining));
      outputSize += Math.min(chunk.length, remaining);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') reject(new PreviewSessionError('unsupported', '未找到 Java 运行时；请安装 JRE 8 或更高版本后重试'));
      else reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const message = Buffer.concat(output, outputSize).toString('utf8').trim();
      if (timedOut) return reject(new PreviewSessionError('invalid', 'Java 反编译超时'));
      if (code === 0) return resolve(message);
      reject(new PreviewSessionError('unsupported', message || 'Java Decompiler 无法解析此 class 文件'));
    });
  });
}

async function findDecompiledSource(outputDirectory: string): Promise<string | null> {
  const candidates: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.java')) candidates.push(entryPath);
    }
  };
  await visit(outputDirectory);
  if (candidates.length !== 1) return null;
  return candidates[0];
}

async function readBoundedText(filePath: string): Promise<{ content: string; truncated: boolean }> {
  const stat = await fs.stat(filePath);
  const handle = await fs.open(filePath, 'r');
  try {
    const bytesToRead = Math.min(stat.size, MAX_OUTPUT_BYTES + 1);
    const bytes = Buffer.allocUnsafe(bytesToRead);
    const { bytesRead } = await handle.read(bytes, 0, bytesToRead, 0);
    return {
      content: bytes.subarray(0, Math.min(bytesRead, MAX_OUTPUT_BYTES)).toString('utf8'),
      truncated: bytesRead > MAX_OUTPUT_BYTES || stat.size > MAX_OUTPUT_BYTES,
    };
  } finally {
    await handle.close();
  }
}
