/**
 * InLineMd Webview Entry Point
 *
 * Thin host shell: creates Extensions + EditorCore, handles VS Code messaging and UI.
 * All ProseMirror logic is in Extensions and EditorCore.
 */

import { NodeSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { undo, redo, undoDepth, redoDepth, isHistoryTransaction } from 'prosemirror-history';
import { undo as cmUndo, redo as cmRedo, undoDepth as cmUndoDepth, redoDepth as cmRedoDepth } from '@codemirror/commands';
import { goToNextCell } from 'prosemirror-tables';

import { EditorCore } from './editor/EditorCore';

// Extensions
import { KeyboardOverridesExtension } from './extensions/behavior/keyboard-overrides/KeyboardOverridesExtension';
import { ListsExtension } from './extensions/blocks/lists/ListsExtension';
import { SmartTextExtension } from './extensions/behavior/smart-text/SmartTextExtension';
import { MarksExtension } from './extensions/inline/marks/MarksExtension';
import { HeadingExtension, setHeadingOutlinePathCopyHandler, setToastFunction } from './extensions/blocks/heading/HeadingExtension';
import { BlockquoteExtension } from './extensions/blocks/blockquote/BlockquoteExtension';
import { CodeBlockExtension } from './extensions/blocks/code-block/CodeBlockExtension';
import { NoticeExtension } from './extensions/blocks/notice/NoticeExtension';
import { HorizontalRuleExtension } from './extensions/blocks/horizontal-rule/HorizontalRuleExtension';
import { TableExtension } from './extensions/blocks/table/TableExtension';
import { setFirstRowStickyDefault } from './extensions/blocks/table/TablePreferences';
import { ImageExtension } from './extensions/inline/image/ImageExtension';
import { MermaidExtension } from './extensions/blocks/mermaid/MermaidExtension';
import { PlantUmlExtension } from './extensions/blocks/plantuml/PlantUmlExtension';
import { ExternalDiagramExtension } from './extensions/blocks/external-diagram/ExternalDiagramExtension';
import { FrontmatterExtension } from './extensions/blocks/frontmatter/FrontmatterExtension';
import { DetailsExtension } from './extensions/blocks/details/DetailsExtension';
import { HtmlBlockExtension } from './extensions/blocks/html-block/HtmlBlockExtension';
import { DrawioExtension } from './extensions/integrations/drawio/DrawioExtension';
import { MathExtension } from './extensions/inline/math/MathExtension';
import { FootnotesExtension } from './extensions/inline/footnotes/FootnotesExtension';
import { InlineDiffExtension } from './extensions/inline/inline-diff/InlineDiffExtension';
import { DescriptionListExtension } from './extensions/blocks/description-list/DescriptionListExtension';
import { TocExtension } from './extensions/blocks/toc/TocExtension';
import { VideoAudioExtension } from './extensions/inline/video-audio/VideoAudioExtension';
import { EmojiExtension } from './extensions/inline/emoji/EmojiExtension';
import { BlockDragExtension } from './extensions/behavior/block-drag/BlockDragExtension';
import { SlashMenuExtension } from './extensions/behavior/slash-menu/SlashMenuExtension';
import { FindReplaceExtension } from './extensions/behavior/find-replace/FindReplaceExtension';
import { BlockEdgeCursorExtension } from './extensions/behavior/block-edge-cursor/BlockEdgeCursorExtension';
import { InlineCursorExtension } from './extensions/behavior/inline-cursor/InlineCursorExtension';
import { MarkBoundaryExtension } from './extensions/behavior/mark-boundary/MarkBoundaryExtension';
import { TrailingNodeExtension } from './extensions/behavior/trailing-node/TrailingNodeExtension';
import { PlaceholderExtension } from './extensions/behavior/placeholder/PlaceholderExtension';
import { ClipboardExtension } from './extensions/behavior/clipboard/ClipboardExtension';
import {
  AiChangesExtension,
  GIT_CHANGE_META,
  refreshAiChangeMarkers,
} from './extensions/integrations/ai-changes/AiChangesExtension';
import { initContextMenu } from './ui/ContextMenu';
import { createPasteParser, extractTextblockLineMap } from './editor/lib/MarkdownParser';
import { stripSettingsComment } from './editor/lib/EditorSettings';
import { ExportController } from './controllers/ExportController';
import { SourceModeController } from './controllers/SourceModeController';
import { LayoutController } from './controllers/LayoutController';
import { ShortcutController } from './controllers/ShortcutController';
import { EditorBootstrap } from './controllers/EditorBootstrap';

// UI
import { FloatingToolbar } from './extensions/behavior/toolbar/ToolbarFloating';
import { linkEditPopup } from './extensions/behavior/toolbar/ToolbarLinkPopup';
import { imageToolbar } from './extensions/inline/image/ImageToolbar';
import { FindAndReplacePanel } from './extensions/behavior/find-replace/FindReplacePanel';
import { TableOfContents } from './extensions/blocks/heading/TableOfContents';
import { createSourceEditor } from './editor/SourceEditor';
import { DualModeHistory } from './editor/DualModeHistory';
import { EditOperationLog } from './editor/EditOperationLog';
import { describeProseMirrorTransaction, describeSourceDocChange } from './editor/describeEditOperation';
import { createFileHeader, type ToolbarShortcutAction, type ToolbarShortcutConfig } from './ui/FileHeader';
import { HistoryPanel } from './ui/HistoryPanel';
import { createStickyNoteModal } from './ui/StickyNoteModal';
import { createTerminalModal, type TerminalAppearance } from './ui/TerminalModal';
import type { HostToWebviewMessage, VscodeWebviewApi } from '../shared/protocol';
import { handleHostMessageSideEffect } from './hostMessageRouter';

// ─── VS Code API ────────────────────────────────────────────────────────────

// @ts-expect-error — acquireVsCodeApi is injected by VS Code webview
const vscode = acquireVsCodeApi() as VscodeWebviewApi;

// Expose VS Code API globally for extensions (TableCommands CSV export, etc.)
window.__vscodeApi = vscode;

// Global reference to EditorView for TableView and table commands access
let globalEditorView: EditorView | null = null;

/** Get the current EditorView instance (used by TableView and table commands) */
export function getEditorView(): EditorView | null {
  return globalEditorView;
}

// ─── State ──────────────────────────────────────────────────────────────────

let currentContent = '';
let currentFilePath = '';
let autoFollowExternalEdits = true;
let isFullWidth = true;
let isTocVisible = true;
let isTableWrap = false; // default: disabled
let isSourceMode = false;
let canPostEditsToHost = false;
let sourceEditor: ReturnType<typeof createSourceEditor> | null = null;
let sourceModeController: SourceModeController | null = null;
const toggleSourceMode = (): void => { sourceModeController?.toggleSourceMode(); };
const openNativeSourceMode = (): void => { sourceModeController?.openNativeSourceMode(); };
let terminalAppearance: TerminalAppearance = {};
const dualHistory = new DualModeHistory();
const editOperationLog = new EditOperationLog();
let _skipDualHistoryRecord = false;
let _hasEditedInCurrentMode = false;
let _modeEntryContent = ''; // content snapshot when entering current mode
let toolbarShortcuts: ToolbarShortcutConfig = {
  openWithEasyView: 'Alt+E',
  toggleToc: 'Alt+W',
  toggleFullWidth: 'Alt+A',
  toggleTableWrap: 'Alt+D',
  toggleExternalFollow: 'Alt+F',
  toggleTheme: 'Alt+R',
  toggleTerminal: 'Alt+T',
  toggleStickyNote: 'Alt+N',
  openSourceMode: 'Alt+Q',
  copyOutlinePath: 'Alt+Shift+O',
  copyFullPath: 'Alt+Shift+P',
  stageFile: 'Alt+S',
  commitFile: 'Alt+C',
  scrollTop: 'Alt+ArrowUp',
  scrollBottom: 'Alt+ArrowDown',
};

interface StickyNoteFacade {
  open: () => void;
  close: () => void;
  toggle: () => void;
  setDocumentContent: (content: string) => void;
  isOpen: () => boolean;
  destroy: () => void;
}

function createNoopStickyNote(): StickyNoteFacade {
  return {
    open() {},
    close() {},
    toggle() {},
    setDocumentContent() {},
    isOpen() {
      return false;
    },
    destroy() {},
  };
}

function normalizeShortcutKeyLabel(value: string): string {
  const lower = value.trim().toLowerCase();
  if (!lower) return '';
  if (lower === 'up' || lower === 'arrowup') return 'ArrowUp';
  if (lower === 'down' || lower === 'arrowdown') return 'ArrowDown';
  if (lower === 'left' || lower === 'arrowleft') return 'ArrowLeft';
  if (lower === 'right' || lower === 'arrowright') return 'ArrowRight';
  if (lower === 'space' || lower === ' ') return 'Space';
  if (/^f\d{1,2}$/i.test(lower)) return lower.toUpperCase();
  if (lower.length === 1) return lower.toUpperCase();
  return value[0].toUpperCase() + value.slice(1).toLowerCase();
}

function parseShortcut(shortcut: string): {
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
} | null {
  const raw = shortcut.trim();
  if (!raw) return null;
  const parts = raw
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const parsed = {
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
    key: '',
  };
  for (const partRaw of parts) {
    const part = partRaw.toLowerCase();
    if (part === 'ctrl' || part === 'control') {
      parsed.ctrl = true;
      continue;
    }
    if (part === 'meta' || part === 'cmd' || part === 'command') {
      parsed.meta = true;
      continue;
    }
    if (part === 'alt' || part === 'option') {
      parsed.alt = true;
      continue;
    }
    if (part === 'shift') {
      parsed.shift = true;
      continue;
    }
    parsed.key = normalizeShortcutKeyLabel(partRaw);
  }
  return parsed.key ? parsed : null;
}

function eventMatchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return false;

  const code = event.code || '';
  const codeKeyMap: Record<string, string> = {
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backquote: '`',
    Space: 'Space',
    Tab: 'Tab',
    Enter: 'Enter',
    Escape: 'Escape',
    Delete: 'Delete',
    Backspace: 'Backspace',
  };
  let key = '';
  if (code.startsWith('Key') && code.length === 4) {
    key = code.slice(3).toUpperCase();
  } else if (code.startsWith('Digit') && code.length === 6) {
    key = code.slice(5);
  } else if (code.startsWith('Numpad') && code.length > 6) {
    const np = code.slice(6);
    const npMap: Record<string, string> = {
      Divide: '/',
      Multiply: '*',
      Subtract: '-',
      Add: '+',
      Decimal: '.',
      Enter: 'Enter',
    };
    key = npMap[np] ?? (np.length === 1 ? np : `Numpad${np}`);
  } else if (codeKeyMap[code]) {
    key = codeKeyMap[code];
  } else {
    const fallback = event.key === ' ' ? 'Space' : event.key;
    key = normalizeShortcutKeyLabel(fallback);
  }
  return (
    event.ctrlKey === parsed.ctrl &&
    event.metaKey === parsed.meta &&
    event.altKey === parsed.alt &&
    event.shiftKey === parsed.shift &&
    key === parsed.key
  );
}

