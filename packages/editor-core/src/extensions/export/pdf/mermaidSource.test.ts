import { describe, expect, it } from 'vitest';

import { extractMermaidSourcesFromMarkdown, lookupMermaidMapValue, looksLikeMermaid, normalizeMermaidSource } from './mermaidSource';

describe('mermaidSource', () => {
  it('trims and normalizes line endings', () => {
    expect(normalizeMermaidSource('\r\ngraph TD\r\n  A-->B\r\n')).toBe('graph TD\n  A-->B');
  });

  it('looks up mermaid map values by normalized source', () => {
    const map = new Map([['graph TD\n  A-->B', { ok: true }]]);
    expect(lookupMermaidMapValue('\n graph TD\r\n  A-->B \n', map)).toEqual({ ok: true });
  });

  it('detects mermaid source without a fence language', () => {
    expect(looksLikeMermaid('flowchart LR\n  A-->B')).toBe(true);
    expect(looksLikeMermaid('function foo() {}')).toBe(false);
  });

  it('extracts unlabeled mermaid fences', () => {
    const markdown = '```\nflowchart LR\n  A-->B\n```\n';
    expect(extractMermaidSourcesFromMarkdown(markdown)).toEqual(['flowchart LR\n  A-->B']);
  });

  it('extracts mermaid fences from markdown', () => {
    const markdown = [
      '# Title',
      '',
      '```mermaid',
      'graph TD',
      '  A-->B',
      '```',
      '',
      'text',
      '',
      '``` mermaidjs',
      'sequenceDiagram',
      '  A->>B: hi',
      '```',
    ].join('\n');

    expect(extractMermaidSourcesFromMarkdown(markdown)).toEqual([
      'graph TD\n  A-->B',
      'sequenceDiagram\n  A->>B: hi',
    ]);
  });
});
