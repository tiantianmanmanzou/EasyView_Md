import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));

function readSource(fileName: string): string {
  return readFileSync(join(directory, fileName), 'utf8');
}

describe('EditorCore module boundaries', () => {
  it('keeps EditorCoreConfig in a neutral type module', () => {
    const coreSource = readSource('EditorCore.ts');
    const handlerSource = readSource('EditorEventHandlers.ts');
    const typesSource = readSource('EditorCoreTypes.ts');

    expect(typesSource).toContain('export interface EditorCoreConfig');
    expect(coreSource).toContain("from './EditorCoreTypes'");
    expect(handlerSource).toContain("from './EditorCoreTypes'");
    expect(handlerSource).not.toContain("from './EditorCore'");
    expect(coreSource).not.toContain('export interface EditorCoreConfig');
  });
});