function matchesToolbarShortcut(event: KeyboardEvent, action: ToolbarShortcutAction): boolean {
  return eventMatchesShortcut(event, toolbarShortcuts[action] || '');
}

function ensurePlaceholderHorizontalFlowStyles(): void {
  const styleId = 'easyview-placeholder-horizontal-flow';
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    .ProseMirror .easyview-placeholder-host {
      position: relative;
    }

    .ProseMirror .easyview-placeholder-host::before {
      content: attr(data-placeholder);
      position: absolute;
      left: 0;
      top: 0;
      display: block;
      max-width: calc(100% - 12px);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      overflow-wrap: normal;
      word-break: keep-all;
      writing-mode: horizontal-tb;
      text-orientation: mixed;
      pointer-events: none;
      user-select: none;
      vertical-align: top;
      color: var(--vscode-input-placeholderForeground, #888);
      font-style: italic;
      opacity: 0.6;
      z-index: 0;
    }
  `;
  document.head.appendChild(style);
}

function ensureMinimalGitChangeStyles(): void {
  const styleId = 'easyview-minimal-git-change-styles';
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    .ProseMirror .block-ai-modified,
    .ProseMirror .block-ai-added,
    .ProseMirror .block-ai-active,
    .ProseMirror .block-ai-fadeout {
      position: relative;
      background: transparent !important;
      background-image: none !important;
      box-shadow: none !important;
      border-left: none !important;
      border-radius: 0 !important;
    }

    .ProseMirror .block-ai-modified::before,
    .ProseMirror .block-ai-added::before,
    .ProseMirror .block-ai-fadeout::before {
      content: none !important;
      display: none !important;
    }

    .ProseMirror .block-ai-active::before {
      content: none !important;
    }

    .ai-left-markers {
      position: fixed;
      width: 2px;
      z-index: 60;
      pointer-events: none;
    }

    .ai-left-marker {
      position: absolute;
      left: 0;
      width: 2px;
      min-height: 6px;
      border-radius: 999px;
      background: var(--vscode-editorWarning-foreground, #f59e0b);
    }

    .ai-left-marker.added {
      background: var(--vscode-gitDecoration-addedResourceForeground, #10b981);
    }

    .ai-left-marker.modified {
      background: var(--vscode-editorWarning-foreground, #f59e0b);
    }
  `;
  document.head.appendChild(style);
}

function ensureEditorContentGutterStyles(): void {
  const styleId = 'easyview-editor-content-gutter';
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    #editor {
      padding-left: 8px !important;
      padding-right: 8px !important;
    }
    #editor.full-width,
    body.full-width #editor {
      padding-left: 36px !important;
      padding-right: 8px !important;
    }
    #source-editor {
      padding-left: 8px !important;
      padding-right: 8px !important;
    }
    .table-scrollable {
      padding-left: 16px !important;
      padding-right: 8px !important;
    }
    #editor:not(.full-width) .ProseMirror .table-wrapper {
      max-width: 100% !important;
    }
    .ProseMirror > h1 .block-drag-handle.with-heading-level,
    .ProseMirror > h2 .block-drag-handle.with-heading-level,
    .ProseMirror > h3 .block-drag-handle.with-heading-level,
    .ProseMirror > h4 .block-drag-handle.with-heading-level,
    .ProseMirror > h5 .block-drag-handle.with-heading-level,
    .ProseMirror > h6 .block-drag-handle.with-heading-level {
      margin-left: -34px;
    }
  `;
  document.head.appendChild(style);
}

function ensureTableWidthStyles(): void {
  const styleId = 'easyview-table-width-without-minimum';
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    /* Brighter table borders for better visibility */
    .ProseMirror table {
      border-color: rgba(160, 160, 160, 0.45) !important;
    }
    .ProseMirror th,
    .ProseMirror td {
      border-color: rgba(160, 160, 160, 0.45) !important;
      vertical-align: middle;
    }

    /* Opaque first-row band — same look when idle and when sticky clone is shown. */
    .ProseMirror table > tbody > tr:first-child > th,
    .ProseMirror table > tbody > tr:first-child > td,
    .ProseMirror tr[data-easyview-sticky="true"] > th,
    .ProseMirror tr[data-easyview-sticky="true"] > td,
    .easyview-sticky-table-header th,
    .easyview-sticky-table-header td {
      background: color-mix(
        in srgb,
        var(--vscode-editor-foreground, #cccccc) 7%,
        var(--vscode-editor-background, #1e1e1e)
      ) !important;
      border-bottom: 1px solid rgba(160, 160, 160, 0.45) !important;
    }

    .ProseMirror table > tbody > tr:first-child > .easyview-table-cell-content,
    .ProseMirror tr[data-easyview-sticky="true"] > .easyview-table-cell-content,
    .easyview-sticky-table-header .easyview-table-cell-content {
      background: inherit !important;
    }

    /* Explicit <col> widths are authoritative and must never be enlarged by
       the intrinsic width of text already inside the cell. */
    .ProseMirror table.table-manual-width {
      min-width: 0 !important;
      table-layout: fixed !important;
    }

    .ProseMirror table.table-manual-width th,
    .ProseMirror table.table-manual-width td {
      box-sizing: border-box;
      min-width: 0 !important;
      overflow: hidden;
    }

    /* Nested tables must not contribute min-content width to the host cell.
       Host columns can be dragged arbitrarily small or large; the nested table
       keeps its own width and scrolls horizontally inside the cell. */
    .ProseMirror td .table-wrapper,
    .ProseMirror th .table-wrapper {
      width: 0 !important;
      min-width: 100% !important;
      max-width: 100% !important;
      box-sizing: border-box;
    }

    .ProseMirror td .table-scrollable,
    .ProseMirror th .table-scrollable {
      width: 100%;
      max-width: 100%;
      min-width: 0;
      box-sizing: border-box;
    }

    .ProseMirror .table-wrapper > .table-scrollable {
      padding-top: 26px !important;
      padding-left: 36px !important;
      padding-right: 8px !important;
    }

    .ProseMirror td .table-wrapper > .table-scrollable,
    .ProseMirror th .table-wrapper > .table-scrollable {
      padding-right: 36px !important;
    }

    /* Row markers now live inside .table-scrollable so they follow scroll. */
    .table-wrapper.has-focus > .table-scrollable > .table-controls > .table-grip,
    .table-wrapper.has-focus > .table-scrollable > .table-controls > .table-grip-row,
    .table-wrapper.has-focus > .table-scrollable > .table-controls > .table-add-row {
      opacity: 1;
    }

    .ProseMirror .table-grip {
      width: 14px;
      height: 14px;
      z-index: 6;
    }

    /* A nested table wrapper fills the host cell. Centre the nested table
       itself so extra host-cell width appears as equal side gutters. */
    .ProseMirror td .table-wrapper > .table-scrollable > table,
    .ProseMirror th .table-wrapper > .table-scrollable > table {
      margin-left: auto;
      margin-right: auto;
    }

    /* See TableView.syncStickyHeader(): horizontal table scrollports prevent
       native CSS sticky cells from following the editor's vertical scrollport. */
    .easyview-sticky-table-header {
      position: fixed;
      z-index: 72;
      pointer-events: none;
      overflow: visible;
      background: transparent;
      box-shadow: none;
    }

    /* The normal table grip starts hidden until table focus. The sticky copy
       is an always-visible vertical-scroll anchor and remains interactive. */
    .easyview-sticky-table-grip {
      position: absolute;
      z-index: 8;
      pointer-events: auto;
      opacity: 1 !important;
      border-radius: 50%;
      background: var(--vscode-focusBorder, #007fd4);
      border: none;
      box-sizing: border-box;
      cursor: pointer;
    }

    .easyview-sticky-table-header .easyview-sticky-table {
      border-color: rgba(160, 160, 160, 0.45) !important;
    }

    .easyview-sticky-table-header th,
    .easyview-sticky-table-header td {
      border-color: rgba(160, 160, 160, 0.45) !important;
      font-weight: 500;
      text-transform: none;
      letter-spacing: 0;
      color: var(--vscode-editorWidget-foreground, var(--vscode-editor-foreground));
    }

    /* The fixed clone receives the source table's measured pixel width and
       computed border/cell styles in TableView. Do not force 100% here: that
       would let Chromium redistribute columns and misalign their boundaries. */
    .easyview-sticky-table-header .easyview-sticky-table {
      margin: 0 !important;
    }

    .easyview-sticky-table-header td,
    .easyview-sticky-table-header th {
      text-align: center;
      vertical-align: middle;
    }

    .easyview-sticky-table-header .easyview-table-cell-content {
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      text-align: center;
      background: inherit;
    }

    .ProseMirror td > .easyview-table-cell-content,
    .ProseMirror th > .easyview-table-cell-content {
      box-sizing: border-box;
      display: block;
      min-width: 0;
      max-width: 100%;
      min-height: 0;
    }

    /* Merged cells use their full rectangle as a flex viewport so short text
       is vertically centred by default, just like normal cells. */
    .ProseMirror td[data-easyview-merged-cell="true"],
    .ProseMirror th[data-easyview-merged-cell="true"] {
      vertical-align: middle !important;
      text-align: left !important;
    }
    .ProseMirror td[data-easyview-merged-cell="true"] > .easyview-table-cell-content,
    .ProseMirror th[data-easyview-merged-cell="true"] > .easyview-table-cell-content {
      display: flex !important;
      flex-direction: column;
      justify-content: center;
      align-items: stretch;
      width: 100% !important;
      min-height: 100%;
      height: 100% !important;
      max-height: none !important;
      overflow: visible !important;
      scrollbar-gutter: auto !important;
      text-align: left !important;
      white-space: normal !important;
      overflow-wrap: anywhere;
      word-break: normal;
    }

    /* A rowspan cell spans several logical rows. Remove its content from the
       table sizing flow so the merged area is governed by those rows rather
       than by a long paragraph, while retaining vertical centring and scroll. */
    .ProseMirror td[data-easyview-rowspan-merged],
    .ProseMirror th[data-easyview-rowspan-merged] {
      position: relative;
    }
    .ProseMirror td[data-easyview-rowspan-merged] > .easyview-table-cell-content,
    .ProseMirror th[data-easyview-rowspan-merged] > .easyview-table-cell-content {
      position: absolute !important;
      inset: 10px 14px !important;
      min-height: 0;
      height: auto !important;
      overflow-y: auto !important;
      overflow-x: auto;
    }

    /* Table cells: tighten list indent so bullets sit closer to the left edge. */
    .ProseMirror td ul,
    .ProseMirror td ol,
    .ProseMirror th ul,
    .ProseMirror th ol {
      padding-left: 12px;
    }

    .ProseMirror td li > ul.checkbox-list,
    .ProseMirror td li > ol,
    .ProseMirror td li > ul,
    .ProseMirror td li[data-type=checkbox_item] > ul,
    .ProseMirror td li[data-type=checkbox_item] > ol,
    .ProseMirror td li[data-type=checkbox_item] > ul.checkbox-list,
    .ProseMirror th li > ul.checkbox-list,
    .ProseMirror th li > ol,
    .ProseMirror th li > ul,
    .ProseMirror th li[data-type=checkbox_item] > ul,
    .ProseMirror th li[data-type=checkbox_item] > ol,
    .ProseMirror th li[data-type=checkbox_item] > ul.checkbox-list {
      padding-left: 12px;
    }

    .ProseMirror td[data-easyview-column-resized] > .easyview-table-cell-content,
    .ProseMirror th[data-easyview-column-resized] > .easyview-table-cell-content {
      width: 100%;
      min-width: 0;
      max-width: 100%;
      overflow-x: auto;
      overscroll-behavior-x: contain;
      overscroll-behavior-y: auto;
      /* Preserve the normal table-reading flow: ordinary text wraps to the
         explicit column width, then a fixed row-height viewport scrolls
         vertically when its content no longer fits. */
      white-space: normal;
      overflow-wrap: anywhere;
      word-break: normal;
    }

    /* Code remains an intentionally unbreakable payload. If it is wider than
       the resized cell, the cell/code viewport can still scroll horizontally. */
    .ProseMirror td[data-easyview-column-resized] > .easyview-table-cell-content code,
    .ProseMirror th[data-easyview-column-resized] > .easyview-table-cell-content code {
      white-space: nowrap;
      overflow-wrap: normal;
      word-break: normal;
    }

    .ProseMirror td[data-easyview-column-resized] > .easyview-table-cell-content pre,
    .ProseMirror th[data-easyview-column-resized] > .easyview-table-cell-content pre,
    .ProseMirror td[data-easyview-column-resized] > .easyview-table-cell-content pre code,
    .ProseMirror th[data-easyview-column-resized] > .easyview-table-cell-content pre code {
      white-space: pre;
      overscroll-behavior-x: contain;
    }

    .ProseMirror tr[data-easyview-row-height] > td > .easyview-table-cell-content,
    .ProseMirror tr[data-easyview-row-height] > th > .easyview-table-cell-content,
    .ProseMirror td[data-easyview-row-resized] > .easyview-table-cell-content,
    .ProseMirror th[data-easyview-row-resized] > .easyview-table-cell-content {
      position: absolute;
      min-height: 0;
      max-height: none;
      overflow-y: auto;
      overscroll-behavior: auto;
      scrollbar-gutter: stable;
    }

    /* Explicit row heights use the content node as the scroll viewport. The
       native td vertical-align property cannot reposition a full-height
       viewport, so TableCellView marks only short, non-overflowing content for
       scoped flex alignment. Overflow remains top-aligned and scrollable. */
    .ProseMirror tr[data-easyview-row-height] > td > .easyview-table-cell-content[data-easyview-vertical-alignment="middle"],
    .ProseMirror tr[data-easyview-row-height] > th > .easyview-table-cell-content[data-easyview-vertical-alignment="middle"],
    .ProseMirror td[data-easyview-row-resized] > .easyview-table-cell-content[data-easyview-vertical-alignment="middle"],
    .ProseMirror th[data-easyview-row-resized] > .easyview-table-cell-content[data-easyview-vertical-alignment="middle"] {
      display: flex;
      flex-direction: column;
      justify-content: center;
    }

    .ProseMirror tr[data-easyview-row-height] > td > .easyview-table-cell-content[data-easyview-vertical-alignment="bottom"],
    .ProseMirror tr[data-easyview-row-height] > th > .easyview-table-cell-content[data-easyview-vertical-alignment="bottom"],
    .ProseMirror td[data-easyview-row-resized] > .easyview-table-cell-content[data-easyview-vertical-alignment="bottom"],
    .ProseMirror th[data-easyview-row-resized] > .easyview-table-cell-content[data-easyview-vertical-alignment="bottom"] {
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
    }

    .ProseMirror tr[data-easyview-row-height] > td > .easyview-table-cell-content[data-easyview-vertical-alignment] > *,
    .ProseMirror tr[data-easyview-row-height] > th > .easyview-table-cell-content[data-easyview-vertical-alignment] > *,
    .ProseMirror td[data-easyview-row-resized] > .easyview-table-cell-content[data-easyview-vertical-alignment] > *,
    .ProseMirror th[data-easyview-row-resized] > .easyview-table-cell-content[data-easyview-vertical-alignment] > * {
      flex: 0 0 auto;
    }

    /* Keep table scrollbars visually stable. VS Code supplies a darker hover
       slider color by default; use the normal slider color in every state so
       hovering a horizontal or vertical table scrollbar never turns it black. */
    .ProseMirror .table-scrollable,
    .ProseMirror td[data-easyview-column-resized] > .easyview-table-cell-content,
    .ProseMirror th[data-easyview-column-resized] > .easyview-table-cell-content,
    .ProseMirror td[data-easyview-row-resized] > .easyview-table-cell-content,
    .ProseMirror th[data-easyview-row-resized] > .easyview-table-cell-content {
      scrollbar-color: var(--vscode-scrollbarSlider-background, rgba(128, 128, 128, 0.3)) transparent;
      scrollbar-width: thin;
      overflow-anchor: none;
    }

    .ProseMirror .table-scrollable::-webkit-scrollbar,
    .ProseMirror td[data-easyview-column-resized] > .easyview-table-cell-content::-webkit-scrollbar,
    .ProseMirror th[data-easyview-column-resized] > .easyview-table-cell-content::-webkit-scrollbar,
    .ProseMirror td[data-easyview-row-resized] > .easyview-table-cell-content::-webkit-scrollbar,
    .ProseMirror th[data-easyview-row-resized] > .easyview-table-cell-content::-webkit-scrollbar {
      width: 10px;
      height: 10px;
    }

    .ProseMirror .table-scrollable::-webkit-scrollbar-track,
    .ProseMirror td[data-easyview-column-resized] > .easyview-table-cell-content::-webkit-scrollbar-track,
    .ProseMirror th[data-easyview-column-resized] > .easyview-table-cell-content::-webkit-scrollbar-track,
    .ProseMirror td[data-easyview-row-resized] > .easyview-table-cell-content::-webkit-scrollbar-track,
    .ProseMirror th[data-easyview-row-resized] > .easyview-table-cell-content::-webkit-scrollbar-track {
      background: transparent;
    }

    .ProseMirror .table-scrollable::-webkit-scrollbar-thumb,
    .ProseMirror .table-scrollable::-webkit-scrollbar-thumb:hover,
    .ProseMirror .table-scrollable::-webkit-scrollbar-thumb:active,
    .ProseMirror td[data-easyview-column-resized] > .easyview-table-cell-content::-webkit-scrollbar-thumb,
    .ProseMirror td[data-easyview-column-resized] > .easyview-table-cell-content::-webkit-scrollbar-thumb:hover,
    .ProseMirror td[data-easyview-column-resized] > .easyview-table-cell-content::-webkit-scrollbar-thumb:active,
    .ProseMirror th[data-easyview-column-resized] > .easyview-table-cell-content::-webkit-scrollbar-thumb,
    .ProseMirror th[data-easyview-column-resized] > .easyview-table-cell-content::-webkit-scrollbar-thumb:hover,
    .ProseMirror th[data-easyview-column-resized] > .easyview-table-cell-content::-webkit-scrollbar-thumb:active,
    .ProseMirror td[data-easyview-row-resized] > .easyview-table-cell-content::-webkit-scrollbar-thumb,
    .ProseMirror td[data-easyview-row-resized] > .easyview-table-cell-content::-webkit-scrollbar-thumb:hover,
    .ProseMirror td[data-easyview-row-resized] > .easyview-table-cell-content::-webkit-scrollbar-thumb:active,
    .ProseMirror th[data-easyview-row-resized] > .easyview-table-cell-content::-webkit-scrollbar-thumb,
    .ProseMirror th[data-easyview-row-resized] > .easyview-table-cell-content::-webkit-scrollbar-thumb:hover,
    .ProseMirror th[data-easyview-row-resized] > .easyview-table-cell-content::-webkit-scrollbar-thumb:active {
      background: var(--vscode-scrollbarSlider-background, rgba(128, 128, 128, 0.3));
      border-radius: 5px;
    }

    .ProseMirror .table-scrollable::-webkit-scrollbar-corner {
      background: transparent;
    }

    /* Column-resize cursor must stay on the active table. Applying it to
       .ProseMirror restyles the entire document and flashes the screen. */
    .table-wrapper.easyview-col-resize-cursor,
    .table-wrapper.easyview-col-resize-cursor * {
      cursor: col-resize !important;
    }
  `;
  document.head.appendChild(style);
}

