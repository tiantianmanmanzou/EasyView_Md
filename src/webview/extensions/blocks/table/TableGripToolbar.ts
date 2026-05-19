/**
 * Table Grip Toolbar
 *
 * Inline toolbar for table row/column operations (Outline-style).
 * Shows directly on grip hover/click instead of context menu.
 */

import * as tableCommands from './TableCommands';
import { getEditorView } from '../../../index';
import { isHeaderEnabled } from './TableQueries';
import { selectedRect } from 'prosemirror-tables';

export class TableGripToolbar {
  private el: HTMLDivElement;
  private currentGrip: HTMLElement | null = null;
  private currentIndex: number = -1;
  private currentType: 'row' | 'column' | 'table' | null = null;
  private isVisible = false;
  private outsideClickHandler: ((e: MouseEvent) => void) | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'table-grip-toolbar';
    this.el.setAttribute('contenteditable', 'false');
    document.body.appendChild(this.el);
  }

  /**
   * Show toolbar for a row grip
   */
  showForRow(gripElement: HTMLElement, rowIndex: number) {
    this.currentGrip = gripElement;
    this.currentIndex = rowIndex;
    this.currentType = 'row';

    this.render();
    this.show(gripElement);
  }

  /**
   * Show toolbar for a column grip
   */
  showForColumn(gripElement: HTMLElement, colIndex: number) {
    this.currentGrip = gripElement;
    this.currentIndex = colIndex;
    this.currentType = 'column';

    this.render();
    this.show(gripElement);
  }

  /**
   * Show toolbar for the table grip (corner)
   */
  showForTable(gripElement: HTMLElement) {
    this.currentGrip = gripElement;
    this.currentIndex = -1;
    this.currentType = 'table';

    this.render();
    this.show(gripElement);
  }

  private show(gripElement: HTMLElement) {
    this.el.classList.add('visible');
    this.isVisible = true;

    // Position next to grip
    requestAnimationFrame(() => this.updatePosition(gripElement));

    // Click outside -> close
    if (!this.outsideClickHandler) {
      this.outsideClickHandler = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (!this.el.contains(target) && !target.closest('.table-grip') && !target.closest('.table-grip-row') && !target.closest('.table-grip-column')) {
          this.hide();
        }
      };
      setTimeout(() => {
        document.addEventListener('mousedown', this.outsideClickHandler!);
      }, 0);
    }
  }

  private updatePosition(gripElement: HTMLElement) {
    const rect = gripElement.getBoundingClientRect();
    const popupWidth = this.el.offsetWidth;
    const popupHeight = this.el.offsetHeight;

    let left: number;
    let top: number;

    if (this.currentType === 'row') {
      // Row grip: show to the left of the grip, vertically centered
      left = rect.left - popupWidth - 4;
      top = rect.top + rect.height / 2 - popupHeight / 2;
    } else if (this.currentType === 'column') {
      // Column grip: show above the grip, horizontally centered
      left = rect.left + rect.width / 2 - popupWidth / 2;
      top = rect.top - popupHeight - 4;
    } else {
      // Table grip (corner): show above-left
      left = rect.left + rect.width / 2 - popupWidth / 2;
      top = rect.top - popupHeight - 4;
    }

    // Keep within viewport
    left = Math.max(8, Math.min(left, window.innerWidth - popupWidth - 8));
    if (top < 8) {
      // Flip below
      top = rect.bottom + 4;
    }
    if (top + popupHeight > window.innerHeight - 8) {
      top = rect.top - popupHeight - 4;
    }

    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }

  hide() {
    if (!this.isVisible) return;

    this.el.classList.remove('visible');
    this.isVisible = false;
    this.currentGrip = null;
    this.currentIndex = -1;
    this.currentType = null;

    if (this.outsideClickHandler) {
      document.removeEventListener('mousedown', this.outsideClickHandler);
      this.outsideClickHandler = null;
    }
  }

  /**
   * Get current toolbar state (for restoring after updates)
   */
  getState(): { type: 'row' | 'column' | 'table', index: number } | null {
    if (this.currentType && (this.currentType === 'table' || this.currentIndex >= 0)) {
      return {
        type: this.currentType,
        index: this.currentIndex
      };
    }
    return null;
  }

  private render() {
    this.el.innerHTML = '';

    if (this.currentType === 'row') {
      this.renderRowToolbar();
    } else if (this.currentType === 'column') {
      this.renderColumnToolbar();
    } else if (this.currentType === 'table') {
      this.renderTableToolbar();
    }
  }

  private renderRowToolbar() {
    // Row grip = horizontal grip on the left - for moving rows up/down
    const toolbar = document.createElement('div');
    toolbar.className = 'grip-toolbar-inner grip-toolbar-vertical';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-orientation', 'vertical');

    // Toggle header button (only for first row)
    if (this.currentIndex === 0) {
      let isHeader = false;
      const view = getEditorView();
      if (view) {
        try {
          const rect = selectedRect(view.state);
          isHeader = isHeaderEnabled(view.state, "row", rect);
        } catch {}
      }
      toolbar.appendChild(this.createToggleButton(
        'Toggle header row',
        this.headerIcon(),
        isHeader,
        () => { this.toggleHeaderRow(); }
      ));
      toolbar.appendChild(this.createSeparator());
    }

    // Add row buttons
    toolbar.appendChild(this.createButton('Add row above', this.addAboveIcon(), () => {
      this.addRowBefore(this.currentIndex);
    }));

    toolbar.appendChild(this.createButton('Add row below', this.addBelowIcon(), () => {
      this.addRowBefore(this.currentIndex + 1);
    }));

    // Separator
    toolbar.appendChild(this.createSeparator());

    // Move buttons
    toolbar.appendChild(this.createButton('Move up', this.moveUpIcon(), () => {
      this.moveRow(this.currentIndex, -1);
    }));

    toolbar.appendChild(this.createButton('Move down', this.moveDownIcon(), () => {
      this.moveRow(this.currentIndex, 1);
    }));

    // Separator
    toolbar.appendChild(this.createSeparator());

    // Delete button
    toolbar.appendChild(this.createButton('Delete row', this.deleteIcon(), () => {
      this.deleteRow(this.currentIndex);
    }));

    this.el.appendChild(toolbar);
  }

  private renderColumnToolbar() {
    // Column grip = vertical grip on top - for column alignment, sorting, moving
    const toolbar = document.createElement('div');
    toolbar.className = 'grip-toolbar-inner';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-orientation', 'horizontal');

    // Add column buttons
    toolbar.appendChild(this.createButton('Add column before', this.addLeftIcon(), () => {
      this.addColumnBefore(this.currentIndex);
    }));

    toolbar.appendChild(this.createButton('Add column after', this.addRightIcon(), () => {
      this.addColumnBefore(this.currentIndex + 1);
    }));

    // Separator
    toolbar.appendChild(this.createSeparator());

    // Alignment buttons
    toolbar.appendChild(this.createButton('Align left', this.alignLeftIcon(), () => {
      this.setColumnAlignment(this.currentIndex, 'left');
    }));

    toolbar.appendChild(this.createButton('Align center', this.alignCenterIcon(), () => {
      this.setColumnAlignment(this.currentIndex, 'center');
    }));

    toolbar.appendChild(this.createButton('Align right', this.alignRightIcon(), () => {
      this.setColumnAlignment(this.currentIndex, 'right');
    }));

    // Separator
    toolbar.appendChild(this.createSeparator());

    // Sort buttons (only for columns)
    toolbar.appendChild(this.createButton('Sort ascending', this.sortAscIcon(), () => {
      this.sortColumn(this.currentIndex, 'asc');
    }));

    toolbar.appendChild(this.createButton('Sort descending', this.sortDescIcon(), () => {
      this.sortColumn(this.currentIndex, 'desc');
    }));

    // Separator
    toolbar.appendChild(this.createSeparator());

    // Move buttons
    toolbar.appendChild(this.createButton('Move left', this.moveLeftIcon(), () => {
      this.moveColumn(this.currentIndex, -1);
    }));

    toolbar.appendChild(this.createButton('Move right', this.moveRightIcon(), () => {
      this.moveColumn(this.currentIndex, 1);
    }));

    // Separator
    toolbar.appendChild(this.createSeparator());

    // Delete button
    toolbar.appendChild(this.createButton('Delete column', this.deleteIcon(), () => {
      this.deleteColumn(this.currentIndex);
    }));

    this.el.appendChild(toolbar);
  }

  private renderTableToolbar() {
    // Table grip = corner grip - for table-level actions
    const toolbar = document.createElement('div');
    toolbar.className = 'grip-toolbar-inner';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-orientation', 'horizontal');

    // Delete table button
    toolbar.appendChild(this.createButton('Delete table', this.deleteIcon(), () => {
      this.deleteTable();
    }));

    // Separator
    toolbar.appendChild(this.createSeparator());

    // Export CSV button (with text "CSV")
    toolbar.appendChild(this.createButton('Export CSV', this.exportCSVIcon(), () => {
      this.exportTableCSV();
    }, false, 'CSV'));

    this.el.appendChild(toolbar);
  }

  private createButton(label: string, icon: string, onClick: () => void, text?: string): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'grip-toolbar-btn';
    btn.setAttribute('aria-label', label);

    if (text) {
      const textSpan = document.createElement('span');
      textSpan.className = 'grip-toolbar-btn-text';
      textSpan.textContent = text;
      btn.appendChild(textSpan);
    }

    btn.innerHTML += icon;
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  private createSeparator(): HTMLElement {
    const sep = document.createElement('div');
    sep.className = 'grip-toolbar-separator';
    return sep;
  }

  private createToggleButton(label: string, icon: string, active: boolean, onClick: () => void): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `grip-toolbar-btn${active ? ' active' : ''}`;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', String(active));
    btn.innerHTML = icon;
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  /** Find the .table-wrapper DOM element for the table that currently has selection */
  private findActiveTableWrapper(): Element | null {
    try {
      const view = getEditorView();
      if (!view) return null;
      const rect = selectedRect(view.state);
      // nodeDOM returns the DOM node for the table (tableStart - 1 is the table node pos)
      const tableDOM = view.nodeDOM(rect.tableStart - 1) as HTMLElement;
      return tableDOM?.closest('.table-wrapper') || null;
    } catch {
      return null;
    }
  }

  // Command implementations
  private toggleHeaderRow() {
    const view = getEditorView();
    if (!view) return;
    tableCommands.toggleHeader("row")(view.state, view.dispatch);
  }

  private addRowBefore(rowIndex: number) {
    const view = getEditorView();
    if (!view) return;
    tableCommands.addRowBefore({ index: rowIndex })(view.state, view.dispatch);
    this.hide();
  }

  private addColumnBefore(colIndex: number) {
    const view = getEditorView();
    if (!view) return;
    tableCommands.addColumnBefore({ index: colIndex })(view.state, view.dispatch);
    this.hide();
  }

  private setColumnAlignment(colIndex: number, alignment: 'left' | 'center' | 'right') {
    const view = getEditorView();
    if (!view) return;
    tableCommands.setColumnAttr({ index: colIndex, alignment })(view.state, view.dispatch);
  }

  private sortColumn(colIndex: number, direction: 'asc' | 'desc') {
    const view = getEditorView();
    if (!view) return;
    tableCommands.sortTable({ index: colIndex, direction })(view.state, view.dispatch);
  }

  private moveRow(rowIndex: number, direction: number) {
    const view = getEditorView();
    if (!view) return;
    const targetIndex = rowIndex + direction;
    if (targetIndex < 0) return; // Can't move before first row

    // Hide current toolbar to prevent it from being restored at wrong position
    this.hide();

    // Move row
    tableCommands.moveTableRow({ from: rowIndex, to: targetIndex })(view.state, view.dispatch);

    // Wait for TableView.updateControls to recreate grips, then select and show toolbar
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const updatedView = getEditorView();
        if (updatedView) {
          // Select row at new position with gripSelection meta
          tableCommands.selectRow(targetIndex)(updatedView.state, (tr) => {
            tr.setMeta('gripSelection', true);
            updatedView.dispatch(tr);
          });

          // Find new grip in the SPECIFIC table that has the selection
          requestAnimationFrame(() => {
            const wrapper = this.findActiveTableWrapper();
            if (wrapper) {
              const newRowGrip = wrapper.querySelector(`[data-index="${targetIndex}"].table-grip-row`) as HTMLElement;
              if (newRowGrip) {
                this.showForRow(newRowGrip, targetIndex);
              }
            }
          });
        }
      });
    });
  }

  private moveColumn(colIndex: number, direction: number) {
    const view = getEditorView();
    if (!view) return;
    const targetIndex = colIndex + direction;
    if (targetIndex < 0) return; // Can't move before first column

    // Hide current toolbar to prevent it from being restored at wrong position
    this.hide();

    // Move column
    tableCommands.moveTableColumn({ from: colIndex, to: targetIndex })(view.state, view.dispatch);

    // Wait for TableView.updateControls to recreate grips, then select and show toolbar
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const updatedView = getEditorView();
        if (updatedView) {
          // Select column at new position with gripSelection meta
          tableCommands.selectColumn(targetIndex)(updatedView.state, (tr) => {
            tr.setMeta('gripSelection', true);
            updatedView.dispatch(tr);
          });

          // Find new grip in the SPECIFIC table that has the selection
          requestAnimationFrame(() => {
            const wrapper = this.findActiveTableWrapper();
            if (wrapper) {
              const newColGrip = wrapper.querySelector(`[data-index="${targetIndex}"].table-grip-column`) as HTMLElement;
              if (newColGrip) {
                this.showForColumn(newColGrip, targetIndex);
              }
            }
          });
        }
      });
    });
  }

  private deleteRow(rowIndex: number) {
    const view = getEditorView();
    if (!view) return;
    this.hide();
    tableCommands.selectRow(rowIndex)(view.state, view.dispatch);
    setTimeout(() => {
      const updatedView = getEditorView();
      if (updatedView) {
        tableCommands.deleteRowSelection()(updatedView.state, updatedView.dispatch);
      }
    }, 0);
  }

  private deleteColumn(colIndex: number) {
    const view = getEditorView();
    if (!view) return;
    this.hide();
    tableCommands.selectColumn(colIndex)(view.state, view.dispatch);
    setTimeout(() => {
      const updatedView = getEditorView();
      if (updatedView) {
        tableCommands.deleteColSelection()(updatedView.state, updatedView.dispatch);
      }
    }, 0);
  }

  private deleteTable() {
    const view = getEditorView();
    if (!view) return;

    // Hide toolbar first
    this.hide();

    // Delete table in a single transaction (single undo step)
    tableCommands.deleteTable(view.state, view.dispatch);
  }

  private exportTableCSV() {
    const view = getEditorView();
    if (!view) return;
    const fileName = `table-${Date.now()}.csv`;
    tableCommands.exportTable({ format: 'csv', fileName })(view.state, view.dispatch);
  }

  // SVG Icons from Outline
  private addAboveIcon() {
    return `<svg fill="currentColor" width="24px" height="24px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M13.125,16.75 L13.125,19.5 C13.125,20.0522847 12.6772847,20.5 12.125,20.5 L11.875,20.5 C11.3227153,20.5 10.875,20.0522847 10.875,19.5 L10.875,16.75 L8.5,16.75 C7.94771525,16.75 7.5,16.3022847 7.5,15.75 L7.5,15.25 C7.5,14.6977153 7.94771525,14.25 8.5,14.25 L10.875,14.25 L10.875,11.5 C10.875,10.9477153 11.3227153,10.5 11.875,10.5 L12.125,10.5 C12.6772847,10.5 13.125,10.9477153 13.125,11.5 L13.125,14.25 L15.5,14.25 C16.0522847,14.25 16.5,14.6977153 16.5,15.25 L16.5,15.75 C16.5,16.3022847 16.0522847,16.75 15.5,16.75 L13.125,16.75 Z M7.38994949,10.6094757 C6.84321549,11.1301748 5.95678451,11.1301748 5.41005051,10.6094757 C4.8633165,10.0887767 4.8633165,9.24455668 5.41005051,8.72385763 L11.0100505,3.39052429 C11.5567845,2.86982524 12.4432155,2.86982524 12.9899495,3.39052429 L18.5899495,8.72385763 C19.1366835,9.24455668 19.1366835,10.0887767 18.5899495,10.6094757 C18.0432155,11.1301748 17.1567845,11.1301748 16.6100505,10.6094757 L12,6.21895142 L7.38994949,10.6094757 Z"></path></svg>`;
  }

  private addBelowIcon() {
    return `<svg fill="currentColor" width="24px" height="24px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M10.875,7.25 L10.875,4.5 C10.875,3.94771525 11.3227153,3.5 11.875,3.5 L12.125,3.5 C12.6772847,3.5 13.125,3.94771525 13.125,4.5 L13.125,7.25 L15.5,7.25 C16.0522847,7.25 16.5,7.69771525 16.5,8.25 L16.5,8.75 C16.5,9.30228475 16.0522847,9.75 15.5,9.75 L13.125,9.75 L13.125,12.5 C13.125,13.0522847 12.6772847,13.5 12.125,13.5 L11.875,13.5 C11.3227153,13.5 10.875,13.0522847 10.875,12.5 L10.875,9.75 L8.5,9.75 C7.94771525,9.75 7.5,9.30228475 7.5,8.75 L7.5,8.25 C7.5,7.69771525 7.94771525,7.25 8.5,7.25 L10.875,7.25 Z M16.2807612,13.8417088 C16.7884428,13.3860971 17.6115572,13.3860971 18.1192388,13.8417088 C18.6269204,14.2973204 18.6269204,15.0360129 18.1192388,15.4916246 L12.9192388,20.1582912 C12.4115572,20.6139029 11.5884428,20.6139029 11.0807612,20.1582912 L5.88076118,15.4916246 C5.37307961,15.0360129 5.37307961,14.2973204 5.88076118,13.8417088 C6.38844276,13.3860971 7.21155724,13.3860971 7.71923882,13.8417088 L12,17.6834175 L16.2807612,13.8417088 Z"></path></svg>`;
  }

  private addLeftIcon() {
    return `<svg fill="currentColor" width="24px" height="24px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M16.625,10.75 L19,10.75 C19.5522847,10.75 20,11.1977153 20,11.75 L20,12.25 C20,12.8022847 19.5522847,13.25 19,13.25 L16.625,13.25 L16.625,16 C16.625,16.5522847 16.1772847,17 15.625,17 L15.375,17 C14.8227153,17 14.375,16.5522847 14.375,16 L14.375,13.25 L12,13.25 C11.4477153,13.25 11,12.8022847 11,12.25 L11,11.75 C11,11.1977153 11.4477153,10.75 12,10.75 L14.375,10.75 L14.375,8 C14.375,7.44771525 14.8227153,7 15.375,7 L15.625,7 C16.1772847,7 16.625,7.44771525 16.625,8 L16.625,10.75 Z M10.6582912,15.9514719 C11.1139029,16.420101 11.1139029,17.179899 10.6582912,17.6485281 C10.2026796,18.1171573 9.4639871,18.1171573 9.00837542,17.6485281 L4.34170876,12.8485281 C3.88609708,12.379899 3.88609708,11.620101 4.34170876,11.1514719 L9.00837542,6.35147186 C9.4639871,5.88284271 10.2026796,5.88284271 10.6582912,6.35147186 C11.1139029,6.82010101 11.1139029,7.57989899 10.6582912,8.04852814 L6.81658249,12 L10.6582912,15.9514719 Z"></path></svg>`;
  }

  private addRightIcon() {
    return `<svg fill="currentColor" width="24px" height="24px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M7.375,13.25 L5,13.25 C4.44771525,13.25 4,12.8022847 4,12.25 L4,11.75 C4,11.1977153 4.44771525,10.75 5,10.75 L7.375,10.75 L7.375,8 C7.375,7.44771525 7.82271525,7 8.375,7 L8.625,7 C9.17728475,7 9.625,7.44771525 9.625,8 L9.625,10.75 L12,10.75 C12.5522847,10.75 13,11.1977153 13,11.75 L13,12.25 C13,12.8022847 12.5522847,13.25 12,13.25 L9.625,13.25 L9.625,16 C9.625,16.5522847 9.17728475,17 8.625,17 L8.375,17 C7.82271525,17 7.375,16.5522847 7.375,16 L7.375,13.25 Z M13.3417088,8.04852814 C12.8860971,7.57989899 12.8860971,6.82010101 13.3417088,6.35147186 C13.7973204,5.88284271 14.5360129,5.88284271 14.9916246,6.35147186 L19.6582912,11.1514719 C20.1139029,11.620101 20.1139029,12.379899 19.6582912,12.8485281 L14.9916246,17.6485281 C14.5360129,18.1171573 13.7973204,18.1171573 13.3417088,17.6485281 C12.8860971,17.179899 12.8860971,16.420101 13.3417088,15.9514719 L17.1834175,12 L13.3417088,8.04852814 Z"></path></svg>`;
  }

  private alignLeftIcon() {
    return `<svg fill="currentColor" width="24px" height="24px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M5,6 L19,6 C19.5522847,6 20,6.44771525 20,7 C20,7.55228475 19.5522847,8 19,8 L5,8 C4.44771525,8 4,7.55228475 4,7 C4,6.44771525 4.44771525,6 5,6 Z M5,11 L14,11 C14.5522847,11 15,11.4477153 15,12 C15,12.5522847 14.5522847,13 14,13 L5,13 C4.44771525,13 4,12.5522847 4,12 C4,11.4477153 4.44771525,11 5,11 Z M5,16 L19,16 C19.5522847,16 20,16.4477153 20,17 C20,17.5522847 19.5522847,18 19,18 L5,18 C4.44771525,18 4,17.5522847 4,17 C4,16.4477153 4.44771525,16 5,16 Z"></path></svg>`;
  }

  private alignCenterIcon() {
    return `<svg fill="currentColor" width="24px" height="24px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M5,6 L19,6 C19.5522847,6 20,6.44771525 20,7 C20,7.55228475 19.5522847,8 19,8 L5,8 C4.44771525,8 4,7.55228475 4,7 C4,6.44771525 4.44771525,6 5,6 Z M8,11 L16,11 C16.5522847,11 17,11.4477153 17,12 C17,12.5522847 16.5522847,13 16,13 L8,13 C7.44771525,13 7,12.5522847 7,12 C7,11.4477153 7.44771525,11 8,11 Z M5,16 L19,16 C19.5522847,16 20,16.4477153 20,17 C20,17.5522847 19.5522847,18 19,18 L5,18 C4.44771525,18 4,17.5522847 4,17 C4,16.4477153 4.44771525,16 5,16 Z"></path></svg>`;
  }

  private alignRightIcon() {
    return `<svg fill="currentColor" width="24px" height="24px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M5,6 L19,6 C19.5522847,6 20,6.44771525 20,7 C20,7.55228475 19.5522847,8 19,8 L5,8 C4.44771525,8 4,7.55228475 4,7 C4,6.44771525 4.44771525,6 5,6 Z M10,11 L19,11 C19.5522847,11 20,11.4477153 20,12 C20,12.5522847 19.5522847,13 19,13 L10,13 C9.44771525,13 9,12.5522847 9,12 C9,11.4477153 9.44771525,11 10,11 Z M5,16 L19,16 C19.5522847,16 20,16.4477153 20,17 C20,17.5522847 19.5522847,18 19,18 L5,18 C4.44771525,18 4,17.5522847 4,17 C4,16.4477153 4.44771525,16 5,16 Z"></path></svg>`;
  }

  private sortAscIcon() {
    return `<svg fill="currentColor" width="24px" height="24px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M6 4C5.52332 4 5.11291 4.33646 5.01942 4.80388L4.21942 8.80388L4.01942 9.80388C3.91111 10.3454 4.26233 10.8723 4.80389 10.9806C5.34545 11.0889 5.87227 10.7377 5.98058 10.1961L6.01981 10H7.9802L8.01942 10.1961C8.12773 10.7377 8.65456 11.0889 9.19612 10.9806C9.73768 10.8723 10.0889 10.3454 9.98058 9.80388L9.78058 8.80388L8.98058 4.80388C8.8871 4.33646 8.47668 4 8 4H6ZM7.5802 8H6.41981L6.81981 6H7.1802L7.5802 8ZM13 5C12.4477 5 12 5.44772 12 6C12 6.55228 12.4477 7 13 7H19C19.5523 7 20 6.55228 20 6C20 5.44772 19.5523 5 19 5H13ZM14 9C13.4477 9 13 9.44772 13 10C13 10.5523 13.4477 11 14 11H19C19.5523 11 20 10.5523 20 10C20 9.44772 19.5523 9 19 9H14ZM14 14C14 13.4477 14.4477 13 15 13H19C19.5523 13 20 13.4477 20 14C20 14.5523 19.5523 15 19 15H15C14.4477 15 14 14.5523 14 14ZM16 17C15.4477 17 15 17.4477 15 18C15 18.5523 15.4477 19 16 19H19C19.5523 19 20 18.5523 20 18C20 17.4477 19.5523 17 19 17H16ZM4 14C4 13.4477 4.44772 13 5 13H9C9.38441 13 9.73478 13.2203 9.9013 13.5668C10.0678 13.9133 10.021 14.3245 9.78087 14.6247L7.08063 18H9C9.55229 18 10 18.4477 10 19C10 19.5523 9.55229 20 9 20H5C4.6156 20 4.26522 19.7797 4.0987 19.4332C3.93218 19.0867 3.979 18.6755 4.21913 18.3753L6.91938 15H5C4.44772 15 4 14.5523 4 14Z"></path></svg>`;
  }

  private sortDescIcon() {
    return `<svg fill="currentColor" width="24px" height="24px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M3.99999 5C3.99999 4.44772 4.44771 4 4.99999 4H8.99999C9.3844 4 9.73478 4.22035 9.9013 4.56681C10.0678 4.91328 10.021 5.32453 9.78086 5.6247L7.08062 9H8.99999C9.55228 9 9.99999 9.44772 9.99999 10C9.99999 10.5523 9.55228 11 8.99999 11H4.99999C4.61559 11 4.26521 10.7797 4.09869 10.4332C3.93217 10.0867 3.97899 9.67548 4.21913 9.37531L6.91937 6H4.99999C4.44771 6 3.99999 5.55228 3.99999 5ZM13 5C12.4477 5 12 5.44772 12 6C12 6.55228 12.4477 7 13 7H19C19.5523 7 20 6.55228 20 6C20 5.44772 19.5523 5 19 5H13ZM14 9C13.4477 9 13 9.44772 13 10C13 10.5523 13.4477 11 14 11H19C19.5523 11 20 10.5523 20 10C20 9.44772 19.5523 9 19 9H14ZM14 14C14 13.4477 14.4477 13 15 13H19C19.5523 13 20 13.4477 20 14C20 14.5523 19.5523 15 19 15H15C14.4477 15 14 14.5523 14 14ZM16 17C15.4477 17 15 17.4477 15 18C15 18.5523 15.4477 19 16 19H19C19.5523 19 20 18.5523 20 18C20 17.4477 19.5523 17 19 17H16ZM5.99999 13C5.52331 13 5.1129 13.3365 5.01941 13.8039L4.21941 17.8039L4.01941 18.8039C3.9111 19.3454 4.26232 19.8723 4.80388 19.9806C5.34544 20.0889 5.87226 19.7377 5.98058 19.1961L6.0198 19H7.98019L8.01941 19.1961C8.12773 19.7377 8.65455 20.0889 9.19611 19.9806C9.73767 19.8723 10.0889 19.3454 9.98058 18.8039L9.78057 17.8039L8.98057 13.8039C8.88709 13.3365 8.47668 13 7.99999 13H5.99999ZM7.58019 17H6.4198L6.8198 15H7.18019L7.58019 17Z"></path></svg>`;
  }

  private moveUpIcon() {
    return `<svg fill="currentColor" width="24px" height="24px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M6.29289 11.2929C5.90237 11.6834 5.90237 12.3166 6.29289 12.7071C6.68342 13.0976 7.31658 13.0976 7.70711 12.7071L11 9.41421V17C11 17.5523 11.4477 18 12 18C12.5523 18 13 17.5523 13 17V9.41421L16.2929 12.7071C16.6834 13.0976 17.3166 13.0976 17.7071 12.7071C18.0976 12.3166 18.0976 11.6834 17.7071 11.2929L12.7071 6.29289C12.3166 5.90237 11.6834 5.90237 11.2929 6.29289L6.29289 11.2929Z"></path></svg>`;
  }

  private moveDownIcon() {
    return `<svg fill="currentColor" width="24px" height="24px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M17.7071 11.2929C18.0976 11.6834 18.0976 12.3166 17.7071 12.7071L12.7071 17.7071C12.3166 18.0976 11.6834 18.0976 11.2929 17.7071L6.29289 12.7071C5.90237 12.3166 5.90237 11.6834 6.29289 11.2929C6.68342 10.9024 7.31658 10.9024 7.70711 11.2929L11 14.5858V7C11 6.44772 11.4477 6 12 6C12.5523 6 13 6.44772 13 7V14.5858L16.2929 11.2929C16.6834 10.9024 17.3166 10.9024 17.7071 11.2929Z"></path></svg>`;
  }

  private moveLeftIcon() {
    return `<svg fill="currentColor" width="24px" height="24px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M12.7071 6.29289C13.0976 6.68342 13.0976 7.31658 12.7071 7.70711L9.41421 11H17C17.5523 11 18 11.4477 18 12C18 12.5523 17.5523 13 17 13H9.41421L12.7071 16.2929C13.0976 16.6834 13.0976 17.3166 12.7071 17.7071C12.3166 18.0976 11.6834 18.0976 11.2929 17.7071L6.29289 12.7071C5.90237 12.3166 5.90237 11.6834 6.29289 11.2929L11.2929 6.29289C11.6834 5.90237 12.3166 5.90237 12.7071 6.29289Z"></path></svg>`;
  }

  private moveRightIcon() {
    return `<svg fill="currentColor" width="24px" height="24px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M11.2929 17.7071C10.9024 17.3166 10.9024 16.6834 11.2929 16.2929L14.5858 13H7C6.44772 13 6 12.5523 6 12C6 11.4477 6.44772 11 7 11L14.5858 11L11.2929 7.70711C10.9024 7.31658 10.9024 6.68342 11.2929 6.29289C11.6834 5.90237 12.3166 5.90237 12.7071 6.29289L17.7071 11.2929C18.0976 11.6834 18.0976 12.3166 17.7071 12.7071L12.7071 17.7071C12.3166 18.0976 11.6834 18.0976 11.2929 17.7071Z"></path></svg>`;
  }

  private exportCSVIcon() {
    return `<svg fill="currentColor" width="24px" height="24px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M7.29289 10.2929C7.68342 9.90237 8.31658 9.90237 8.70711 10.2929L12 13.5858L15.2929 10.2929C15.6834 9.90237 16.3166 9.90237 16.7071 10.2929C17.0976 10.6834 17.0976 11.3166 16.7071 11.7071L12.7071 15.7071C12.3166 16.0976 11.6834 16.0976 11.2929 15.7071L7.29289 11.7071C6.90237 11.3166 6.90237 10.6834 7.29289 10.2929Z"></path><path d="M11 7C11 6.44772 11.4477 6 12 6C12.5523 6 13 6.44772 13 7V13C13 13.5523 12.5523 14 12 14C11.4477 14 11 13.5523 11 13V7Z"></path><path d="M18 17C18.5523 17 19 17.4477 19 18C19 18.5523 18.5523 19 18 19L6 19C5.44772 19 5 18.5523 5 18C5 17.4477 5.44772 17 6 17L12 17H18Z"></path></svg>`;
  }

  private deleteIcon() {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
  }

  private headerIcon() {
    return `<svg fill="currentColor" width="20px" height="20px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M6 4h12c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2zm0 2v12h12V6H6zm2 2h2v3h4V8h2v8h-2v-3H10v3H8V8z"/></svg>`;
  }

  destroy() {
    if (this.outsideClickHandler) {
      document.removeEventListener('mousedown', this.outsideClickHandler);
      this.outsideClickHandler = null;
    }
    this.el.remove();
  }
}
