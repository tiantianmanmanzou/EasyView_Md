import { copyFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(appDir, '../..');
const temporaryFiles = [
  [path.join(repositoryRoot, 'readme.md'), path.join(appDir, 'README.md')],
  [path.join(repositoryRoot, 'LICENSE.txt'), path.join(appDir, 'LICENSE.txt')],
];

try {
  await Promise.all(temporaryFiles.map(([source, target]) => copyFile(source, target)));
  const { stdout, stderr } = await execFileAsync('npx', ['vsce', 'package', '--no-dependencies'], {
    cwd: appDir,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
} finally {
  await Promise.all(temporaryFiles.map(([, target]) => rm(target, { force: true })));
}
