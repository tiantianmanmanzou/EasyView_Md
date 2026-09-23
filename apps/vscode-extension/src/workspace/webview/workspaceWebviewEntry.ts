import './workspace-explorer.css';
import { WorkspaceExplorerView, type WorkspaceExplorerVsCodeApi } from './WorkspaceExplorerView';

declare function acquireVsCodeApi(): WorkspaceExplorerVsCodeApi;

const vscodeApi = acquireVsCodeApi();

function resolveMount(): HTMLElement {
  const existing = document.getElementById('workspace-explorer-root');
  if (existing) return existing;
  const root = document.createElement('div');
  root.id = 'workspace-explorer-root';
  document.body.replaceChildren(root);
  return root;
}

const view = new WorkspaceExplorerView(resolveMount(), vscodeApi);

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  view.handleEvent(event.data);
});

vscodeApi.postMessage({ type: 'ready' });

export { WorkspaceExplorerView };
export type { WorkspaceExplorerVsCodeApi };
