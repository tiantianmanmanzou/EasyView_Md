import { RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension, type Range, type RangeSet } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutter, type DecorationSet, WidgetType } from '@codemirror/view';
import {
  applyHunkToContent,
  computeGitDiff,
  computeHunkInlineHighlights,
  findMatchingHunk,
  revertHunkInContent,
  type GitDiffHunk,
  type InlineRange,
} from '@easyview/markdown-core/git-diff';
import { createSourceEditor } from '../editor/SourceEditor';

export interface ChangeViewVisibleAnchor {
  line: number;
  offsetFromTop: number;
}

export interface ChangeViewControllerDeps {
  scrollArea: HTMLElement;
  editorElement: HTMLElement;
  currentContent: () => string;
  setContent: (content: string) => void;
  getBaseContent: () => string;
  postEdit: (content: string) => void;
  stageHunk: (content: string) => void;
  onStateChange: (active: boolean) => void;
  getVisibleSourceAnchor: () => ChangeViewVisibleAnchor;
  revealSourceAnchor: (anchor: ChangeViewVisibleAnchor) => void;
}

type HunkIdentity = Pick<GitDiffHunk, 'oldStart' | 'newStart' | 'kind'>;

const setBase = StateEffect.define<string>();

class RemovedLines extends WidgetType {
  constructor(
    private readonly lines: string[],
    private readonly identity: HunkIdentity,
    private readonly removedRanges: InlineRange[][] = [],
  ) { super(); }
  eq(other: RemovedLines): boolean {
    return this.lines.join('\n') === other.lines.join('\n')
      && this.identity.oldStart === other.identity.oldStart
      && this.identity.newStart === other.identity.newStart
      && this.identity.kind === other.identity.kind
      && JSON.stringify(this.removedRanges) === JSON.stringify(other.removedRanges);
  }
  toDOM(): HTMLElement {
    const pre = document.createElement('pre');
    pre.className = 'easyview-change-deletion';
    pre.dataset.oldStart = String(this.identity.oldStart);
    pre.dataset.newStart = String(this.identity.newStart);
    pre.dataset.kind = this.identity.kind;
    for (const [index, line] of this.lines.entries()) {
      const row = document.createElement('div');
      row.className = 'easyview-change-deletion-line';
      const marker = document.createElement('span');
      marker.className = 'easyview-change-deletion-marker';
      marker.setAttribute('aria-hidden', 'true');
      marker.textContent = '−';
      const text = document.createElement('span');
      text.className = 'easyview-change-deletion-text';
      const displayed = displayedOldLine(line);
      appendHighlightedText(text, displayed.text, shiftRanges(this.removedRanges[index] ?? [], displayed.shift, displayed.text.length), 'easyview-change-text-removed');
      row.append(marker, text);
      pre.append(row);
    }
    return pre;
  }
  ignoreEvent(): boolean { return false; }
}

class ChangeKindMarker extends GutterMarker {
  constructor(readonly kind: 'added' | 'modified') { super(); }
  eq(other: ChangeKindMarker): boolean { return other.kind === this.kind; }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = `easyview-change-kind-bar easyview-change-kind-bar-${this.kind}`;
    el.setAttribute('aria-hidden', 'true');
    return el;
  }
}

function createHunkActions(hunk: GitDiffHunk): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'easyview-change-hunk-actions';
  wrap.dataset.oldStart = String(hunk.oldStart);
  wrap.dataset.newStart = String(hunk.newStart);
  wrap.dataset.kind = hunk.kind;

  const revertBtn = document.createElement('button');
  revertBtn.type = 'button';
  revertBtn.className = 'easyview-change-hunk-action';
  revertBtn.dataset.hunkAction = 'revert';
  revertBtn.title = 'Revert Block';
  revertBtn.setAttribute('aria-label', 'Revert Block');
  revertBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>';

  const stageBtn = document.createElement('button');
  stageBtn.type = 'button';
  stageBtn.className = 'easyview-change-hunk-action';
  stageBtn.dataset.hunkAction = 'stage';
  stageBtn.title = 'Stage Block';
  stageBtn.setAttribute('aria-label', 'Stage Block');
  stageBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>';

  wrap.append(revertBtn, stageBtn);
  return wrap;
}

