import { describe, expect, it, vi } from 'vitest';
import { requestRestart } from './appLifecycle';

describe('requestRestart (problem 5)', () => {
  it('must confirm dirty documents before relaunching', async () => {
    const confirmCloseAll = vi.fn().mockResolvedValue(false);
    const relaunch = vi.fn();

    await expect(requestRestart({
      hasDirtyDocuments: true,
      confirmCloseAll,
      relaunch,
    })).resolves.toBe(false);

    expect(confirmCloseAll).toHaveBeenCalledTimes(1);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('relaunches only after confirmCloseAll accepts', async () => {
    const confirmCloseAll = vi.fn().mockResolvedValue(true);
    const relaunch = vi.fn();

    await expect(requestRestart({
      hasDirtyDocuments: true,
      confirmCloseAll,
      relaunch,
    })).resolves.toBe(true);

    expect(confirmCloseAll).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it('skips the confirmation prompt when nothing is dirty', async () => {
    const confirmCloseAll = vi.fn();
    const relaunch = vi.fn();

    await expect(requestRestart({
      hasDirtyDocuments: false,
      confirmCloseAll,
      relaunch,
    })).resolves.toBe(true);

    expect(confirmCloseAll).not.toHaveBeenCalled();
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});
