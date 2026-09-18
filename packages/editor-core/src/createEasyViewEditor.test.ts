// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorHostTransport, HostToEditorMessage } from '@easyview/contracts';
import { createEasyViewEditor } from './index';

function createHost(): EditorHostTransport {
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
    subscribe: (_listener: (message: HostToEditorMessage) => void) => ({ unsubscribe: vi.fn() }),
  };
}

afterEach(() => {
  document.body.replaceChildren();
  document.head.querySelectorAll('style[id^="easyview-"]').forEach((node) => node.remove());
});

describe('createEasyViewEditor entry boundary', () => {
  it('can be imported without creating an editor or reading the host runtime', () => {
    expect(createEasyViewEditor).toBeTypeOf('function');
  });

  it('creates and disposes simultaneous rooted instances without sharing facade state', () => {
    const firstRoot = document.createElement('section');
    const secondRoot = document.createElement('section');
    document.body.append(firstRoot, secondRoot);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const first = createEasyViewEditor({ host: createHost(), root: firstRoot });
    const second = createEasyViewEditor({ host: createHost(), root: secondRoot });

    first.setOutlineVisible(true);
    expect(first.getUiState().outlineVisible).toBe(true);
    expect(second.getUiState().outlineVisible).toBe(false);

    first.dispose();
    expect(() => second.setOutlineVisible(true)).not.toThrow();
    expect(second.getUiState().outlineVisible).toBe(true);
    second.dispose();
    error.mockRestore();
  });
});