function updateGitChangeRailOffset(): void {
  const scrollArea = document.getElementById('editor-scroll-area');
  const proseMirror = document.querySelector('#editor .ProseMirror') as HTMLElement | null;
  if (!scrollArea || !proseMirror) return;

  const scrollRect = scrollArea.getBoundingClientRect();
  const paneInset = 6;
  // Anchor the change rail to the editor content edge, not to the first
  // rendered block. A wide table can have its first visible text column near
  // the center of the viewport while the editor content itself still starts
  // at the left gutter; using that block's rect moves the rail into the table.
  const contentLeft = proseMirror.getBoundingClientRect().left;
  const offset = Math.max(12, Math.round(contentLeft - scrollRect.left - paneInset));
  const nextOffset = `${offset}px`;
  if (proseMirror.style.getPropertyValue('--easyview-change-rail-offset') !== nextOffset) {
    proseMirror.style.setProperty('--easyview-change-rail-offset', nextOffset);
  }
}

function refreshChangeRailsAfterLayout(): void {
  const refresh = () => {
    updateGitChangeRailOffset();
    refreshAiChangeMarkers();
  };

  refresh();
  requestAnimationFrame(refresh);
  setTimeout(refresh, 60);
  setTimeout(refresh, 220);
}

function findFirstChangedLine(previousContent: string, nextContent: string): number | null {
  if (previousContent === nextContent) return null;
  const prevLines = previousContent.split('\n');
  const nextLines = nextContent.split('\n');
  const minCount = Math.min(prevLines.length, nextLines.length);

  for (let i = 0; i < minCount; i++) {
    if (prevLines[i] !== nextLines[i]) {
      return i + 1;
    }
  }

  return minCount + 1;
}

