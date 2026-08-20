import { Plugin, PluginKey } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { columnResizingPluginKey } from 'prosemirror-tables';

export const COLUMN_RESIZE_CURSOR_CLASS = 'easyview-col-resize-cursor';

function isPointerOnHorizontalScrollbar(event: MouseEvent, scrollable: HTMLElement): boolean {
  const rect = scrollable.getBoundingClientRect();
  if (event.clientX < rect.left - 1 || event.clientX > rect.right + 1) return false;
  const classicBar = scrollable.offsetHeight - scrollable.clientHeight;
  const bar = classicBar > 0 ? classicBar : 14;
  return (
    scrollable.scrollWidth > scrollable.clientWidth + 1 &&
    event.clientY >= rect.bottom - bar &&
    event.clientY <= rect.bottom + 2
  );
}

function cellFromColumnResizeWalk(target: EventTarget | null): HTMLElement | null {
  let node: Element | null = target instanceof Element ? target : null;
  while (node && node.nodeName !== 'TD' && node.nodeName !== 'TH') {
    if (node.classList.contains('ProseMirror')) return null;
    node = node.parentElement;
  }
  return node instanceof HTMLElement ? node : null;
}

/**
 * columnResizing walks from event.target up to any TD/TH. Events on nested
 * table chrome (scrollbar, padding, grips) therefore hit-test the OUTER cell
 * that wraps the nested table and restyle the whole parent grid.
 */
export function shouldBlockColumnResizeHitTest(event: MouseEvent): boolean {
  if (!(event.target instanceof Element)) return false;
  const scrollable = event.target.closest('.table-scrollable');
  if (scrollable instanceof HTMLElement && isPointerOnHorizontalScrollbar(event, scrollable)) {
    return true;
  }

  const wrapper = event.target.closest('.table-wrapper');
  if (!(wrapper instanceof HTMLElement)) return false;

  const cell = cellFromColumnResizeWalk(event.target);
  if (cell && wrapper.contains(cell)) return false;
  return Boolean(wrapper.closest('td, th'));
}

function clearHandle(view: EditorView): void {
  const pluginState = columnResizingPluginKey.getState(view.state);
  if (pluginState && pluginState.activeHandle > -1 && !pluginState.dragging) {
    view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setHandle: -1 }));
  }
}

function findActiveResizeWrapper(view: EditorView): HTMLElement | null {
  const pluginState = columnResizingPluginKey.getState(view.state);
  if (!pluginState || pluginState.activeHandle < 0) return null;

  try {
    const cellDom = view.nodeDOM(pluginState.activeHandle);
    const cellEl =
      cellDom instanceof HTMLElement
        ? cellDom
        : cellDom && 'parentElement' in cellDom
          ? (cellDom as Node).parentElement
          : null;
    const wrapper = cellEl?.closest('.table-wrapper');
    return wrapper instanceof HTMLElement ? wrapper : null;
  } catch {
    return null;
  }
}

function syncTableResizeCursor(view: EditorView, current: HTMLElement | null): HTMLElement | null {
  view.dom.classList.remove('resize-cursor');
  const next = findActiveResizeWrapper(view);
  if (current && current !== next) current.classList.remove(COLUMN_RESIZE_CURSOR_CLASS);
  if (next && next !== current) next.classList.add(COLUMN_RESIZE_CURSOR_CLASS);
  return next && next.isConnected ? next : null;
}

/**
 * Keep column-resize cursor on the active table wrapper instead of the editor
 * root. Toggling `.ProseMirror.resize-cursor` restyles the whole document.
 */
export function columnResizeGuardPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey('columnResizeGuard'),
    view(editorView) {
      let currentWrapper: HTMLElement | null = syncTableResizeCursor(editorView, null);
      return {
        update(view) {
          currentWrapper = syncTableResizeCursor(view, currentWrapper);
        },
        destroy() {
          editorView.dom.classList.remove('resize-cursor');
          currentWrapper?.classList.remove(COLUMN_RESIZE_CURSOR_CLASS);
        },
      };
    },
    props: {
      handleDOMEvents: {
        mousemove(view, event) {
          if (!shouldBlockColumnResizeHitTest(event as MouseEvent)) return false;
          clearHandle(view);
          return true;
        },
      },
    },
  });
}

export function withoutRootResizeCursor(plugin: Plugin): Plugin {
  const specProps = plugin.spec.props as { attributes?: unknown } | undefined;
  if (specProps) specProps.attributes = () => ({});
  (plugin.props as { attributes?: unknown }).attributes = () => ({});
  return plugin;
}
