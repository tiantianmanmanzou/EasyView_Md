import type { DesktopTab } from '../contracts';

export interface DesktopTabBarHandlers {
  onActivate(tabId: string): void;
  onClose(tabId: string): void;
  onContextMenu(tabId: string): void;
}

export function renderDesktopTabBar(
  container: HTMLElement,
  tabs: readonly DesktopTab[],
  activeTabId: string | null,
  handlers: DesktopTabBarHandlers,
): void {
  container.replaceChildren();
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
    activate.title = tab.kind === 'editor' ? tab.filePath : tab.relativePath;
    activate.addEventListener('click', () => { handlers.onActivate(tab.id); });

    const icon = document.createElement('span');
    icon.className = `desktop-tab-icon desktop-tab-icon-${tab.kind}`;
    icon.textContent = tab.kind === 'editor' ? 'M' : 'P';
    activate.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'desktop-tab-label';
    label.textContent = tab.fileName;
    activate.appendChild(label);

    if (tab.kind === 'editor' && tab.dirty) {
      const dirty = document.createElement('span');
      dirty.className = 'desktop-tab-dirty';
      dirty.setAttribute('aria-label', '未保存');
      activate.appendChild(dirty);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'desktop-tab-close';
    close.textContent = '×';
    close.title = `关闭 ${tab.fileName}`;
    close.setAttribute('aria-label', `关闭 ${tab.fileName}`);
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      handlers.onClose(tab.id);
    });

    item.append(activate, close);
    container.appendChild(item);
  }
  const active = container.querySelector<HTMLElement>('.desktop-tab.active');
  active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}
