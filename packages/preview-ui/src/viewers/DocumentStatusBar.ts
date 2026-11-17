import * as React from 'react';
import { tPreview } from '../preview.i18n';
import { clampZoom, zoomChoices } from '../spreadsheet/spreadsheetZoom';

const h = React.createElement;

export interface ZoomControlsProps {
  percent: number;
  onPercent: (percent: number) => void;
  onStep: (direction: -1 | 1) => void;
  onReset: () => void;
  onFit: () => void;
}

export interface DocumentPages {
  current: number;
  count: number;
  /** Pages laid out side by side in a row (two-page view); previous / next step a whole row. */
  perRow: number;
  goTo: (page: number) => void;
}

/** Zoom group of the bottom status bar; every document route (sheets included) uses this one. */
export function ZoomControls({ percent, onPercent, onStep, onReset, onFit }: ZoomControlsProps): React.ReactElement {
  return h('div', { className: 'preview-zoom-controls' },
    h('select', {
      'aria-label': tPreview('document.zoomLevel'),
      value: String(percent),
      onChange: (event: React.ChangeEvent<HTMLSelectElement>) => { onPercent(Number(event.target.value)); },
    }, ...zoomChoices(percent).map((value) => h('option', { key: value, value: String(value) }, `${value}%`))),
    h('button', { type: 'button', 'aria-label': tPreview('document.zoomOut'), onClick: () => { onStep(-1); } }, '−'),
    h('input', {
      type: 'range',
      min: 10,
      max: 400,
      step: 5,
      value: percent,
      'aria-label': tPreview('document.zoomLevel'),
      // Fill share of the track: same mapping as min/max on the input (10%–400%).
      style: { ['--preview-zoom-level' as string]: `${((Math.min(400, Math.max(10, percent)) - 10) / 390) * 100}%` },
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => { onPercent(Number(event.target.value)); },
    }),
    h('button', { type: 'button', 'aria-label': tPreview('document.zoomIn'), onClick: () => { onStep(1); } }, '+'),
    h('button', { type: 'button', className: 'preview-zoom-reset', 'aria-label': tPreview('document.zoomReset'), onClick: onReset }, '1:1'),
    h('button', { type: 'button', className: 'preview-zoom-fit', 'aria-label': tPreview('document.zoomFit'), onClick: onFit },
      h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': true },
        h('path', { d: 'M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
      ),
    ),
  );
}

function PageControls({ current, count, perRow, goTo }: DocumentPages): React.ReactElement {
  const [draft, setDraft] = React.useState<string | null>(null);
  const commit = (): void => {
    const page = Number.parseInt(draft ?? '', 10);
    setDraft(null);
    if (Number.isFinite(page)) goTo(Math.min(count, Math.max(1, page)));
  };
  return h('div', { className: 'preview-page-controls' },
    h('button', { type: 'button', 'aria-label': tPreview('document.previousPage'), disabled: current <= 1, onClick: () => { goTo(Math.max(1, current - perRow)); } }, '‹'),
    h('input', {
      type: 'text',
      inputMode: 'numeric',
      'aria-label': tPreview('document.pageNumber'),
      value: draft ?? String(current),
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setDraft(event.target.value); },
      onFocus: (event: React.FocusEvent<HTMLInputElement>) => { event.target.select(); },
      onBlur: commit,
      onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') commit();
        else if (event.key === 'Escape') setDraft(null);
      },
    }),
    h('span', { className: 'preview-page-count' }, `/ ${count}`),
    h('button', { type: 'button', 'aria-label': tPreview('document.nextPage'), disabled: current + perRow > count, onClick: () => { goTo(current + perRow); } }, '›'),
  );
}

/** Bottom strip of PDF / PPT / PPTX / DOC / DOCX: page navigation on the left, zoom on the right. */
export function DocumentStatusBar({ pages, ...zoom }: ZoomControlsProps & { pages: DocumentPages | null }): React.ReactElement {
  return h('div', { className: 'preview-statusbar preview-document-statusbar' },
    pages ? h(PageControls, pages) : null,
    h(ZoomControls, { ...zoom, percent: clampZoom(zoom.percent) }),
  );
}

export function scrollParent(page: Element, root: HTMLElement): HTMLElement | null {
  for (let element = page.parentElement; element; element = element.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(element).overflowY)) return element;
    if (element === root) break;
  }
  return null;
}

/**
 * Page elements (`selector`) rendered under `root`: the row of pages at the upper third of their
 * scroller holds the current page (its first page), and `goTo` scrolls a page to the top. Viewers
 * only name their page elements.
 */
export function useDocumentPages(rootRef: React.RefObject<HTMLElement | null>, selector: string | null): DocumentPages | null {
  const [state, setState] = React.useState<{ current: number; count: number; perRow: number } | null>(null);
  React.useEffect(() => {
    const root = rootRef.current;
    setState(null);
    if (!root || !selector) return undefined;
    let scroller: HTMLElement | null = null;
    let frame = 0;
    const schedule = (): void => { if (!frame) frame = requestAnimationFrame(measure); };
    function measure(): void {
      frame = 0;
      const pages = root!.querySelectorAll(selector!);
      const next = pages.length ? scrollParent(pages[0], root!) : null;
      if (next !== scroller) {
        scroller?.removeEventListener('scroll', schedule);
        next?.addEventListener('scroll', schedule, { passive: true });
        scroller = next;
      }
      if (!scroller) {
        setState(null);
        return;
      }
      const tops = Array.from(pages, (page) => page.getBoundingClientRect().top);
      const rowStart = (index: number): number => {
        while (index > 0 && Math.abs(tops[index - 1] - tops[index]) < 1) index--;
        return index;
      };
      let last = 0;
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) last = tops.length - 1;
      else {
        const line = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
        tops.forEach((top, index) => { if (top <= line) last = index; });
      }
      const current = rowStart(last) + 1;
      const count = pages.length;
      let perRow = 1;
      while (perRow < count && Math.abs(tops[perRow] - tops[0]) < 1) perRow++;
      setState((previous) => (previous?.current === current && previous.count === count && previous.perRow === perRow ? previous : { current, count, perRow }));
    }
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    schedule();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      scroller?.removeEventListener('scroll', schedule);
    };
  }, [rootRef, selector]);
  const goTo = React.useCallback((page: number) => {
    const root = rootRef.current;
    const target = selector ? root?.querySelectorAll(selector)[page - 1] : undefined;
    const scroller = target && root ? scrollParent(target, root) : null;
    if (!target || !scroller) return;
    scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }, [rootRef, selector]);
  return state ? { ...state, goTo } : null;
}
