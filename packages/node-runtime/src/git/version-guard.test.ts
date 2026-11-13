import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ExcelJS from 'exceljs';
import { VersionGuardService, guardDiagnostics, parseCommitRefs, stripUrlCredentials, githubRepositoryPath } from './version-guard';
import type { GuardBranch, GuardComparison, GuardFile, GuardHistory } from '@easyview/contracts';
const temps: string[] = []; const services: VersionGuardService[] = [];
afterEach(async () => { services.splice(0).forEach(service => service.dispose()); await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'version-guard-test-'))); temps.push(root);
  const repo = path.join(root, 'repo'); await mkdir(repo); init(repo);
  const service = new VersionGuardService({ roots: () => [root], beforeStage: async () => {}, discard: async (_files, action) => { await action(); return true; }, trash: file => rm(file) }); services.push(service);
  return { root, repo, service };
}
function init(root: string) { git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Guard Test'); git(root, 'config', 'user.email', 'guard@example.test'); }
it('discovers every nested repository, submodule and worktree without including an outside parent or symlink', async () => {
  const { root, repo, service } = await fixture();
  await writeFile(path.join(repo, 'base'), 'base'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  const nested = path.join(repo, 'deep', 'nested'); await mkdir(nested, { recursive: true }); init(nested);
  const worktree = path.join(root, 'worktree'); git(repo, 'worktree', 'add', '-q', '-b', 'second', worktree);
  const external = path.join(root, 'external'); await mkdir(external); init(external); await writeFile(path.join(external, 'file'), 'sub'); git(external, 'add', '.'); git(external, 'commit', '-qm', 'sub');
  git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', external, 'sub');
  await symlink(external, path.join(root, 'alias'));
  const found = await service.discover(); expect(found.map(item => item.rootPath).sort()).toEqual([repo, nested, worktree, external, path.join(repo, 'sub')].sort());
  const below = new VersionGuardService({ roots: () => [path.join(repo, 'deep')], beforeStage: async () => {}, discard: async () => false, trash: async () => {} }); services.push(below);
  expect((await below.discover()).map(item => item.rootPath)).toEqual([nested]);
});
it('parses commit decorations into current, local, remote and tag refs', () => {
  expect(parseCommitRefs('HEAD -> refs/heads/dev_zxy, refs/remotes/origin/dev_zxy, refs/remotes/origin/HEAD, refs/heads/main, tag: refs/tags/v1.0, refs/stash')).toEqual([
    { name: 'dev_zxy', type: 'branch', current: true },
    { name: 'origin/dev_zxy', type: 'remote' },
    { name: 'main', type: 'branch' },
    { name: 'v1.0', type: 'tag' },
  ]);
  expect(parseCommitRefs('HEAD')).toEqual([{ name: 'HEAD', type: 'head', current: true }]);
  expect(parseCommitRefs('')).toEqual([]);
});
it('includes incoming upstream commits in history when the branch is behind', async () => {
  const { root, repo, service } = await fixture(); await service.discover();
  await writeFile(path.join(repo, 'a'), 'a'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'local');
  const remote = path.join(root, 'remote.git'); git(root, 'init', '--bare', '-q', remote);
  git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-qu', 'origin', 'HEAD');
  const other = path.join(root, 'other'); git(root, 'clone', '-q', remote, other); git(other, 'config', 'user.name', 'Other'); git(other, 'config', 'user.email', 'other@example.test');
  await writeFile(path.join(other, 'b'), 'b'); git(other, 'add', '.'); git(other, 'commit', '-qm', 'incoming'); git(other, 'push', '-q');
  git(repo, 'fetch', '-q');
  const branch = git(repo, 'branch', '--show-current');
  const history = await service.handle({ method: 'history', repository: repo }) as GuardHistory;
  expect(history.entries.map(entry => entry.message)).toEqual(['incoming', 'local']);
  expect(history.entries[0].refs).toEqual([{ name: `origin/${branch}`, type: 'remote' }]);
  expect(history.entries[1].refs).toEqual([{ name: branch, type: 'branch', current: true }]);
  expect(await service.handle({ method: 'remoteUrl', repository: repo, branch: `refs/remotes/origin/${branch}` })).toBe(remote);
  expect(await service.handle({ method: 'remoteUrl', repository: repo, branch: `refs/heads/${branch}` })).toBe(remote);
  git(repo, 'remote', 'add', 'team/mirror', 'https://user:secret-token@example.test/group/repo.git');
  expect(await service.handle({ method: 'remoteUrl', repository: repo, branch: 'refs/remotes/team/mirror/main' })).toBe('https://example.test/group/repo.git');
  await expect(service.handle({ method: 'remoteUrl', repository: repo, branch: 'refs/heads/--upload-pack=x' })).resolves.toBe(remote);
  await expect(service.handle({ method: 'remoteUrl', repository: repo, branch: 'refs/remotes/x y' })).rejects.toThrow('Invalid ref.');
});
it('strips credentials only from http(s) remote addresses', () => {
  expect(stripUrlCredentials('https://user:secret-token@example.test/group/repo.git')).toBe('https://example.test/group/repo.git');
  expect(stripUrlCredentials('https://oauth2@example.test/repo.git')).toBe('https://example.test/repo.git');
  expect(stripUrlCredentials('ssh://git@example.test/group/repo.git')).toBe('ssh://git@example.test/group/repo.git');
  expect(stripUrlCredentials('git@example.test:group/repo.git')).toBe('git@example.test:group/repo.git');
});
it('recognizes github.com remotes in every URL form', () => {
  expect(githubRepositoryPath('https://user:token@github.com/Owner/Repo.git')).toBe('Owner/Repo');
  expect(githubRepositoryPath('https://github.com/owner/my.repo')).toBe('owner/my.repo');
  expect(githubRepositoryPath('git@github.com:owner/repo.git')).toBe('owner/repo');
  expect(githubRepositoryPath('ssh://git@ssh.github.com:443/owner/repo.git\n')).toBe('owner/repo');
  expect(githubRepositoryPath('https://gitlab.com/owner/repo.git')).toBeUndefined();
  expect(githubRepositoryPath('https://github.com.evil.test/owner/repo.git')).toBeUndefined();
  expect(githubRepositoryPath('https://github.com/owner/repo/tree/main')).toBeUndefined();
});
it('reports GitHub visibility per remote, asking once per repository and treating an unseen repository as private', async () => {
  const { repo, service } = await fixture(); await service.discover();
  git(repo, 'remote', 'add', 'origin', 'https://github.com/owner/open.git');
  git(repo, 'remote', 'add', 'github', 'git@github.com:Owner/Open.git');
  git(repo, 'remote', 'add', 'team', 'https://github.com/owner/secret.git');
  git(repo, 'remote', 'add', 'gitlab', 'https://gitlab.com/owner/open.git');
  git(repo, 'remote', 'add', 'flaky', 'https://github.com/owner/flaky.git');
  const fetch = vi.fn(async (url: string) => /\/open$/i.test(url) ? new Response(JSON.stringify({ private: false })) : url.endsWith('/secret') ? new Response('{}', { status: 404 }) : new Response('{}', { status: 403 }));
  vi.stubGlobal('fetch', fetch);
  try {
    expect(await service.handle({ method: 'remoteVisibility', repository: repo })).toEqual({ origin: 'public', github: 'public', team: 'private' });
    expect(fetch.mock.calls.map(([url]) => url.toLowerCase()).sort()).toEqual(['https://api.github.com/repos/owner/flaky', 'https://api.github.com/repos/owner/open', 'https://api.github.com/repos/owner/secret']);
  } finally { vi.unstubAllGlobals(); }
});
it('does not look for repositories inside node_modules', async () => {
  const { repo, service } = await fixture(); const dependency = path.join(repo, 'node_modules', 'pkg'); await mkdir(dependency, { recursive: true }); init(dependency);
  expect((await service.discover()).map(item => item.rootPath)).toEqual([repo]);
});
it('initializes the open folder as a Git repository once', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'version-guard-init-'))); temps.push(root);
  const service = new VersionGuardService({ roots: () => [root], beforeStage: async () => {}, discard: async () => false, trash: async () => {} }); services.push(service);
  expect(await service.discover()).toEqual([]);
  expect(await service.handle({ method: 'init' })).toEqual([root]);
  expect((await service.discover()).map(item => item.rootPath)).toEqual([root]);
  await expect(service.handle({ method: 'init' })).rejects.toThrow('already exists');
});
it('keeps index and worktree distinct and commits only staged changes including unusual paths', async () => {
  const { repo, service } = await fixture(); await service.discover();
  const name = '中文 file\nname.txt'; await writeFile(path.join(repo, name), 'one\n'); await writeFile(path.join(repo, 'other'), 'untouched');
  await service.handle({ method: 'stage', repository: repo, paths: [name] });
  await service.handle({ method: 'commit', repository: repo, message: 'initial' });
  expect(git(repo, 'ls-tree', '--name-only', 'HEAD')).not.toContain('other');
});
it('commits staged content, preserves unstaged edits, and unstages before and after first commit', async () => {
  const { repo, service } = await fixture(); await service.discover();
  const name = '中文 file\nname.txt'; await writeFile(path.join(repo, name), 'one\n');
  await service.handle({ method: 'stage', repository: repo, paths: [name] }); await service.handle({ method: 'unstage', repository: repo, paths: [name] });
  expect((await service.status(await service.repository(repo))).files[0].index).toBe('?');
  await service.handle({ method: 'stage', repository: repo, paths: [name] }); await service.handle({ method: 'commit', repository: repo, message: 'initial' });
  await writeFile(path.join(repo, name), 'two\n'); await service.handle({ method: 'stage', repository: repo, paths: [name] }); await writeFile(path.join(repo, name), 'three\n'); await writeFile(path.join(repo, 'other'), 'other');
  const status = await service.status(await service.repository(repo)); expect(status.files.find(file => file.path === name)).toMatchObject({ index: 'M', worktree: 'M' });
  const diff = await service.handle({ method: 'comparison', repository: repo, paths: [name], source: 'working' }) as GuardComparison; expect(diff.base).toBe('two\n'); expect(diff.content).toBe('three\n');
  await service.handle({ method: 'discard', repository: repo, paths: [name] }); expect(await readFile(path.join(repo, name), 'utf8')).toBe('two\n');
  await service.handle({ method: 'commit', repository: repo, message: 'second\n\nbody' }); expect(git(repo, 'show', `HEAD:${name}`)).toBe('two'); expect(git(repo, 'ls-tree', '--name-only', 'HEAD')).not.toContain('other');
  git(repo, 'tag', 'v1', 'HEAD~1');
  const history = await service.handle({ method: 'history', repository: repo }) as GuardHistory; expect(history.entries).toHaveLength(2); expect(history.entries[0].message).toBe('second\n\nbody');
  expect(history.entries[0].refs).toEqual([{ name: git(repo, 'branch', '--show-current'), type: 'branch', current: true }]);
  expect(history.entries[1].refs).toEqual([{ name: 'v1', type: 'tag' }]);
  expect(await service.handle({ method: 'commitStats', repository: repo, revision: history.entries[0].hash })).toEqual({ files: 1, insertions: 1, deletions: 1 });
  expect(await service.handle({ method: 'commitStats', repository: repo, revision: history.entries[1].hash })).toEqual({ files: 1, insertions: 1, deletions: 0 });
  const files = await service.handle({ method: 'commitFiles', repository: repo, revision: history.entries[0].hash }) as GuardFile[]; expect(files[0].path).toBe(name);
  const initial = await service.handle({ method: 'comparison', repository: repo, revision: history.entries[1].hash, paths: [name], source: 'commit' }) as GuardComparison; expect(initial.base).toBe(''); expect(initial.content).toBe('one\n');
});
it('compares workbook versions cell by cell instead of reporting a binary change', async () => {
  const { repo, service } = await fixture(); await service.discover();
  const save = async (rows: unknown[][]) => { const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('数据').addRows(rows); await workbook.xlsx.writeFile(path.join(repo, 'book.xlsx')); };
  await save([['名称', '数量'], ['苹果', 3]]); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'book');
  await save([['名称', '数量'], ['苹果', 5], ['梨', 2]]);
  const diff = await service.handle({ method: 'comparison', repository: repo, paths: ['book.xlsx'], source: 'working' }) as GuardComparison;
  expect(diff.binary).toBeUndefined();
  expect(diff.spreadsheet).toEqual({
    base: [{ name: '数据', rows: [['名称', '数量'], ['苹果', '3']] }],
    content: [{ name: '数据', rows: [['名称', '数量'], ['苹果', '5'], ['梨', '2']] }],
  });
  await writeFile(path.join(repo, 'broken.xlsx'), 'not a zip'); git(repo, 'add', 'broken.xlsx');
  const broken = await service.handle({ method: 'comparison', repository: repo, paths: ['broken.xlsx'], source: 'staged' }) as GuardComparison;
  expect(broken.spreadsheet).toBeUndefined(); expect(broken.content).toBe('not a zip');
});
it('fetches and pushes the configured upstream and never performs a background network poll', async () => {
  const { root, repo, service } = await fixture(); const remote = path.join(root, 'remote.git'); git(root, 'init', '--bare', '-q', remote);
  await writeFile(path.join(repo, 'file'), 'base'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base'); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-qu', 'origin', 'HEAD');
  await service.discover(); await writeFile(path.join(repo, 'file'), 'next'); await service.handle({ method: 'stage', repository: repo, paths: ['file'] }); await service.handle({ method: 'commit', repository: repo, message: 'next' });
  expect((await service.status(await service.repository(repo))).ahead).toBe(1); await service.handle({ method: 'push', repository: repo });
  expect((await service.status(await service.repository(repo))).ahead).toBe(0); await service.handle({ method: 'fetch', repository: repo }); expect((await service.status(await service.repository(repo))).checkedAt).toBeTypeOf('number');
  const commands = guardDiagnostics.commands; await new Promise(resolve => setTimeout(resolve, 100)); expect(guardDiagnostics.commands).toBe(commands); expect(guardDiagnostics.peak).toBeLessThanOrEqual(2);
});
it('stages every change before committing when nothing is staged and stageAll is requested', async () => {
  const { repo, service } = await fixture();
  await writeFile(path.join(repo, 'kept'), 'one'); await writeFile(path.join(repo, 'gone'), 'x'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  await writeFile(path.join(repo, 'kept'), 'two'); await writeFile(path.join(repo, 'new file.md'), 'new'); await rm(path.join(repo, 'gone'));
  await service.discover();
  await expect(service.handle({ method: 'commit', repository: repo, message: 'nothing staged' })).rejects.toThrow('No staged changes');
  await service.handle({ method: 'commit', repository: repo, message: 'all', stageAll: true });
  expect(git(repo, 'status', '--porcelain')).toBe('');
  expect(git(repo, 'ls-tree', '--name-only', 'HEAD').split('\n').sort()).toEqual(['kept', 'new file.md']);
  await writeFile(path.join(repo, 'kept'), 'three'); await writeFile(path.join(repo, 'new file.md'), 'changed'); git(repo, 'add', 'kept');
  await service.handle({ method: 'commit', repository: repo, message: 'staged only', stageAll: true });
  expect(git(repo, 'status', '--porcelain')).toBe('M "new file.md"');
});
async function diverged() {
  const { root, repo, service } = await fixture(); const remote = path.join(root, 'remote.git'); git(root, 'init', '--bare', '-q', remote);
  await writeFile(path.join(repo, 'file'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base'); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-qu', 'origin', 'HEAD');
  const other = path.join(root, 'other'); execFileSync('git', ['clone', '-q', remote, other]); init(other);
  const commitIn = async (dir: string, file: string, text: string) => { await writeFile(path.join(dir, file), text); git(dir, 'add', '.'); git(dir, 'commit', '-qm', text.trim()); };
  await service.discover();
  return { repo, other, service, commitIn, status: async () => service.status(await service.repository(repo)) };
}
it('lists local branches, remote branches and tags and switches, tracks or creates branches', async () => {
  const { repo, other, service, commitIn, status } = await diverged();
  git(other, 'switch', '-qc', 'feature'); await commitIn(other, 'f.md', 'feature\n'); git(other, 'push', '-qu', 'origin', 'feature');
  git(repo, 'tag', 'backup/light'); git(repo, 'tag', '-a', 'v1.0.0', '-m', 'Release one');
  await service.handle({ method: 'fetch', repository: repo });
  const branches = await service.handle({ method: 'branches', repository: repo }) as GuardBranch[];
  const names = branches.map(branch => `${branch.type}:${branch.name}${branch.current ? '*' : ''}`);
  const current = git(repo, 'branch', '--show-current');
  expect(names).toContain(`branch:${current}*`); expect(names).toContain('remote:origin/feature'); expect(names.some(name => name.endsWith('/HEAD'))).toBe(false);
  expect(names).toEqual(expect.arrayContaining(['tag:backup/light', 'tag:v1.0.0']));
  expect(branches.find(branch => branch.name === 'origin/feature')).toMatchObject({ subject: 'feature', author: 'Guard Test' });
  // An annotated tag reports the tagged commit, not the tag object, like the other rows.
  expect(branches.find(branch => branch.name === 'v1.0.0')).toMatchObject({ subject: 'base', author: 'Guard Test' });
  expect(branches.find(branch => branch.name === 'v1.0.0')!.timestamp).toBeGreaterThan(0);
  await service.handle({ method: 'checkout', repository: repo, branch: 'v1.0.0' });
  expect(await status()).toMatchObject({ branch: '(detached)', head: git(repo, 'rev-parse', 'v1.0.0^{commit}') });
  await service.handle({ method: 'checkout', repository: repo, branch: current });
  await service.handle({ method: 'checkout', repository: repo, branch: 'origin/feature' });
  expect(await status()).toMatchObject({ branch: 'feature', upstream: 'origin/feature' });
  await service.handle({ method: 'checkout', repository: repo, branch: current });
  expect((await status()).branch).toBe(current);
  await service.handle({ method: 'checkout', repository: repo, branch: 'topic/new', create: true });
  expect((await status()).branch).toBe('topic/new');
  await expect(service.handle({ method: 'checkout', repository: repo, branch: 'bad name..', create: true })).rejects.toThrow('Invalid branch name');
  await expect(service.handle({ method: 'checkout', repository: repo, branch: 'missing' })).rejects.toThrow('Unknown branch');
});
const isolatedConfig = () => { const previous = process.env.GIT_CONFIG_GLOBAL; process.env.GIT_CONFIG_GLOBAL = '/dev/null'; return () => { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; }; };
it('pulls remote commits and merges diverged branches before pushing, like VS Code', async () => {
  const restore = isolatedConfig();
  try {
    const { repo, other, service, commitIn, status } = await diverged();
    await commitIn(other, 'remote.md', 'remote one\n'); git(other, 'push', '-q');
    await service.handle({ method: 'fetch', repository: repo }); expect(await status()).toMatchObject({ ahead: 0, behind: 1 });
    await service.handle({ method: 'pull', repository: repo }); expect(await status()).toMatchObject({ ahead: 0, behind: 0 });
    await commitIn(other, 'remote.md', 'remote two\n'); git(other, 'push', '-q'); await commitIn(repo, 'local.md', 'local\n');
    await service.handle({ method: 'fetch', repository: repo }); expect(await status()).toMatchObject({ ahead: 1, behind: 1 });
    await service.handle({ method: 'pull', repository: repo }); expect(await status()).toMatchObject({ ahead: 2, behind: 0 });
    await service.handle({ method: 'push', repository: repo });
    expect(await status()).toMatchObject({ ahead: 0, behind: 0 });
    expect(git(repo, 'log', '-1', '--format=%P').split(' ')).toHaveLength(2);
    git(other, 'pull', '-q', '--no-rebase'); expect(await readFile(path.join(other, 'local.md'), 'utf8')).toBe('local\n');
  } finally { restore(); }
});
it('restores the branch when a configured rebase pull stops on a conflict', async () => {
  const { repo, other, service, commitIn, status } = await diverged(); git(repo, 'config', 'pull.rebase', 'true');
  await commitIn(other, 'file', 'remote\n'); git(other, 'push', '-q'); await commitIn(repo, 'file', 'local\n');
  const head = git(repo, 'rev-parse', 'HEAD');
  await expect(service.handle({ method: 'pull', repository: repo })).rejects.toThrow();
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(head); expect(git(repo, 'status', '--porcelain')).toBe('');
  expect(await status()).toMatchObject({ ahead: 1, behind: 1 });
});
it('amends and undoes only commits that are not on a remote yet', async () => {
  const { repo, service, commitIn, status } = await diverged();
  await expect(service.handle({ method: 'undoCommit', repository: repo })).rejects.toThrow('already on a remote');
  await expect(service.handle({ method: 'commit', repository: repo, amend: true })).rejects.toThrow('already on a remote');
  await commitIn(repo, 'local.md', 'local\n');
  await writeFile(path.join(repo, 'extra.md'), 'extra'); git(repo, 'add', 'extra.md');
  await service.handle({ method: 'commit', repository: repo, amend: true });
  expect(git(repo, 'log', '-1', '--format=%s')).toBe('local'); expect(git(repo, 'ls-tree', '--name-only', 'HEAD')).toContain('extra.md');
  await service.handle({ method: 'commit', repository: repo, amend: true, message: 'local and extra' });
  expect(git(repo, 'log', '-1', '--format=%s')).toBe('local and extra'); expect((await status()).ahead).toBe(1);
  expect(await service.handle({ method: 'undoCommit', repository: repo })).toBe('local and extra');
  expect((await status()).ahead).toBe(0);
  expect(git(repo, 'status', '--porcelain').split('\n').sort()).toEqual(['A  extra.md', 'A  local.md']);
});
it('undoes the very first commit, keeping its files staged', async () => {
  const { repo, service } = await fixture(); await writeFile(path.join(repo, 'first.md'), 'first'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'first');
  await service.discover();
  expect(await service.handle({ method: 'undoCommit', repository: repo })).toBe('first');
  expect((await service.status(await service.repository(repo))).head).toBe('(initial)'); expect(git(repo, 'status', '--porcelain')).toBe('A  first.md');
});
it('stashes every local change including new files and restores them', async () => {
  const { repo, service } = await fixture(); await writeFile(path.join(repo, 'file'), 'base'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  await service.discover();
  await expect(service.handle({ method: 'stash', repository: repo })).rejects.toThrow('No local changes');
  await writeFile(path.join(repo, 'file'), 'edited'); await writeFile(path.join(repo, 'new.md'), 'new');
  await service.handle({ method: 'stash', repository: repo });
  expect(git(repo, 'status', '--porcelain')).toBe('');
  await service.handle({ method: 'stashPop', repository: repo });
  expect(await readFile(path.join(repo, 'file'), 'utf8')).toBe('edited'); expect(await readFile(path.join(repo, 'new.md'), 'utf8')).toBe('new');
});
it('keeps serving status for known repositories while a rediscovery walks the folder', async () => {
  const { repo, service } = await fixture(); await service.discover();
  const rediscovery = service.discover();
  await expect(service.handle({ method: 'status', repository: repo })).resolves.toMatchObject({ files: [] });
  expect((await rediscovery).map(item => item.rootPath)).toEqual([repo]);
});
it('reports a full refresh when it becomes active again, since nothing was watched meanwhile', async () => {
  const { service } = await fixture(); await service.discover();
  const changes: Array<string[] | null> = []; const changed = (paths: string[] | null) => changes.push(paths);
  service.setActive(true, changed); service.setActive(true, changed);
  expect(changes).toEqual([null]);
  service.setActive(false); service.setActive(true, changed);
  expect(changes).toEqual([null, null]);
});
it('rejects workspace escapes, nested file ownership and Git metadata paths', async () => {
  const { root, repo, service } = await fixture(); const nested = path.join(repo, 'child'); await mkdir(nested); init(nested); await service.discover();
  await expect(service.handle({ method: 'stage', repository: repo, paths: ['../external'] })).rejects.toThrow('Invalid');
  await expect(service.handle({ method: 'stage', repository: repo, paths: ['.git/config'] })).rejects.toThrow('Invalid');
  await expect(service.handle({ method: 'stage', repository: repo, paths: ['child/file'] })).rejects.toThrow('own repository');
  await symlink(root, path.join(repo, 'escape')); await expect(service.handle({ method: 'stage', repository: repo, paths: ['escape/nope'] })).rejects.toThrow('outside');
});
