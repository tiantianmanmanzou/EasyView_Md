import { describe, expect, it, vi } from 'vitest';
import {
  assertAllowedExternalUrl,
  assertNonEmptyString,
  assertPositiveInteger,
  operationFailure,
  operationSuccess,
  isEditorToHostMessage,
  type EditorHostTransport,
} from '../src';

describe('platform-neutral shared protocol', () => {
  it('accepts known editor message types without requiring a host platform', () => {
    expect(isEditorToHostMessage({ type: 'ready' })).toBe(true);
    expect(isEditorToHostMessage({ type: 'exportXlsx', payload: {}, fileName: 'table.xlsx' })).toBe(true);
    expect(isEditorToHostMessage({ type: 'unknown-command' })).toBe(false);
    expect(isEditorToHostMessage({ type: 'openNativeSourceMode' })).toBe(false);
    expect(isEditorToHostMessage({ type: 'syncOpenEditorShortcut', shortcut: 'Alt+E' })).toBe(false);
    expect(isEditorToHostMessage({ type: 'openWithEasyView' })).toBe(false);
  });

  it('supports transport subscription lifecycle', () => {
    const listener = vi.fn();
    let currentListener: ((message: { type: 'focus' }) => void) | undefined;
    const transport: EditorHostTransport = {
      capabilities: {
      sourceMode: 'embedded',
      git: false,
      terminal: false,
      aiCommitMessage: false,
      documentConversion: false,
      shortcutPersistence: false,
    },
      postMessage: vi.fn(),
      subscribe(next) {
        currentListener = next;
        return {
          unsubscribe() {
            currentListener = undefined;
          },
        };
      },
    };

    const subscription = transport.subscribe(listener);
    currentListener?.({ type: 'focus' });
    expect(listener).toHaveBeenCalledWith({ type: 'focus' });
    subscription.unsubscribe();
    expect(currentListener).toBeUndefined();
  });
});

describe('runtime validation', () => {
  it('validates strings, positive integers, and external URLs', () => {
    expect(() => assertNonEmptyString('  ', 'name')).toThrow('name must be a non-empty string');
    expect(() => assertPositiveInteger(0, 'count')).toThrow('count must be a positive integer');
    expect(() => assertAllowedExternalUrl('file:///tmp/a.md')).toThrow('url must use http or https');
    expect(() => assertAllowedExternalUrl('https://example.com')).not.toThrow();
  });
});

describe('IPC results', () => {
  it('creates discriminated success and failure results', () => {
    expect(operationSuccess('saved')).toEqual({ ok: true, value: 'saved' });
    expect(operationFailure('CONFLICT', 'The file changed on disk')).toEqual({
      ok: false,
      code: 'CONFLICT',
      message: 'The file changed on disk',
    });
  });
});
