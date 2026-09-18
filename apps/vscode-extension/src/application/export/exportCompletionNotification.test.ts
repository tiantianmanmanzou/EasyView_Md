import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const showInformationMessage = vi.fn();
const openWithDefaultApp = vi.fn();

vi.mock('vscode', () => ({
  window: { showInformationMessage },
}));

vi.mock('../document/openWithDefaultApp', () => ({
  openWithDefaultApp,
}));

describe('showExportCompletionNotification', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    showInformationMessage.mockReset();
    openWithDefaultApp.mockReset();
    showInformationMessage.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defers the toast and opens the file when Open File is chosen', async () => {
    const { showExportCompletionNotification } = await import('./exportCompletionNotification');
    showInformationMessage.mockResolvedValue('Open File');

    showExportCompletionNotification('Excel exported to a.xlsx', '/tmp/a.xlsx', 'Open File');
    expect(showInformationMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(showInformationMessage).toHaveBeenCalledWith('Excel exported to a.xlsx', 'Open File');
    await Promise.resolve();
    expect(openWithDefaultApp).toHaveBeenCalledWith('/tmp/a.xlsx');
  });
});