function getScrollPositionKey(content: string): string {
  let hash = 2166136261;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `easyview-md-scroll:${(hash >>> 0).toString(16)}`;
}

function restoreEditorScrollPosition(scrollArea: HTMLElement, content: string): void {
  const raw = localStorage.getItem(getScrollPositionKey(content));
  const top = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(top) || top <= 0) return;
  const restore = () => {
    const max = Math.max(0, scrollArea.scrollHeight - scrollArea.clientHeight);
    scrollArea.scrollTop = Math.min(top, max);
  };
  requestAnimationFrame(restore);
  setTimeout(restore, 80);
  setTimeout(restore, 240);
}

function persistEditorScrollPosition(scrollArea: HTMLElement, content: string): void {
  localStorage.setItem(getScrollPositionKey(content), String(Math.max(0, scrollArea.scrollTop)));
}

function scrollWysiwygToApproxLine(line: number, totalLines: number): void {
  const scrollArea = document.getElementById('editor-scroll-area');
  if (!scrollArea) return;

  const safeTotal = Math.max(1, totalLines);
  const safeLine = Math.min(Math.max(1, line), safeTotal);
  const ratio = (safeLine - 1) / Math.max(1, safeTotal - 1);
  const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const behavior: ScrollBehavior = prefersReducedMotion ? 'auto' : 'smooth';
  const animate = () => {
    const maxScrollTop = Math.max(0, scrollArea.scrollHeight - scrollArea.clientHeight);
    const targetTop = Number.isFinite(ratio) ? Math.round(maxScrollTop * ratio) : 0;
    scrollArea.scrollTo({ top: targetTop, behavior });
  };

  requestAnimationFrame(animate);
  setTimeout(animate, 50);
}

/** Show a brief toast notification */
function showToast(message: string) {
  const existing = document.querySelector('.inlinemd-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'inlinemd-toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  toast.offsetHeight;
  toast.classList.add('visible');
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 200);
  }, 2000);
}

function normalizeMarkdownLineForMatch(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s{0,3}>\s?/, '')
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+(?:\[(?: |x|X|~)\]\s+)?/, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~`]/g, '')
    .replace(/<\/?[^>]+>/g, '')
    .trim();
}

function findApproximateMarkdownPosition(
  markdown: string,
  lineText: string,
  textBeforeLine: string,
  wordPrefix: string
): { line: number; character: number } {
  const rawLines = markdown.split('\n');
  const normalizedLineText = normalizeMarkdownLineForMatch(lineText);
  const normalizedBefore = normalizeMarkdownLineForMatch(textBeforeLine);
  let best: { line: number; character: number; score: number } | null = null;

  for (let index = 0; index < rawLines.length; index++) {
    const rawLine = rawLines[index];
    const normalizedRaw = normalizeMarkdownLineForMatch(rawLine);
    let score = -1;

    if (normalizedBefore && normalizedRaw.includes(normalizedBefore)) {
      score = 3;
    } else if (normalizedLineText && normalizedRaw.includes(normalizedLineText)) {
      score = 2;
    } else if (wordPrefix && rawLine.toLowerCase().includes(wordPrefix.toLowerCase())) {
      score = 1;
    }

    if (score < 0) continue;

    let character = rawLine.length;
    const beforeIndex = textBeforeLine ? rawLine.indexOf(textBeforeLine) : -1;
    if (beforeIndex >= 0) {
      character = beforeIndex + textBeforeLine.length;
    } else {
      const wordIndex = wordPrefix ? rawLine.toLowerCase().lastIndexOf(wordPrefix.toLowerCase()) : -1;
      if (wordIndex >= 0) {
        character = wordIndex + wordPrefix.length;
      }
    }

    if (!best || score > best.score) {
      best = { line: index, character, score };
      if (score === 3) break;
    }
  }

  return best ? { line: best.line, character: best.character } : { line: 0, character: 0 };
}

interface WysiwygGhostSuggestion {
  anchor: number;
  replaceFrom: number;
  replaceTo: number;
  insertText: string;
  displayText: string;
}

interface WysiwygTabContext {
  anchor: number;
  replaceFrom: number;
  replaceTo: number;
  wordPrefix: string;
  approx: { line: number; character: number };
}

/** Update the settings comment line in CodeMirror when flags change */
function updateSourceSettingsComment(): void {
  return;
}

function postEdit(content: string): void {
  if (!canPostEditsToHost) {
    console.debug('[InLineMd] Suppressed pre-init edit sync', {
      length: content.length,
    });
    vscode.postMessage({
      type: 'openWithDebugLog',
      stage: 'suppressedPreInitEdit',
      meta: {
        editLength: content.length,
        currentContentLength: currentContent.length,
      },
    });
    return;
  }
  vscode.postMessage({
    type: 'openWithDebugLog',
    stage: 'postEdit',
    meta: {
      editLength: content.length,
      currentContentLength: currentContent.length,
    },
  });
  vscode.postMessage({
    type: 'edit',
    content,
    fullWidth: isFullWidth,
    tocVisible: isTocVisible,
    tableWrap: isTableWrap,
  });
}

type HeadingBreadcrumbEntry = { level: number; text: string; pos: number };

function normalizeHeadingText(text: string): string {
  const normalized = text
    .replace(/\s+#+\s*$/g, '')
    .replace(/[*_~`]/g, '')
    .trim();
  return normalized || '(empty)';
}

function computeHeadingBreadcrumbFromMarkdown(markdown: string, targetLine: number): string {
  const lines = markdown.split('\n');
  const stack: Array<{ level: number; text: string }> = [];
  let inFence = false;

  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1;
    if (lineNo > targetLine) break;

    const line = lines[index];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (!match) continue;

    const level = match[1].length;
    const text = normalizeHeadingText(match[2] || '');
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }
    stack.push({ level, text });
  }

  return stack.map((entry) => entry.text).join('》');
}

function computeHeadingBreadcrumbForPos(pos: number): string {
  const doc = globalEditorView?.state.doc;
  if (!doc) return '';
  const stack: HeadingBreadcrumbEntry[] = [];

  doc.forEach((node, offset) => {
    if (offset > pos) return;
    if (node.type.name !== 'heading') return;
    const rawLevel = Number(node.attrs.level);
    if (!Number.isFinite(rawLevel) || rawLevel < 1 || rawLevel > 6) return;
    while (stack.length > 0 && stack[stack.length - 1].level >= rawLevel) {
      stack.pop();
    }
    stack.push({
      level: rawLevel,
      text: normalizeHeadingText(node.textContent || ''),
      pos: offset,
    });
  });

  return stack.map((entry) => entry.text).join('》');
}

function getCurrentSelectionAnchorPos(): number {
  return globalEditorView?.state.selection.from ?? 0;
}

function getCurrentOutlinePath(): string {
  if (isSourceMode && sourceEditor) {
    const head = sourceEditor.view.state.selection.main.head;
    const line = sourceEditor.view.state.doc.lineAt(head).number;
    return computeHeadingBreadcrumbFromMarkdown(sourceEditor.getContent(), line);
  }
  return computeHeadingBreadcrumbForPos(getCurrentSelectionAnchorPos());
}

async function copyTextToClipboard(text: string, successMessage: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      showToast(successMessage);
      return;
    }
  } catch {
    // Fall back to host clipboard.
  }
  vscode.postMessage({ type: 'copyTextToClipboard', text, successMessage });
}

async function copyOutlinePathText(outline: string): Promise<void> {
  if (!outline) {
    showToast('No outline path found');
    return;
  }
  const fileName = currentFilePath.split(/[\\/]/).pop()?.trim() || 'Unknown.md';
  await copyTextToClipboard(`文件：${fileName}\n内容位置：${outline}`, 'Copied outline path');
}

async function copyOutlinePathForSelection(): Promise<void> {
  await copyOutlinePathText(getCurrentOutlinePath());
}

async function copyOutlinePathAtPos(pos: number): Promise<void> {
  await copyOutlinePathText(computeHeadingBreadcrumbForPos(pos));
}

async function copyFullPathForSelection(): Promise<void> {
  const outline = getCurrentOutlinePath();
  if (!outline) {
    showToast('No outline path found');
    return;
  }
  await copyTextToClipboard(`文件：${currentFilePath}\n内容位置：${outline}`, 'Copied file and outline path');
}

/** Detect if VS Code is using a dark theme */
function isDarkTheme(): boolean {
  try {
    const stored = localStorage.getItem('mdpre-zalman-theme');
    if (stored === 'light') return false;
    if (stored === 'dark') return true;
  } catch {
    // Webview storage can be unavailable in restricted contexts.
  }
  try {
    let bgColor = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim();
    if (bgColor) {
      let r, g, b;
      if (bgColor.startsWith('#')) {
        const hex = bgColor.replace('#', '');
        r = parseInt(hex.substring(0, 2), 16) / 255;
        g = parseInt(hex.substring(2, 4), 16) / 255;
        b = parseInt(hex.substring(4, 6), 16) / 255;
      } else {
        const rgb = bgColor.match(/\d+/g);
        if (rgb && rgb.length >= 3) {
          r = parseInt(rgb[0]) / 255;
          g = parseInt(rgb[1]) / 255;
          b = parseInt(rgb[2]) / 255;
        } else {
          return false;
        }
      }
      return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
    }
  } catch (e) {
    console.warn('Could not detect theme', e);
  }
  return false;
}

