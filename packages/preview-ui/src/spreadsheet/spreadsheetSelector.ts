/**
 * Align the selection overlay with cell grid lines.
 *
 * x-data-spreadsheet sizes the area for content-box (`width − 3 + 0.8`) so a 2px
 * border sits on the grid. Under border-box (common host resets) that formula
 * shrinks the outer edge inward — most visible on the right and bottom, next to
 * the fill-handle corner. Set the area to the cell rect with border-box instead.
 */

const PATCH_FLAG = '__easyviewSelectorAlign';

interface AreaOffset {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface DomLike {
  offset?(value: AreaOffset): DomLike;
  show?(): DomLike;
  css?(name: string, value: string): DomLike;
  el?: HTMLElement;
}

interface SelectorElementLike {
  setAreaOffset?(offset: AreaOffset): unknown;
  useHideInput?: boolean;
  areaEl?: DomLike;
  hideInputDiv?: DomLike;
  hideInput?: { val?(value: string): { focus?(): void } };
}

interface SelectorLike {
  br?: SelectorElementLike;
  t?: SelectorElementLike;
  l?: SelectorElementLike;
  tl?: SelectorElementLike;
}

interface SheetLike {
  selector?: SelectorLike & { [PATCH_FLAG]?: boolean };
}

/** Patch every freeze-pane selector so the blue box matches the cell edges. */
export function patchSpreadsheetSelector(sheet: SheetLike | null | undefined): void {
  const selector = sheet?.selector;
  if (!selector || selector[PATCH_FLAG]) return;
  for (const part of [selector.br, selector.t, selector.l, selector.tl]) {
    patchSelectorElement(part);
  }
  selector[PATCH_FLAG] = true;
}

function patchSelectorElement(element: SelectorElementLike | null | undefined): void {
  if (!element || typeof element.setAreaOffset !== 'function') return;
  element.setAreaOffset = (offset: AreaOffset) => {
    const area = element.areaEl;
    if (!area?.offset) return element;
    // border-box: width/height include the 2px border → outer edges = cellRect.
    area.css?.('box-sizing', 'border-box');
    if (area.el) area.el.style.boxSizing = 'border-box';
    const box = {
      left: offset.left,
      top: offset.top,
      width: offset.width,
      height: offset.height,
    };
    area.offset(box).show?.();
    if (element.useHideInput) {
      element.hideInputDiv?.offset?.(box);
      element.hideInput?.val?.('')?.focus?.();
    }
    return element;
  };
}
