/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('openMarkdownEditor open path', () => {
  it('routes markdown opens through easyviewMd scheme helpers', () => {
    const source = readFileSync(path.join(here, 'openMarkdownEditor.ts'), 'utf8');
    expect(source).toContain('toEasyViewMarkdownUri');
    expect(source).toContain('openMarkdown.primaryScheme');
    expect(source).toContain('rematerializeFileSchemeEasyViewMarkdownTabs');
    expect(source).toContain('preserveFocus');
  });

  it('workspace explorer no longer openWith-s markdown over raw file://', () => {
    const source = readFileSync(
      path.join(here, '../../workspace/workspaceExplorerHost.ts'),
      'utf8',
    );
    expect(source).toContain('openMarkdownInEasyViewEditor');
    expect(source).not.toMatch(
      /vscode\.openWith',\s*uri,\s*'easyviewMd\.markdownEditor'/,
    );
  });
});
