/**
 * Excel-like column filter popup for Markdown table headers.
 */

import type { Node as ProsemirrorNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { tTable } from './table.i18n';
import {
  collectColumnFilterValues,
  mergeColumnFilter,
  readTableFilters,
} from './tableFilterLogic';
import { setTableFiltersAtPos } from './TableCommands';

let openPopup: HTMLDivElement | null = null;

function closeTableFilterPopup(): void {
  openPopup?.remove();
  openPopup = null;
  document.removeEventListener('mousedown', onDocumentPointerDown, true);
  window.removeEventListener('keydown', onWindowKeyDown, true);
}

function onDocumentPointerDown(event: MouseEvent): void {
  if (!openPopup) return;
  const target = event.target as Node | null;
  if (target && openPopup.contains(target)) return;
  if (target instanceof Element && target.closest('.easyview-table-filter-btn')) return;
  closeTableFilterPopup();
}

function onWindowKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeTableFilterPopup();
}

export function showTableFilterPopup(options: {
  anchor: HTMLElement;
  view: EditorView;
  tablePos: number;
  table: ProsemirrorNode;
  col: number;
}): void {
  const { anchor, view, tablePos, col } = options;
  closeTableFilterPopup();

  const table = view.state.doc.nodeAt(tablePos);
  if (!table || table.type.name !== 'table') return;

  const allValues = collectColumnFilterValues(table, col);
  const existing = readTableFilters(table).find((item) => item.col === col);
  const selected = new Set(existing ? existing.selected : allValues);

  const popup = document.createElement('div');
  popup.className = 'easyview-table-filter-popup';
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', tTable('filter.title'));

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'easyview-table-filter-search';
  search.placeholder = tTable('filter.search');
  popup.appendChild(search);

  const actions = document.createElement('div');
  actions.className = 'easyview-table-filter-actions';
  const selectAll = document.createElement('button');
  selectAll.type = 'button';
  selectAll.textContent = tTable('filter.selectAll');
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.textContent = tTable('filter.clear');
  actions.append(selectAll, clear);
  popup.appendChild(actions);

  const list = document.createElement('div');
  list.className = 'easyview-table-filter-list';
  popup.appendChild(list);

  const footer = document.createElement('div');
  footer.className = 'easyview-table-filter-footer';
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'primary';
  apply.textContent = tTable('filter.apply');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = tTable('filter.cancel');
  footer.append(apply, cancel);
  popup.appendChild(footer);

  const checkboxes = new Map<string, HTMLInputElement>();

  const renderList = (needle: string) => {
    list.replaceChildren();
    const query = needle.trim().toLowerCase();
    for (const value of allValues) {
      const labelText = value === '' ? tTable('filter.blank') : value;
      if (query && !labelText.toLowerCase().includes(query)) continue;
      const label = document.createElement('label');
      label.className = 'easyview-table-filter-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = selected.has(value);
      input.addEventListener('change', () => {
        if (input.checked) selected.add(value);
        else selected.delete(value);
      });
      checkboxes.set(value, input);
      const span = document.createElement('span');
      span.textContent = labelText;
      label.append(input, span);
      list.appendChild(label);
    }
  };

  renderList('');
  search.addEventListener('input', () => renderList(search.value));
  selectAll.addEventListener('click', () => {
    for (const value of allValues) selected.add(value);
    renderList(search.value);
  });
  clear.addEventListener('click', () => {
    selected.clear();
    renderList(search.value);
  });
  cancel.addEventListener('click', () => closeTableFilterPopup());
  apply.addEventListener('click', () => {
    const latest = view.state.doc.nodeAt(tablePos);
    if (!latest || latest.type.name !== 'table') {
      closeTableFilterPopup();
      return;
    }
    const next = mergeColumnFilter(latest, col, [...selected]);
    setTableFiltersAtPos(tablePos, next)(view.state, view.dispatch);
    closeTableFilterPopup();
  });

  document.body.appendChild(popup);
  openPopup = popup;
  document.addEventListener('mousedown', onDocumentPointerDown, true);
  window.addEventListener('keydown', onWindowKeyDown, true);

  const rect = anchor.getBoundingClientRect();
  const width = Math.min(280, Math.max(200, rect.width));
  popup.style.width = `${width}px`;
  const top = Math.min(window.innerHeight - popup.offsetHeight - 8, rect.bottom + 4);
  const left = Math.min(window.innerWidth - width - 8, Math.max(8, rect.left));
  popup.style.top = `${Math.max(8, top)}px`;
  popup.style.left = `${left}px`;
  search.focus();
}

export { closeTableFilterPopup };
