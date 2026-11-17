import { browserLinkFromEvent } from '@easyview/editor-core';

/** Right-click a URL in a code preview. Markdown and source mode use the editor context menu. */
export function installBrowserLinkMenu(options: { label: string; open(url: string): void }): () => void {
  let menu: HTMLElement | null = null;
  const hide = (): void => menu?.classList.remove('visible');
  const onContextMenu = (event: Event): void => {
    const mouse = event as MouseEvent;
    const target = mouse.target instanceof Element ? mouse.target : null;
    if (!target?.closest('.preview-text-editor-host')) return;
    const url = browserLinkFromEvent(mouse);
    if (!url) return;
    mouse.preventDefault();
    if (!menu) {
      menu = document.createElement('div');
      menu.className = 'context-menu';
      document.body.append(menu);
    }
    menu.replaceChildren();
    const item = document.createElement('div');
    item.className = 'context-menu-item';
    item.dataset.action = 'open-in-browser';
    const label = document.createElement('span');
    label.className = 'context-menu-label';
    label.textContent = options.label;
    item.append(label);
    item.addEventListener('mousedown', (click) => {
      click.preventDefault();
      click.stopPropagation();
      options.open(url);
      hide();
    });
    menu.append(item);
    menu.style.left = `${mouse.clientX}px`;
    menu.style.top = `${mouse.clientY}px`;
    menu.classList.add('visible');
  };
  const onMouseDown = (event: Event): void => {
    if (menu && !menu.contains(event.target as Node)) hide();
  };
  const onKeyDown = (event: Event): void => {
    if ((event as KeyboardEvent).key === 'Escape') hide();
  };
  document.addEventListener('contextmenu', onContextMenu);
  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('keydown', onKeyDown);
  return () => {
    document.removeEventListener('contextmenu', onContextMenu);
    document.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('keydown', onKeyDown);
    menu?.remove();
    menu = null;
  };
}
