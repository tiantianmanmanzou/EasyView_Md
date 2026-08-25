export type TableToolbarType = 'row' | 'column' | 'table';

export class TableToolbarPositionController {
  position(toolbar: HTMLElement, grip: HTMLElement, type: TableToolbarType): void {
    const rect = grip.getBoundingClientRect();
    const popupWidth = toolbar.offsetWidth;
    const popupHeight = toolbar.offsetHeight;
    let left: number;
    let top: number;

    if (type === 'row') {
      left = rect.left - popupWidth - 4;
      top = rect.top + rect.height / 2 - popupHeight / 2;
    } else {
      left = rect.left + rect.width / 2 - popupWidth / 2;
      top = rect.top - popupHeight - 4;
    }

    left = Math.max(8, Math.min(left, window.innerWidth - popupWidth - 8));
    if (top < 8) top = rect.bottom + 4;
    if (top + popupHeight > window.innerHeight - 8) top = rect.top - popupHeight - 4;
    const maxTop = Math.max(8, window.innerHeight - popupHeight - 8);
    top = Math.max(8, Math.min(top, maxTop));
    toolbar.style.left = `${left}px`;
    toolbar.style.top = `${top}px`;
  }
}
