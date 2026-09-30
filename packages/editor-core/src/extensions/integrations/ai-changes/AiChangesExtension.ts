/**
 * AiChangesExtension
 *
 * Detects external document changes (from AI agents, other editors, etc.) and
 * visualizes them with:
 * 1. Shimmer animation on actively changing blocks
 * 2. Gradient gutter (modified/added) after changes settle
 * 3. Floating indicator during active editing
 * 4. Summary toast with jump-to-changes
 *
 * Works by comparing ProseMirror document snapshots (line-level diff).
 */

import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as ProsemirrorNode, Schema } from 'prosemirror-model';
import { Extension } from '../../../editor/EditorExtension';
import { extractBlockLineMap } from '../../../editor/lib/MarkdownParser';
import type { GitRefreshStatus } from '@easyview/contracts';

// ─── Types ──────────────────────────────────────────────────────────────────

interface BlockFingerprint {
  /** ProseMirror position of the block node */
  pos: number;
  /** Hash of the block content for change detection */
  hash: string;
  /** Node type name */
  type: string;
}

type ChangeKind = 'modified' | 'added';

interface BlockChange {
  pos: number;
  size: number;
  kind: ChangeKind;
  startLine?: number;
  showOverview?: boolean;
  overviewRatios?: number[];
}

export interface GitLineRange {
  startLine: number;
  endLine: number;
  kind: ChangeKind;
}

interface DocumentBlockRange {
  startLine: number;
  endLine: number;
  pos: number;
  size: number;
}

interface DocumentLineBlockIndex {
  totalLines: number;
  blocks: DocumentBlockRange[];
  structureKey: string;
}

