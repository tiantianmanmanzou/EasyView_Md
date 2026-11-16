import type { DesktopBrowserApi, DesktopBrowserState } from '../../contracts';
import { tDesktop } from '../desktopRenderer.i18n';

export interface BrowserChromeLabels {
  back: string;
  forward: string;
  reload: string;
  address: string;
  placeholder: string;
  loading: string;
}

let labels: BrowserChromeLabels = {
  back: 'Back',
  forward: 'Forward',
  reload: 'Reload',
  address: 'Address',
  placeholder: '',
  loading: 'Loading',
};

let browserApi: DesktopBrowserApi | null = null;

export function bindBrowserChrome(api: DesktopBrowserApi, nextLabels: BrowserChromeLabels): () => void {
  browserApi = api;
  labels = nextLabels;
  const subscription = api.onState((state) => {
    for (const host of document.querySelectorAll<HTMLElement>('.desktop-browser-host')) {
      if (host.dataset.tabId === state.tabId) applyBrowserState(host, state);
    }
  });
  return () => { subscription.unsubscribe(); browserApi = null; };
}

export function mountBrowserChrome(host: HTMLElement): void {
  if (host.dataset.chrome === 'ready') return;
  host.dataset.chrome = 'ready';
  host.classList.add('desktop-browser-host');
  const bar = document.createElement('div');
  bar.className = 'desktop-browser-chrome';
  const back = chromeButton('back', labels.back, 'M14 8H4M7 4 3 8l4 4');
  const forward = chromeButton('forward', labels.forward, 'M2 8h10M9 4l4 4-4 4');
  const reload = chromeButton('reload', labels.reload, 'M14.5 8a6.5 6.5 0 1 1-1.5-4.1M14.5 2.5v3h-3');
  const address = document.createElement('input');
  address.className = 'desktop-browser-address';
  address.type = 'text';
  address.spellcheck = false;
  address.autocomplete = 'off';
  address.placeholder = labels.placeholder;
  address.setAttribute('aria-label', labels.address);
  const loading = document.createElement('span');
  loading.className = 'desktop-browser-loading';
  loading.hidden = true;
  loading.textContent = labels.loading;
  const slot = document.createElement('div');
  slot.className = 'desktop-browser-slot';
  bar.append(back, forward, reload, address, loading);
  host.append(bar, slot);

  const tabId = (): string => host.dataset.tabId ?? '';
  back.addEventListener('click', () => { const id = tabId(); if (id) void browserApi?.back(id); });
  forward.addEventListener('click', () => { const id = tabId(); if (id) void browserApi?.forward(id); });
  reload.addEventListener('click', () => { const id = tabId(); if (id) void browserApi?.reload(id); });
  address.addEventListener('input', () => { address.dataset.editing = '1'; });
  address.addEventListener('blur', () => {
    delete address.dataset.editing;
    const last = host.dataset.lastUrl;
    if (last !== undefined) address.value = last === 'about:blank' ? '' : last;
  });
  address.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const id = tabId();
    const value = address.value.trim();
    if (!id || !value) return;
    delete address.dataset.editing;
    address.dataset.pending = '1';
    void browserApi?.navigate(id, value).then((result) => {
      if (!result?.ok) delete address.dataset.pending;
      if (result && !result.ok) window.alert(result.message);
    });
  });
}

export function showBrowserTab(host: HTMLElement, tab: { id: string; url: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }): void {
  mountBrowserChrome(host);
  host.dataset.tabId = tab.id;
  applyBrowserState(host, {
    tabId: tab.id,
    url: tab.url,
    title: '',
    loading: tab.loading,
    canGoBack: tab.canGoBack,
    canGoForward: tab.canGoForward,
  });
}

function applyBrowserState(host: HTMLElement, state: DesktopBrowserState): void {
  host.dataset.loading = String(state.loading);
  const address = host.querySelector<HTMLInputElement>('.desktop-browser-address');
  const loading = host.querySelector<HTMLElement>('.desktop-browser-loading');
  const back = host.querySelector<HTMLButtonElement>('[data-action="back"]');
  const forward = host.querySelector<HTMLButtonElement>('[data-action="forward"]');
  host.dataset.lastUrl = state.url;
  if (address && address.dataset.editing !== '1') {
    address.value = state.url === 'about:blank' ? '' : state.url;
    delete address.dataset.pending;
  }
  if (loading) loading.hidden = !state.loading;
  if (back) back.disabled = !state.canGoBack;
  if (forward) forward.disabled = !state.canGoForward;
}

function chromeButton(action: string, label: string, path: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'desktop-browser-button';
  button.dataset.action = action;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${path}"></path></svg>`;
  return button;
}

export function browserChromeLabels(): BrowserChromeLabels {
  return {
    back: tDesktop('browser.back'),
    forward: tDesktop('browser.forward'),
    reload: tDesktop('browser.reload'),
    address: tDesktop('browser.address'),
    placeholder: tDesktop('browser.placeholder'),
    loading: tDesktop('browser.loading'),
  };
}
