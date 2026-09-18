import { describe, expect, it } from 'vitest';
import { isEditorToHostMessage } from '../src/messages/editor-messages';

describe('editor message protocol', () => {
  it('accepts known message types', () => {
    expect(isEditorToHostMessage({ type: 'ready' })).toBe(true);
    expect(isEditorToHostMessage({ type: 'exportXlsx', payload: {}, fileName: 'table.xlsx' })).toBe(true);
  });

  it('rejects malformed and unknown messages', () => {
    expect(isEditorToHostMessage(null)).toBe(false);
    expect(isEditorToHostMessage({})).toBe(false);
    expect(isEditorToHostMessage({ type: 'unknown-command' })).toBe(false);
  });
});
