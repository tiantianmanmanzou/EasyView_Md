import { execFile as execFileCallback } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface GitRepository {
  rootPath: string;
}

export interface GitFileStatus {
  repository: GitRepository;
  filePath: string;
  relativePath: string;
  indexStatus: string;
  workTreeStatus: string;
  status: string;
  isTracked: boolean;
  isModified: boolean;
  isStaged: boolean;
  isUntracked: boolean;
}

export interface GitFileDiff {
  repository: GitRepository;
  filePath: string;
  relativePath: string;
  diff: string;
  source: "working-tree" | "cached" | "none";
}

export interface GitCommitResult {
  repository: GitRepository;
  filePath: string;
  commitHash: string;
  output: string;
}

export interface GitUpstreamStatus {
  repository: GitRepository;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface GitPushResult {
  repository: GitRepository;
  upstream: string;
  output: string;
}

export class GitServiceError extends Error {
  readonly code:
    | "INVALID_PATH"
    | "NOT_FOUND"
    | "NOT_REPOSITORY"
    | "OUTSIDE_REPOSITORY"
    | "COMMAND_FAILED"
    | "NO_UPSTREAM"
    | "INVALID_ARGUMENT";
  readonly cause?: unknown;

  constructor(
    code: GitServiceError["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "GitServiceError";
    this.code = code;
    this.cause = cause;
  }
}

interface GitCommandError extends Error {
  code?: string;
  stdout?: string;
  stderr?: string;
}

function commandErrorMessage(error: unknown): string {
  const commandError = error as GitCommandError;
  const detail = (commandError.stderr || commandError.stdout || "").trim();
  return detail || (error instanceof Error ? error.message : String(error));
}

async function runGit(
  repositoryPath: string,
  args: readonly string[],
): Promise<string> {
  try {
    const result = await execFile("git", ["-C", repositoryPath, ...args], {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    throw new GitServiceError(
      "COMMAND_FAILED",
      `Git 命令执行失败（git ${args.join(" ")}）：${commandErrorMessage(error)}`,
      error,
    );
  }
}

async function resolveExistingPath(inputPath: string): Promise<string> {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new GitServiceError("INVALID_PATH", "路径不能为空。");
  }

  const resolvedPath = path.resolve(inputPath);
  try {
    return await realpath(resolvedPath);
  } catch (error) {
    throw new GitServiceError(
      "NOT_FOUND",
      `路径不存在或无法访问：${resolvedPath}`,
      error,
    );
  }
}

function isPathInside(rootPath: string, targetPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function resolveRepositoryRoot(startPath: string): Promise<string | null> {
  const resolvedPath = await resolveExistingPath(startPath);
  const pathStat = await stat(resolvedPath);
  const searchPath = pathStat.isDirectory() ? resolvedPath : path.dirname(resolvedPath);

  try {
    const output = await execFile("git", ["-C", searchPath, "rev-parse", "--show-toplevel"], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return await realpath(output.stdout.trim());
  } catch (error) {
    const commandError = error as GitCommandError;
    if (commandError.code === "ENOENT") {
      throw new GitServiceError("COMMAND_FAILED", "未找到 git 可执行文件。", error);
    }
    return null;
  }
}

async function requireRepository(startPath: string): Promise<GitRepository> {
  const rootPath = await resolveRepositoryRoot(startPath);
  if (!rootPath) {
    throw new GitServiceError(
      "NOT_REPOSITORY",
      `路径不属于 Git 仓库：${path.resolve(startPath)}`,
    );
  }
  return { rootPath };
}

async function resolveRepositoryFile(
  repositoryPath: string,
  filePath: string,
): Promise<{ repository: GitRepository; absolutePath: string; relativePath: string }> {
  const repository = await requireRepository(repositoryPath);
  const requestedPath = path.resolve(filePath);
  let absolutePath = requestedPath;

  try {
    absolutePath = await realpath(requestedPath);
  } catch (error) {
    const commandError = error as NodeJS.ErrnoException;
    if (commandError.code !== "ENOENT") {
      throw new GitServiceError("NOT_FOUND", `文件无法访问：${requestedPath}`, error);
    }
    const parentPath = path.dirname(requestedPath);
    try {
      const realParentPath = await realpath(parentPath);
      absolutePath = path.join(realParentPath, path.basename(requestedPath));
    } catch (parentError) {
      throw new GitServiceError("NOT_FOUND", `文件不存在：${requestedPath}`, parentError);
    }
  }

  if (!isPathInside(repository.rootPath, absolutePath) || absolutePath === repository.rootPath) {
    throw new GitServiceError(
      "OUTSIDE_REPOSITORY",
      `文件必须位于仓库内：${requestedPath}`,
    );
  }

  const relativePath = path.relative(repository.rootPath, absolutePath);
  return { repository, absolutePath, relativePath };
}

function parseStatusLine(line: string): Pick<GitFileStatus, "indexStatus" | "workTreeStatus" | "status"> {
  const indexStatus = line.slice(0, 1) || " ";
  const workTreeStatus = line.slice(1, 2) || " ";
  return {
    indexStatus,
    workTreeStatus,
    status: `${indexStatus}${workTreeStatus}`,
  };
}

export async function findRepository(startPath: string): Promise<GitRepository | null> {
  const rootPath = await resolveRepositoryRoot(startPath);
  return rootPath ? { rootPath } : null;
}

export async function getFileStatus(
  repositoryPath: string,
  filePath: string,
): Promise<GitFileStatus> {
  const resolved = await resolveRepositoryFile(repositoryPath, filePath);
  const output = await runGit(resolved.repository.rootPath, [
    "status",
    "--short",
    "--untracked-files=all",
    "--",
    resolved.relativePath,
  ]);
  const line = output.split(/\r?\n/).find(Boolean) ?? "  ";
  const status = parseStatusLine(line);

  return {
    repository: resolved.repository,
    filePath: resolved.absolutePath,
    relativePath: resolved.relativePath,
    ...status,
    isTracked: status.status !== "??",
    isModified: status.workTreeStatus !== " " || status.indexStatus !== " ",
    isStaged: status.indexStatus !== " " && status.status !== "??",
    isUntracked: status.status === "??",
  };
}

export async function getFileDiff(
  repositoryPath: string,
  filePath: string,
): Promise<GitFileDiff> {
  const resolved = await resolveRepositoryFile(repositoryPath, filePath);
  const diffArgs = ["diff", "--no-ext-diff", "--no-color"] as const;
  const worktreeDiff = await runGit(resolved.repository.rootPath, [
    ...diffArgs,
    "--",
    resolved.relativePath,
  ]);
  if (worktreeDiff) {
    return {
      repository: resolved.repository,
      filePath: resolved.absolutePath,
      relativePath: resolved.relativePath,
      diff: worktreeDiff,
      source: "working-tree",
    };
  }

  const cachedDiff = await runGit(resolved.repository.rootPath, [
    ...diffArgs,
    "--cached",
    "--",
    resolved.relativePath,
  ]);
  return {
    repository: resolved.repository,
    filePath: resolved.absolutePath,
    relativePath: resolved.relativePath,
    diff: cachedDiff,
    source: cachedDiff ? "cached" : "none",
  };
}

export async function getIndexFileContent(
  repositoryPath: string,
  filePath: string,
): Promise<string | null> {
  const resolved = await resolveRepositoryFile(repositoryPath, filePath);
  const indexEntries = await runGit(resolved.repository.rootPath, [
    "ls-files",
    "--stage",
    "--",
    resolved.relativePath,
  ]);
  if (!indexEntries.trim()) return null;
  return runGit(resolved.repository.rootPath, ["show", `:${resolved.relativePath}`]);
}

export async function stageFile(
  repositoryPath: string,
  filePath: string,
): Promise<GitFileStatus> {
  const resolved = await resolveRepositoryFile(repositoryPath, filePath);
  await runGit(resolved.repository.rootPath, ["add", "--", resolved.relativePath]);
  return getFileStatus(resolved.repository.rootPath, resolved.absolutePath);
}

export async function commitFile(
  repositoryPath: string,
  filePath: string,
  message: string,
): Promise<GitCommitResult> {
  if (typeof message !== "string" || message.trim() === "") {
    throw new GitServiceError("INVALID_ARGUMENT", "提交信息不能为空。");
  }

  const resolved = await resolveRepositoryFile(repositoryPath, filePath);
  await runGit(resolved.repository.rootPath, ["add", "--", resolved.relativePath]);
  await runGit(resolved.repository.rootPath, [
    "commit",
    "--only",
    "-m",
    message,
    "--",
    resolved.relativePath,
  ]);
  const commitHash = (
    await runGit(resolved.repository.rootPath, ["rev-parse", "HEAD"])
  ).trim();

  return {
    repository: resolved.repository,
    filePath: resolved.absolutePath,
    commitHash,
    output: `已提交文件 ${resolved.relativePath}。`,
  };
}

export async function getUpstreamStatus(
  repositoryPath: string,
): Promise<GitUpstreamStatus> {
  const repository = await requireRepository(repositoryPath);
  const branch = (await runGit(repository.rootPath, ["branch", "--show-current"])).trim();
  if (!branch) {
    throw new GitServiceError("INVALID_ARGUMENT", "当前处于 detached HEAD，无法查询上游分支。");
  }

  let upstream: string | null = null;
  try {
    upstream = (
      await runGit(repository.rootPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
    ).trim();
  } catch (error) {
    const commandError = error as GitServiceError;
    if (commandError.code !== "COMMAND_FAILED") throw error;
  }

  if (!upstream) {
    return { repository, branch, upstream: null, ahead: 0, behind: 0 };
  }

  const counts = (
    await runGit(repository.rootPath, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`])
  ).trim().split(/\s+/).map(Number);

  if (counts.length !== 2 || counts.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new GitServiceError("COMMAND_FAILED", `无法解析分支同步状态：${counts.join(" ")}`);
  }

  return { repository, branch, upstream, ahead: counts[0], behind: counts[1] };
}

export async function push(repositoryPath: string): Promise<GitPushResult> {
  const status = await getUpstreamStatus(repositoryPath);
  if (!status.upstream) {
    throw new GitServiceError(
      "NO_UPSTREAM",
      `当前分支 ${status.branch} 未配置上游分支，无法推送。`,
    );
  }

  const output = await runGit(status.repository.rootPath, ["push"]);
  return { repository: status.repository, upstream: status.upstream, output: output.trim() };
}
