import * as React from 'react';
import { tPreview } from '../preview.i18n';
import { scrollParent } from './DocumentStatusBar';

const h = React.createElement;

const TWO_PAGE_VIEW_STORAGE_KEY = 'easyview.preview.twoPageView';

/** Side-by-side pages in PDF / DOC / DOCX: default off; one choice for every document. */
export function readTwoPageView(): boolean {
  try {
    return localStorage.getItem(TWO_PAGE_VIEW_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeTwoPageView(on: boolean): void {
  try {
    localStorage.setItem(TWO_PAGE_VIEW_STORAGE_KEY, on ? '1' : '0');
  } catch {
    // Ignore quota / private-mode failures.
  }
}

/** Toolbar toggle between one page per row and two pages side by side. */
export function TwoPageButton(props: { on: boolean; disabled?: boolean; onToggle: () => void }): React.ReactElement {
  return h('button', {
    type: 'button',
    className: 'preview-chrome-btn preview-chrome-btn--icon preview-two-page-toggle',
    title: tPreview('document.twoPage'),
    'aria-label': tPreview('document.twoPage'),
    'aria-pressed': props.on,
    disabled: props.disabled,
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      props.onToggle();
    },
  }, h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true },
    h('path', {
      d: 'M1.8 3.2h5.4v9.6H1.8V3.2ZM8.8 3.2h5.4v9.6H8.8V3.2Z',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinejoin: 'round',
    })));
}

/** Room left beside a row of pages: side margins wide enough for DOCX comment markers, and the gap between the two pages. */
const ROW_GUTTER = 96;

/**
 * Zoom at which the first two pages (`selector`, whose layout boxes are sized for `scale`) fill
 * the width of their scroller side by side; null until they are laid out. Layout widths ignore
 * transforms, so a zoom animating as a CSS transform does not skew the result.
 */
export function twoPageFitScale(root: HTMLElement, selector: string, scale: number): number | null {
  const pages = Array.from(root.querySelectorAll<HTMLElement>(selector)).slice(0, 2);
  const scroller = pages[0] ? scrollParent(pages[0], root) : null;
  if (!scroller || !(scale > 0)) return null;
  const widths = pages.map((page) => page.offsetWidth);
  const row = widths[0] + (widths[1] ?? widths[0]);
  return row > 0 ? (scale * (scroller.clientWidth - ROW_GUTTER)) / row : null;
}
