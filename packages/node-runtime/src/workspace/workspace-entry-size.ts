import type { WorkspaceEntry, WorkspaceGateway } from '@easyview/contracts';
import { parentWorkspaceRelativePath } from './workspace-path';

/** Sum file contents without traversing symbolic links. An unreadable entry fails the whole calculation. */
export async function workspaceEntrySize(gateway: WorkspaceGateway, rootId: string, relativePath: string): Promise<number> {
  const entries = await gateway.listChildren(rootId, parentWorkspaceRelativePath(relativePath));
  const entry = entries.find((item) => item.relativePath === relativePath);
  if (!entry) throw new Error('Workspace entry not found');
  async function sum(item: WorkspaceEntry): Promise<number> {
    if (item.kind === 'symlink') return 0;
    if (item.kind === 'file') {
      if (item.sizeBytes === undefined) throw new Error('File size unavailable');
      return item.sizeBytes;
    }
    const children = await gateway.listChildren(rootId, item.relativePath);
    let total = 0;
    for (const child of children) total += await sum(child);
    return total;
  }
  return sum(entry);
}
