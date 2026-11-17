import { VersionGuardPanel } from '@easyview/editor-core/version-guard';
import type { GuardRepository, GuardRequest, GuardUiState } from '@easyview/contracts';
import { normalizeLocale, setLocale } from '@easyview/contracts/i18n';
declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): GuardUiState | undefined; setState(state: GuardUiState): void };
const api = acquireVsCodeApi(); setLocale(normalizeLocale(document.documentElement.lang) ?? 'en');
let sequence = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const listeners = new Set<(paths: string[] | null) => void>();
const discoveries = new Set<(repositories: GuardRepository[], warnings: string[]) => void>();
let durableState: GuardUiState | undefined = api.getState();
let panel: VersionGuardPanel | undefined;
function ensurePanel(state?: GuardUiState): VersionGuardPanel {
  if (state) durableState = state;
  if (panel) return panel;
  panel = new VersionGuardPanel({
    header: false,
    onExpandStateChange: allExpanded => api.postMessage({ type: 'guard.expandState', allExpanded }),
    onSoloStateChange: solo => api.postMessage({ type: 'guard.soloState', solo }),
    client: {
      onDiscovery: listener => { discoveries.add(listener); return { dispose: () => discoveries.delete(listener) }; },
      request: (request: GuardRequest) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); api.postMessage({ type: 'guard.request', id, request }); }),
      subscribe: listener => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
      loadState: () => durableState ?? api.getState(),
      saveState: state => {
        durableState = state;
        api.setState(state);
        api.postMessage({ type: 'guard.saveUi', state });
      },
    },
  });
  document.getElementById('guard-root')!.append(panel.element);
  return panel;
}
window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'guard.bootstrap') { ensurePanel(message.state as GuardUiState | undefined); return; }
  if (message.type === 'guard.result') { const waiter = pending.get(message.id); pending.delete(message.id); if (message.error) waiter?.reject(new Error(message.error)); else waiter?.resolve(message.value); }
  else if (message.type === 'guard.discovery') discoveries.forEach(listener => listener(message.repositories, message.warnings));
  else if (message.type === 'guard.changed') listeners.forEach(listener => listener(message.paths));
  else if (message.type === 'guard.visible') ensurePanel().setVisible(message.visible);
  else if (message.type === 'guard.reset') ensurePanel().reset();
  else if (message.type === 'guard.refresh') ensurePanel().refreshRepositories();
  else if (message.type === 'guard.expandAll') ensurePanel().expandAll();
  else if (message.type === 'guard.collapseAll') ensurePanel().collapseAll();
  else if (message.type === 'guard.soloOn') ensurePanel().setSolo(true);
  else if (message.type === 'guard.soloOff') ensurePanel().setSolo(false);
});
window.addEventListener('pagehide', () => {
  panel?.dispose();
  for (const waiter of pending.values()) waiter.reject(new Error('Version Guard closed.'));
  pending.clear();
});
api.postMessage({ type: 'guard.ready' });