const HEADING_NUMBERING_RE = /^((?:[（(]\d+[）)]|\d+(?:\.\d+)+(?:[.)、．])?|\d+[.)、．]|[一二三四五六七八九十百千]+、))(\s+)/;
const ATX_HEADING_RE = /^( {0,3})(#{1,6})(?:[ \t]+(.+?))?(?:[ \t]+#+\s*)?$/;
const SCROLLBAR_PROXIMITY_PX = 48;
const SCROLLBAR_COLLAPSE_MS = 200;
const SCROLLBAR_IDLE_WIDTH_PX = 10;
const HOST_HEADING_MARGIN = 40;

function stripHeadingNumbering(text: string): string {
  return text.replace(HEADING_NUMBERING_RE, '').trim();
}

function displayedOldLine(line: string): { text: string; shift: number } {
  const match = /^(\s{0,3})#{1,6}[ \t]+/.exec(line);
  if (!match) return { text: line, shift: 0 };
  return { text: `${match[1]}${line.slice(match[0].length)}`, shift: match[0].length - match[1].length };
}

function shiftRanges(ranges: readonly InlineRange[], shift: number, length: number): InlineRange[] {
  return ranges
    .map((range) => ({
      from: Math.max(0, range.from - shift),
      to: Math.max(0, range.to - shift),
    }))
    .filter((range) => range.to > range.from && range.from < length)
    .map((range) => ({
      from: Math.min(length, range.from),
      to: Math.min(length, range.to),
    }));
}

function appendHighlightedText(parent: HTMLElement, text: string, ranges: readonly InlineRange[], className: string): void {
  const marks = [...ranges].filter((range) => range.to > range.from).sort((left, right) => left.from - right.from);
  if (marks.length === 0) {
    parent.textContent = text;
    return;
  }
  let cursor = 0;
  for (const range of marks) {
    const from = Math.max(cursor, Math.min(text.length, range.from));
    const to = Math.max(from, Math.min(text.length, range.to));
    if (from > cursor) parent.append(text.slice(cursor, from));
    if (to > from) {
      const span = document.createElement('span');
      span.className = className;
      span.textContent = text.slice(from, to);
      parent.append(span);
    }
    cursor = Math.max(cursor, to);
  }
  if (cursor < text.length) parent.append(text.slice(cursor));
}

function parseAtxHeading(line: string): { level: number; body: string } | null {
  const match = ATX_HEADING_RE.exec(line);
  if (!match || !match[3]) return null;
  return { level: match[2].length, body: match[3].trim() };
}

function findHeadingLine(content: string, level: number, text: string): number {
  const lines = content.split('\n');
  const wanted = text.trim();
  const wantedBare = stripHeadingNumbering(wanted);
  for (let index = 0; index < lines.length; index++) {
    const parsed = parseAtxHeading(lines[index]);
    if (!parsed || parsed.level !== level) continue;
    const bodyBare = stripHeadingNumbering(parsed.body);
    if (parsed.body === wanted || bodyBare === wantedBare || parsed.body.endsWith(wanted) || wanted.endsWith(parsed.body)) {
      return index + 1;
    }
  }
  return -1;
}

function decorations(state: EditorState, base: string): { marks: DecorationSet; gutters: RangeSet<GutterMarker> } {
  const changes: Range<Decoration>[] = [];
  const gutters = new RangeSetBuilder<GutterMarker>();
  let fencedCodeMarker: '`' | '~' | null = null;
  // Block widgets show deleted source immediately above the corresponding editable line.
  for (const hunk of computeGitDiff(base, state.doc.toString()).hunks) {
    const identity: HunkIdentity = { oldStart: hunk.oldStart, newStart: hunk.newStart, kind: hunk.kind };
    const at = state.doc.line(Math.max(1, Math.min(state.doc.lines, hunk.newStart))).from;
    const inline = hunk.oldLines.length && hunk.newLines.length
      ? computeHunkInlineHighlights(hunk.oldLines, hunk.newLines)
      : { old: hunk.oldLines.map((): InlineRange[] => []), new: hunk.newLines.map((): InlineRange[] => []) };
    if (hunk.oldLines.length) {
      changes.push(Decoration.widget({ widget: new RemovedLines(hunk.oldLines, identity, inline.old), block: true, side: -1 }).range(at));
    }
    const kindMarker = hunk.newLines.length
      ? new ChangeKindMarker(hunk.kind === 'added' ? 'added' : 'modified')
      : null;
    for (let line = hunk.newStart; line < hunk.newStart + hunk.newLines.length; line++) {
      if (line > state.doc.lines) break;
      const docLine = state.doc.line(line);
      const from = docLine.from;
      if (kindMarker) gutters.add(from, from, kindMarker);
      changes.push(Decoration.line({
        class: `${hunk.kind === 'added' ? 'easyview-change-added' : 'easyview-change-modified'} easyview-change-hunk-target`,
        attributes: {
          'data-old-start': String(hunk.oldStart),
          'data-new-start': String(hunk.newStart),
          'data-kind': hunk.kind,
        },
      }).range(from));
      if (hunk.kind !== 'modified' || !hunk.oldLines.length) continue;
      for (const range of inline.new[line - hunk.newStart] ?? []) {
        const markFrom = from + range.from;
        const markTo = from + range.to;
        if (markFrom < markTo && markTo <= docLine.to) {
          changes.push(Decoration.mark({ class: 'easyview-change-text-added' }).range(markFrom, markTo));
        }
      }
    }
  }
  // Keep Markdown source editable; style only heading text after the ATX marker.
  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber++) {
    const line = state.doc.line(lineNumber);
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line.text);
    if (fence) {
      const marker = fence[1][0] as '`' | '~';
      if (fencedCodeMarker === null || fencedCodeMarker === marker) {
        changes.push(Decoration.line({ class: 'easyview-change-code-line' }).range(line.from));
        fencedCodeMarker = fencedCodeMarker === null ? marker : null;
        continue;
      }
    } else if (fencedCodeMarker !== null) {
      changes.push(Decoration.line({ class: 'easyview-change-code-line' }).range(line.from));
      continue;
    }
    const heading = /^( {0,3})(#{1,6})[ \t]+(.+)$/.exec(line.text);
    if (!heading) continue;
    const textStart = line.to - heading[3].length;
    const prefixEnd = textStart;
    changes.push(Decoration.mark({ class: 'easyview-change-heading-prefix' }).range(line.from + heading[1].length, prefixEnd));
    const numbering = HEADING_NUMBERING_RE.exec(heading[3]);
    if (numbering) {
      const numberingEnd = textStart + numbering[1].length;
      changes.push(Decoration.mark({ class: 'easyview-change-numbering' }).range(textStart, numberingEnd));
      const titleStart = textStart + numbering[0].length;
      if (titleStart < line.to) {
        changes.push(Decoration.mark({ class: `easyview-change-heading-text easyview-change-heading-${heading[2].length}` }).range(titleStart, line.to));
      }
    } else {
      changes.push(Decoration.mark({ class: `easyview-change-heading-text easyview-change-heading-${heading[2].length}` }).range(textStart, line.to));
    }
  }
  return { marks: Decoration.set(changes, true), gutters: gutters.finish() };
}

