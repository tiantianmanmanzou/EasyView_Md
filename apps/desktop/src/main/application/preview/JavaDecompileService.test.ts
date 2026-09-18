import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JavaDecompileService } from './JavaDecompileService';
import { PreviewSessionStore } from './PreviewSession';

const execFileAsync = promisify(execFile);
const directories: string[] = [];

async function workspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyview-java-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('JavaDecompileService', () => {
  it('uses the bundled Fernflower ConsoleDecompiler runtime for a class preview', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'Sample.java'), 'public class Sample { private int n = 3; public int value() { return n + 1; } }');
    await execFileAsync('javac', ['-d', root, path.join(root, 'Sample.java')]);
    const sessions = new PreviewSessionStore();
    const descriptor = await sessions.open(root, 'Sample.class');

    const result = await new JavaDecompileService(sessions).decompile(descriptor.sessionId);
    expect(result.engine).toBe('fernflower');
    expect(result.output).toContain('class Sample');
    expect(result.output).toContain('return this.n + 1');
  });
});
