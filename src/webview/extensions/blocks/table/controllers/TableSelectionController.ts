import type { EditorView } from 'prosemirror-view';
import { selectedRect } from 'prosemirror-tables';
import * as tableCommands from '../TableCommands';
import { isColumnSelection, isRowSelection, isTableSelected } from '../TableQueries';
import { TableStyleHelper } from '../TableStyleHelper';

export interface TableSelectionControllerDeps {
  getEditorView: () => EditorView | null;
  tableDom: HTMLElement;
  rowControls: HTMLElement;
  columnControls: HTMLElement;
}

export class TableSelectionController {
  constructor(private readonly deps: TableSelectionControllerDeps) {}

  refresh(): void {
    const { rowControls, columnControls, tableDom } = this.deps;
    const view = this.deps.getEditorView();
    if (!view) return;

    const selectedRows = new Set<number>();
    const selectedColumns = new Set<number>();
    let showTableGrip = false;
    try {
      const activeRect = tableCommands.selectedRect(view.state);
      const activeTableDom = view.nodeDOM(activeRect.tableStart - 1) as HTMLElement | null;
      if (activeTableDom?.closest('.table-wrapper') === tableDom) {
        if (isTableSelected(view.state)) {
          showTableGrip = true;
        } else {
          for (let row = activeRect.top; row < activeRect.bottom; row++) selectedRows.add(row);
          for (let col = activeRect.left; col < activeRect.right; col++) selectedColumns.add(col);
          if (selectedRows.size === 0 && !isColumnSelection(view.state.selection)) selectedRows.add(activeRect.top);
          if (selectedColumns.size === 0 && !isRowSelection(view.state.selection)) selectedColumns.add(activeRect.left);
        }
      }
    } catch {
      // A text selection outside a table clears previous control state.
    }

    rowControls.querySelectorAll<HTMLElement>(`.${TableStyleHelper.tableGripRow}`).forEach((grip) => {
      grip.classList.toggle(TableStyleHelper.selected, selectedRows.has(Number(grip.dataset.index)));
    });
    columnControls.querySelectorAll<HTMLElement>(`.${TableStyleHelper.tableGripColumn}`).forEach((grip) => {
      grip.classList.toggle(TableStyleHelper.selected, selectedColumns.has(Number(grip.dataset.index)));
    });
    rowControls.querySelector(`.${TableStyleHelper.tableGrip}`)?.classList.toggle(
      TableStyleHelper.selected,
      showTableGrip,
    );
  }
}
