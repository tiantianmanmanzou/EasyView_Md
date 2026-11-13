import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const pkgRoot = fileURLToPath(new URL('../..', import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8')) as { exports: Record<string, string> };
describe('source exports', () => {
  test('every declared entry exists', () => {
    expect(Object.entries(pkg.exports).filter(([, target]) => !existsSync(resolve(pkgRoot, target)))).toEqual([]);
  });
  test('retains core editor entry points', () => {
    for (const key of ['.', './headless', './prosemirror', './docx', './docx/serializer', './layout-engine', './plugin-api']) {
      expect(pkg.exports).toHaveProperty(key);
    }
  });
});
