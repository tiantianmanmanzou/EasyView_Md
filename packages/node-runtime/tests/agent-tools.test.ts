import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAiAgentTools } from '../src/ai/agent-tools';

function executable(tools: Awaited<ReturnType<typeof createAiAgentTools>>, name: string) {
  const tool = tools[name];
  if (!tool?.execute) throw new Error(`Missing executable tool: ${name}`);
  return tool.execute as (input: Record<string, unknown>) => Promise<unknown>;
}

describe('EasyView agent tools', () => {
  let rootPath = '';

  afterEach(async () => {
    if (rootPath) await rm(rootPath, { recursive: true, force: true });
    rootPath = '';
  });

  it('creates, lists, reads, and writes workspace files without escaping the root', async () => {
    rootPath = await mkdtemp(path.join(os.tmpdir(), 'easyview-agent-tools-'));
    await writeFile(path.join(rootPath, 'existing.md'), '# Existing\n', 'utf8');
    const tools = await createAiAgentTools({
      workspaceRootPath: rootPath,
      includeWorkspaceTools: true,
    });

    await executable(tools, 'create_file')({ path: 'new.md', content: '# New\n' });
    const baseline = await executable(tools, 'inspect_file')({ path: 'existing.md' }) as { baselineId: string };
    await executable(tools, 'apply_patch')({
      baselineId: baseline.baselineId,
      patches: [{ description: 'Rename heading', expectedText: '# Existing', replacement: '# Updated' }],
    });
    const read = await executable(tools, 'read_file')({ path: 'existing.md' });
    const listed = await executable(tools, 'list_files')({});

    expect(read).toEqual({ path: 'existing.md', content: '# Updated\n' });
    expect(listed).toEqual({
      path: '.',
      entries: expect.arrayContaining([expect.objectContaining({ path: 'new.md', type: 'file' })]),
    });
    await expect(executable(tools, 'read_file')({ path: '../outside.md' })).rejects.toThrow('相对路径');
    await expect(readFile(path.join(rootPath, 'new.md'), 'utf8')).resolves.toBe('# New\n');
  });

  it('registers web_search only when a Brave Search API key is configured', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      web: { results: [{ title: 'EasyView', url: 'https://example.com', description: 'Markdown editor' }] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const tools = await createAiAgentTools({
      workspaceRootPath: null,
      webSearchApiKey: 'brave-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(tools).toHaveProperty('web_search');
    await expect(executable(tools, 'web_search')({ query: 'EasyView' })).resolves.toEqual({
      query: 'EasyView',
      results: [{ title: 'EasyView', url: 'https://example.com', snippet: 'Markdown editor' }],
    });
  });
});
