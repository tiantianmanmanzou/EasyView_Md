import { describe, expect, it } from 'vitest';
import { isWebviewToHostMessage } from './protocol';

describe('webview message protocol', () => {
  it('accepts known message types', () => {
    expect(isWebviewToHostMessage({ type: 'ready' })).toBe(true);
    expect(isWebviewToHostMessage({ type: 'exportXlsx', payload: {}, fileName: 'table.xlsx' })).toBe(true);
  });

  it('rejects malformed and unknown messages', () => {
    expect(isWebviewToHostMessage(null)).toBe(false);
    expect(isWebviewToHostMessage({})).toBe(false);
    expect(isWebviewToHostMessage({ type: 'unknown-command' })).toBe(false);
  });
});
