/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceExplorerView } from './WorkspaceExplorerView';

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.style.removeProperty('--workspace-font-offset');
});

const fakeApi = (state: unknown) => {
  let saved = state;
  return {
    postMessage: vi.fn(),
    getState: () => saved,
    setState: vi.fn((next: unknown) => { saved = next; }),
  };
};

it('restores the saved font size offset and persists the value saved from the settings dialog', async () => {
  const api = fakeApi({ displayMode: 'icons', fontSizeOffset: 2 });
  const container = document.createElement('div');
  document.body.append(container);
  const view = new WorkspaceExplorerView(container, api) as unknown as {
    applySettings(values: Record<string, unknown>): Promise<void>;
    displayMode: string;
    sortMode: string;
    showCreatedAt: boolean;
    showUpdatedAt: boolean;
    showSize: boolean;
    showSizeHover: boolean;
    showTimestampHover: boolean;
    showNameHover: boolean;
    showDotEntries: boolean;
  };
  expect(document.documentElement.style.getPropertyValue('--workspace-font-offset')).toBe('2px');

  await view.applySettings({
    displayMode: view.displayMode,
    sortMode: view.sortMode,
    showCreatedAt: view.showCreatedAt,
    showUpdatedAt: view.showUpdatedAt,
    showSize: view.showSize,
    showSizeHover: view.showSizeHover,
    showTimestampHover: view.showTimestampHover,
    showNameHover: view.showNameHover,
    showDotEntries: view.showDotEntries,
    fontSizeOffset: 5,
  });
  expect(document.documentElement.style.getPropertyValue('--workspace-font-offset')).toBe('5px');
  expect(api.setState).toHaveBeenLastCalledWith(expect.objectContaining({ displayMode: 'icons', fontSizeOffset: 5, showNameHover: true }));
  expect(api.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'setSortMode' }));
});

it('restores and persists the full-name hover setting locally', async () => {
  const api = fakeApi({ showNameHover: false });
  const container = document.createElement('div');
  document.body.append(container);
  const view = new WorkspaceExplorerView(container, api) as unknown as {
    applySettings(values: Record<string, unknown>): Promise<void>;
    showNameHover: boolean;
  } & Record<string, unknown>;
  expect(view.showNameHover).toBe(false);

  await view.applySettings({
    displayMode: view.displayMode,
    sortMode: view.sortMode,
    showCreatedAt: view.showCreatedAt,
    showUpdatedAt: view.showUpdatedAt,
    showSize: view.showSize,
    showSizeHover: view.showSizeHover,
    showTimestampHover: view.showTimestampHover,
    showNameHover: true,
    showDotEntries: view.showDotEntries,
    fontSizeOffset: view.fontSizeOffset,
  });
  expect(view.showNameHover).toBe(true);
  expect(api.setState).toHaveBeenLastCalledWith(expect.objectContaining({ showNameHover: true }));
  expect(api.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'setShowTimestampHover' }));
});
