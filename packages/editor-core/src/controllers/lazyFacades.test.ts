import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('editor first-load lazy facades', () => {
  it('keeps AI, terminal, and export implementations behind dynamic imports', () => {
    const files = [
      '../ui/lazyAiChatPanel.ts',
      '../ui/lazyTerminalModal.ts',
      './lazyExportController.ts',
    ];
    for (const file of files) {
      const source = readFileSync(resolve(import.meta.dirname, file), 'utf8');
      expect(source).toMatch(/import\(['"]/);
    }
  });

  it('does not statically import heavy implementations from the editor entry', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../index.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"]\.\/ui\/(AiChatPanel|TerminalModal)['"]/);
    expect(source).not.toMatch(/from ['"]\.\/controllers\/ExportController['"]/);
  });
});