interface AiChangesState {
  /** Persistent Git decorations derived from the current Git diff. */
  gitDecorations: DecorationSet;
  /** Transient decorations for external/AI edits. */
  aiDecorations: DecorationSet;
  /** Whether external editing is actively happening */
  isActive: boolean;
  /** Timestamp of last external change */
  lastChangeTime: number;
  /** Fingerprints of blocks before external changes started */
  baseFingerprints: BlockFingerprint[];
  /** Detected transient changes after debounce */
  changes: BlockChange[];
  /** Persistent block changes from the current Git diff. */
  gitChanges: BlockChange[];
  /** Latest accepted Git revision */
  gitRevision: number;
  /** Git ranges used to build the current decorations */
  gitLineRanges: GitLineRange[];
  /** Structure identity for the cached block index */
  gitStructureKey: string;
  gitMarkdown: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Debounce time: after this many ms of inactivity, compute diff */
const DEBOUNCE_MS = 1000;

/** How long to show diff highlights before fading */
const HIGHLIGHT_DURATION_MS = 24 * 60 * 60 * 1000;

/** Fade animation duration */
const FADE_DURATION_MS = 2000;

/** Meta key for external change signal */
const EXTERNAL_CHANGE_META = 'externalChange';

/** Meta key for Git unstaged change ranges */
const GIT_CHANGES_META = 'gitChanges';

const pluginKey = new PluginKey<AiChangesState>('aiChanges');
// ─── Utility: simple content hash ───────────────────────────────────────────

function hashNode(node: ProsemirrorNode): string {
  // Fast, collision-unlikely hash of node content
  let result = node.type.name + ':';
  if (node.isText) {
    result += node.text || '';
  } else if (node.isLeaf) {
    result += JSON.stringify(node.attrs);
  } else {
    node.forEach((child) => {
      result += hashNode(child) + '|';
    });
  }
  return result;
}

/** Get fingerprints of all top-level blocks */
function getBlockFingerprints(doc: ProsemirrorNode): BlockFingerprint[] {
  const fingerprints: BlockFingerprint[] = [];
  doc.forEach((node, offset) => {
    fingerprints.push({
      pos: offset,
      hash: hashNode(node),
      type: node.type.name,
    });
  });
  return fingerprints;
}

// ─── Diff Algorithm ─────────────────────────────────────────────────────────

/**
 * Compare base fingerprints with new document to find changed/added blocks.
 * Uses LCS-like approach on hashes to match old blocks to new blocks.
 */
function computeBlockChanges(
  baseFingerprints: BlockFingerprint[],
  newDoc: ProsemirrorNode
): BlockChange[] {
  const newFingerprints = getBlockFingerprints(newDoc);
  const changes: BlockChange[] = [];

  // Build set of old hashes
  const oldHashes = new Set(baseFingerprints.map((f) => f.hash));
  const oldHashCounts = new Map<string, number>();
  for (const f of baseFingerprints) {
    oldHashCounts.set(f.hash, (oldHashCounts.get(f.hash) || 0) + 1);
  }

  // Track which old hashes have been matched
  const matchedOldHashes = new Map<string, number>();

  for (const newFp of newFingerprints) {
    const available = (oldHashCounts.get(newFp.hash) || 0) - (matchedOldHashes.get(newFp.hash) || 0);

    if (available > 0) {
      // Exact match — block unchanged
      matchedOldHashes.set(newFp.hash, (matchedOldHashes.get(newFp.hash) || 0) + 1);
    } else if (oldHashes.size === 0) {
      // No base at all — everything is new (initial load, skip)
      continue;
    } else {
      // Try to match by position/type heuristic
      const nodeAtPos = newDoc.nodeAt(newFp.pos);
      const nodeSize = nodeAtPos ? nodeAtPos.nodeSize : 1;

      // Check if this type existed in old doc at a similar index
      const newIdx = newFingerprints.indexOf(newFp);
      const oldAtIdx = baseFingerprints[newIdx];

      if (oldAtIdx && oldAtIdx.type === newFp.type && oldAtIdx.hash !== newFp.hash) {
        // Same position, same type, different content → modified
        changes.push({ pos: newFp.pos, size: nodeSize, kind: 'modified' });
      } else {
        // No match at same position → likely added
        changes.push({ pos: newFp.pos, size: nodeSize, kind: 'added' });
      }
    }
  }

  return changes;
}

const documentBlockIndexCache = new WeakMap<ProsemirrorNode, { markdown: string; index: DocumentLineBlockIndex }>();

function getDocumentBlockIndex(doc: ProsemirrorNode, markdown: string): DocumentLineBlockIndex {
  const cached = documentBlockIndexCache.get(doc);
  if (cached?.markdown === markdown) return cached.index;

  const blocks: DocumentBlockRange[] = [];
  const sourceRanges = extractBlockLineMap(markdown);
  const structureParts: string[] = [];

  doc.forEach((node, pos, ordinal) => {
    const sourceRange = sourceRanges[ordinal];
    if (!sourceRange) return;
    const { startLine, endLine } = sourceRange;
    blocks.push({ startLine, endLine, pos, size: node.nodeSize });
    structureParts.push(`${node.type.name}:${node.nodeSize}:${startLine}-${endLine}`);
  });

  const index = {
    totalLines: Math.max(1, markdown.split('\n').length),
    blocks,
    structureKey: structureParts.join('|'),
  };
  documentBlockIndexCache.set(doc, { markdown, index });
  return index;
}

function normalizeGitRanges(lineRanges: GitLineRange[]): GitLineRange[] {
  return lineRanges
    .filter((range) => Number.isFinite(range.startLine) && Number.isFinite(range.endLine))
    .map((range) => ({
      startLine: Math.max(1, Math.floor(range.startLine)),
      endLine: Math.max(1, Math.floor(range.endLine)),
      kind: range.kind === 'added' ? ('added' as const) : ('modified' as const),
    }))
    .map((range) => ({ ...range, endLine: Math.max(range.startLine, range.endLine) }))
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}

function gitRangesKey(lineRanges: GitLineRange[]): string {
  return lineRanges.map((range) => `${range.startLine}-${range.endLine}-${range.kind}`).join('|');
}

export function shouldAcceptGitRevision(currentRevision: number, nextRevision: number): boolean {
  return Number.isFinite(nextRevision) && nextRevision >= currentRevision;
}

function intersects(a: { startLine: number; endLine: number }, b: { startLine: number; endLine: number }): boolean {
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

function isPreciseOverviewRange(range: GitLineRange, totalLines: number): boolean {
  const safeTotalLines = Math.max(1, totalLines);
  const changedLines = Math.max(1, range.endLine - range.startLine + 1);

  // Untracked files and fallback Git diffs can report the whole document as changed.
  // Rendering that on the right overview rail collapses into a permanent bright top marker.
  if (range.startLine <= 1 && range.endLine >= safeTotalLines) return false;
  if (changedLines / safeTotalLines >= 0.8) return false;

  return true;
}

function getOverviewRatio(range: GitLineRange, totalLines: number): number {
  return (Math.max(1, range.startLine) - 1) / Math.max(1, totalLines - 1);
}

export function computeGitBlockChanges(
  lineRanges: GitLineRange[],
  doc: ProsemirrorNode,
  markdown: string
): BlockChange[] {
  const normalizedRanges = normalizeGitRanges(lineRanges);
  if (!normalizedRanges.length) return [];

  const index = getDocumentBlockIndex(doc, markdown);
  const changes: BlockChange[] = [];
  let rangeIndex = 0;

  // Both inputs are sorted. Advance the range pointer once per range instead
  // of filtering every range for every block.
  for (const block of index.blocks) {
    while (rangeIndex < normalizedRanges.length && normalizedRanges[rangeIndex].endLine < block.startLine) {
      rangeIndex += 1;
    }
    let probe = rangeIndex;
    let hasMatch = false;
    let allAdded = true;
    let firstChangedLine: number | undefined;
    const overviewRanges: GitLineRange[] = [];
    while (probe < normalizedRanges.length && normalizedRanges[probe].startLine <= block.endLine) {
      const range = normalizedRanges[probe];
      if (intersects(block, range)) {
        hasMatch = true;
        firstChangedLine ??= Math.max(block.startLine, Math.min(block.endLine, range.startLine));
        allAdded = allAdded && range.kind === 'added';
        if (isPreciseOverviewRange(range, index.totalLines)) overviewRanges.push(range);
      }
      probe += 1;
    }
    if (!hasMatch) continue;
    changes.push({
      pos: block.pos,
      size: block.size,
      kind: allAdded ? 'added' : 'modified',
      startLine: firstChangedLine,
      showOverview: overviewRanges.length > 0,
      overviewRatios: overviewRanges.map((range) => getOverviewRatio(range, index.totalLines)),
    });
  }

  return changes;
}

// ─── DOM Elements ───────────────────────────────────────────────────────────

let indicatorEl: HTMLElement | null = null;
let toastEl: HTMLElement | null = null;
let fadeTimeoutId: ReturnType<typeof setTimeout> | null = null;
let debounceTimeoutId: ReturnType<typeof setTimeout> | null = null;
let scrollMarkerOverlay: HTMLElement | null = null;
let leftMarkerOverlay: HTMLElement | null = null;
let scrollMarkerChanges: BlockChange[] = [];
let scrollMarkerView: EditorView | null = null;
let scrollMarkerBound = false;
let scrollMarkerLayoutObserver: ResizeObserver | null = null;

function clearScrollMarkers() {
  if (scrollMarkerOverlay) {
    scrollMarkerOverlay.remove();
    scrollMarkerOverlay = null;
  }
  if (leftMarkerOverlay) {
    leftMarkerOverlay.remove();
    leftMarkerOverlay = null;
  }
  scrollMarkerChanges = [];
  scrollMarkerView = null;
}

function layoutScrollMarkers() {
  try {
    const scrollArea = document.getElementById('editor-scroll-area');
    if (!scrollArea || !scrollMarkerOverlay || !leftMarkerOverlay || !scrollMarkerView) return;

    const rect = scrollArea.getBoundingClientRect();
    const proseMirror = document.querySelector('#editor .ProseMirror') as HTMLElement | null;
    // Use the editor content edge as the rail anchor. The first child is not
    // stable for wide tables: its text may begin at an internal column, which
    // incorrectly places the version marker through the table body in full
    // width mode.
    const leftRailX = proseMirror
      ? Math.round(Math.max(rect.left, proseMirror.getBoundingClientRect().left - 6))
      : Math.round(rect.left);
    scrollMarkerOverlay.style.left = `${rect.right - 10}px`;
    scrollMarkerOverlay.style.top = `${rect.top}px`;
    scrollMarkerOverlay.style.height = `${rect.height}px`;
    scrollMarkerOverlay.innerHTML = '';
    leftMarkerOverlay.style.left = `${leftRailX}px`;
    leftMarkerOverlay.style.top = `${rect.top}px`;
    leftMarkerOverlay.style.height = `${rect.height}px`;
    leftMarkerOverlay.innerHTML = '';

    const viewportHeight = Math.max(1, rect.height);
    const scrollHeight = Math.max(1, scrollArea.scrollHeight);
    const renderedOverviewTops = new Set<number>();

    for (const change of scrollMarkerChanges) {
      const dom = scrollMarkerView.nodeDOM(change.pos);
      if (!(dom instanceof HTMLElement)) continue;

      const domRect = dom.getBoundingClientRect();
      if (change.showOverview !== false) {
        const documentTop = domRect.top - rect.top + scrollArea.scrollTop;
        for (const sourceRatio of change.overviewRatios ?? [documentTop / scrollHeight]) {
          const markerTop = Math.max(
            1,
            Math.min(viewportHeight - 5, Math.round(sourceRatio * viewportHeight))
          );

          if (!renderedOverviewTops.has(markerTop)) {
            renderedOverviewTops.add(markerTop);
            const marker = document.createElement('div');
            marker.className = `ai-scroll-marker ${change.kind === 'added' ? 'added' : 'modified'}`;
            marker.style.top = `${markerTop}px`;
            scrollMarkerOverlay.appendChild(marker);
          }
        }
      }

      const visibleTop = Math.max(0, domRect.top - rect.top);
      const visibleBottom = Math.min(viewportHeight, domRect.bottom - rect.top);
      if (visibleBottom > 0 && visibleTop < viewportHeight && visibleBottom > visibleTop) {
        const leftMarker = document.createElement('div');
        leftMarker.className = `ai-left-marker ${change.kind === 'added' ? 'added' : 'modified'}`;
        leftMarker.style.top = `${visibleTop}px`;
        leftMarker.style.height = `${Math.max(6, visibleBottom - visibleTop)}px`;
        leftMarkerOverlay.appendChild(leftMarker);
      }
    }
  } catch {
    // Marker rendering should never interrupt editor updates.
  }
}

export function refreshAiChangeMarkers(): void {
  layoutScrollMarkers();
}

function bindScrollMarkerLayoutListeners(): void {
  if (scrollMarkerBound) return;
  scrollMarkerBound = true;

  window.addEventListener('resize', layoutScrollMarkers);
  window.addEventListener('easyview-toc-layout-change', layoutScrollMarkers);
  window.addEventListener('easyview-table-wrap-layout-change', layoutScrollMarkers);
  window.addEventListener('easyview-editor-layout-change', layoutScrollMarkers);
  document.getElementById('editor-scroll-area')?.addEventListener('scroll', layoutScrollMarkers, { passive: true });

  if (typeof ResizeObserver === 'undefined') return;

  scrollMarkerLayoutObserver = new ResizeObserver(() => layoutScrollMarkers());
  const scrollArea = document.getElementById('editor-scroll-area');
  const editorBody = document.getElementById('editor-body');
  const tocSidebar = document.querySelector('.toc-sidebar');
  const historyPanel = document.querySelector('.history-panel');
  if (scrollArea) scrollMarkerLayoutObserver.observe(scrollArea);
  if (editorBody) scrollMarkerLayoutObserver.observe(editorBody);
  if (tocSidebar instanceof HTMLElement) scrollMarkerLayoutObserver.observe(tocSidebar);
  if (historyPanel instanceof HTMLElement) scrollMarkerLayoutObserver.observe(historyPanel);
}

function renderScrollMarkers(changes: BlockChange[], view: EditorView) {
  if (!changes.length) {
    clearScrollMarkers();
    return;
  }

  scrollMarkerChanges = changes;
  scrollMarkerView = view;

  if (!scrollMarkerOverlay) {
    scrollMarkerOverlay = document.createElement('div');
    scrollMarkerOverlay.className = 'ai-scroll-markers';
    document.body.appendChild(scrollMarkerOverlay);
  }
  if (!leftMarkerOverlay) {
    leftMarkerOverlay = document.createElement('div');
    leftMarkerOverlay.className = 'ai-left-markers';
    document.body.appendChild(leftMarkerOverlay);
  }

  layoutScrollMarkers();
  bindScrollMarkerLayoutListeners();
}

function getIndicator(): HTMLElement {
  if (!indicatorEl) {
    indicatorEl = document.createElement('div');
    indicatorEl.className = 'ai-indicator';
    indicatorEl.innerHTML =
      '<span class="ai-indicator-icon">\u2726</span>' +
      '<span>AI is editing\u2026</span>' +
      '<span class="ai-indicator-dots">' +
        '<span class="ai-indicator-dot"></span>' +
        '<span class="ai-indicator-dot"></span>' +
        '<span class="ai-indicator-dot"></span>' +
      '</span>';
    document.body.appendChild(indicatorEl);
  }
  return indicatorEl;
}

function showIndicator() {
  const el = getIndicator();
  // Force reflow for animation
  el.offsetHeight;
  el.classList.add('visible');
}

function hideIndicator() {
  if (indicatorEl) {
    indicatorEl.classList.remove('visible');
  }
}

function getToastEl(): HTMLElement {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'ai-changes-toast';
    toastEl.setAttribute('role', 'group');
    toastEl.setAttribute('aria-label', 'Change navigator');
    document.body.appendChild(toastEl);
    let drag: { pointerId: number; x: number; y: number; left: number; top: number } | null = null;
    toastEl.addEventListener('pointerdown', (event) => {
      if ((event.target as HTMLElement).closest('button')) return;
      const rect = toastEl!.getBoundingClientRect();
      drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      toastEl!.setPointerCapture(event.pointerId);
      toastEl!.classList.add('dragging');
      event.preventDefault();
    });
    toastEl.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const left = Math.max(0, Math.min(window.innerWidth - toastEl!.offsetWidth, drag.left + event.clientX - drag.x));
      const top = Math.max(0, Math.min(window.innerHeight - toastEl!.offsetHeight, drag.top + event.clientY - drag.y));
      toastEl!.style.left = `${left}px`;
      toastEl!.style.top = `${top}px`;
      toastEl!.style.bottom = 'auto';
      toastEl!.style.transform = 'none';
    });
    const endDrag = (event: PointerEvent) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag = null;
      toastEl?.classList.remove('dragging');
      toastEl?.releasePointerCapture(event.pointerId);
    };
    toastEl.addEventListener('pointerup', endDrag);
    toastEl.addEventListener('pointercancel', endDrag);
  }
  return toastEl;
}

