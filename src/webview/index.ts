/**
 * InLineMd Webview Entry Point
 *
 * Thin host shell: creates Extensions + EditorCore, handles VS Code messaging and UI.
 * All ProseMirror logic is in Extensions and EditorCore.
 */

import { NodeSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { undo, redo } from 'prosemirror-history';
import { goToNextCell } from 'prosemirror-tables';

import { EditorCore } from './editor/EditorCore';

// Extensions
import { KeyboardOverridesExtension } from './extensions/behavior/keyboard-overrides/KeyboardOverridesExtension';
import { ListsExtension } from './extensions/blocks/lists/ListsExtension';
import { SmartTextExtension } from './extensions/behavior/smart-text/SmartTextExtension';
import { MarksExtension } from './extensions/inline/marks/MarksExtension';
import { HeadingExtension, setToastFunction } from './extensions/blocks/heading/HeadingExtension';
import { BlockquoteExtension } from './extensions/blocks/blockquote/BlockquoteExtension';
import { CodeBlockExtension } from './extensions/blocks/code-block/CodeBlockExtension';
import { NoticeExtension } from './extensions/blocks/notice/NoticeExtension';
import { HorizontalRuleExtension } from './extensions/blocks/horizontal-rule/HorizontalRuleExtension';
import { TableExtension } from './extensions/blocks/table/TableExtension';
import { ImageExtension } from './extensions/inline/image/ImageExtension';
import { MermaidExtension } from './extensions/blocks/mermaid/MermaidExtension';
import { PlantUmlExtension } from './extensions/blocks/plantuml/PlantUmlExtension';
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
import { AiChangesExtension, GIT_CHANGE_META } from './extensions/integrations/ai-changes/AiChangesExtension';
import { initContextMenu } from './ui/ContextMenu';
import { createPasteParser } from './editor/lib/MarkdownParser';

// UI
import { FloatingToolbar } from './extensions/behavior/toolbar/ToolbarFloating';
import { linkEditPopup } from './extensions/behavior/toolbar/ToolbarLinkPopup';
import { imageToolbar } from './extensions/inline/image/ImageToolbar';
import { FindAndReplacePanel } from './extensions/behavior/find-replace/FindReplacePanel';
import { TableOfContents } from './extensions/blocks/heading/TableOfContents';
import { generateStandaloneHtml } from './extensions/export/html/ExportHtml';
import { createSourceEditor } from './editor/SourceEditor';
import { DualModeHistory } from './editor/DualModeHistory';
import { createFileHeader } from './ui/FileHeader';
import { HistoryPanel } from './ui/HistoryPanel';

// ─── VS Code API ────────────────────────────────────────────────────────────

// @ts-expect-error — acquireVsCodeApi is injected by VS Code webview
const vscode = acquireVsCodeApi();

// Expose VS Code API globally for extensions (TableCommands CSV export, etc.)
(window as any).__vscodeApi = vscode;

// Global reference to EditorView for TableView and table commands access
let globalEditorView: EditorView | null = null;

/** Get the current EditorView instance (used by TableView and table commands) */
export function getEditorView(): EditorView | null {
  return globalEditorView;
}

// ─── State ──────────────────────────────────────────────────────────────────

let currentContent = '';
let isFullWidth = true;
let isTocVisible = true;
let isTableWrap = false; // default: disabled
let isSourceMode = false;
let sourceEditor: ReturnType<typeof createSourceEditor> | null = null;
const dualHistory = new DualModeHistory();
let _skipDualHistoryRecord = false;
let _hasEditedInCurrentMode = false;
let _modeEntryContent = ''; // content snapshot when entering current mode

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
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      left: calc(-1 * var(--easyview-change-rail-offset, 12px));
      width: 2px;
      border-radius: 999px;
      pointer-events: none;
      z-index: 1;
    }

    .ProseMirror .block-ai-modified::before {
      background: var(--vscode-editorWarning-foreground, #f59e0b);
    }

    .ProseMirror .block-ai-added::before {
      background: var(--vscode-gitDecoration-addedResourceForeground, #10b981);
    }

    .ProseMirror .block-ai-fadeout::before {
      background: var(--vscode-gitDecoration-modifiedResourceForeground, #3b82f6);
      opacity: 0.45;
    }

    .ProseMirror .block-ai-active::before {
      content: none !important;
    }
  `;
  document.head.appendChild(style);
}

function updateGitChangeRailOffset(): void {
  const scrollArea = document.getElementById('editor-scroll-area');
  const proseMirror = document.querySelector('#editor .ProseMirror') as HTMLElement | null;
  if (!scrollArea || !proseMirror) return;

  const referenceBlock =
    (proseMirror.querySelector(':scope > *:not(.table-wrapper)') as HTMLElement | null) ??
    (proseMirror.firstElementChild as HTMLElement | null) ??
    proseMirror;

  const scrollRect = scrollArea.getBoundingClientRect();
  const referenceRect = referenceBlock.getBoundingClientRect();
  const paneInset = 6;
  const offset = Math.max(12, Math.round(referenceRect.left - scrollRect.left - paneInset));
  proseMirror.style.setProperty('--easyview-change-rail-offset', `${offset}px`);
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

/** Same regex as provider — matches settings comment at file start */
const SETTINGS_COMMENT_RE = /^<!--\s*fullWidth:\s*(true|false)(?:\s+tocVisible:\s*(true|false))?(?:\s+tableWrap:\s*(true|false))?(?:\s+lineNumbersVisible:\s*(true|false))?\s*-->[\r\n]*/;

function stripSettingsComment(content: string): string {
  return content.replace(SETTINGS_COMMENT_RE, '');
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
  wordPrefix: string,
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
  vscode.postMessage({
    type: 'edit',
    content,
    fullWidth: isFullWidth,
    tocVisible: isTocVisible,
    tableWrap: isTableWrap,
  });
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
  wysiwygGhostEl.style.color = 'var(--vscode-inlineSuggestion-foreground, var(--vscode-editorGhostText-foreground, rgba(128, 128, 128, 0.7)))';
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

  // Apply default table-wrap class (enabled by default)
  editorElement.classList.add('table-wrap');

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

  // 2. Create UI components
  const tUI = performance.now();
  const fileHeader = createFileHeader({
    postMessage: (msg) => vscode.postMessage(msg),
    getState: () => ({ isFullWidth, isTocVisible, isTableWrap, currentContent }),
    setState: (patch) => {
      if (patch.isFullWidth !== undefined) isFullWidth = patch.isFullWidth;
      if (patch.isTocVisible !== undefined) isTocVisible = patch.isTocVisible;
      if (patch.isTableWrap !== undefined) isTableWrap = patch.isTableWrap;
    },
    onSettingsChange: () => updateSourceSettingsComment(),
  });
  const editorBody = document.getElementById('editor-body');
  if (editorBody) {
    editorBody.parentElement?.insertBefore(fileHeader.el, editorBody);
  }
  const toolbar = new FloatingToolbar();
  console.log(`[InLineMd perf] create UI (FileHeader+Toolbar): ${(performance.now() - tUI).toFixed(1)}ms`);

  const runNativeWysiwygTab = (pmView: EditorView, backwards = false): boolean => {
    if (goToNextCell(backwards ? -1 : 1)(pmView.state, pmView.dispatch)) {
      return true;
    }
    if (backwards) return false;
    const { from, to } = pmView.state.selection;
    pmView.dispatch(pmView.state.tr.insertText('\t', from, to));
    return true;
  };

  // 3. Create EditorCore
  const tCore = performance.now();
  const editor = new EditorCore({
    extensions,
    keymaps: {
      Tab: (_state, _dispatch, view) => view ? runNativeWysiwygTab(view, false) : false,
      'Shift-Tab': (_state, _dispatch, view) => view ? runNativeWysiwygTab(view, true) : false,
      'Mod-k': (_state, _dispatch, view) => {
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
      toc.update(view);
      if (tr.docChanged || tr.selectionSet) {
        hideWysiwygGhost();
        scheduleWysiwygGhost?.(view);
      } else {
        renderWysiwygGhost();
      }
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

  // 4. Initialize editor
  const tEditorInit = performance.now();
  editor.init(editorElement);
  console.log(`[InLineMd perf] editor.init(): ${(performance.now() - tEditorInit).toFixed(1)}ms`);

  const view = editor.view!;
  globalEditorView = view;
  window.addEventListener('resize', renderWysiwygGhost);
  window.addEventListener('resize', updateGitChangeRailOffset);
  document.getElementById('editor-scroll-area')?.addEventListener('scroll', renderWysiwygGhost, { passive: true });
  const layoutObserver = new ResizeObserver(() => updateGitChangeRailOffset());
  const scrollAreaElement = document.getElementById('editor-scroll-area');
  if (scrollAreaElement) layoutObserver.observe(scrollAreaElement);
  layoutObserver.observe(editorElement);
  editorElement.addEventListener('focusout', () => {
    wysiwygGhostRequestToken++;
    hideWysiwygGhost();
  });
  toolbar.attach(view);

  // Initialize custom context menu (Cut/Copy/Paste/Paste as Text)
  const contextPasteParser = createPasteParser();
  initContextMenu(editorElement, () => editor.view, () => contextPasteParser);

  // Create Find & Replace panel
  const findReplacePanel = new FindAndReplacePanel(view);
  findReplacePanel.setSourceCallbacks(
    () => sourceEditor,
    () => isSourceMode,
  );

  // Create Table of Contents sidebar
  const toc = new TableOfContents(view);

  // Create History panel — pure visualizer, reads from PM/CM/DualHistory
  const historyPanel = new HistoryPanel({
    getView: () => editor.view,
    getDualHistory: () => dualHistory,
    getIsSourceMode: () => isSourceMode,
    getSourceView: () => sourceEditor?.view ?? null,
    triggerUndo() {
      if (isSourceMode && sourceEditor) {
        // Dispatch Ctrl+Z to source editor
        const cmView = sourceEditor.view;
        cmView.dispatch({ userEvent: 'undo' });
      } else if (editor.view) {
        undo(editor.view.state, editor.view.dispatch);
      }
    },
    triggerRedo() {
      if (isSourceMode && sourceEditor) {
        const cmView = sourceEditor.view;
        cmView.dispatch({ userEvent: 'redo' });
      } else if (editor.view) {
        redo(editor.view.state, editor.view.dispatch);
      }
    },
  });

  // 5. Wire file header handlers
  const scrollToEditorTop = () => {
    if (isSourceMode && sourceEditor?.view?.scrollDOM) {
      sourceEditor.view.scrollDOM.scrollTo({ top: 0, behavior: 'auto' });
    } else {
      document.getElementById('editor-scroll-area')?.scrollTo({ top: 0, behavior: 'auto' });
    }
  };

  const scrollToEditorBottom = () => {
    if (isSourceMode && sourceEditor?.view?.scrollDOM) {
      const scroller = sourceEditor.view.scrollDOM;
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' });
    } else {
      const scroller = document.getElementById('editor-scroll-area');
      if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' });
    }
  };

  fileHeader.setScrollTopHandler(() => scrollToEditorTop());
  fileHeader.setScrollBottomHandler(() => scrollToEditorBottom());

  fileHeader.setStageHandler(() => {
    editor.flushSync();
    vscode.postMessage({ type: 'stageFile' });
  });
  fileHeader.setHistoryHandler(() => {
    historyPanel.toggle();
    fileHeader.getHistoryBtn().classList.toggle('active', historyPanel.visible);
  });
  fileHeader.setTocHandler(() => toc.toggle());

  document.addEventListener('keydown', (e) => {
    const isModKey = e.ctrlKey || e.metaKey;
    const isOptionOnly = e.altKey && !e.ctrlKey && !e.metaKey;
    if (isModKey && e.shiftKey && e.code === 'KeyT' && !e.altKey) {
      e.preventDefault();
      toc.toggle();
      isTocVisible = toc.visible;
      const tocBtnEl = document.querySelector('.file-header-btn[title*="Table of Contents"], .file-header-btn[title*="Hide Table"]');
      if (tocBtnEl) {
        tocBtnEl.classList.toggle('active', isTocVisible);
        (tocBtnEl as HTMLElement).title = isTocVisible
          ? 'Hide Table of Contents (Option+W)'
          : 'Toggle Table of Contents (Option+W)';
      }
      postEdit(currentContent);
      updateSourceSettingsComment();
    }
    if (isOptionOnly && e.code === 'KeyW') {
      e.preventDefault();
      toc.toggle();
      isTocVisible = toc.visible;
      const tocBtnEl = document.querySelector('.file-header-btn[title*="Table of Contents"], .file-header-btn[title*="Hide Table"]');
      if (tocBtnEl) {
        tocBtnEl.classList.toggle('active', isTocVisible);
        (tocBtnEl as HTMLElement).title = isTocVisible
          ? 'Hide Table of Contents (Option+W)'
          : 'Toggle Table of Contents (Option+W)';
      }
      postEdit(currentContent);
      updateSourceSettingsComment();
    }
  });

  let isAllCollapsed = false;
  fileHeader.setCollapseHandler(() => {
    isAllCollapsed = !isAllCollapsed;
    toggleAllHeadings(view, isAllCollapsed);
  });

  // Export handler
  async function triggerExport(theme: 'light' | 'dark' = 'light') {
    try {
      const result = await generateStandaloneHtml(view, {
        title: fileHeader.el.querySelector('.file-header-name')?.textContent?.trim() || 'Document',
        isDark: theme === 'dark',
      });
      vscode.postMessage({ type: 'exportHtml', html: result.html, images: result.images });
    } catch (err) {
      console.error('[InLineMd] Export failed:', err);
      vscode.postMessage({ type: 'showInfo', text: `Export failed: ${err}` });
    }
  }
  // PDF export: generate PDF via pdfmake directly in webview
  async function triggerExportPdf(theme: 'light' | 'dark' = 'light') {
    try {
      const { generatePdfBase64 } = await import('./extensions/export/pdf/PdfMakeExport');
      const title = fileHeader.el.querySelector('.file-header-name')?.textContent?.trim() || 'Document';

      // Callback to load local images from extension host
      const loadImageFromHost = (originalSrc: string): Promise<string | null> => {
        return new Promise((resolve) => {
          const requestId = Math.random().toString(36).substr(2, 9);
          const handler = (event: MessageEvent) => {
            const msg = event.data;
            if (msg.type === 'imageBase64Response' && msg.requestId === requestId) {
              window.removeEventListener('message', handler);
              resolve(msg.base64 || null);
            }
          };
          window.addEventListener('message', handler);
          vscode.postMessage({ type: 'getImageBase64', requestId, originalSrc });
          // Timeout after 10 seconds
          setTimeout(() => {
            window.removeEventListener('message', handler);
            console.warn('[InLineMd] Image request TIMED OUT:', originalSrc, requestId);
            resolve(null);
          }, 10000);
        });
      };

      const base64 = await generatePdfBase64(view.state.doc, { title, theme }, loadImageFromHost);
      vscode.postMessage({ type: 'exportPdfBase64', data: base64 });
    } catch (err) {
      console.error('[InLineMd] PDF export failed:', err);
      vscode.postMessage({ type: 'showInfo', text: `PDF export failed: ${err}` });
    }
  }

  fileHeader.setExportHtmlLightHandler(() => triggerExport('light'));
  fileHeader.setExportHtmlDarkHandler(() => triggerExport('dark'));
  fileHeader.setExportPdfLightHandler(() => triggerExportPdf('light'));
  fileHeader.setExportPdfDarkHandler(() => triggerExportPdf('dark'));

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

    const fullBlockText = $from.parent.textBetween(0, $from.parent.content.size, '\n', '\n');
    const blockLines = fullBlockText.split('\n');
    const currentLineIndex = textBeforeBlock.split('\n').length - 1;
    const lineText = blockLines[currentLineIndex] ?? fullBlockText;
    const markdown = editor.getMarkdown();
    const approx = findApproximateMarkdownPosition(markdown, lineText, textBeforeLine, wordPrefix);

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
      void requestTabCompletionFromHost(
        context.approx.line,
        context.approx.character,
        context.wordPrefix,
      ).then((completion) => {
        if (requestToken !== wysiwygGhostRequestToken || !editor.view) return;

        const activeSelection = editor.view.state.selection;
        if (!activeSelection.empty || activeSelection.from !== context.anchor) return;

        const insertText = completion?.insertText ?? '';
        const currentText = editor.view.state.doc.textBetween(context.replaceFrom, context.replaceTo, '\n', '\n');
        const displayText = insertText.startsWith(currentText)
          ? insertText.slice(currentText.length)
          : insertText;

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
      }).catch(() => {
        if (requestToken === wysiwygGhostRequestToken) {
          hideWysiwygGhost();
        }
      });
    }, 120);
  };

  const requestTabCompletionFromHost = (
    line: number,
    character: number,
    wordPrefix: string,
  ): Promise<{ insertText: string; replaceStartCharacter?: number; replaceEndCharacter?: number } | null> => {
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
          replaceStartCharacter: typeof message.replaceStartCharacter === 'number'
            ? message.replaceStartCharacter
            : undefined,
          replaceEndCharacter: typeof message.replaceEndCharacter === 'number'
            ? message.replaceEndCharacter
            : undefined,
        });
      };

      window.addEventListener('message', handler);
      vscode.postMessage({ type: 'requestTabCompletion', requestId, line, character, wordPrefix });
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
          wysiwygGhostSuggestion.replaceTo,
        )
      );
      hideWysiwygGhost();
      pmView.focus();
      return true;
    }

    const context = getWysiwygTabContext(pmView);
    if (!context) return false;

    void requestTabCompletionFromHost(
      context.approx.line,
      context.approx.character,
      context.wordPrefix,
    ).then((completion) => {
      if (!completion?.insertText || !editor.view) return;

      const activeSelection = editor.view.state.selection;
      if (!activeSelection.empty || activeSelection.from !== context.anchor) return;

      editor.view.dispatch(
        editor.view.state.tr.insertText(
          completion.insertText,
          context.replaceFrom,
          context.replaceTo,
        )
      );
      hideWysiwygGhost();
      editor.view.focus();
    });

    return true;
  };

  // 6. Source mode toggle
  function getNativeSourcePosition(): { line: number; character: number } {
    if (isSourceMode && sourceEditor) {
      const state = sourceEditor.view.state;
      const head = state.selection.main.head;
      const line = state.doc.lineAt(head);
      return {
        line: Math.max(0, line.number - 1),
        character: Math.max(0, head - line.from),
      };
    }

    if (editor.view) {
      const context = getWysiwygTabContext(editor.view);
      if (context) return context.approx;
    }

    return { line: 0, character: 0 };
  }

  function openNativeSourceMode() {
    const sourcePosition = getNativeSourcePosition();
    const content = isSourceMode && sourceEditor
      ? stripSettingsComment(sourceEditor.getContent())
      : editor.getMarkdown();

    wysiwygGhostRequestToken++;
    hideWysiwygGhost();
    editor.flushSync();
    currentContent = content;

    vscode.postMessage({
      type: 'openNativeSourceMode',
      content,
      fullWidth: isFullWidth,
      tocVisible: isTocVisible,
      tableWrap: isTableWrap,
      line: sourcePosition.line,
      character: sourcePosition.character,
    });
  }

  function toggleSourceMode() {
    const scrollArea = document.getElementById('editor-scroll-area')!;
    const editorEl = document.getElementById('editor')!;

    if (!isSourceMode) {
      wysiwygGhostRequestToken++;
      hideWysiwygGhost();
      // WYSIWYG → Source
      if (!_skipDualHistoryRecord) {
        dualHistory.recordModeSwitch(editor.getMarkdown(), 'wysiwyg', editor.view?.state);
      }
      toolbar.forceHide();

      const scrollPct = scrollArea.scrollHeight > scrollArea.clientHeight
        ? scrollArea.scrollTop / (scrollArea.scrollHeight - scrollArea.clientHeight)
        : 0;

      const rawMd = editor.getMarkdown();
      const fullMd = rawMd;

      editorEl.style.display = 'none';
      let sourceContainer = document.getElementById('source-editor');
      if (!sourceContainer) {
        sourceContainer = document.createElement('div');
        sourceContainer.id = 'source-editor';
        scrollArea.appendChild(sourceContainer);
      }
      sourceContainer.style.display = 'block';

      if (!sourceEditor) {
        sourceEditor = createSourceEditor({
          parent: sourceContainer,
          onChange: (rawContent) => {
            _hasEditedInCurrentMode = true;
            const content = stripSettingsComment(rawContent);
            if (content !== currentContent) {
              currentContent = content;
              postEdit(content);
            }
          },
          requestTabCompletion({ line, character, wordPrefix }) {
            return requestTabCompletionFromHost(line, character, wordPrefix);
          },
          onUndoExhausted() {
            const rawMd = sourceEditor!.getContent();
            const md = stripSettingsComment(rawMd);
            dualHistory.skipIdenticalUndos(md);
            const snapshot = dualHistory.crossModeUndo(md, 'source');
            if (!snapshot) return false;
            if (snapshot.mode === 'wysiwyg') {
              _skipDualHistoryRecord = true;
              toggleSourceMode();
              _skipDualHistoryRecord = false;
            } else if (snapshot.editorState) {
              // Restore exact saved CM6 state (with full undo history)
              sourceEditor!.view.setState(snapshot.editorState);
              currentContent = snapshot.markdown;
              postEdit(snapshot.markdown);
            } else {
              // Fallback: restore content via setContent
              sourceEditor!.setContent(snapshot.markdown);
              currentContent = snapshot.markdown;
              postEdit(snapshot.markdown);
            }
            return true;
          },
          onRedoExhausted() {
            const rawMd = sourceEditor!.getContent();
            const md = stripSettingsComment(rawMd);
            const snapshot = dualHistory.crossModeRedo(md, 'source');
            if (!snapshot) return false;
            if (snapshot.mode === 'wysiwyg') {
              _skipDualHistoryRecord = true;
              toggleSourceMode();
              _skipDualHistoryRecord = false;
            } else if (snapshot.editorState) {
              sourceEditor!.view.setState(snapshot.editorState);
              currentContent = snapshot.markdown;
              postEdit(snapshot.markdown);
            }
            return true;
          },
        });
      }
      // Only update source content if it actually changed — preserves CM6 undo stack
      if (sourceEditor.getContent() !== fullMd) {
        sourceEditor.setContent(fullMd);
      }
      sourceEditor.focus();

      requestAnimationFrame(() => {
        // Force CodeMirror to recalculate visible ranges after container becomes visible
        sourceEditor!.view.requestMeasure();
        const cmScroller = sourceEditor!.view.scrollDOM;
        if (cmScroller.scrollHeight > cmScroller.clientHeight) {
          cmScroller.scrollTop = scrollPct * (cmScroller.scrollHeight - cmScroller.clientHeight);
        }
      });

      // TOC source mode
      toc.sourceClickHandler = (heading) => {
        if (!sourceEditor) return;
        const text = sourceEditor.getContent();
        const prefix = '#'.repeat(heading.level) + ' ';
        const idx = text.indexOf(prefix + heading.text);
        if (idx !== -1) {
          const line = text.slice(0, idx).split('\n').length;
          sourceEditor.scrollToLine(line);
          sourceEditor.focus();
        }
      };

      const headingLineMap: { pos: number; line: number }[] = [];
      const fullMdLines = fullMd.split('\n');
      const headings = toc['headings'] as { level: number; text: string; pos: number }[];
      for (const h of headings) {
        const searchStr = '#'.repeat(h.level) + ' ' + h.text;
        for (let i = 0; i < fullMdLines.length; i++) {
          if (fullMdLines[i].startsWith(searchStr)) {
            headingLineMap.push({ pos: h.pos, line: i + 1 });
            break;
          }
        }
      }

      toc.enterSourceMode(() => {
        if (!sourceEditor) return -1;
        let activePos = -1;
        for (const entry of headingLineMap) {
          const offset = sourceEditor.getLineTopOffset(entry.line);
          if (offset === -1) continue;
          if (offset > 20) break;
          activePos = entry.pos;
        }
        return activePos;
      }, sourceEditor.view.scrollDOM);

      isSourceMode = true;
      _hasEditedInCurrentMode = false;
      _modeEntryContent = rawMd; // snapshot for cross-mode undo guard
      fileHeader.getSourceBtn().classList.add('active');
    } else {
      // Source → WYSIWYG
      const rawMdForHistory = sourceEditor!.getContent();
      if (!_skipDualHistoryRecord) {
        dualHistory.recordModeSwitch(stripSettingsComment(rawMdForHistory), 'source', sourceEditor!.view.state);
      }
      const cmScroller = sourceEditor!.view.scrollDOM;
      const scrollPct = cmScroller.scrollHeight > cmScroller.clientHeight
        ? cmScroller.scrollTop / (cmScroller.scrollHeight - cmScroller.clientHeight)
        : 0;

      const rawMd = sourceEditor!.getContent();
      const md = stripSettingsComment(rawMd);

      const sourceContainer = document.getElementById('source-editor');
      if (sourceContainer) sourceContainer.style.display = 'none';
      editorEl.style.display = '';

      document.getElementById('editor')?.classList.toggle('full-width', isFullWidth);
      document.getElementById('editor')?.classList.toggle('table-wrap', isTableWrap);
      if (isTocVisible && !toc.visible) toc.open();
      if (!isTocVisible && toc.visible) toc.close();

      // Try to restore saved PM state if content unchanged — preserves full undo history
      const savedSnapshot = dualHistory.peekUndo();
      if (savedSnapshot?.editorState && savedSnapshot.mode === 'wysiwyg' && md === savedSnapshot.markdown) {
        // Content unchanged in source → restore exact WYSIWYG state (with undo history)
        editor.view!.updateState(savedSnapshot.editorState);
      } else if (md !== editor.getMarkdown()) {
        // Content changed → re-parse (PM undo stack may become stale)
        editor.isUpdatingFromExtension = true;
        editor.setContent(md);
        editor.isUpdatingFromExtension = false;
      }

      requestAnimationFrame(() => {
        if (scrollArea.scrollHeight > scrollArea.clientHeight) {
          scrollArea.scrollTop = scrollPct * (scrollArea.scrollHeight - scrollArea.clientHeight);
        }
      });

      toc.sourceClickHandler = null;
      toc.exitSourceMode();
      view.focus();
      isSourceMode = false;
      scheduleWysiwygGhost?.(view);
      _hasEditedInCurrentMode = false;
      _modeEntryContent = md; // snapshot for cross-mode undo guard
      fileHeader.getSourceBtn().classList.remove('active');
    }
  }

  fileHeader.setSourceHandler(() => openNativeSourceMode());

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const isModKey = e.ctrlKey || e.metaKey;
    const isOptionOnly = e.altKey && !e.ctrlKey && !e.metaKey;
    if (isModKey && e.key === '/') {
      e.preventDefault();
      openNativeSourceMode();
    }
    if (isOptionOnly && e.code === 'KeyQ') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      openNativeSourceMode();
    }
    if (isOptionOnly && e.code === 'KeyS') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      editor.flushSync();
      vscode.postMessage({ type: 'stageFile' });
    }
    if (isOptionOnly && e.code === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      scrollToEditorTop();
    }
    if (isOptionOnly && e.code === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      scrollToEditorBottom();
    }
    if (isOptionOnly && e.code === 'KeyA') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const widthBtn = document.querySelector('.file-header-btn[title*="full width"]') as HTMLElement | null;
      widthBtn?.click();
    }
    if (isOptionOnly && e.code === 'KeyD') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const wrapBtn = document.querySelector('.file-header-btn[title*="table word wrap"]') as HTMLElement | null;
      wrapBtn?.click();
    }
    if (isOptionOnly && e.code === 'KeyR') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const themeBtn = document.querySelector('.file-header-btn[title*="Switch to light mode"], .file-header-btn[title*="Switch to dark mode"]') as HTMLElement | null;
      themeBtn?.click();
    }
    if (isModKey && e.key === 's' && isSourceMode) {
      e.preventDefault();
      editor.flushSync();
      vscode.postMessage({ type: 'save' });
    }
  });

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
  let currentThemeIsDark = isDark;
  const applyThemeChange = (isDarkNow = isDarkTheme()) => {
    if (isDarkNow !== currentThemeIsDark) {
      currentThemeIsDark = isDarkNow;
      view.dispatch(view.state.tr.setMeta('theme', { isDark: isDarkNow }));
    }
  };
  window.addEventListener('inlinemd:themeChanged', ((event: CustomEvent) => {
    applyThemeChange(!!event.detail?.isDark);
  }) as EventListener);
  const themeObserver = new MutationObserver(() => {
    const newIsDark = isDarkTheme();
    applyThemeChange(newIsDark);
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });

  // 9. Message handling
  let initReceived = false;

  window.addEventListener('message', (event) => {
    const message = event.data;

    switch (message.type) {
      case 'init':
      case 'documentChanged': {
        const tMsg = message.type === 'init' ? performance.now() : 0;
        if (message.type === 'init') {
          console.log('[InLineMd perf] init message received');
          dualHistory.clear();
        }
        initReceived = true;
        const content = message.content || '';

        if (message.imagePathMap) {
          editor.setImagePathMap(message.imagePathMap);
        }

        if (message.filename) {
          fileHeader.setName(message.filename);
        }

        if (message.type === 'init') {
          if (typeof message.fullWidth === 'boolean') {
            isFullWidth = message.fullWidth;
            document.getElementById('editor')?.classList.toggle('full-width', isFullWidth);
            const widthBtn = document.querySelector('.file-header-btn[title*="full width"]') as HTMLElement;
            if (widthBtn) {
              widthBtn.classList.toggle('active', isFullWidth);
              widthBtn.title = isFullWidth ? 'Exit full width (Option+A)' : 'Expand to full width (Option+A)';
              widthBtn.innerHTML = isFullWidth
                ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/></svg>'
                : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>';
            }
          }
          if (typeof message.tocVisible === 'boolean' && message.tocVisible) {
            isTocVisible = true;
            toc.open();
            const tocBtnEl = document.querySelector('.file-header-btn[title*="Table of Contents"], .file-header-btn[title*="Hide Table"]') as HTMLElement;
            if (tocBtnEl) {
              tocBtnEl.classList.add('active');
              tocBtnEl.title = 'Hide Table of Contents (Option+W)';
            }
          }
	          if (typeof message.tableWrap === 'boolean') {
	            isTableWrap = message.tableWrap;
	            document.getElementById('editor')?.classList.toggle('table-wrap', isTableWrap);
            const wrapBtn = document.querySelector('.file-header-btn[title*="table word wrap"]') as HTMLElement;
            if (wrapBtn) {
              wrapBtn.classList.toggle('active', isTableWrap);
	              wrapBtn.title = isTableWrap ? 'Disable table word wrap (Option+D)' : 'Enable table word wrap (Option+D)';
	            }
	          }
	        }

        if (content === currentContent && message.type !== 'init') return;
        currentContent = content;

        if (isSourceMode && sourceEditor) {
          sourceEditor.setContent(content);
          break;
        }

        const isInit = message.type === 'init';
        const tSetContent = isInit ? performance.now() : 0;
        const scrollArea = document.getElementById('editor-scroll-area');
        const prevScrollRatio = !isInit && scrollArea && scrollArea.scrollHeight > scrollArea.clientHeight
          ? scrollArea.scrollTop / (scrollArea.scrollHeight - scrollArea.clientHeight)
          : 0;
        editor.setContent(content, isInit, isInit ? undefined : { scrollIntoView: false });
        if (!isInit && scrollArea) {
          const restoreScroll = () => {
            const maxScrollTop = Math.max(0, scrollArea.scrollHeight - scrollArea.clientHeight);
            scrollArea.scrollTop = Math.round(maxScrollTop * prevScrollRatio);
          };
          restoreScroll();
          requestAnimationFrame(restoreScroll);
          setTimeout(restoreScroll, 60);
        }
        requestAnimationFrame(updateGitChangeRailOffset);
        setTimeout(updateGitChangeRailOffset, 60);
        if (Array.isArray(message.gitLineRanges) && view) {
          view.dispatch(view.state.tr.setMeta(GIT_CHANGE_META, {
            lineRanges: message.gitLineRanges,
            content,
          }));
        }
        if (isInit) {
          console.log(`[InLineMd perf] editor.setContent(init): ${(performance.now() - tSetContent).toFixed(1)}ms`);
          toolbar.update(view);
          toc.update(view);
          requestAnimationFrame(() => {
            const scrollArea = document.getElementById('editor-scroll-area');
            if (scrollArea) {
              const cursorLine = typeof (message as any).initialCursorLine === 'number'
                ? (message as any).initialCursorLine
                : 0;
              const totalLines = typeof (message as any).initialTotalLines === 'number'
                ? (message as any).initialTotalLines
                : 1;
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
          view.dispatch(view.state.tr.setMeta(GIT_CHANGE_META, {
            lineRanges: Array.isArray(message.lineRanges) ? message.lineRanges : [],
            content: currentContent,
          }));
        }
        break;

      case 'focus':
        editor.focus();
        break;
      case 'revealCursor': {
        const scrollArea = document.getElementById('editor-scroll-area');
        if (!scrollArea) break;
        const cursorLine = typeof (message as any).line === 'number' ? (message as any).line : 0;
        const totalLinesFromMsg = typeof (message as any).totalLines === 'number' ? (message as any).totalLines : 0;
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
        break;
      }

      case 'fileRenamed':
        if (message.fileName) fileHeader.setName(message.fileName);
        break;

      case 'requestExportHtml':
        triggerExport(message.theme || 'light');
        break;

      case 'requestExportPdf':
        triggerExportPdf(message.theme || 'light');
        break;

      case 'imageSelected': {
        const { src, originalSrc, pos } = message;
        if (!src) break;
        editor.insertImage(src, originalSrc, pos);
        if (typeof pos === 'number' && pos >= 0) {
          showToast('Image replaced');
        }
        break;
      }

      case 'imagesDropped': {
        const images: Array<{ src: string; originalSrc: string }> = message.images;
        const dropPos: number = message.pos;
        if (!images?.length) break;
        editor.insertImagesAtPos(images, dropPos);
        showToast(images.length === 1 ? 'Image inserted' : `${images.length} images inserted`);
        break;
      }
    }
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
      if (initReceived) { clearInterval(readyRetry); return; }
      vscode.postMessage({ type: 'ready' });
    }, 500);
    setTimeout(() => clearInterval(readyRetry), 10000);
  }

}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    ensurePlaceholderHorizontalFlowStyles();
    ensureMinimalGitChangeStyles();
    initEditor();
  });
} else {
  ensurePlaceholderHorizontalFlowStyles();
  ensureMinimalGitChangeStyles();
  initEditor();
}
