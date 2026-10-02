/** @vitest-environment jsdom */
import { expect, it, vi } from 'vitest';
import { WorkspaceExplorerView } from './WorkspaceExplorerView';
import type { WorkspaceExplorerEntry } from './workspace-explorer-messages';

interface MenuItem { label: string; action: () => void }
const buildMenu = (WorkspaceExplorerView.prototype as unknown as {
  buildContextMenuItems(entry: WorkspaceExplorerEntry): MenuItem[];
}).buildContextMenuItems;

it('offers Markdown export only for PDF and Word files and uses the clicked path', () => {
  const post = vi.fn();
  const owner = { post };
  const entry = (name: string): WorkspaceExplorerEntry => ({
    id: name, rootId: 'root', relativePath: `documents/${name}`, name, kind: 'file', writable: false,
  });
  for (const name of ['report.pdf', 'brief.docx', 'legacy.doc']) {
    const item = buildMenu.call(owner as never, entry(name)).find((candidate) => candidate.label === 'Export to Markdown (.md)');
    expect(item).toBeDefined();
    item!.action();
    expect(post).toHaveBeenLastCalledWith({ type: 'convertToMarkdown', relativePath: `documents/${name}` });
  }
  expect(buildMenu.call(owner as never, entry('notes.md')).some((item) => item.label === 'Export to Markdown (.md)')).toBe(false);
});