// ─── Toggle All Headings ────────────────────────────────────────────────────

function toggleAllHeadings(view: EditorView, collapse: boolean): void {
  const { doc } = view.state;
  const tr = view.state.tr;
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, collapsed: collapse });
    }
  });
  if (tr.docChanged) view.dispatch(tr);
}

// ─── Editor Initialization ──────────────────────────────────────────────────

function initEditor() {
  const tInit = performance.now();
  console.log('[InLineMd perf] initEditor START');

  const editorElement = document.getElementById('editor');
  if (!editorElement) {
    console.error('Editor element not found');
    return;
  }

  const wysiwygGhostEl = document.createElement('span');
  wysiwygGhostEl.style.position = 'fixed';
  wysiwygGhostEl.style.display = 'none';
  wysiwygGhostEl.style.pointerEvents = 'none';
  wysiwygGhostEl.style.whiteSpace = 'pre';
  wysiwygGhostEl.style.color =
    'var(--vscode-inlineSuggestion-foreground, var(--vscode-editorGhostText-foreground, rgba(128, 128, 128, 0.7)))';
  wysiwygGhostEl.style.opacity = '0.9';
  wysiwygGhostEl.style.zIndex = '40';
  document.body.appendChild(wysiwygGhostEl);

  let wysiwygGhostSuggestion: WysiwygGhostSuggestion | null = null;
  let wysiwygGhostRequestToken = 0;
  let wysiwygGhostTimer: ReturnType<typeof setTimeout> | null = null;
  let hideWysiwygGhost = () => {
    wysiwygGhostSuggestion = null;
    wysiwygGhostEl.style.display = 'none';
    wysiwygGhostEl.textContent = '';
  };
  let renderWysiwygGhost = () => {
    wysiwygGhostEl.style.display = 'none';
  };
  let getWysiwygTabContext = (_pmView: EditorView): WysiwygTabContext | null => null;
  let scheduleWysiwygGhost: ((pmView: EditorView) => void) | null = null;
  let runWysiwygTabCompletion: ((pmView: EditorView) => boolean) | null = null;
  let cachedLineMapMarkdown = '';
  let cachedTextblockLineMap: number[] = [];
  let cachedMarkdownLines: string[] = [];

  // Apply default table-wrap class (enabled by default)
  editorElement.classList.add('table-wrap');
  window.dispatchEvent(new CustomEvent('easyview-table-wrap-layout-change'));

  const isDark = isDarkTheme();

  // 1. Create extensions (order matters for keymap priority)
  const tExt = performance.now();
  const extensions = [
    new KeyboardOverridesExtension(),
    new ListsExtension(),
    new SmartTextExtension(),
    new MarksExtension(),
    new HeadingExtension(),
    new BlockquoteExtension(),
    new CodeBlockExtension(),
    new NoticeExtension(),
    new HorizontalRuleExtension(),
    new TableExtension(),
    new ImageExtension(),
    new MermaidExtension(isDark),
    new PlantUmlExtension(),
    new ExternalDiagramExtension(),
    new FrontmatterExtension(),
    new DetailsExtension(),
    new HtmlBlockExtension(),
    new DrawioExtension(),
    new MathExtension(),
    new FootnotesExtension(),
    new InlineDiffExtension(),
    new DescriptionListExtension(),
    new TocExtension(),
    new VideoAudioExtension(),
    new EmojiExtension(),
    new BlockDragExtension(),
    new SlashMenuExtension(),
    new FindReplaceExtension(),
    new BlockEdgeCursorExtension(),
    new InlineCursorExtension(),
    new MarkBoundaryExtension(),
    new TrailingNodeExtension(),
    new PlaceholderExtension(),
    new ClipboardExtension(),
    new AiChangesExtension(),
  ];

  console.log(`[InLineMd perf] create extensions: ${(performance.now() - tExt).toFixed(1)}ms`);

  // Register toast callback for HeadingExtension (anchor link copy)
  setToastFunction(showToast);
  setHeadingOutlinePathCopyHandler((headingPos) => {
    void copyOutlinePathAtPos(headingPos);
  });

  // 2. Create UI components
  const tUI = performance.now();
  const fileHeader = createFileHeader({
    postMessage: (msg) => vscode.postMessage(msg),
    getState: () => ({
      isFullWidth,
      isTocVisible,
      isTableWrap,
      currentContent,
    }),
    setState: (patch) => {
      if (patch.isFullWidth !== undefined) isFullWidth = patch.isFullWidth;
      if (patch.isTocVisible !== undefined) isTocVisible = patch.isTocVisible;
      if (patch.isTableWrap !== undefined) isTableWrap = patch.isTableWrap;
    },
    onSettingsChange: () => updateSourceSettingsComment(),
  });
  fileHeader.setShortcutChangeHandler((config) => {
    toolbarShortcuts = config;
    vscode.postMessage({
      type: 'syncOpenEditorShortcut',
      shortcut: config.openWithEasyView,
    });
  });
  fileHeader.setExternalFollowHandler((enabled) => {
    autoFollowExternalEdits = enabled;
  });
  const editorBody = document.getElementById('editor-body');
  if (editorBody) {
    editorBody.parentElement?.insertBefore(fileHeader.el, editorBody);
  }
  const toolbar = new FloatingToolbar();
  window.addEventListener('easyview-table-cell-popup-open', () => toolbar.forceHide());
  (window as any).__easyviewCopyOutlinePath = () => {
    void copyOutlinePathForSelection();
  };
  (window as any).__easyviewCopyFullPath = () => {
    void copyFullPathForSelection();
  };
  console.log(`[InLineMd perf] create UI (FileHeader+Toolbar): ${(performance.now() - tUI).toFixed(1)}ms`);
  let stickyNote: StickyNoteFacade = createNoopStickyNote();
  const terminalModal = createTerminalModal({
    postMessage: (msg) => vscode.postMessage(msg),
    appearance: terminalAppearance,
    onVisibilityChange: (visible) => fileHeader.syncTerminalState(visible),
  });

  const runNativeWysiwygTab = (pmView: EditorView, backwards = false): boolean => {
    if (goToNextCell(backwards ? -1 : 1)(pmView.state, pmView.dispatch)) {
      return true;
    }
    if (backwards) return false;
    const { from, to } = pmView.state.selection;
    pmView.dispatch(pmView.state.tr.insertText('\t', from, to));
    return true;
  };
  let updateTocStatusBar = () => {};
  let refreshHistoryPanel = () => {};

  // 3. Create EditorCore
  const tCore = performance.now();
  const editor = new EditorCore({
    extensions,
    keymaps: {
      Tab: (_state, _dispatch, view) => (view ? runNativeWysiwygTab(view, false) : false),
      'Shift-Tab': (_state, _dispatch, view) => (view ? runNativeWysiwygTab(view, true) : false),
      'Ctrl-k': (_state, _dispatch, view) => {
        if (view) linkEditPopup.toggle(view);
        return true;
      },
      'Mod-s': () => {
        editor.flushSync();
        vscode.postMessage({ type: 'save' });
        return true;
      },
    },
    onDispatch(view, tr) {
      toolbar.update(view);
      // Hide image toolbar when selection moves away from image
      const sel = view.state.selection;
      if (!(sel instanceof NodeSelection) || sel.node.type.name !== 'image') {
        if (imageToolbar.visible) imageToolbar.hide();
      }
      toc.update(view, {
        docChanged: tr.docChanged,
        selectionSet: tr.selectionSet,
      });
      updateTocStatusBar();
      if (tr.docChanged || tr.selectionSet) {
        hideWysiwygGhost();
        scheduleWysiwygGhost?.(view);
      } else {
        renderWysiwygGhost();
      }

      if (tr.docChanged && !isHistoryTransaction(tr) && tr.getMeta('addToHistory') !== false) {
        const label = describeProseMirrorTransaction(tr);
        if (label) editOperationLog.notePendingLabel(label, 'wysiwyg');
      }
      editOperationLog.sync(undoDepth(view.state), redoDepth(view.state), 'wysiwyg');
      refreshHistoryPanel();
    },
    onContentChange(markdown) {
      _hasEditedInCurrentMode = true;
      currentContent = markdown;
      postEdit(markdown);
    },
    onImageClick(view, pos, node, dom) {
      imageToolbar.show(view, pos, node, dom);
    },
    onOpenLink(href) {
      vscode.postMessage({ type: 'openLink', url: href });
    },
    onLinkSelect(view, href) {
      linkEditPopup.show(view, href);
    },
    onUndoExhausted() {
      const md = editor.getMarkdown();
      // Skip snapshots with identical content (no-op mode switches)
      dualHistory.skipIdenticalUndos(md);
      const snapshot = dualHistory.crossModeUndo(md, 'wysiwyg');
      if (!snapshot) return false;
      if (snapshot.mode === 'source') {
        _skipDualHistoryRecord = true;
        toggleSourceMode();
        _skipDualHistoryRecord = false;
      } else if (snapshot.editorState) {
        // Restore exact saved PM state (with full undo history)
        editor.view!.updateState(snapshot.editorState);
        currentContent = snapshot.markdown;
        postEdit(snapshot.markdown);
      } else {
        // Fallback: restore content via setContent
        editor.isUpdatingFromExtension = true;
        editor.setContent(snapshot.markdown);
        editor.isUpdatingFromExtension = false;
        currentContent = snapshot.markdown;
        postEdit(snapshot.markdown);
      }
      return true;
    },
    onRedoExhausted() {
      const md = editor.getMarkdown();
      const snapshot = dualHistory.crossModeRedo(md, 'wysiwyg');
      if (!snapshot) return false;
      if (snapshot.mode === 'source') {
        _skipDualHistoryRecord = true;
        toggleSourceMode();
        _skipDualHistoryRecord = false;
      } else if (snapshot.editorState) {
        editor.view!.updateState(snapshot.editorState);
        currentContent = snapshot.markdown;
        postEdit(snapshot.markdown);
      }
      return true;
    },
  });

  console.log(`[InLineMd perf] new EditorCore(): ${(performance.now() - tCore).toFixed(1)}ms`);

  try {
    stickyNote = createStickyNoteModal({
      getDocumentContent: () =>
        isSourceMode && sourceEditor
          ? stripSettingsComment(sourceEditor.getContent())
          : currentContent || editor.getMarkdown(),
      commitDocumentContent: (content, options) => {
        currentContent = content;
        if (isSourceMode && sourceEditor) {
          sourceEditor.setContent(content);
          updateTocStatusBar();
        } else {
          editor.setContent(content, false, { scrollIntoView: false });
          updateTocStatusBar();
        }
        postEdit(content);
        if (options?.save) {
          vscode.postMessage({ type: 'save' });
        }
      },
      requestTabCompletion({ line, character, wordPrefix }) {
        return requestTabCompletionFromHost(line, character, wordPrefix);
      },
      onVisibilityChange: (visible) => {
        fileHeader.syncStickyNoteState(visible);
      },
    });
  } catch (error) {
    console.error('[InLineMd] Sticky note initialization failed:', error);
    vscode.postMessage({
      type: 'webviewRuntimeError',
      source: 'sticky-note-init',
      message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      stack: error instanceof Error ? (error.stack ?? '') : '',
    });
    stickyNote = createNoopStickyNote();
  }

  // 4. Initialize editor
  const tEditorInit = performance.now();
  editor.init(editorElement);
  console.log(`[InLineMd perf] editor.init(): ${(performance.now() - tEditorInit).toFixed(1)}ms`);

  const view = editor.view!;
  globalEditorView = view;
  window.addEventListener('resize', renderWysiwygGhost);
  window.addEventListener('resize', updateGitChangeRailOffset);
  window.addEventListener('easyview-toc-layout-change', refreshChangeRailsAfterLayout);
  window.addEventListener('easyview-editor-layout-change', refreshChangeRailsAfterLayout);
  const editorScrollArea = document.getElementById('editor-scroll-area');
  editorScrollArea?.addEventListener('scroll', renderWysiwygGhost, { passive: true });
  if (editorScrollArea) {
    editorScrollArea.addEventListener('scroll', () => {
      persistEditorScrollPosition(editorScrollArea, currentContent || editor.getMarkdown());
    }, { passive: true });
    restoreEditorScrollPosition(editorScrollArea, currentContent || editor.getMarkdown());
  }
  const layoutController = new LayoutController({
    editorElement,
    scrollArea: document.getElementById('editor-scroll-area'),
    editorBody: document.getElementById('editor-body'),
    isSourceMode: () => isSourceMode,
    getSourceEditor: () => sourceEditor,
    updateGitChangeRailOffset,
    refreshAiChangeMarkers,
    refreshChangeRailsAfterLayout,
    getView: () => editor.view,
    isDarkTheme,
  }, isDark);

  editorElement.addEventListener('focusout', () => {
    wysiwygGhostRequestToken++;
    hideWysiwygGhost();
  });
  toolbar.attach(view);

  // Initialize custom context menu (Cut/Copy/Paste/Paste as Text)
  const contextPasteParser = createPasteParser();
  initContextMenu(
    editorElement,
    () => editor.view,
    () => contextPasteParser
  );

  // Create Find & Replace panel
  const findReplacePanel = new FindAndReplacePanel(view);
  findReplacePanel.setSourceCallbacks(
    () => sourceEditor,
    () => isSourceMode
  );

  // Create Table of Contents sidebar
  const toc = new TableOfContents(view);

  // Create History panel — pure visualizer, reads from PM/CM/DualHistory
  const historyPanel = new HistoryPanel({
    getView: () => editor.view,
    getDualHistory: () => dualHistory,
    getOperationLog: () => editOperationLog,
    getIsSourceMode: () => isSourceMode,
    getSourceView: () => sourceEditor?.view ?? null,
    triggerUndo() {
      if (isSourceMode && sourceEditor) {
        cmUndo(sourceEditor.view);
      } else if (editor.view) {
        undo(editor.view.state, editor.view.dispatch);
      }
    },
    triggerRedo() {
      if (isSourceMode && sourceEditor) {
        cmRedo(sourceEditor.view);
      } else if (editor.view) {
        redo(editor.view.state, editor.view.dispatch);
      }
    },
    onVisibilityChange(visible) {
      fileHeader.getHistoryBtn().classList.toggle('active', visible);
      refreshChangeRailsAfterLayout();
    },
  });
  refreshHistoryPanel = () => historyPanel.refresh();

  // 5. Wire file header handlers
  fileHeader.setScrollTopHandler(() => layoutController.scrollTop());
  fileHeader.setScrollBottomHandler(() => layoutController.scrollBottom());

  fileHeader.setStageHandler(() => {
    editor.flushSync();
    vscode.postMessage({ type: 'stageFile' });
  });
  fileHeader.setCommitHandler(() => {
    editor.flushSync();
    fileHeader.openCommitModal();
    fileHeader.setCommitMessageLoading(true);
    vscode.postMessage({ type: 'generateCommitMessage' });
  });
  fileHeader.setCommitConfirmHandler((message) => {
    editor.flushSync();
    fileHeader.setCommitInProgress(true, 'commit');
    vscode.postMessage({ type: 'commitFile', message });
  });
  fileHeader.setCommitSyncHandler((message) => {
    editor.flushSync();
    fileHeader.setCommitInProgress(true, 'sync');
    vscode.postMessage({ type: 'syncFile', message });
  });
  fileHeader.setTerminalHandler(() => {
    terminalModal.toggle();
  });
  fileHeader.setHistoryHandler(() => {
    historyPanel.toggle();
  });
  fileHeader.setTocHandler(() => {
    toc.toggle();
    refreshChangeRailsAfterLayout();
  });

  let isAllCollapsed = false;
  fileHeader.setCollapseHandler(() => {
    isAllCollapsed = !isAllCollapsed;
    toggleAllHeadings(view, isAllCollapsed);
  });

  const exportController = new ExportController({
    editor,
    view,
    fileHeader,
    vscode,
    isSourceMode: () => isSourceMode,
    getSourceEditor: () => sourceEditor,
  });
  exportController.installImageResolutionBridge();
  exportController.registerFileHeaderHandlers();


  hideWysiwygGhost = () => {
    wysiwygGhostSuggestion = null;
    wysiwygGhostEl.style.display = 'none';
    wysiwygGhostEl.textContent = '';
  };

  renderWysiwygGhost = () => {
    if (isSourceMode || !editor.view || !wysiwygGhostSuggestion) {
      wysiwygGhostEl.style.display = 'none';
      return;
    }

    const selection = editor.view.state.selection;
    if (!selection.empty || selection.from !== wysiwygGhostSuggestion.anchor) {
      wysiwygGhostEl.style.display = 'none';
      return;
    }

    try {
      const caretRect = editor.view.coordsAtPos(wysiwygGhostSuggestion.anchor);
      const fontSource = (window.getSelection()?.anchorNode?.parentElement as HTMLElement | null) ?? editorElement;
      const computed = getComputedStyle(fontSource);

      wysiwygGhostEl.textContent = wysiwygGhostSuggestion.displayText;
      wysiwygGhostEl.style.left = `${caretRect.left}px`;
      wysiwygGhostEl.style.top = `${caretRect.top}px`;
      wysiwygGhostEl.style.lineHeight = `${caretRect.bottom - caretRect.top}px`;
      wysiwygGhostEl.style.fontFamily = computed.fontFamily;
      wysiwygGhostEl.style.fontSize = computed.fontSize;
      wysiwygGhostEl.style.fontWeight = computed.fontWeight;
      wysiwygGhostEl.style.fontStyle = computed.fontStyle;
      wysiwygGhostEl.style.letterSpacing = computed.letterSpacing;
      wysiwygGhostEl.style.display = 'block';
    } catch {
      wysiwygGhostEl.style.display = 'none';
    }
  };

  const getWysiwygApproxSourcePosition = (pmView: EditorView): { line: number; character: number } => {
    const selection = pmView.state.selection;
    const head = selection.from;
    const $from = pmView.state.doc.resolve(head);
    if (!$from.parent.isTextblock) return { line: 0, character: 0 };

    const textBeforeBlock = $from.parent.textBetween(0, $from.parentOffset, '\n', '\n');
    const textBeforeLine = textBeforeBlock.split('\n').at(-1) ?? textBeforeBlock;
    const fullBlockText = $from.parent.textBetween(0, $from.parent.content.size, '\n', '\n');
    const blockLines = fullBlockText.split('\n');
    const currentLineIndex = Math.max(0, textBeforeBlock.split('\n').length - 1);
    const lineText = blockLines[currentLineIndex] ?? fullBlockText;
    const wordPrefixMatch = textBeforeLine.match(/[\p{L}\p{N}_-]+$/u);
    const wordPrefix = wordPrefixMatch?.[0] ?? '';
    const markdown = currentContent || editor.getMarkdown();
    const approx = findApproximateMarkdownPosition(markdown, lineText, textBeforeLine, wordPrefix);

    if (cachedLineMapMarkdown !== markdown) {
      cachedLineMapMarkdown = markdown;
      cachedTextblockLineMap = extractTextblockLineMap(markdown);
      cachedMarkdownLines = markdown.split('\n');
    }

    let textblockOrdinal = 0;
    let targetOrdinal = -1;
    pmView.state.doc.descendants((node, pos) => {
      if (!node.isTextblock) return;
      const from = pos + 1;
      const to = from + node.content.size;
      if (targetOrdinal === -1 && head >= from && head <= to) {
        targetOrdinal = textblockOrdinal;
        return false;
      }
      textblockOrdinal++;
    });

    if (targetOrdinal >= 0 && targetOrdinal < cachedTextblockLineMap.length) {
      const mappedLine1Based = cachedTextblockLineMap[targetOrdinal];
      const rawLine = cachedMarkdownLines[Math.max(0, mappedLine1Based - 1)] ?? '';
      const beforeIdx = textBeforeLine ? rawLine.indexOf(textBeforeLine) : -1;
      const character = beforeIdx >= 0 ? beforeIdx + textBeforeLine.length : approx.character;
      return {
        line: Math.max(0, mappedLine1Based - 1),
        character: Math.max(0, character),
      };
    }

    return approx;
  };

  updateTocStatusBar = () => {
    const markdown =
      isSourceMode && sourceEditor
        ? stripSettingsComment(sourceEditor.getContent())
        : currentContent || editor.getMarkdown();

    if (isSourceMode && sourceEditor) {
      const sourceSelection = sourceEditor.view.state.selection.main;
      const head = sourceSelection.head;
      const line = sourceEditor.view.state.doc.lineAt(head);
      toc.setStatus({
        totalChars: markdown.length,
        line: line.number,
        selectedChars: Math.abs(sourceSelection.to - sourceSelection.from),
      });
      return;
    }

    if (editor.view) {
      const approx = getWysiwygApproxSourcePosition(editor.view);
      const pmSelection = editor.view.state.selection;
      toc.setStatus({
        totalChars: markdown.length,
        line: approx.line + 1,
        selectedChars: Math.abs(pmSelection.to - pmSelection.from),
      });
      return;
    }

    toc.setStatus({
      totalChars: markdown.length,
      line: 1,
      selectedChars: 0,
    });
  };
  updateTocStatusBar();

  getWysiwygTabContext = (pmView: EditorView) => {
    const selection = pmView.state.selection;
    if (!selection.empty) return null;

    const { $from } = selection;
    if (!$from.parent.isTextblock) return null;

    const textBeforeBlock = $from.parent.textBetween(0, $from.parentOffset, '\n', '\n');
    const textBeforeLine = textBeforeBlock.split('\n').at(-1) ?? textBeforeBlock;
    const wordPrefixMatch = textBeforeLine.match(/[\p{L}\p{N}_-]+$/u);
    const wordPrefix = wordPrefixMatch?.[0] ?? '';
    if (textBeforeLine.trim().length === 0) return null;

    const approx = getWysiwygApproxSourcePosition(pmView);

    return {
      anchor: selection.from,
      replaceFrom: selection.from - wordPrefix.length,
      replaceTo: selection.from,
      wordPrefix,
      approx,
    };
  };

  scheduleWysiwygGhost = (pmView: EditorView) => {
    wysiwygGhostRequestToken++;
    if (wysiwygGhostTimer) {
      clearTimeout(wysiwygGhostTimer);
      wysiwygGhostTimer = null;
    }

    const context = getWysiwygTabContext(pmView);
    if (!context) {
      hideWysiwygGhost();
      return;
    }

    const requestToken = wysiwygGhostRequestToken;
    wysiwygGhostTimer = setTimeout(() => {
      void requestTabCompletionFromHost(context.approx.line, context.approx.character, context.wordPrefix)
        .then((completion) => {
          if (requestToken !== wysiwygGhostRequestToken || !editor.view) return;

          const activeSelection = editor.view.state.selection;
          if (!activeSelection.empty || activeSelection.from !== context.anchor) return;

          const insertText = completion?.insertText ?? '';
          const currentText = editor.view.state.doc.textBetween(context.replaceFrom, context.replaceTo, '\n', '\n');
          const displayText = insertText.startsWith(currentText) ? insertText.slice(currentText.length) : insertText;

          if (!displayText) {
            hideWysiwygGhost();
            return;
          }

          wysiwygGhostSuggestion = {
            anchor: context.anchor,
            replaceFrom: context.replaceFrom,
            replaceTo: context.replaceTo,
            insertText,
            displayText,
          };
          renderWysiwygGhost();
        })
        .catch(() => {
          if (requestToken === wysiwygGhostRequestToken) {
            hideWysiwygGhost();
          }
        });
    }, 120);
  };

  const requestTabCompletionFromHost = (
    line: number,
    character: number,
    wordPrefix: string
  ): Promise<{
    insertText: string;
    replaceStartCharacter?: number;
    replaceEndCharacter?: number;
  } | null> => {
    return new Promise((resolve) => {
      const requestId = Math.random().toString(36).slice(2, 11);
      const timeout = setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve(null);
      }, 1200);

      const handler = (event: MessageEvent) => {
        const message = event.data;
        if (message?.type !== 'tabCompletionResponse' || message.requestId !== requestId) return;
        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        if (typeof message.insertText !== 'string' || !message.insertText) {
          resolve(null);
          return;
        }
        resolve({
          insertText: message.insertText,
          replaceStartCharacter:
            typeof message.replaceStartCharacter === 'number' ? message.replaceStartCharacter : undefined,
          replaceEndCharacter:
            typeof message.replaceEndCharacter === 'number' ? message.replaceEndCharacter : undefined,
        });
      };

      window.addEventListener('message', handler);
      vscode.postMessage({
        type: 'requestTabCompletion',
        requestId,
        line,
        character,
        wordPrefix,
      });
    });
  };

  runWysiwygTabCompletion = (pmView: EditorView): boolean => {
    const selection = pmView.state.selection;
    if (!selection.empty) return false;

    if (wysiwygGhostSuggestion && selection.from === wysiwygGhostSuggestion.anchor) {
      pmView.dispatch(
        pmView.state.tr.insertText(
          wysiwygGhostSuggestion.insertText,
          wysiwygGhostSuggestion.replaceFrom,
          wysiwygGhostSuggestion.replaceTo
        )
      );
      hideWysiwygGhost();
      pmView.focus();
      return true;
    }

    const context = getWysiwygTabContext(pmView);
    if (!context) return false;

    void requestTabCompletionFromHost(context.approx.line, context.approx.character, context.wordPrefix).then(
      (completion) => {
        if (!completion?.insertText || !editor.view) return;

        const activeSelection = editor.view.state.selection;
        if (!activeSelection.empty || activeSelection.from !== context.anchor) return;

        editor.view.dispatch(
          editor.view.state.tr.insertText(completion.insertText, context.replaceFrom, context.replaceTo)
        );
        hideWysiwygGhost();
        editor.view.focus();
      }
    );

    return true;
  };

  // 6. Source mode toggle
  sourceModeController = new SourceModeController({
    editor,
    vscode,
    fileHeader,
    toolbar,
    toc,
    dualHistory,
    editOperationLog,
    historyPanel,
    getSourceEditor: () => sourceEditor,
    setSourceEditor: (value) => { sourceEditor = value; },
    getView: () => editor.view,
    getCurrentContent: () => currentContent,
    setCurrentContent: (content) => { currentContent = content; },
    isSourceMode: () => isSourceMode,
    setSourceMode: (value) => { isSourceMode = value; },
    getFullWidth: () => isFullWidth,
    getTocVisible: () => isTocVisible,
    getTableWrap: () => isTableWrap,
    getSkipHistoryRecord: () => _skipDualHistoryRecord,
    setSkipHistoryRecord: (value) => { _skipDualHistoryRecord = value; },
    setHasEditedInCurrentMode: (value) => { _hasEditedInCurrentMode = value; },
    setModeEntryContent: (content) => { _modeEntryContent = content; },
    hideGhost: () => hideWysiwygGhost(),
    postEdit,
    requestTabCompletion: requestTabCompletionFromHost,
    describeSourceDocChange,
    syncSourceHistory: (state) => {
      editOperationLog.sync(cmUndoDepth(state), cmRedoDepth(state), 'source');
    },
    updateTocStatus: updateTocStatusBar,
    scheduleWysiwygGhost: (currentView) => scheduleWysiwygGhost(currentView),
    getWysiwygApproxSourcePosition,
  });

  fileHeader.setSourceHandler(() => openNativeSourceMode());
  fileHeader.setStickyNoteHandler(() => {
    stickyNote.toggle();
  });

  new ShortcutController({
    vscode,
    fileHeader,
    layout: layoutController,
    terminal: terminalModal,
    stickyNote,
    getShortcut: (action) => toolbarShortcuts[action],
    matchesShortcut: eventMatchesShortcut,
    isSourceMode: () => isSourceMode,
    toggleSourceMode,
    openNativeSourceMode,
    copyOutlinePath: copyOutlinePathForSelection,
    copyFullPath: copyFullPathForSelection,
    flushEditor: () => editor.flushSync(),
  }).register();

  // 7. Event listeners
  window.addEventListener('inlinemd:openLink', ((e: CustomEvent) => {
    vscode.postMessage({ type: 'openLink', url: e.detail.url });
  }) as EventListener);

  window.addEventListener('inlinemd:imageSelected', ((e: CustomEvent) => {
    const { pos, node, dom } = e.detail;
    imageToolbar.show(view, pos, node, dom);
  }) as EventListener);

  window.addEventListener('inlinemd:pickImage', ((e: CustomEvent) => {
    vscode.postMessage({ type: 'pickImage', pos: e.detail.pos });
  }) as EventListener);

  window.addEventListener('inlinemd:dropImages', ((e: CustomEvent) => {
    const { paths, pos } = e.detail;
    vscode.postMessage({ type: 'dropImages', paths, pos });
  }) as EventListener);

  window.addEventListener('inlinemd:pasteImage', ((e: CustomEvent) => {
    const { dataUrl, mimeType, name, pos } = e.detail;
    vscode.postMessage({ type: 'pasteImage', dataUrl, mimeType, name, pos });
  }) as EventListener);

  // 8. Theme change observer
  window.addEventListener('inlinemd:themeChanged', ((event: CustomEvent) => {
    layoutController.applyThemeChange(!!event.detail?.isDark);
  }) as EventListener);
  const themeObserver = new MutationObserver(() => layoutController.applyThemeChange());
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });

  // 9. Message handling
  let initReceived = false;

  window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
    const message = event.data;
    if (terminalModal.handleMessage(message)) {
      return;
    }

    if (handleHostMessageSideEffect(message, {
      onCommitMessageGenerated: (generatedMessage, source) => {
        if (generatedMessage.trim()) fileHeader.setCommitMessage(generatedMessage, source);
        else fileHeader.setCommitError('Could not generate a commit message.');
      },
      onCommitMessageGenerationFailed: (messageText) => {
        fileHeader.setCommitError(messageText);
        showToast(messageText);
      },
      onCommitFileCompleted: (messageText) => {
        fileHeader.setCommitInProgress(false);
        showToast(messageText);
      },
      onCommitFileFailed: (messageText) => {
        fileHeader.setCommitInProgress(false);
        fileHeader.setCommitError(messageText);
        showToast(messageText);
      },
      onSyncFileCompleted: (messageText) => {
        fileHeader.setCommitInProgress(false);
        fileHeader.closeCommitModal();
        showToast(messageText);
      },
      onSyncFileFailed: (messageText) => {
        fileHeader.setCommitInProgress(false, 'sync');
        fileHeader.setCommitError(messageText);
        showToast(messageText);
      },
      onClipboardCopyCompleted: (messageText) => showToast(messageText),
      onClipboardCopyFailed: (messageText) => showToast(messageText),
      onFocus: () => editor.focus(),
      onRevealCursor: (cursorLine, totalLinesFromMsg) => {
        const scrollArea = document.getElementById('editor-scroll-area');
        if (!scrollArea) return;
        const totalLinesFromContent = Math.max(1, currentContent.split('\n').length);
        const safeTotal = Math.max(1, totalLinesFromMsg || totalLinesFromContent);
        const safeLine = Math.min(Math.max(0, cursorLine), safeTotal - 1);
        const ratio = safeLine / Math.max(1, safeTotal - 1);
        const applyReveal = () => {
          const maxScrollTop = Math.max(0, scrollArea.scrollHeight - scrollArea.clientHeight);
          scrollArea.scrollTop = Number.isFinite(ratio) ? Math.round(maxScrollTop * ratio) : 0;
        };
        applyReveal();
        requestAnimationFrame(applyReveal);
        setTimeout(applyReveal, 80);
      },
      onFileRenamed: (fileName) => fileHeader.setName(fileName),
      onRequestExportHtml: (theme) => void exportController.exportHtml(theme),
      onRequestExportPdf: (theme) => void exportController.exportPdf(theme),
      onRequestExportDocx: () => void exportController.exportDocx(),
      onImageSelected: ({ src, originalSrc, pos }) => {
        if (!src) return;
        editor.insertImage(src, originalSrc, pos);
        if (typeof pos === 'number' && pos >= 0) showToast('Image replaced');
      },
      onImagesDropped: ({ images, pos }) => {
        if (!images?.length) return;
        editor.insertImagesAtPos(images, typeof pos === 'number' ? pos : 0);
        showToast(images.length === 1 ? 'Image inserted' : `${images.length} images inserted`);
      },
    })) {
      return;
    }

    switch (message.type) {
      case 'init':
      case 'documentChanged': {
        const tMsg = message.type === 'init' ? performance.now() : 0;
        const isInit = message.type === 'init';
        const previousContent = currentContent;
        vscode.postMessage({
          type: 'openWithDebugLog',
          stage: message.type === 'init' ? 'initReceived' : 'documentChangedReceived',
          meta: {
            messageContentLength: typeof message.content === 'string' ? message.content.length : -1,
            previousContentLength: previousContent.length,
            canPostEditsToHost,
            isSourceMode,
          },
        });
        if (message.type === 'init') {
          console.log('[InLineMd perf] init message received');
          dualHistory.clear();
          editOperationLog.clear();
        }
        initReceived = true;
        const content = message.content || '';
        const changedLine = !isInit ? findFirstChangedLine(previousContent, content) : null;
        const changedTotalLines = Math.max(1, content.split('\n').length);
        const shouldAutoFollowExternalChange =
          !isInit && autoFollowExternalEdits && !message.skipAutoScroll && changedLine !== null;

        if (message.imagePathMap) {
          editor.setImagePathMap(message.imagePathMap);
        }

        if (message.filename) {
          fileHeader.setName(message.filename);
        }
        if (typeof message.filePath === 'string') {
          currentFilePath = message.filePath;
        }
        if (message.terminalAppearance && typeof message.terminalAppearance === 'object') {
          terminalAppearance = message.terminalAppearance as TerminalAppearance;
          terminalModal.updateAppearance(terminalAppearance);
        }

        if (message.type === 'init') {
          if (typeof message.fullWidth === 'boolean') {
            isFullWidth = message.fullWidth;
            document.getElementById('editor')?.classList.toggle('full-width', isFullWidth);
            fileHeader.syncFullWidthState(isFullWidth);
          }
          if (typeof message.tocVisible === 'boolean') {
            isTocVisible = message.tocVisible;
            if (isTocVisible) toc.open();
            if (!isTocVisible) toc.close();
            fileHeader.syncTocState(isTocVisible);
          }
          if (typeof message.tableFirstRowStickyDefault === 'boolean') {
            setFirstRowStickyDefault(message.tableFirstRowStickyDefault);
          }
          if (typeof message.tableWrap === 'boolean') {
            isTableWrap = message.tableWrap;
            document.getElementById('editor')?.classList.toggle('table-wrap', isTableWrap);
            window.dispatchEvent(new CustomEvent('easyview-table-wrap-layout-change'));
            fileHeader.syncTableWrapState(isTableWrap);
          }
        }

        if (content === currentContent && message.type !== 'init') return;
        currentContent = content;
        stickyNote.setDocumentContent(content);

        if (isSourceMode && sourceEditor) {
          sourceEditor.setContent(content);
          canPostEditsToHost = true;
          if (shouldAutoFollowExternalChange && changedLine !== null) {
            sourceEditor.scrollToLine(changedLine, 'smooth');
          }
          updateTocStatusBar();
          break;
        }

        const tSetContent = isInit ? performance.now() : 0;
        const scrollArea = document.getElementById('editor-scroll-area');
        const prevScrollRatio =
          !isInit && scrollArea && scrollArea.scrollHeight > scrollArea.clientHeight
            ? scrollArea.scrollTop / (scrollArea.scrollHeight - scrollArea.clientHeight)
            : 0;
        editor.setContent(content, isInit, isInit ? undefined : { scrollIntoView: false });
        canPostEditsToHost = true;
        updateTocStatusBar();
        if (!isInit && scrollArea) {
          if (shouldAutoFollowExternalChange && changedLine !== null) {
            scrollWysiwygToApproxLine(changedLine, changedTotalLines);
          } else {
            const restoreScroll = () => {
              const maxScrollTop = Math.max(0, scrollArea.scrollHeight - scrollArea.clientHeight);
              scrollArea.scrollTop = Math.round(maxScrollTop * prevScrollRatio);
            };
            restoreScroll();
            requestAnimationFrame(restoreScroll);
            setTimeout(restoreScroll, 60);
          }
        }
        refreshChangeRailsAfterLayout();
        if (Array.isArray(message.gitLineRanges) && view) {
          view.dispatch(
            view.state.tr.setMeta(GIT_CHANGE_META, {
              lineRanges: message.gitLineRanges,
              content,
            })
          );
        }
        if (isInit) {
          console.log(`[InLineMd perf] editor.setContent(init): ${(performance.now() - tSetContent).toFixed(1)}ms`);
          toolbar.update(view);
          toc.update(view);
          requestAnimationFrame(() => {
            const scrollArea = document.getElementById('editor-scroll-area');
            if (scrollArea) {
              const cursorLine =
                typeof (message as any).initialCursorLine === 'number' ? (message as any).initialCursorLine : 0;
              const totalLines =
                typeof (message as any).initialTotalLines === 'number' ? (message as any).initialTotalLines : 1;
              const safeTotal = Math.max(1, totalLines);
              const safeLine = Math.min(Math.max(0, cursorLine), safeTotal - 1);
              const ratioDenominator = Math.max(1, safeTotal - 1);
              const lineRatio = safeLine / ratioDenominator;
              const applyCursorScroll = () => {
                const maxScrollTop = Math.max(0, scrollArea.scrollHeight - scrollArea.clientHeight);
                scrollArea.scrollTop = Number.isFinite(lineRatio) ? Math.round(maxScrollTop * lineRatio) : 0;
              };

              applyCursorScroll();
              requestAnimationFrame(applyCursorScroll);
              setTimeout(applyCursorScroll, 80);
              // The initial cursor positioning runs after editor.setContent and
              // would otherwise overwrite the persisted page position.
              restoreEditorScrollPosition(scrollArea, content);
            }
            editor.view?.dom.querySelectorAll('.mdpre-source-line-gutter').forEach((el) => el.remove());
            document.body.classList.remove('inlinemd-booting');
            document.body.classList.add('inlinemd-ready');
          });
          console.log(`[InLineMd perf] init message TOTAL: ${(performance.now() - tMsg).toFixed(1)}ms`);
          console.log(`[InLineMd perf] initEditor TOTAL: ${(performance.now() - tInit).toFixed(1)}ms`);
        }
        break;
      }

      case 'gitStatusChanged':
        if (view) {
          const messageContent = typeof message.content === 'string' ? message.content : null;
          // Drop stale Git updates computed from older content snapshots.
          if (messageContent !== null && messageContent !== currentContent) {
            break;
          }
          view.dispatch(
            view.state.tr.setMeta(GIT_CHANGE_META, {
              lineRanges: Array.isArray(message.lineRanges) ? message.lineRanges : [],
              content: messageContent ?? currentContent,
            })
          );
        }
        break;

    }
  });

  const isResizeObserverLoopDiagnostic = (message: string): boolean =>
    message === 'ResizeObserver loop completed with undelivered notifications.' ||
    message === 'ResizeObserver loop limit exceeded';

  window.addEventListener('error', (event) => {
    if (isResizeObserverLoopDiagnostic(event.message)) {
      // Chromium reports this as a window error even though it is a recoverable
      // layout diagnostic. Keep it out of the user-facing VS Code error dialog.
      console.warn(`[InLineMd] ${event.message}`);
      return;
    }

    vscode.postMessage({
      type: 'webviewRuntimeError',
      source: 'window-error',
      message: event.message,
      stack: event.error?.stack ?? '',
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    vscode.postMessage({
      type: 'webviewRuntimeError',
      source: 'unhandled-rejection',
      message: reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason),
      stack: reason instanceof Error ? (reason.stack ?? '') : '',
    });
  });

  // 10. Bootstrap
  const tBootstrap = performance.now();
  console.log(`[InLineMd perf] pre-bootstrap setup: ${(tBootstrap - tInit).toFixed(1)}ms`);
  const embeddedData = (window as any).__INITIAL_DATA__;
  if (embeddedData) {
    console.log(`[InLineMd perf] dispatching embedded __INITIAL_DATA__`);
    window.dispatchEvent(new MessageEvent('message', { data: embeddedData }));
    delete (window as any).__INITIAL_DATA__;
  } else {
    vscode.postMessage({ type: 'ready' });
    const readyRetry = setInterval(() => {
      if (initReceived) {
        clearInterval(readyRetry);
        return;
      }
      vscode.postMessage({ type: 'ready' });
    }, 500);
    setTimeout(() => clearInterval(readyRetry), 10000);
  }
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

new EditorBootstrap({
  initialize: initEditor,
  installStyles: () => {
    ensurePlaceholderHorizontalFlowStyles();
    ensureMinimalGitChangeStyles();
    ensureEditorContentGutterStyles();
    ensureTableWidthStyles();
  },
}).start();
