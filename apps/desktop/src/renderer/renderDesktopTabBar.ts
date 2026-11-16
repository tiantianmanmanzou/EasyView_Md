import { resolveWorkspaceTreeIcon } from '@easyview/contracts';
import { DESKTOP_TAB_CLOSE_SHORTCUT } from '../contracts';
import type { DesktopTab } from '../contracts';
import { tDesktop } from './desktopRenderer.i18n';

export interface DesktopTabBarHandlers {
  onActivate(tabId: string): void;
  onClose(tabId: string): void;
  onContextMenu(tabId: string): void;
  onUnpin(tabId: string): void;
}

const PIN_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"><path d="M9.5 2.5 13.5 6.5 12.4 7.6 11.3 7.3 8.9 9.7 9.2 12.1 8.1 13.2 2.8 7.9 3.9 6.8 6.3 7.1 8.7 4.7 8.4 3.6Z"/><path d="M5.4 10.6 2.5 13.5"/></svg>';

const wheelScrollBound = new WeakSet<HTMLElement>();

type TabRowKind = 'pinned' | 'regular';
const tabRows = new WeakMap<HTMLElement, Record<TabRowKind, HTMLElement>>();

/** Pinned tabs get their own strip above the regular, horizontally scrolling tabs.
 * Rows persist across renders so each keeps its own scroll position.
 */
function tabRowsFor(container: HTMLElement): Record<TabRowKind, HTMLElement> {
  let rows = tabRows.get(container);
  if (!rows) {
    const create = (kind: TabRowKind): HTMLElement => {
      const row = container.ownerDocument.createElement('div');
      row.className = `desktop-tab-row desktop-tab-row-${kind}`;
      row.dataset.row = kind;
      row.setAttribute('role', 'presentation');
      bindWheelScroll(row);
      return row;
    };
    rows = { pinned: create('pinned'), regular: create('regular') };
    tabRows.set(container, rows);
  }
  return rows;
}

function hideTabTooltip(document: Document): void {
  const tooltip = document.getElementById('desktop-tab-tooltip');
  if (tooltip) tooltip.hidden = true;
}

function showTabTooltip(button: HTMLElement, name: string, path: string): void {
  const document = button.ownerDocument;
  let tooltip = document.getElementById('desktop-tab-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'desktop-tab-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    document.body.appendChild(tooltip);
  }
  tooltip.textContent = name;
  if (path !== name) {
    const location = document.createElement('div');
    location.className = 'desktop-tab-tooltip-path';
    location.textContent = path;
    tooltip.appendChild(location);
  }
  tooltip.style.left = '0px';
  tooltip.style.top = '0px';
  tooltip.hidden = false;
  const anchor = button.getBoundingClientRect();
  const bounds = tooltip.getBoundingClientRect();
  tooltip.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8))}px`;
  tooltip.style.top = `${Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - bounds.height - 8))}px`;
}

/** The scrollbar is hidden, so a vertical mouse wheel scrolls the tabs sideways. */
function bindWheelScroll(container: HTMLElement): void {
  if (wheelScrollBound.has(container)) return;
  wheelScrollBound.add(container);
  container.addEventListener('scroll', () => hideTabTooltip(container.ownerDocument));
  container.addEventListener('pointerdown', () => hideTabTooltip(container.ownerDocument));
  container.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideTabTooltip(container.ownerDocument);
  });
  container.addEventListener('wheel', (event) => {
    if (event.shiftKey || event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    if (container.scrollWidth <= container.clientWidth) return;
    container.scrollLeft += event.deltaY;
    event.preventDefault();
  }, { passive: false });
}

export function renderDesktopTabBar(
  container: HTMLElement,
  tabs: readonly DesktopTab[],
  activeTabId: string | null,
  handlers: DesktopTabBarHandlers,
): void {
  hideTabTooltip(container.ownerDocument);
  const rows = tabRowsFor(container);
  rows.pinned.replaceChildren();
  rows.regular.replaceChildren();
  container.replaceChildren(...(['pinned', 'regular'] as const)
    .filter((kind) => tabs.some((tab) => !!tab.pinned === (kind === 'pinned')))
    .map((kind) => rows[kind]));
  container.classList.toggle('has-pinned-row', tabs.some((tab) => !!tab.pinned));
  container.hidden = tabs.length === 0;
  for (const tab of tabs) {
    const item = document.createElement('div');
    item.className = 'desktop-tab';
    item.dataset.tabId = tab.id;
    item.classList.toggle('active', tab.id === activeTabId);
    item.setAttribute('role', 'tab');
    item.setAttribute('aria-selected', String(tab.id === activeTabId));
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      handlers.onContextMenu(tab.id);
    });

    const activate = document.createElement('button');
    activate.type = 'button';
    activate.className = 'desktop-tab-activate';
    activate.setAttribute('aria-label', tab.fileName);
    const path = tab.kind === 'editor' ? tab.filePath : tab.kind === 'browser' ? (tab.relativePath || tab.url) : tab.relativePath;
    const showTooltip = (): void => showTabTooltip(activate, tab.fileName, path);
    const hideTooltip = (): void => hideTabTooltip(container.ownerDocument);
    activate.addEventListener('pointerenter', showTooltip);
    activate.addEventListener('pointerleave', hideTooltip);
    activate.addEventListener('focus', showTooltip);
    activate.addEventListener('blur', hideTooltip);
    activate.addEventListener('click', () => { handlers.onActivate(tab.id); });

    const icon = document.createElement('span');
    icon.className = 'desktop-tab-icon';
    const descriptor = resolveWorkspaceTreeIcon({ kind: 'file', name: tab.fileName });
    icon.dataset.icon = descriptor.id;
    icon.innerHTML = descriptor.svg;
    activate.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'desktop-tab-label';
    label.textContent = tab.fileName;
    activate.appendChild(label);

    if ((tab.kind === 'editor' || tab.kind === 'preview') && tab.dirty) {
      const dirty = document.createElement('span');
      dirty.className = 'desktop-tab-dirty';
      dirty.setAttribute('aria-label', tDesktop('tab.unsaved'));
      activate.appendChild(dirty);
    }

    item.classList.toggle('pinned', !!tab.pinned);
    const action = document.createElement('button');
    action.type = 'button';
    if (tab.pinned) {
      action.className = 'desktop-tab-close desktop-tab-pin';
      action.innerHTML = PIN_ICON;
    } else {
      action.className = 'desktop-tab-close';
      action.textContent = '×';
    }
    const actionLabel = tDesktop(tab.pinned ? 'tab.unpin' : 'tab.close', { name: tab.fileName });
    const closeShortcut = navigator.platform.toLowerCase().includes('mac') ? DESKTOP_TAB_CLOSE_SHORTCUT.macLabel : DESKTOP_TAB_CLOSE_SHORTCUT.otherLabel;
    action.title = tab.pinned ? actionLabel : `${actionLabel} (${closeShortcut})`;
    action.setAttribute('aria-label', actionLabel);
    action.addEventListener('click', (event) => {
      event.stopPropagation();
      if (tab.pinned) handlers.onUnpin(tab.id);
      else handlers.onClose(tab.id);
    });

    item.append(activate, action);
    (tab.pinned ? rows.pinned : rows.regular).appendChild(item);
  }
  const active = container.querySelector<HTMLElement>('.desktop-tab.active');
  active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}
