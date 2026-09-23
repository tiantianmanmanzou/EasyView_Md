/** @vitest-environment node */
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  GitServiceError,
  commitFile,
  findRepository,
  getFileDiff,
  getIndexFileContent,
  getIndexObjectId,
  getFileStatus,
  getUpstreamStatus,
  push,
  stageFile,
} from '../src/git/git-service';

const execFile = promisify(execFileCallback);
const tempDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", cwd, ...args], { windowsHide: true });
  return result.stdout.trim();
}

async function createRepository(): Promise<{ root: string; filePath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "easyview-git-service-"));
  tempDirectories.push(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "EasyView Test"]);
  await git(root, ["config", "user.email", "easyview@example.test"]);
  const filePath = path.join(root, "note.md");
  await writeFile(filePath, "# initial\n", "utf8");
  await git(root, ["add", "--", "note.md"]);
  await git(root, ["commit", "-m", "initial"]);
  return { root, filePath };
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("git service", () => {
  it("finds a repository from a nested path and reports a single file status", async () => {
    const { root, filePath } = await createRepository();
    await writeFile(filePath, "# changed\n", "utf8");
    const nestedPath = path.join(root, "docs");
    await mkdir(nestedPath);

    await expect(findRepository(nestedPath)).resolves.toEqual({ rootPath: await realpath(root) });
    const status = await getFileStatus(root, filePath);
    expect(status.relativePath).toBe("note.md");
    expect(status.status).toBe(" M");
    expect(status.isModified).toBe(true);
    expect(status.isStaged).toBe(false);
  });

  it("prefers the working-tree diff when both working-tree and cached changes exist", async () => {
    const { root, filePath } = await createRepository();
    await writeFile(filePath, "# staged\n", "utf8");
    await stageFile(root, filePath);
    await writeFile(filePath, "# working tree\n", "utf8");

    const result = await getFileDiff(root, filePath);
    expect(result.source).toBe("working-tree");
    expect(result.diff).toContain("-# staged");
    expect(result.diff).toContain("+# working tree");
  });

  it("falls back to the cached diff when the working tree is clean", async () => {
    const { root, filePath } = await createRepository();
    await writeFile(filePath, "# cached\n", "utf8");
    await stageFile(root, filePath);

    const result = await getFileDiff(root, filePath);
    expect(result.source).toBe("cached");
    expect(result.diff).toContain("-# initial");
    expect(result.diff).toContain("+# cached");
  });

  it("reports no diff for a clean tracked file", async () => {
    const { root, filePath } = await createRepository();
    const untrackedPath = path.join(root, "untracked.md");
    await writeFile(untrackedPath, "# untracked\n", "utf8");

    await expect(getFileDiff(root, filePath)).resolves.toMatchObject({
      diff: "",
      source: "none",
    });
    await expect(getFileDiff(root, untrackedPath)).resolves.toMatchObject({
      diff: "",
      source: "none",
    });
  });

  it("returns the indexed file content, index object id, and null for untracked files", async () => {
    const { root, filePath } = await createRepository();
    expect(await getIndexFileContent(root, filePath)).toBe("# initial\n");
    expect(await getIndexObjectId(root, filePath)).toMatch(/^[0-9a-f]{40}$/);

    const untracked = path.join(root, "untracked.md");
    await writeFile(untracked, "new\n", "utf8");
    expect(await getIndexFileContent(root, untracked)).toBeNull();
    expect(await getIndexObjectId(root, untracked)).toBeNull();
  });

  it("stages and commits only the requested file", async () => {
    const { root, filePath } = await createRepository();
    const otherPath = path.join(root, "other.md");
    await writeFile(filePath, "# changed\n", "utf8");
    await writeFile(otherPath, "unrelated\n", "utf8");
    await git(root, ["add", "--", "other.md"]);

    const result = await commitFile(root, filePath, "Update note");
    expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/);
    expect(await git(root, ["show", "--format=", "--name-only", "HEAD"])).toBe("note.md");
    expect(await readFile(otherPath, "utf8")).toBe("unrelated\n");
    expect((await getFileStatus(root, otherPath)).status).toBe("A ");
    expect(await git(root, ["diff", "--cached", "--name-only"])).toBe("other.md");
  });

  it("returns upstream and ahead/behind counts, then pushes with git arguments", async () => {
    const remote = await mkdtemp(path.join(os.tmpdir(), "easyview-git-remote-"));
    tempDirectories.push(remote);
    await git(remote, ["init", "--bare"]);
    const { root } = await createRepository();
    await git(root, ["remote", "add", "origin", remote]);
    await git(root, ["push", "-u", "origin", "main"]);

    expect(await getUpstreamStatus(root)).toMatchObject({
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
    });

    await writeFile(path.join(root, "note.md"), "# pushed\n", "utf8");
    await stageFile(root, path.join(root, "note.md"));
    await commitFile(root, path.join(root, "note.md"), "Push note");
    expect(await getUpstreamStatus(root)).toMatchObject({ ahead: 1, behind: 0 });
    const result = await push(root);
    expect(result.upstream).toBe("origin/main");
    expect(await git(remote, ["log", "--format=%s", "main"])).toContain("Push note");
  });

  it("rejects files outside the repository and reports missing upstream clearly", async () => {
    const { root, filePath } = await createRepository();
    const outsidePath = path.join(os.tmpdir(), "easyview-outside.md");
    await writeFile(outsidePath, "outside\n", "utf8");
    try {
      await expect(getFileStatus(root, outsidePath)).rejects.toMatchObject({
        code: "OUTSIDE_REPOSITORY",
      });
      await expect(push(root)).rejects.toThrow("未配置上游分支");
      expect(await readFile(filePath, "utf8")).toBe("# initial\n");
    } finally {
      await rm(outsidePath, { force: true });
    }
  });
});
