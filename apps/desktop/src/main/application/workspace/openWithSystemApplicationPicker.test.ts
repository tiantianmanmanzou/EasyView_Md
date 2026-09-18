/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('openWithSystemApplicationPicker', () => {
  it('keeps platform OpenAs / choose-application entry points', () => {
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'openWithSystemApplicationPicker.ts'),
      'utf8',
    );
    expect(source).toContain('shell32.dll,OpenAs_RunDLL');
    expect(source).toContain('choose application');
    expect(source).toContain('openWithSystemApplicationPicker');
  });
});
