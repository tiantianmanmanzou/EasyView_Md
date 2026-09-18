import { describe, expect, it } from 'vitest';
import type { EditorView } from 'prosemirror-view';

import type { SlashMenuItem } from './SlashMenuTypes';

describe('SlashMenuItem type boundary', () => {
  it('keeps the menu item contract independent from the menu implementation', () => {
    const item = {
      id: 'test',
      label: 'Test',
      icon: '<span>Test</span>',
      keywords: ['test'],
      group: 'test',
      command: (_view: EditorView, _from: number, _to: number) => undefined,
    } satisfies SlashMenuItem;

    expect(item.id).toBe('test');
    expect(item.group).toBe('test');
  });
});
