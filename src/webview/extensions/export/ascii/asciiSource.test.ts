import { describe, expect, it } from 'vitest';
import {
  extractAsciiSourcesFromMarkdown,
  isAsciiFenceInfo,
  looksLikeAsciiArt,
  normalizeAsciiSource,
} from './asciiSource';

const TABLE = `┌──────────────────────┬──────────┐
│ 事件ID                │ 事件类别   │
├══════════════════════╪══════════┤
│ EVT00001              │ 数据泄露   │
└──────────────────────┴──────────┘`;

const PLAIN_TEXT = `not an ascii diagram
just some prose
with a | pipe and a - dash here`;

describe('asciiSource', () => {
  it('normalizes line endings and trims', () => {
    expect(normalizeAsciiSource('  a\r\nb  \n')).toBe('a\nb');
  });

  it('recognizes text-like fence languages', () => {
    expect(isAsciiFenceInfo('text')).toBe(true);
    expect(isAsciiFenceInfo('txt')).toBe(true);
    expect(isAsciiFenceInfo('ascii')).toBe(true);
    expect(isAsciiFenceInfo('mermaid')).toBe(false);
    expect(isAsciiFenceInfo('')).toBe(false);
  });

  it('detects an ASCII diagram with a border row', () => {
    expect(looksLikeAsciiArt(TABLE)).toBe(true);
  });

  it('rejects plain prose/code', () => {
    expect(looksLikeAsciiArt(PLAIN_TEXT)).toBe(false);
  });

  it('extracts ASCII fences from markdown', () => {
    const md = [
      '# title',
      '',
      '```text',
      TABLE,
      '```',
      '',
      '```mermaid',
      'graph TD; A-->B',
      '```',
      '',
      '```',
      TABLE,
      '```',
    ].join('\n');
    const sources = extractAsciiSourcesFromMarkdown(md);
    // `text` fence + unlabelled fence that looks like ASCII art.
    expect(sources).toHaveLength(2);
    expect(sources[0]).toBe(normalizeAsciiSource(TABLE));
  });

  it('does not treat a plain unlabelled code block as ASCII art', () => {
    const md = ['```', 'const x = 1;', '```'].join('\n');
    expect(extractAsciiSourcesFromMarkdown(md)).toHaveLength(0);
  });
});
