/**
 * @file-viewer/doc starts a page only at an explicit page or section break and pads every page
 * the same generic way, so a .doc reads as one tall page where Word shows several. This gives each
 * page the document's paper size and margins, then moves what runs past the bottom margin onto
 * following pages: paragraphs split between lines, tables between rows.
 *
 * The renderer's zoom layout only knows the pages it built; added pages copy the transform it
 * gives the first page.
 */
import type { DocPageSetup } from './docFloatingPictures';

/** Sub-pixel slack for blocks that end exactly on the bottom margin. */
const EPSILON = 0.5;

const rootOf = (page: Element): HTMLElement | null => page.querySelector<HTMLElement>(':scope > .msdoc-root');

/** Paper size and margins; `data-doc-page` / `data-doc-grid` switch on Word's paragraph spacing and line boxes (preview.css). */
function applyPageSetup(root: HTMLElement, setup: DocPageSetup): void {
  root.style.width = `${setup.width}px`;
  // A fixed sheet: space after the last paragraph falls off the page as in Word instead of stretching it.
  root.style.height = `${setup.height}px`;
  root.style.minHeight = `${setup.height}px`;
  root.style.padding = `${setup.top}px ${setup.right}px ${setup.bottom}px ${setup.left}px`;
  root.dataset.docPage = '';
  if (setup.linePitch) root.dataset.docGrid = '';
  if (root.ownerDocument.defaultView?.getComputedStyle(root).position === 'static') root.style.position = 'relative';
}

const EAST_ASIAN = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/**
 * Word on a document grid gives every line the fewest whole grid pitches that hold its single-spaced
 * height (about 1.3 × the font size for East Asian fonts, 1.15 for Latin ones) times the spacing
 * multiple. Exact line heights stay; "at least" ones never go below their value.
 * An empty paragraph keeps the renderer's default size, which matches Word's default 10.5pt mark
 * (the parser does not give the mark's own size).
 */
function snapToGrid(root: HTMLElement, pitch: number): void {
  const win = root.ownerDocument.defaultView!;
  const sizeOf = (el: Element): number => Number.parseFloat(win.getComputedStyle(el).fontSize) || 0;
  let single = 1.15;
  for (const paragraph of root.querySelectorAll<HTMLElement>('.msdoc-paragraph')) {
    const fixed = paragraph.style.lineHeight.endsWith('px');
    const atLeast = paragraph.classList.contains('msdoc-line-at-least');
    if (fixed && !atLeast) continue;
    const text = paragraph.textContent ?? '';
    if (text.trim()) single = EAST_ASIAN.test(text) ? 1.3 : 1.15;
    const fontSize = Math.max(sizeOf(paragraph), ...Array.from(paragraph.querySelectorAll('span'), sizeOf));
    const multiple = fixed ? 1 : Number(paragraph.style.lineHeight) || 1;
    const snapped = Math.max(1, Math.ceil((fontSize * single * multiple) / pitch - 0.01)) * pitch;
    paragraph.style.lineHeight = `${atLeast ? Math.max(snapped, Number.parseFloat(paragraph.style.lineHeight)) : snapped}px`;
  }
}

/** Bottom of `el` in `root`'s padding-box coordinates; layout px, unaffected by the zoom transform. */
function bottomWithin(el: HTMLElement, root: HTMLElement): number {
  let top = 0;
  for (let node: HTMLElement | null = el; node && node !== root; node = node.offsetParent as HTMLElement | null) top += node.offsetTop;
  return top + el.offsetHeight;
}

/** Cuts `paragraph` before its first line that ends below `limit`; returns the cut-off lines, or null if none fit. */
function splitParagraph(paragraph: HTMLElement, root: HTMLElement, limit: number): HTMLElement | null {
  const doc = paragraph.ownerDocument;
  const box = paragraph.getBoundingClientRect();
  const scale = paragraph.offsetHeight ? box.height / paragraph.offsetHeight : 1;
  const top = bottomWithin(paragraph, root) - paragraph.offsetHeight;
  const range = doc.createRange();
  const rectAt = (node: Text, offset: number): DOMRect | null => {
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    const rect = range.getBoundingClientRect();
    return rect.height ? rect : null;
  };
  const walker = doc.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
  const characters: Array<{ node: Text; offset: number; rect: DOMRect }> = [];
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    for (let offset = 0; offset < node.data.length; offset++) {
      const rect = rectAt(node, offset);
      if (!rect) continue;
      characters.push({ node, offset, rect });
      if (top + (rect.bottom - box.top) / scale <= limit + EPSILON) continue;
      // First character of a line past the margin: walk back to where that line starts.
      let start = characters.length - 1;
      while (start > 0 && characters[start - 1].rect.bottom > rect.top + 1) start--;
      if (start === 0) return null;
      range.setStart(characters[start].node, characters[start].offset);
      range.setEnd(paragraph, paragraph.childNodes.length);
      const rest = paragraph.cloneNode(false) as HTMLElement;
      rest.append(range.extractContents());
      rest.style.textIndent = '0';
      rest.style.marginTop = '0';
      return rest;
    }
  }
  return null;
}

