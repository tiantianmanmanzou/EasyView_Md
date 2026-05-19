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
}

interface GitLineRange {
  startLine: number;
  endLine: number;
  kind: ChangeKind;
}

interface AiChangesState {
  /** Current decorations */
  decorations: DecorationSet;
  /** Whether external editing is actively happening */
  isActive: boolean;
  /** Timestamp of last external change */
  lastChangeTime: number;
  /** Fingerprints of blocks before external changes started */
  baseFingerprints: BlockFingerprint[];
  /** Detected changes after debounce */
  changes: BlockChange[];
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

function buildMarkdownBlockRanges(content: string): Array<{ startLine: number; endLine: number }> {
  const lines = content.split('\n');
  const ranges: Array<{ startLine: number; endLine: number }> = [];
  let startLine: number | null = null;
  let inFence = false;

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNumber = idx + 1;
    const line = lines[idx];
    const trimmed = line.trim();
    const isFence = /^(```|~~~)/.test(trimmed);

    if (startLine === null && trimmed !== '') {
      startLine = lineNumber;
    }

    if (isFence) {
      inFence = !inFence;
    }

    if (startLine !== null && !inFence && trimmed === '') {
      ranges.push({ startLine, endLine: Math.max(startLine, lineNumber - 1) });
      startLine = null;
    }
  }

  if (startLine !== null) {
    ranges.push({ startLine, endLine: lines.length });
  }

  return ranges.length ? ranges : [{ startLine: 1, endLine: 1 }];
}

function intersects(a: { startLine: number; endLine: number }, b: { startLine: number; endLine: number }) {
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

function computeGitBlockChanges(
  lineRanges: GitLineRange[],
  content: string,
  doc: ProsemirrorNode
): BlockChange[] {
  if (!lineRanges.length) return [];

  const blockRanges = buildMarkdownBlockRanges(content);
  const docBlocks: Array<{ pos: number; size: number; index: number }> = [];
  doc.forEach((node, offset, index) => {
    docBlocks.push({ pos: offset, size: node.nodeSize, index });
  });

  const changes: BlockChange[] = [];
  for (const block of docBlocks) {
    const blockRange = blockRanges[Math.min(block.index, blockRanges.length - 1)];
    const matched = lineRanges.filter((range) => intersects(blockRange, range));
    if (!matched.length) continue;
    changes.push({
      pos: block.pos,
      size: block.size,
      kind: matched.some((range) => range.kind === 'added') ? 'added' : 'modified',
    });
  }

  if (!changes.length) {
    const totalLines = Math.max(1, content.split('\n').length);
    const childCount = Math.max(1, doc.childCount);
    const seen = new Set<number>();

    for (const range of lineRanges) {
      const index = Math.max(
        0,
        Math.min(childCount - 1, Math.floor(((range.startLine - 1) / totalLines) * childCount))
      );
      if (seen.has(index)) continue;
      seen.add(index);

      let offset = 0;
      for (let i = 0; i < doc.childCount; i++) {
        const node = doc.child(i);
        if (i === index) {
          changes.push({ pos: offset, size: node.nodeSize, kind: range.kind });
          break;
        }
        offset += node.nodeSize;
      }
    }
  }

  return changes;
}

// ─── DOM Elements ───────────────────────────────────────────────────────────

let indicatorEl: HTMLElement | null = null;
let toastEl: HTMLElement | null = null;
let fadeTimeoutId: ReturnType<typeof setTimeout> | null = null;
let toastTimeoutId: ReturnType<typeof setTimeout> | null = null;
let debounceTimeoutId: ReturnType<typeof setTimeout> | null = null;
let scrollMarkerOverlay: HTMLElement | null = null;
let scrollMarkerChanges: BlockChange[] = [];
let scrollMarkerView: EditorView | null = null;
let scrollMarkerBound = false;

function clearScrollMarkers() {
  if (scrollMarkerOverlay) {
    scrollMarkerOverlay.remove();
    scrollMarkerOverlay = null;
  }
  scrollMarkerChanges = [];
  scrollMarkerView = null;
}

function layoutScrollMarkers() {
  try {
    const scrollArea = document.getElementById('editor-scroll-area');
    if (!scrollArea || !scrollMarkerOverlay || !scrollMarkerView) return;

    const rect = scrollArea.getBoundingClientRect();
    scrollMarkerOverlay.style.left = `${rect.right - 10}px`;
    scrollMarkerOverlay.style.top = `${rect.top}px`;
    scrollMarkerOverlay.style.height = `${rect.height}px`;
    scrollMarkerOverlay.innerHTML = '';

    const scrollHeight = Math.max(1, scrollArea.scrollHeight);
    const viewportHeight = Math.max(1, rect.height);

    for (const change of scrollMarkerChanges) {
      const dom = scrollMarkerView.nodeDOM(change.pos);
      if (!(dom instanceof HTMLElement)) continue;

      const domRect = dom.getBoundingClientRect();
      const documentTop = domRect.top - rect.top + scrollArea.scrollTop;
      const markerTop = Math.max(
        1,
        Math.min(viewportHeight - 5, Math.round((documentTop / scrollHeight) * viewportHeight))
      );

      const marker = document.createElement('div');
      marker.className = `ai-scroll-marker ${change.kind === 'added' ? 'added' : 'modified'}`;
      marker.style.top = `${markerTop}px`;
      scrollMarkerOverlay.appendChild(marker);
    }
  } catch {
    // Marker rendering should never interrupt editor updates.
  }
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

  layoutScrollMarkers();

  if (!scrollMarkerBound) {
    window.addEventListener('resize', layoutScrollMarkers);
    scrollMarkerBound = true;
  }
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
    document.body.appendChild(toastEl);
  }
  return toastEl;
}

function showSummaryToast(changes: BlockChange[], view: EditorView) {
  const modified = changes.filter((c) => c.kind === 'modified').length;
  const added = changes.filter((c) => c.kind === 'added').length;

  if (modified === 0 && added === 0) return;

  const parts: string[] = [];
  if (modified > 0) parts.push(`${modified} block${modified > 1 ? 's' : ''} modified`);
  if (added > 0) parts.push(`${added} block${added > 1 ? 's' : ''} added`);

  const el = getToastEl();
  el.innerHTML =
    '<span class="ai-changes-toast-icon">\u2726</span>' +
    `<span>${parts.join(', ')}</span>` +
    '<a class="ai-changes-toast-jump">\u2193 Jump to changes</a>';

  const jumpLink = el.querySelector('.ai-changes-toast-jump') as HTMLElement;
  if (jumpLink) {
    jumpLink.addEventListener('click', () => {
      const firstChange = changes[0];
      if (firstChange) {
        const dom = view.nodeDOM(firstChange.pos);
        if (dom && dom instanceof HTMLElement) {
          dom.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
      el.classList.remove('visible');
    });
  }

  // Show toast
  el.offsetHeight;
  el.classList.add('visible');

  // Auto-hide after 8s
  if (toastTimeoutId) clearTimeout(toastTimeoutId);
  toastTimeoutId = setTimeout(() => {
    el.classList.remove('visible');
    toastTimeoutId = null;
  }, HIGHLIGHT_DURATION_MS);
}

// ─── Plugin ─────────────────────────────────────────────────────────────────

function createAiChangesPlugin(): Plugin<AiChangesState> {
  let activeView: EditorView | null = null;

  return new Plugin<AiChangesState>({
    key: pluginKey,

    state: {
      init(_, state): AiChangesState {
        return {
          decorations: DecorationSet.empty,
          isActive: false,
          lastChangeTime: 0,
          baseFingerprints: [],
          changes: [],
        };
      },

      apply(tr: Transaction, prev: AiChangesState, _oldState: EditorState, newState: EditorState): AiChangesState {
        const gitMeta = tr.getMeta(GIT_CHANGES_META);
        if (gitMeta) {
          const { lineRanges, content } = gitMeta as { lineRanges: GitLineRange[]; content: string };
          const changes = computeGitBlockChanges(lineRanges || [], content || '', newState.doc);
          hideIndicator();
          if (debounceTimeoutId) clearTimeout(debounceTimeoutId);
          if (fadeTimeoutId) clearTimeout(fadeTimeoutId);
          if (toastTimeoutId) clearTimeout(toastTimeoutId);

          if (changes.length === 0) {
            clearScrollMarkers();
            return {
              decorations: DecorationSet.empty,
              isActive: false,
              lastChangeTime: 0,
              baseFingerprints: [],
              changes: [],
            };
          }

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

          if (activeView) {
            renderScrollMarkers(changes, activeView);
          }

          return {
            decorations: DecorationSet.create(newState.doc, diffDecos),
            isActive: false,
            lastChangeTime: Date.now(),
            baseFingerprints: [],
            changes,
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
            decorations: DecorationSet.create(newState.doc, shimmerDecos),
            isActive: true,
            lastChangeTime: now,
            baseFingerprints: baseFp,
            changes: [],
          };
        }

        // Handle diff computation complete
        const completeMeta = tr.getMeta('aiChangesComplete');
        if (completeMeta) {
          const { changes, baseFp } = completeMeta as { changes: BlockChange[]; baseFp: BlockFingerprint[] };

          hideIndicator();

          if (changes.length === 0) {
            return {
              decorations: DecorationSet.empty,
              isActive: false,
              lastChangeTime: 0,
              baseFingerprints: [],
              changes: [],
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

          // Auto-scroll to first change, then show toast
          if (activeView) {
            const firstChange = changes[0];
            if (firstChange) {
              const dom = activeView.nodeDOM(firstChange.pos);
              if (dom && dom instanceof HTMLElement) {
                dom.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            }
            showSummaryToast(changes, activeView);
            renderScrollMarkers(changes, activeView);
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
            decorations: DecorationSet.create(newState.doc, diffDecos),
            isActive: false,
            lastChangeTime: prev.lastChangeTime,
            baseFingerprints: [],
            changes,
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
            decorations: DecorationSet.create(newState.doc, decos),
          };
        }

        // Clear all decorations
        if (tr.getMeta('aiChangesClear')) {
          clearScrollMarkers();
          return {
            decorations: DecorationSet.empty,
            isActive: false,
            lastChangeTime: 0,
            baseFingerprints: [],
            changes: [],
          };
        }

        // Map existing decorations through document changes
        if (tr.docChanged && prev.decorations !== DecorationSet.empty) {
          return {
            ...prev,
            decorations: prev.decorations.map(tr.mapping, tr.doc),
          };
        }

        return prev;
      },
    },

    props: {
      decorations(state) {
        return pluginKey.getState(state)?.decorations ?? DecorationSet.empty;
      },
    },

    view(view) {
      activeView = view;
      return {
        destroy() {
          activeView = null;
          hideIndicator();
          if (debounceTimeoutId) clearTimeout(debounceTimeoutId);
          if (fadeTimeoutId) clearTimeout(fadeTimeoutId);
          if (toastTimeoutId) clearTimeout(toastTimeoutId);
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
  get name() {
    return 'aiChanges';
  }

  plugins(_schema: Schema) {
    return [createAiChangesPlugin()];
  }
}
