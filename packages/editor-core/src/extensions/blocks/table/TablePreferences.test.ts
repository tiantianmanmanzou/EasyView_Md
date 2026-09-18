import { describe, expect, it, vi } from 'vitest';
import type { EditorHostTransport } from '@easyview/contracts';

import {
  getFirstRowStickyDefault,
  rememberFirstRowStickyDefault,
} from './TablePreferences';

function host(): EditorHostTransport {
  return {
    capabilities: {
      sourceMode: 'embedded',
      git: false,
      terminal: false,
      aiCommitMessage: false,
      aiChat: false,
      documentConversion: false,
      shortcutPersistence: false,
    },
    postMessage: vi.fn(),
    subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
  };
}

describe('TablePreferences', () => {
  it('persists the preference through the explicitly supplied host', () => {
    const transport = host();

    rememberFirstRowStickyDefault(true, {
      getEditorView: () => null,
      host: transport,
    });

    expect(getFirstRowStickyDefault()).toBe(true);
    expect(transport.postMessage).toHaveBeenCalledWith({
      type: 'setTableFirstRowStickyDefault',
      sticky: true,
    });
  });
});
