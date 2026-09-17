import { describe, expect, it } from 'vitest';
import {
  applyAssociationPin,
  nativeEditorAssociationPattern,
  removeAssociationPin,
} from './nativeEditorAssociation';

describe('nativeEditorAssociationPattern', () => {
  it('matches VS Code path globs against scheme:path', () => {
    expect(nativeEditorAssociationPattern({
      scheme: 'file',
      path: '/Users/zhangxy/GAFile/方案.md',
    })).toBe('file:/Users/zhangxy/GAFile/方案.md');
  });
});

describe('association pin merge', () => {
  it('pins a file-specific default without dropping other associations', () => {
    const { next, previous } = applyAssociationPin(
      { '*.md': 'inlineMd.markdownEditor', '*.markdown': 'default' },
      'file:/tmp/a.md',
      'default',
    );
    expect(previous).toBeUndefined();
    expect(next).toEqual({
      '*.md': 'inlineMd.markdownEditor',
      '*.markdown': 'default',
      'file:/tmp/a.md': 'default',
    });
  });

  it('restores the previous mapping when the pin is removed', () => {
    const pinned = applyAssociationPin(
      { '*.md': 'inlineMd.markdownEditor', 'file:/tmp/a.md': 'inlineMd.markdownEditor' },
      'file:/tmp/a.md',
      'default',
    );
    expect(pinned.previous).toBe('inlineMd.markdownEditor');
    expect(removeAssociationPin(pinned.next, 'file:/tmp/a.md', pinned.previous)).toEqual({
      '*.md': 'inlineMd.markdownEditor',
      'file:/tmp/a.md': 'inlineMd.markdownEditor',
    });
  });

  it('deletes the pin key when it did not exist before', () => {
    const pinned = applyAssociationPin({ '*.md': 'inlineMd.markdownEditor' }, 'file:/tmp/a.md', 'default');
    expect(removeAssociationPin(pinned.next, 'file:/tmp/a.md', pinned.previous)).toEqual({
      '*.md': 'inlineMd.markdownEditor',
    });
  });
});