/** Cuts `table` before its first row that ends below `limit`; returns the cut-off rows, or null if none fit. */
function splitTable(table: HTMLTableElement, root: HTMLElement, limit: number): HTMLTableElement | null {
  const body = table.tBodies[0];
  if (!body) return null;
  const rows = Array.from(body.rows);
  const index = rows.findIndex((row) => bottomWithin(row, root) > limit + EPSILON);
  if (index <= 0) return null;
  const rest = table.cloneNode(false) as HTMLTableElement;
  const restBody = body.cloneNode(false) as HTMLTableSectionElement;
  restBody.append(...rows.slice(index));
  rest.append(restBody);
  return rest;
}

/** Content of `root` that runs past the bottom margin, taken out of `root`; null when it all fits. */
function takeOverflow(root: HTMLElement, setup: DocPageSetup): Node[] | null {
  const limit = setup.height - setup.bottom;
  const blocks = Array.from(root.children).filter((el): el is HTMLElement => el instanceof HTMLElement && el.offsetHeight > 0);
  const index = blocks.findIndex((block) => bottomWithin(block, root) > limit + EPSILON);
  if (index < 0) return null;
  const block = blocks[index];
  const rest = block instanceof HTMLTableElement ? splitTable(block, root, limit)
    : block.matches('p.msdoc-paragraph') ? splitParagraph(block, root, limit) : null;
  const moved: Node[] = rest ? [rest] : index > 0 ? [block] : [];
  // A first block that cannot be split stays and overflows; everything after it still moves on.
  for (let sibling = block.nextSibling; sibling; sibling = sibling.nextSibling) moved.push(sibling);
  if (!moved.length) return null;
  for (const node of moved) node.parentNode?.removeChild(node);
  return moved;
}

/**
 * Applies the zoom the renderer gives `reference` (the first page root) to every page, and sizes the
 * page boxes to their sheets; the renderer pads its own boxes to A4 height whatever the paper.
 */
function followZoom(reference: HTMLElement, pages: readonly HTMLElement[]): () => void {
  const sync = (): void => {
    const transform = reference.style.transform;
    const scale = Number(/scale\(([\d.]+)\)/.exec(transform)?.[1] ?? 1);
    for (const page of pages) {
      const root = rootOf(page);
      if (!root) continue;
      if (root !== reference) root.style.transform = transform;
      page.style.width = `${Math.ceil(Math.max(root.offsetWidth * scale, 120))}px`;
      page.style.height = `${Math.ceil(Math.max(root.scrollHeight, root.offsetHeight) * scale)}px`;
    }
  };
  const observer = new MutationObserver(sync);
  observer.observe(reference, { attributes: true, attributeFilter: ['style'] });
  sync();
  return () => observer.disconnect();
}

/**
 * Lays the .doc pages inside `content` out on `setup` paper and paginates them by height.
 * Returns a function that stops the added pages from following the renderer's zoom.
 */
export function paginateDocPages(content: Element, setup: DocPageSetup): () => void {
  const pages = Array.from(content.querySelectorAll<HTMLElement>('.msdoc-page'));
  const reference = pages[0] && rootOf(pages[0]);
  if (!reference) return () => undefined;
  const all: HTMLElement[] = [];
  for (const page of pages) {
    const root = rootOf(page);
    if (!root) continue;
    applyPageSetup(root, setup);
    if (setup.linePitch) snapToGrid(root, setup.linePitch);
    all.push(page);
    for (let current = page, overflow = takeOverflow(root, setup); overflow;) {
      const next = current.cloneNode(false) as HTMLElement;
      next.removeAttribute('style');
      const nextRoot = rootOf(current)!.cloneNode(false) as HTMLElement;
      nextRoot.append(...overflow);
      next.append(nextRoot);
      current.after(next);
      all.push(next);
      current = next;
      overflow = takeOverflow(nextRoot, setup);
    }
  }
  return followZoom(reference, all);
}
