import { describe, expect, it, vi } from 'vitest';

const vscodeMocks = vi.hoisted(() => ({
  showInformationMessage: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: { showInformationMessage: vscodeMocks.showInformationMessage },
  env: { openExternal: vscodeMocks.openExternal },
  Uri: { parse: (value: string) => value },
  extensions: { getExtension: vi.fn() },
}));

import { notifyExtensionUpdated } from './extensionUpdateNotification';

function createContext(initialVersion?: string) {
  let version = initialVersion;
  return {
    globalState: {
      get: vi.fn(() => version),
      update: vi.fn(async (_key: string, nextVersion: string) => {
        version = nextVersion;
      }),
    },
  } as any;
}

describe('notifyExtensionUpdated', () => {
  it('records the first installed version without a notification', async () => {
    const context = createContext();

    await expect(notifyExtensionUpdated(context, '1.0.257')).resolves.toBe(false);
    expect(context.globalState.update).toHaveBeenCalledWith('easyviewMd.lastActivatedVersion', '1.0.257');
    expect(vscodeMocks.showInformationMessage).not.toHaveBeenCalled();
  });

  it('notifies once when the installed version changes', async () => {
    vscodeMocks.showInformationMessage.mockResolvedValue(undefined);
    const context = createContext('1.0.256');

    await expect(notifyExtensionUpdated(context, '1.0.257')).resolves.toBe(true);
    expect(vscodeMocks.showInformationMessage).toHaveBeenCalledWith(
      'EasyView_Md updated from v1.0.256 to v1.0.257.',
      'View Release Notes',
    );
    expect(vscodeMocks.openExternal).not.toHaveBeenCalled();
  });
});
