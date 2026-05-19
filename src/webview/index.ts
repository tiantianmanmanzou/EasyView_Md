/**
 * InLineMd Webview Entry Point
 *
 * Thin host shell: creates Extensions + EditorCore, handles VS Code messaging and UI.
 * All ProseMirror logic is in Extensions and EditorCore.
 */

import { NodeSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { undo, redo } from 'prosemirror-history';

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
let isFullWidth = false;
let isTocVisible = false;
let isTableWrap = true; // default: enabled
let isSourceMode = false;
let sourceEditor: ReturnType<typeof createSourceEditor> | null = null;
const dualHistory = new DualModeHistory();
let _skipDualHistoryRecord = false;
let _hasEditedInCurrentMode = false;
let _modeEntryContent = ''; // content snapshot when entering current mode

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
const SETTINGS_COMMENT_RE = /^<!--\s*fullWidth:\s*(true|false)(?:\s+tocVisible:\s*(true|false))?(?:\s+tableWrap:\s*(true|false))?\s*-->[\r\n]*/;

function stripSettingsComment(content: string): string {
  return content.replace(SETTINGS_COMMENT_RE, '');
}

/** Update the settings comment line in CodeMirror when flags change */
function updateSourceSettingsComment(): void {
  return;
}

/** Detect if VS Code is using a dark theme */
function isDarkTheme(): boolean {
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

  // 3. Create EditorCore
  const tCore = performance.now();
  const editor = new EditorCore({
    extensions,
    keymaps: {
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
    },
    onContentChange(markdown) {
      _hasEditedInCurrentMode = true;
      currentContent = markdown;
      vscode.postMessage({ type: 'edit', content: markdown, fullWidth: isFullWidth, tocVisible: isTocVisible, tableWrap: isTableWrap });
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
        vscode.postMessage({ type: 'edit', content: snapshot.markdown, fullWidth: isFullWidth, tocVisible: isTocVisible, tableWrap: isTableWrap });
      } else {
        // Fallback: restore content via setContent
        editor.isUpdatingFromExtension = true;
        editor.setContent(snapshot.markdown);
        editor.isUpdatingFromExtension = false;
        currentContent = snapshot.markdown;
        vscode.postMessage({ type: 'edit', content: snapshot.markdown, fullWidth: isFullWidth, tocVisible: isTocVisible, tableWrap: isTableWrap });
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
        vscode.postMessage({ type: 'edit', content: snapshot.markdown, fullWidth: isFullWidth, tocVisible: isTocVisible, tableWrap: isTableWrap });
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
  fileHeader.setHistoryHandler(() => {
    historyPanel.toggle();
    fileHeader.getHistoryBtn().classList.toggle('active', historyPanel.visible);
  });
  fileHeader.setTocHandler(() => toc.toggle());

  document.addEventListener('keydown', (e) => {
    const isModKey = e.ctrlKey || e.metaKey;
    if (isModKey && e.shiftKey && e.code === 'KeyT' && !e.altKey) {
      e.preventDefault();
      toc.toggle();
      isTocVisible = toc.visible;
      const tocBtnEl = document.querySelector('.file-header-btn[title*="Table of Contents"], .file-header-btn[title*="Hide Table"]');
      if (tocBtnEl) {
        tocBtnEl.classList.toggle('active', isTocVisible);
        (tocBtnEl as HTMLElement).title = isTocVisible ? 'Hide Table of Contents' : 'Toggle Table of Contents';
      }
      vscode.postMessage({ type: 'edit', content: currentContent, fullWidth: isFullWidth, tocVisible: isTocVisible, tableWrap: isTableWrap });
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

  // 6. Source mode toggle
  function toggleSourceMode() {
    const scrollArea = document.getElementById('editor-scroll-area')!;
    const editorEl = document.getElementById('editor')!;

    if (!isSourceMode) {
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
              vscode.postMessage({ type: 'edit', content, fullWidth: isFullWidth, tocVisible: isTocVisible, tableWrap: isTableWrap });
            }
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
              vscode.postMessage({ type: 'edit', content: snapshot.markdown, fullWidth: isFullWidth, tocVisible: isTocVisible, tableWrap: isTableWrap });
            } else {
              // Fallback: restore content via setContent
              sourceEditor!.setContent(snapshot.markdown);
              currentContent = snapshot.markdown;
              vscode.postMessage({ type: 'edit', content: snapshot.markdown, fullWidth: isFullWidth, tocVisible: isTocVisible, tableWrap: isTableWrap });
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
              vscode.postMessage({ type: 'edit', content: snapshot.markdown, fullWidth: isFullWidth, tocVisible: isTocVisible, tableWrap: isTableWrap });
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
      _hasEditedInCurrentMode = false;
      _modeEntryContent = md; // snapshot for cross-mode undo guard
      fileHeader.getSourceBtn().classList.remove('active');
    }
  }

  fileHeader.setSourceHandler(() => toggleSourceMode());

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const isModKey = e.ctrlKey || e.metaKey;
    if (isModKey && e.key === '/') {
      e.preventDefault();
      toggleSourceMode();
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

  // 8. Theme change observer
  let currentThemeIsDark = isDark;
  const themeObserver = new MutationObserver(() => {
    const newIsDark = isDarkTheme();
    if (newIsDark !== currentThemeIsDark) {
      currentThemeIsDark = newIsDark;
      view.dispatch(view.state.tr.setMeta('theme', { isDark: newIsDark }));
    }
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });

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
              widthBtn.title = isFullWidth ? 'Exit full width' : 'Expand to full width';
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
              tocBtnEl.title = 'Hide Table of Contents';
            }
          }
          if (typeof message.tableWrap === 'boolean') {
            isTableWrap = message.tableWrap;
            document.getElementById('editor')?.classList.toggle('table-wrap', isTableWrap);
            const wrapBtn = document.querySelector('.file-header-btn[title*="table word wrap"]') as HTMLElement;
            if (wrapBtn) {
              wrapBtn.classList.toggle('active', isTableWrap);
              wrapBtn.title = isTableWrap ? 'Disable table word wrap' : 'Enable table word wrap';
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
        editor.setContent(content, isInit);
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
    initEditor();
  });
} else {
  initEditor();
}
