import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { isPathInsideRoot } from './htmlPreviewPath';

describe('html preview server path guard', () => {
  it('accepts files under the preview root and rejects traversal', () => {
    const root = path.resolve('/tmp/html-preview-root');
    expect(isPathInsideRoot(root, path.join(root, 'dsmp', 'page.html'))).toBe(true);
    expect(isPathInsideRoot(root, path.join(root, '..', 'secret.html'))).toBe(false);
  });
});