function hideSummaryToast(): void {
  toastEl?.classList.remove('visible');
}

type RevealChange = (pos: number, startLine: number | undefined, view: EditorView) => void;

function revealInPreview(pos: number, _startLine: number | undefined, view: EditorView): void {
  const dom = view.nodeDOM(pos);
  if (dom instanceof HTMLElement) dom.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function showSummaryToast(changes: BlockChange[], view: EditorView, revealChange: RevealChange, source: 'git' | 'external' = 'external', gitStatus: GitRefreshStatus = 'ready') {
  const navigableChanges = [...changes].sort((a, b) => a.pos - b.pos);
  let currentIndex = 0;
  const el = getToastEl();
  el.innerHTML =
    '<span class="ai-changes-toast-drag" aria-hidden="true"><svg viewBox="0 0 12 20" fill="currentColor"><circle cx="3" cy="4" r="1.2"/><circle cx="9" cy="4" r="1.2"/><circle cx="3" cy="10" r="1.2"/><circle cx="9" cy="10" r="1.2"/><circle cx="3" cy="16" r="1.2"/><circle cx="9" cy="16" r="1.2"/></svg></span>' +
    '<span class="ai-changes-toast-summary">No changes</span>' +
    '<span class="ai-changes-toast-count" role="status" aria-live="polite"></span>' +
    '<span class="ai-changes-toast-controls">' +
    '<button type="button" class="ai-changes-toast-prev" aria-label="Previous change" title="Previous change"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5-5 5 5"/></svg></button>' +
    '<button type="button" class="ai-changes-toast-next" aria-label="Next change" title="Next change"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 5 5 5-5"/></svg></button>' +
    '</span>' +
    '<button type="button" class="ai-changes-toast-close" aria-label="Close change navigator" title="Close"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 5l10 10M15 5 5 15"/></svg></button>';

  const summary = el.querySelector<HTMLElement>('.ai-changes-toast-summary')!;
  summary.textContent = gitStatus === 'loading' ? 'Loading Git changes…'
    : gitStatus === 'error' ? 'Git read failed' : 'No changes';
  const count = el.querySelector<HTMLElement>('.ai-changes-toast-count')!;
  const previous = el.querySelector<HTMLButtonElement>('.ai-changes-toast-prev')!;
  const next = el.querySelector<HTMLButtonElement>('.ai-changes-toast-next')!;
  const refresh = () => {
    summary.hidden = navigableChanges.length > 0;
    count.hidden = navigableChanges.length === 0;
    count.textContent = `${navigableChanges.length ? currentIndex + 1 : 0}/${navigableChanges.length}`;
    count.setAttribute('aria-label', `${source === 'git' ? 'Git' : 'External'} change ${currentIndex + 1} of ${navigableChanges.length}`);
    previous.disabled = currentIndex === 0;
    next.disabled = currentIndex >= navigableChanges.length - 1;
  };
  const navigate = (index: number) => {
    if (index < 0 || index >= navigableChanges.length) return;
    currentIndex = index;
    const change = navigableChanges[index];
    revealChange(change.pos, change.startLine, view);
    refresh();
  };
  previous.addEventListener('click', () => navigate(currentIndex - 1));
  next.addEventListener('click', () => navigate(currentIndex + 1));
  el.querySelector('.ai-changes-toast-close')!.addEventListener('click', hideSummaryToast);
  refresh();

  el.offsetHeight;
  el.classList.add('visible');
}

function showAvailableChanges(gitChanges: BlockChange[], externalChanges: BlockChange[], view: EditorView, revealChange: RevealChange, gitStatus: GitRefreshStatus): void {
  if (gitStatus !== 'ready') showSummaryToast([], view, revealChange, 'external', gitStatus);
  else if (gitChanges.length) showSummaryToast(gitChanges, view, revealChange, 'git');
  else showSummaryToast(externalChanges, view, revealChange);
}

// ─── Plugin ─────────────────────────────────────────────────────────────────

function createAiChangesPlugin(shouldShowJumpToast: () => boolean, revealChange: RevealChange, getGitRefreshStatus: () => GitRefreshStatus): Plugin<AiChangesState> {
  let activeView: EditorView | null = null;

  return new Plugin<AiChangesState>({
    key: pluginKey,

    state: {
      init(_, state): AiChangesState {
        return {
          gitDecorations: DecorationSet.empty,
          aiDecorations: DecorationSet.empty,
          isActive: false,
          lastChangeTime: 0,
          baseFingerprints: [],
          changes: [],
          gitChanges: [],
          gitRevision: -1,
          gitLineRanges: [],
          gitStructureKey: '',
          gitMarkdown: '',
        };
      },

      apply(tr: Transaction, prev: AiChangesState, _oldState: EditorState, newState: EditorState): AiChangesState {
        const gitMeta = tr.getMeta(GIT_CHANGES_META);
        if (gitMeta) {
          const { lineRanges, revision, markdown } = gitMeta as { lineRanges: GitLineRange[]; revision: number; markdown: string };
          if (!shouldAcceptGitRevision(prev.gitRevision, revision)) return prev;
          const normalizedRanges = normalizeGitRanges(lineRanges || []);
          const nextStructureKey = getDocumentBlockIndex(newState.doc, markdown).structureKey;
          if (revision === prev.gitRevision && gitRangesKey(normalizedRanges) === gitRangesKey(prev.gitLineRanges) &&
              nextStructureKey === prev.gitStructureKey && markdown === prev.gitMarkdown) {
            return tr.docChanged
              ? {
                  ...prev,
                  gitDecorations: prev.gitDecorations.map(tr.mapping, newState.doc),
                  aiDecorations: prev.aiDecorations.map(tr.mapping, newState.doc),
                }
              : prev;
          }

          const gitChanges = computeGitBlockChanges(normalizedRanges, newState.doc, markdown);
          const gitDecos = gitChanges.flatMap((change) => {
            const node = newState.doc.nodeAt(change.pos);
            return node ? [Decoration.node(change.pos, change.pos + change.size, {
              class: change.kind === 'modified' ? 'block-ai-modified' : 'block-ai-added',
            })] : [];
          });

          return {
            ...prev,
            gitDecorations: DecorationSet.create(newState.doc, gitDecos),
            gitChanges,
            gitRevision: revision,
            gitLineRanges: normalizedRanges,
            gitStructureKey: nextStructureKey,
            gitMarkdown: markdown,
          };
        }

        const isExternal = tr.getMeta(EXTERNAL_CHANGE_META);

        if (isExternal) {
          const now = Date.now();
          const wasActive = prev.isActive;

          // Capture base fingerprints on first external change
          const baseFp = wasActive ? prev.baseFingerprints : getBlockFingerprints(tr.before);

          // Show shimmer on all top-level blocks that might be changing
          const shimmerDecos: Decoration[] = [];
          newState.doc.forEach((node, offset) => {
            shimmerDecos.push(
              Decoration.node(offset, offset + node.nodeSize, {
                class: 'block-ai-active',
              })
            );
          });

          // Debounce: schedule diff computation
          if (debounceTimeoutId) clearTimeout(debounceTimeoutId);
          debounceTimeoutId = setTimeout(() => {
            if (activeView) {
              // Transition from active to diff-showing state
              const changes = computeBlockChanges(baseFp, activeView.state.doc);
              activeView.dispatch(
                activeView.state.tr.setMeta('aiChangesComplete', { changes, baseFp })
              );
            }
          }, DEBOUNCE_MS);

          showIndicator();

          return {
            ...prev,
            aiDecorations: DecorationSet.create(newState.doc, shimmerDecos),
            isActive: true,
            lastChangeTime: now,
            baseFingerprints: baseFp,
            changes: [],
            gitRevision: prev.gitRevision,
            gitLineRanges: prev.gitLineRanges,
            gitStructureKey: prev.gitStructureKey,
            gitMarkdown: prev.gitMarkdown,
          };
        }

        // Handle diff computation complete
        const completeMeta = tr.getMeta('aiChangesComplete');
        if (completeMeta) {
          const { changes, baseFp } = completeMeta as { changes: BlockChange[]; baseFp: BlockFingerprint[] };

          hideIndicator();

          if (changes.length === 0) {
            if (activeView && shouldShowJumpToast() && toastEl?.classList.contains('visible')) {
              showAvailableChanges(prev.gitChanges, [], activeView, revealChange, getGitRefreshStatus());
            } else {
              hideSummaryToast();
            }
            return {
              ...prev,
              aiDecorations: DecorationSet.empty,
              isActive: false,
              lastChangeTime: 0,
              baseFingerprints: [],
              changes: [],
              gitRevision: prev.gitRevision,
              gitLineRanges: prev.gitLineRanges,
              gitStructureKey: prev.gitStructureKey,
              gitMarkdown: prev.gitMarkdown,
            };
          }

          // Create diff decorations
          const diffDecos: Decoration[] = [];
          for (const change of changes) {
            const node = newState.doc.nodeAt(change.pos);
            if (!node) continue;
            diffDecos.push(
              Decoration.node(change.pos, change.pos + change.size, {
                class: change.kind === 'modified' ? 'block-ai-modified' : 'block-ai-added',
              })
            );
          }

          if (activeView && shouldShowJumpToast()) {
            showAvailableChanges(prev.gitChanges, changes, activeView, revealChange, getGitRefreshStatus());
          }

          // Schedule fadeout
          if (fadeTimeoutId) clearTimeout(fadeTimeoutId);
          fadeTimeoutId = setTimeout(() => {
            if (activeView) {
              activeView.dispatch(
                activeView.state.tr.setMeta('aiChangesFadeout', true)
              );
            }
          }, HIGHLIGHT_DURATION_MS);

          return {
            ...prev,
            aiDecorations: DecorationSet.create(newState.doc, diffDecos),
            isActive: false,
            lastChangeTime: prev.lastChangeTime,
            baseFingerprints: [],
            changes,
            gitRevision: prev.gitRevision,
            gitLineRanges: prev.gitLineRanges,
            gitStructureKey: prev.gitStructureKey,
            gitMarkdown: prev.gitMarkdown,
          };
        }

        // Handle fadeout
        if (tr.getMeta('aiChangesFadeout')) {
          // Apply fadeout class, then clear after animation
          const decos: Decoration[] = [];
          for (const change of prev.changes) {
            const node = newState.doc.nodeAt(change.pos);
            if (!node) continue;
            decos.push(
              Decoration.node(change.pos, change.pos + change.size, {
                class: 'block-ai-fadeout',
              })
            );
          }

          // Clear decorations after fade animation
          setTimeout(() => {
            if (activeView) {
              activeView.dispatch(
                activeView.state.tr.setMeta('aiChangesClear', true)
              );
            }
          }, FADE_DURATION_MS);

          return {
            ...prev,
            aiDecorations: DecorationSet.create(newState.doc, decos),
          };
        }

        // Clear all decorations
        if (tr.getMeta('aiChangesClear')) {
          return {
            ...prev,
            aiDecorations: DecorationSet.empty,
            isActive: false,
            lastChangeTime: 0,
            baseFingerprints: [],
            changes: [],
          };
        }

        // Rebuild Git decorations only when document structure changed.
        if (tr.docChanged && prev.gitLineRanges.length > 0) {
          const nextIndex = getDocumentBlockIndex(newState.doc, prev.gitMarkdown);
          if (nextIndex.structureKey !== prev.gitStructureKey) {
            const changes = computeGitBlockChanges(prev.gitLineRanges, newState.doc, prev.gitMarkdown);
            const decos = changes.flatMap((change) => {
              const node = newState.doc.nodeAt(change.pos);
              return node ? [Decoration.node(change.pos, change.pos + change.size, {
                class: change.kind === 'modified' ? 'block-ai-modified' : 'block-ai-added',
              })] : [];
            });
            return {
              ...prev,
              gitDecorations: DecorationSet.create(newState.doc, decos),
              gitChanges: changes,
              gitStructureKey: nextIndex.structureKey,
              aiDecorations: prev.aiDecorations.map(tr.mapping, newState.doc),
            };
          }
        }

        // Map existing decorations through document changes
        if (tr.docChanged && (prev.gitDecorations !== DecorationSet.empty || prev.aiDecorations !== DecorationSet.empty)) {
          return {
            ...prev,
            gitDecorations: prev.gitDecorations.map(tr.mapping, tr.doc),
            aiDecorations: prev.aiDecorations.map(tr.mapping, tr.doc),
          };
        }

        return prev;
      },
    },

    props: {
      decorations(state) {
        const pluginState = pluginKey.getState(state);
        if (!pluginState) return DecorationSet.empty;
        return pluginState.gitDecorations.add(state.doc, pluginState.aiDecorations.find());
      },
    },

    view(view) {
      activeView = view;
      return {
        update(view, previousState) {
          const state = pluginKey.getState(view.state);
          const previous = pluginKey.getState(previousState);
          if (state && (state.changes !== previous?.changes || state.gitChanges !== previous?.gitChanges || view.state.doc !== previousState.doc)) {
            renderScrollMarkers(state.gitChanges, view);
          }
          if (state && state.gitChanges !== previous?.gitChanges
            && toastEl?.classList.contains('visible') && shouldShowJumpToast()) {
            showAvailableChanges(state.gitChanges, state.changes, view, revealChange, getGitRefreshStatus());
          }
        },
        destroy() {
          activeView = null;
          hideIndicator();
          if (debounceTimeoutId) clearTimeout(debounceTimeoutId);
          if (fadeTimeoutId) clearTimeout(fadeTimeoutId);
          if (indicatorEl) {
            indicatorEl.remove();
            indicatorEl = null;
          }
          if (toastEl) {
            toastEl.remove();
            toastEl = null;
          }
          clearScrollMarkers();
        },
      };
    },
  });
}

// ─── Extension ──────────────────────────────────────────────────────────────

/** Meta key used to signal external changes to the plugin */
export const AI_CHANGE_META = EXTERNAL_CHANGE_META;
export const GIT_CHANGE_META = GIT_CHANGES_META;

export class AiChangesExtension extends Extension {
  constructor(
    private readonly shouldShowJumpToast: () => boolean = () => true,
    private readonly revealChange: RevealChange = revealInPreview,
    private readonly getGitRefreshStatus: () => GitRefreshStatus = () => 'ready',
  ) {
    super();
  }

  hideJumpToast(): void { hideSummaryToast(); }

  showCurrentJumpToast(view: EditorView | null): void {
    if (!view || !this.shouldShowJumpToast()) return;
    const state = pluginKey.getState(view.state);
    showAvailableChanges(state?.gitChanges ?? [], state?.changes ?? [], view, this.revealChange, this.getGitRefreshStatus());
  }

  refreshVisibleJumpToast(view: EditorView | null): void {
    if (toastEl?.classList.contains('visible')) this.showCurrentJumpToast(view);
  }

  get name() {
    return 'aiChanges';
  }

  plugins(_schema: Schema) {
    return [createAiChangesPlugin(this.shouldShowJumpToast, this.revealChange, this.getGitRefreshStatus)];
  }
}