function changeViewExtensions(initialBase: string): Extension {
  const field = StateField.define<{ base: string; marks: DecorationSet; gutters: RangeSet<GutterMarker> }>({
    create(state) { return { base: initialBase, ...decorations(state, initialBase) }; },
    update(value, tr) {
      const base = tr.effects.find((effect) => effect.is(setBase))?.value ?? value.base;
      return tr.docChanged || base !== value.base ? { base, ...decorations(tr.state, base) } : value;
    },
    provide: (stateField) => [
      EditorView.decorations.from(stateField, (value) => value.marks),
      gutter({
        class: 'easyview-change-kind-gutter',
        markers: (view) => view.state.field(stateField).gutters,
      }),
    ],
  });
  return field;
}

/** Inline, raw Markdown comparison. The only editable document is the new/current source. */
export class ChangeViewController {
  private container: HTMLElement | null = null;
  private sourceEditor: ReturnType<typeof createSourceEditor> | null = null;
  private sourceContainer: HTMLElement | null = null;
  private overview: HTMLElement | null = null;
  private scrollbar: HTMLElement | null = null;
  private scrollbarThumb: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private draggingScrollbar = false;
  private dragOffset = 0;
  private collapseTimer: ReturnType<typeof setTimeout> | null = null;
  private previousSourceDisplay = '';
  private previousEditorDisplay = '';
  private hunkActions: HTMLElement | null = null;
  private activeHunk: HunkIdentity | null = null;
  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.altKey && !event.ctrlKey && !event.metaKey && (event.code === 'KeyZ' || event.key.toLowerCase() === 'z')) {
      event.preventDefault();
      event.stopPropagation();
      this.sourceEditor?.toggleLineWrapping();
    }
  };
  private readonly handleHunkActionClick = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !this.sourceEditor) return;

    const button = target.closest<HTMLElement>('[data-hunk-action]');
    const wrap = button?.closest<HTMLElement>('.easyview-change-hunk-actions');
    if (button && wrap) {
      event.preventDefault();
      event.stopPropagation();
      const oldStart = Number(wrap.dataset.oldStart);
      const newStart = Number(wrap.dataset.newStart);
      const kind = wrap.dataset.kind as GitDiffHunk['kind'] | undefined;
      if (!Number.isFinite(oldStart) || !Number.isFinite(newStart) || !kind) return;
      if (button.dataset.hunkAction === 'revert') this.revertHunk({ oldStart, newStart, kind });
      if (button.dataset.hunkAction === 'stage') this.stageHunk({ oldStart, newStart, kind });
      return;
    }

    const hunkTarget = target.closest<HTMLElement>('.easyview-change-hunk-target, .easyview-change-deletion');
    if (hunkTarget) {
      const identity = this.identityFromElement(hunkTarget);
      if (identity) {
        this.setActiveHunk(identity);
        return;
      }
    }

    if (!target.closest('.easyview-change-hunk-actions')) this.setActiveHunk(null);
  };
  private readonly handleHostScroll = (): void => {
    this.layoutScrollbar();
    this.positionHunkActions();
  };
  private readonly handleThumbPointerMove = (event: PointerEvent): void => this.moveThumb(event.clientY);
  private readonly handleThumbPointerUp = (event: PointerEvent): void => {
    this.draggingScrollbar = false;
    this.scrollbarThumb?.removeEventListener('pointermove', this.handleThumbPointerMove);
    this.scrollbarThumb?.removeEventListener('pointerup', this.handleThumbPointerUp);
    this.scrollbarThumb?.removeEventListener('pointercancel', this.handleThumbPointerUp);
    try { this.scrollbarThumb?.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    this.setScrollbarExpanded(this.isPointerNearScrollbar(event.clientX));
  };
  private readonly handleHostPointerMove = (event: PointerEvent): void => {
    this.setScrollbarExpanded(this.draggingScrollbar || this.isPointerNearScrollbar(event.clientX));
  };
  private readonly handleHostPointerLeave = (event: PointerEvent): void => {
    if (this.draggingScrollbar) return;
    const next = event.relatedTarget;
    if (next instanceof Node && this.scrollbar?.contains(next)) return;
    this.setScrollbarExpanded(false);
  };
  private readonly handleRailPointerEnter = (): void => {
    this.setScrollbarExpanded(true);
  };
  private readonly handleRailPointerLeave = (event: PointerEvent): void => {
    if (this.draggingScrollbar) return;
    const next = event.relatedTarget;
    if (next instanceof Node && this.deps.scrollArea.contains(next)) return;
    this.setScrollbarExpanded(false);
  };
  private readonly handleRailWheel = (event: WheelEvent): void => {
    const host = this.deps.scrollArea;
    event.preventDefault();
    const line = 16;
    const scaleY = event.deltaMode === 1 ? line : event.deltaMode === 2 ? Math.max(1, host.clientHeight) : 1;
    const scaleX = event.deltaMode === 1 ? line : event.deltaMode === 2 ? Math.max(1, host.clientWidth) : 1;
    host.scrollTop += event.deltaY * scaleY;
    host.scrollLeft += event.deltaX * scaleX;
    this.layoutScrollbar();
  };

  constructor(private readonly deps: ChangeViewControllerDeps) {}
  isActive(): boolean { return this.container !== null; }
  toggle(): void { if (this.isActive()) this.close(); else this.open(); }

  open(): void {
    if (this.isActive()) return;
    const { scrollArea, editorElement } = this.deps;
    const anchor = this.deps.getVisibleSourceAnchor();
    this.previousEditorDisplay = editorElement.style.display;
    this.sourceContainer = scrollArea.querySelector<HTMLElement>('#source-editor');
    if (this.sourceContainer) {
      this.previousSourceDisplay = this.sourceContainer.style.display;
      this.sourceContainer.style.display = 'none';
    }
    editorElement.style.display = 'none';
    const container = document.createElement('div');
    container.className = 'easyview-change-view';
    scrollArea.appendChild(container);
    scrollArea.classList.add('easyview-change-scroll-host');
    this.container = container;
    container.addEventListener('keydown', this.handleKeyDown, true);
    container.addEventListener('click', this.handleHunkActionClick);
    this.mountScrollbar(scrollArea);
    this.sourceEditor = createSourceEditor({
      parent: container,
      visualMode: 'changeViewMarkdown',
      extraExtensions: [changeViewExtensions(this.deps.getBaseContent())],
      enableWordWrapToggle: true,
      lineWrapping: false,
      onChange: (content) => {
        this.deps.setContent(content);
        this.deps.postEdit(content);
        this.renderOverview();
        this.layoutScrollbar();
        this.syncHunkActions();
      },
    });
    this.sourceEditor.setContent(this.deps.currentContent());
    this.renderOverview();
    this.restoreChangeViewAnchor(anchor);
    this.sourceEditor.view.contentDOM.focus({ preventScroll: true });
    const gutters = this.sourceEditor.view.dom.querySelector('.cm-gutters');
    if (gutters && this.resizeObserver) this.resizeObserver.observe(gutters);
    this.layoutScrollbar();
    this.deps.onStateChange(true);
    requestAnimationFrame(() => {
      this.syncGutterWidth();
      this.restoreChangeViewAnchor(anchor);
    });
  }

  scrollToLine(line: number): void {
    this.scrollHostToLine(line, 'smooth');
  }

  revealHeading(level: number, text: string): void {
    const line = this.findHeadingLine(level, text);
    if (line < 0) return;
    this.scrollHostToLine(line, 'smooth');
  }

  getActiveHeadingPos(headings: Array<{ level: number; text: string; pos: number }>): number {
    let activePos = -1;
    for (const heading of headings) {
      const line = this.findHeadingLine(heading.level, heading.text);
      if (line < 0) continue;
      const offset = this.getLineTopInHost(line);
      if (offset === -1) continue;
      if (offset > HOST_HEADING_MARGIN) break;
      activePos = heading.pos;
    }
    return activePos;
  }

  setBaseContent(base: string): void {
    this.sourceEditor?.view.dispatch({ effects: setBase.of(base) });
    this.renderOverview();
  }

  setContent(content: string): void {
    if (this.sourceEditor && this.sourceEditor.getContent() !== content) { this.sourceEditor.setContent(content); this.renderOverview(); }
  }

  private identityFromElement(el: HTMLElement): HunkIdentity | null {
    const oldStart = Number(el.dataset.oldStart);
    const newStart = Number(el.dataset.newStart);
    const kind = el.dataset.kind as GitDiffHunk['kind'] | undefined;
    if (!Number.isFinite(oldStart) || !Number.isFinite(newStart) || !kind) return null;
    return { oldStart, newStart, kind };
  }

  private resolveHunk(identity: Pick<GitDiffHunk, 'oldStart' | 'newStart' | 'kind'>): GitDiffHunk | undefined {
    const content = this.sourceEditor?.getContent() ?? this.deps.currentContent();
    return findMatchingHunk(computeGitDiff(this.deps.getBaseContent(), content).hunks, identity);
  }

  private revertHunk(identity: Pick<GitDiffHunk, 'oldStart' | 'newStart' | 'kind'>): void {
    const hunk = this.resolveHunk(identity);
    if (!hunk || !this.sourceEditor) return;
    const next = revertHunkInContent(this.sourceEditor.getContent(), hunk);
    this.sourceEditor.setContent(next, { addToHistory: true });
    this.deps.setContent(next);
    this.deps.postEdit(next);
    this.setActiveHunk(null);
    this.renderOverview();
    this.layoutScrollbar();
  }

  private stageHunk(identity: Pick<GitDiffHunk, 'oldStart' | 'newStart' | 'kind'>): void {
    const hunk = this.resolveHunk(identity);
    if (!hunk) return;
    this.deps.stageHunk(applyHunkToContent(this.deps.getBaseContent(), hunk));
  }

  close(): void {
    if (!this.container) return;
    const anchor = this.getChangeViewAnchor();
    const content = this.sourceEditor?.getContent() ?? this.deps.currentContent();
    this.sourceEditor?.destroy();
    this.sourceEditor = null;
    this.container.removeEventListener('keydown', this.handleKeyDown, true);
    this.container.removeEventListener('click', this.handleHunkActionClick);
    this.setActiveHunk(null);
    this.container.remove();
    this.container = null;
    this.unmountScrollbar();
    this.overview = null;
    this.deps.scrollArea.classList.remove('easyview-change-scroll-host');
    this.deps.editorElement.style.display = this.previousEditorDisplay;
    if (this.sourceContainer) this.sourceContainer.style.display = this.previousSourceDisplay;
    this.sourceContainer = null;
    this.deps.setContent(content);
    this.deps.revealSourceAnchor(anchor);
    this.deps.onStateChange(false);
    requestAnimationFrame(() => this.deps.revealSourceAnchor(anchor));
  }

  dispose(): void { this.close(); }

  private mountScrollbar(scrollArea: HTMLElement): void {
    const rail = document.createElement('div');
    rail.className = 'easyview-change-scrollbar';
    const overview = document.createElement('div');
    overview.className = 'easyview-change-overview';
    const thumb = document.createElement('div');
    thumb.className = 'easyview-change-scrollbar-thumb';
    rail.append(overview, thumb);
    /* Keep the rail outside the 2D scrollport. A child of #editor-scroll-area
       is translated with overflow content, which is what put the overlay in
       the middle of wide tables. Fixed + host getBoundingClientRect() pins it
       to the visible right edge of the editor pane. */
    document.body.appendChild(rail);
    this.scrollbar = rail;
    this.overview = overview;
    this.scrollbarThumb = thumb;
    scrollArea.addEventListener('scroll', this.handleHostScroll, { passive: true });
    scrollArea.addEventListener('pointermove', this.handleHostPointerMove, { passive: true });
    scrollArea.addEventListener('pointerleave', this.handleHostPointerLeave);
    rail.addEventListener('pointerenter', this.handleRailPointerEnter);
    rail.addEventListener('pointerleave', this.handleRailPointerLeave);
    rail.addEventListener('wheel', this.handleRailWheel, { passive: false });
    rail.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      this.setScrollbarExpanded(true);
      this.jumpThumb(event.clientY);
    });
    thumb.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      this.draggingScrollbar = true;
      this.setScrollbarExpanded(true);
      this.dragOffset = event.clientY - thumb.getBoundingClientRect().top;
      thumb.setPointerCapture(event.pointerId);
      thumb.addEventListener('pointermove', this.handleThumbPointerMove);
      thumb.addEventListener('pointerup', this.handleThumbPointerUp);
      thumb.addEventListener('pointercancel', this.handleThumbPointerUp);
    });
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => this.layoutScrollbar());
      this.resizeObserver.observe(scrollArea);
    }
    window.addEventListener('resize', this.handleHostScroll);
  }

  private unmountScrollbar(): void {
    this.deps.scrollArea.removeEventListener('scroll', this.handleHostScroll);
    this.deps.scrollArea.removeEventListener('pointermove', this.handleHostPointerMove);
    this.deps.scrollArea.removeEventListener('pointerleave', this.handleHostPointerLeave);
    this.scrollbar?.removeEventListener('pointerenter', this.handleRailPointerEnter);
    this.scrollbar?.removeEventListener('pointerleave', this.handleRailPointerLeave);
    this.scrollbar?.removeEventListener('wheel', this.handleRailWheel);
    window.removeEventListener('resize', this.handleHostScroll);
    if (this.collapseTimer) {
      clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.scrollbar?.remove();
    this.scrollbar = null;
    this.scrollbarThumb = null;
    this.draggingScrollbar = false;
  }

  private isPointerNearScrollbar(clientX: number): boolean {
    const rect = this.deps.scrollArea.getBoundingClientRect();
    return clientX >= rect.right - SCROLLBAR_PROXIMITY_PX && clientX <= rect.right + SCROLLBAR_IDLE_WIDTH_PX;
  }

  private setScrollbarExpanded(expanded: boolean): void {
    const rail = this.scrollbar;
    if (!rail) return;
    if (expanded) {
      if (this.collapseTimer) {
        clearTimeout(this.collapseTimer);
        this.collapseTimer = null;
      }
      rail.classList.add('is-expanded');
      return;
    }
    if (this.draggingScrollbar || this.collapseTimer || !rail.classList.contains('is-expanded')) return;
    this.collapseTimer = setTimeout(() => {
      this.scrollbar?.classList.remove('is-expanded');
      this.collapseTimer = null;
    }, SCROLLBAR_COLLAPSE_MS);
  }

  private jumpThumb(clientY: number): void {
    const host = this.deps.scrollArea;
    const rail = this.scrollbar;
    const thumb = this.scrollbarThumb;
    if (!rail || !thumb) return;
    const visible = host.clientHeight;
    const total = host.scrollHeight;
    if (total <= visible) return;
    const thumbH = thumb.offsetHeight || 20;
    const y = clientY - rail.getBoundingClientRect().top - thumbH / 2;
    const maxTop = Math.max(1, visible - thumbH);
    host.scrollTop = (y / maxTop) * (total - visible);
    this.layoutScrollbar();
  }

  private moveThumb(clientY: number): void {
    if (!this.draggingScrollbar) return;
    const host = this.deps.scrollArea;
    const rail = this.scrollbar;
    const thumb = this.scrollbarThumb;
    if (!rail || !thumb) return;
    const visible = host.clientHeight;
    const total = host.scrollHeight;
    if (total <= visible) return;
    const thumbH = thumb.offsetHeight || 20;
    const y = clientY - rail.getBoundingClientRect().top - this.dragOffset;
    const maxTop = Math.max(1, visible - thumbH);
    host.scrollTop = (Math.min(maxTop, Math.max(0, y)) / maxTop) * (total - visible);
    this.layoutScrollbar();
  }

  private layoutScrollbar(): void {
    const host = this.deps.scrollArea;
    const rail = this.scrollbar;
    const thumb = this.scrollbarThumb;
    if (!rail || !thumb) return;
    const visible = Math.max(1, host.clientHeight);
    const total = Math.max(visible, host.scrollHeight);
    const rect = host.getBoundingClientRect();
    rail.style.position = 'fixed';
    rail.style.top = `${rect.top}px`;
    rail.style.left = 'auto';
    rail.style.right = `${Math.max(0, window.innerWidth - rect.right)}px`;
    rail.style.width = '';
    rail.style.height = `${rect.height}px`;
    rail.style.transform = '';
    if (total <= visible + 1) {
      thumb.style.display = 'none';
      this.syncGutterWidth();
      this.positionHunkActions();
      return;
    }
    thumb.style.display = '';
    const thumbH = Math.max(20, (visible / total) * visible);
    const maxTop = Math.max(0, visible - thumbH);
    const thumbTop = ((host.scrollTop) / (total - visible)) * maxTop;
    thumb.style.height = `${thumbH}px`;
    thumb.style.transform = `translateY(${Number.isFinite(thumbTop) ? thumbTop : 0}px)`;
    this.syncGutterWidth();
    this.positionHunkActions();
  }

  private syncGutterWidth(): void {
    const host = this.container;
    const gutters = this.sourceEditor?.view.dom.querySelector('.cm-gutters') as HTMLElement | null;
    if (!host || !gutters) return;
    const width = Math.max(0, Math.round(gutters.getBoundingClientRect().width || gutters.offsetWidth || 0));
    if (width > 0) host.style.setProperty('--easyview-change-gutter-width', `${width}px`);
  }

  private setActiveHunk(identity: HunkIdentity | null): void {
    this.activeHunk = identity;
    this.syncHunkActions();
  }

  private syncHunkActions(): void {
    const hunk = this.activeHunk ? this.resolveHunk(this.activeHunk) : undefined;
    if (!hunk || !this.container) {
      this.hunkActions?.remove();
      this.hunkActions = null;
      if (!hunk) this.activeHunk = null;
      return;
    }
    if (!this.hunkActions) {
      this.hunkActions = createHunkActions(hunk);
      this.container.appendChild(this.hunkActions);
    } else {
      this.hunkActions.dataset.oldStart = String(hunk.oldStart);
      this.hunkActions.dataset.newStart = String(hunk.newStart);
      this.hunkActions.dataset.kind = hunk.kind;
    }
    this.positionHunkActions();
  }

  private positionHunkActions(): void {
    const wrap = this.hunkActions;
    const view = this.sourceEditor?.view;
    const hunk = this.activeHunk ? this.resolveHunk(this.activeHunk) : undefined;
    if (!wrap || !view || !hunk) return;

    const hostRect = this.deps.scrollArea.getBoundingClientRect();
    const gutters = view.dom.querySelector('.cm-gutters');
    const gutterRect = gutters?.getBoundingClientRect();
    const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, hunk.newStart)));
    let top: number | null = null;
    const deletion = view.dom.querySelector<HTMLElement>(
      `.easyview-change-deletion[data-old-start="${hunk.oldStart}"][data-new-start="${hunk.newStart}"]`,
    );
    if (deletion) {
      const rect = deletion.getBoundingClientRect();
      if (rect.height) top = rect.top;
    }
    if (top === null) {
      try {
        const coords = view.coordsAtPos(line.from);
        if (coords) top = coords.top;
      } catch { /* jsdom may not implement client rects */ }
    }
    if (top === null) {
      try {
        const block = view.lineBlockAt(line.from);
        top = view.dom.getBoundingClientRect().top + block.top - this.deps.scrollArea.scrollTop;
      } catch {
        top = hostRect.top;
      }
    }

    const width = wrap.offsetWidth || 24;
    const gutterLeft = gutterRect?.left ?? view.dom.getBoundingClientRect().left;
    wrap.style.top = `${top}px`;
    wrap.style.left = `${Math.max(hostRect.left, gutterLeft - width - 2)}px`;
    const visible = top >= hostRect.top - 8 && top <= hostRect.bottom - 8;
    wrap.style.visibility = visible ? 'visible' : 'hidden';
  }

  private getChangeViewAnchor(): ChangeViewVisibleAnchor {
    const source = this.sourceEditor;
    const host = this.deps.scrollArea;
    if (!source) return { line: 1, offsetFromTop: 0 };
    const hostTop = host.getBoundingClientRect().top;
    const doc = source.view.state.doc;
    for (let line = 1; line <= doc.lines; line++) {
      try {
        const coords = source.view.coordsAtPos(doc.line(line).from);
        if (coords && coords.bottom > hostTop + 4) {
          return { line, offsetFromTop: Math.max(0, coords.top - hostTop) };
        }
      } catch { break; }
    }
    try {
      const block = source.view.lineBlockAtHeight(Math.max(0, host.scrollTop));
      return { line: doc.lineAt(block.from).number, offsetFromTop: 0 };
    } catch {
      return { line: 1, offsetFromTop: 0 };
    }
  }

  private restoreChangeViewAnchor(anchor: ChangeViewVisibleAnchor): void {
    this.scrollHostToLine(anchor.line, 'auto', anchor.offsetFromTop);
  }

  private findHeadingLine(level: number, text: string): number {
    const source = this.sourceEditor;
    if (!source) return -1;
    return findHeadingLine(source.getContent(), level, text);
  }

  private getLineTopInHost(line: number): number {
    const source = this.sourceEditor;
    if (!source) return -1;
    const docLine = source.view.state.doc.line(Math.min(Math.max(1, line), source.view.state.doc.lines));
    try {
      const coords = source.view.coordsAtPos(docLine.from);
      if (coords) return coords.top - this.deps.scrollArea.getBoundingClientRect().top;
    } catch { /* jsdom may not implement client rects */ }
    try {
      return source.view.lineBlockAt(docLine.from).top - this.deps.scrollArea.scrollTop;
    } catch {
      return -1;
    }
  }

  private scrollHostToLine(line: number, behavior: ScrollBehavior = 'smooth', yMargin = HOST_HEADING_MARGIN): void {
    const source = this.sourceEditor;
    if (!source) return;
    const docLine = source.view.state.doc.line(Math.min(Math.max(1, line), source.view.state.doc.lines));
    if (behavior !== 'auto') source.view.dispatch({ selection: { anchor: docLine.from } });
    const host = this.deps.scrollArea;
    let nextTop: number | null = null;
    try {
      const coords = source.view.coordsAtPos(docLine.from);
      if (coords) nextTop = host.scrollTop + (coords.top - host.getBoundingClientRect().top) - yMargin;
    } catch { /* jsdom may not implement client rects */ }
    if (nextTop === null) {
      try {
        nextTop = source.view.lineBlockAt(docLine.from).top - yMargin;
      } catch {
        return;
      }
    }
    if (typeof host.scrollTo === 'function') host.scrollTo({ top: Math.max(0, nextTop), behavior });
    else host.scrollTop = Math.max(0, nextTop);
  }

  private renderOverview(): void {
    if (!this.overview || !this.sourceEditor) return;
    const content = this.sourceEditor.getContent();
    const totalLines = Math.max(1, content.split('\n').length);
    this.overview.replaceChildren();
    for (const hunk of computeGitDiff(this.deps.getBaseContent(), content).hunks) {
      const startLine = Math.max(1, hunk.newStart);
      const lineCount = Math.max(1, hunk.kind === 'removed' ? 1 : hunk.newLines.length);
      const top = Math.min(99, ((startLine - 1) / totalLines) * 100);
      const height = Math.max((lineCount / totalLines) * 100, 0.35);
      if (hunk.kind === 'removed' || hunk.kind === 'modified') {
        this.overview.appendChild(this.overviewTick('deleted', top, height));
      }
      if (hunk.kind === 'added' || hunk.kind === 'modified') {
        this.overview.appendChild(this.overviewTick('added', top, height));
      }
    }
  }

  private overviewTick(kind: 'added' | 'deleted', top: number, height: number): HTMLSpanElement {
    const marker = document.createElement('span');
    marker.className = kind;
    marker.style.top = `${top}%`;
    marker.style.height = `${height}%`;
    return marker;
  }
}
