// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="../css-modules.d.ts" />
import * as React from 'react';
import type { DocxEditorRef } from '@eigenpal/docx-editor-react';
import type { PreviewWriteResult } from '@easyview/contracts';
import type { PreviewHost } from '../types';
import {
  extension,
  h,
  loadingElement,
  UniversalFilePreview,
  ViewerError,
  type ViewerProps,
} from './shared';
import {
  DocumentChromeActions,
  DocumentExportIcon,
  DocumentPrintIcon,
  DocumentRouteShell,
  easyViewThemeToDocxColorMode,
  readWordCommentsSidebarOpen,
  useDocumentRouteTheme,
  useToolbarPinned,
  writeWordCommentsSidebarOpen,
} from './DocumentRouteChrome';
import { isEditableWordFile } from '../word/editableFormats';

export interface DocViewerProps extends ViewerProps {
  host?: PreviewHost;
}

/**
 * Word route handler: editable OOXML (.docx/.dotx) when the host can write bytes;
 * .doc and other word formats stay on UniversalFilePreview (same chrome as PDF).
 * Theme uses EasyView per-file preview theme only — DocxEditor has no independent theme UI.
 *
 * Top formatting bar comes from DocxEditor (`showToolbar` + `toolbarExtra`).
 * EasyView save/export/print/theme/collapse are injected into that same bar via toolbarExtra,
 * and collapse toggles `showToolbar` so the host toolbar actually hides.
 */
export function DocViewer({ descriptor, host }: DocViewerProps): React.ReactElement {
  if (isEditableWordFile(descriptor.fileName) && host?.writeBytes) {
    return h(WordEditor, { descriptor, host });
  }
  return h(UniversalFilePreview, { descriptor, loadingLabel: '正在加载 Word 预览器…' });
}

function WordEditor({ descriptor, host }: { descriptor: ViewerProps['descriptor']; host: PreviewHost }): React.ReactElement {
  const editorRef = React.useRef<DocxEditorRef | null>(null);
  const [DocxEditor, setDocxEditor] = React.useState<React.ComponentType<Record<string, unknown>> | null>(null);
  const [buffer, setBuffer] = React.useState<ArrayBuffer | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [loading, setLoading] = React.useState(true);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saveMessage, setSaveMessage] = React.useState<string | null>(null);
  const { themeMode, cycleTheme, viewerVars } = useDocumentRouteTheme(descriptor.relativePath);
  const { pinnedOpen, togglePinned } = useToolbarPinned();
  const [commentsSidebarOpen, setCommentsSidebarOpen] = React.useState(readWordCommentsSidebarOpen);
  // DocxEditor auto-opens the comments sidebar when a document has comments.
  // Accept opens only from comment-related controls — not theme / save / other toolbar clicks.
  const commentsSidebarUserGestureRef = React.useRef(false);
  const colorMode = easyViewThemeToDocxColorMode(themeMode);

  React.useEffect(() => {
    const isCommentsControl = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false;
      const el = target.closest('button, [role="button"], [title], [aria-label]');
      if (!el) return false;
      const label = `${el.getAttribute('title') || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
      return /comment|批注|注释|修订/.test(label);
    };
    const markCommentsGesture = (event: Event) => {
      if (!isCommentsControl(event.target)) return;
      commentsSidebarUserGestureRef.current = true;
      window.setTimeout(() => {
        commentsSidebarUserGestureRef.current = false;
      }, 500);
    };
    window.addEventListener('pointerdown', markCommentsGesture, true);
    window.addEventListener('keydown', markCommentsGesture, true);
    return () => {
      window.removeEventListener('pointerdown', markCommentsGesture, true);
      window.removeEventListener('keydown', markCommentsGesture, true);
    };
  }, []);

  const onCommentsSidebarOpenChange = React.useCallback((open: boolean) => {
    if (open && !commentsSidebarUserGestureRef.current) return;
    setCommentsSidebarOpen(open);
    writeWordCommentsSidebarOpen(open);
  }, []);

  React.useEffect(() => {
    let disposed = false;
    async function boot(): Promise<void> {
      setLoading(true);
      setError(null);
      setDirty(false);
      setSaveMessage(null);
      setBuffer(null);
      try {
        const [{ DocxEditor: Editor }, response] = await Promise.all([
          import('@eigenpal/docx-editor-react'),
          fetch(descriptor.contentUrl),
        ]);
        await import('@eigenpal/docx-editor-react/styles.css');
        // DocxEditor CSS injects after linked preview.css; re-assert left-gutter kill last.
        if (!document.getElementById('easyview-docx-gutter-fix')) {
          const style = document.createElement('style');
          style.id = 'easyview-docx-gutter-fix';
          style.textContent = `
.preview-word-editor .ep-root,
.preview-word-editor .ep-root .docx-editor__scroll-container,
.preview-word-editor .docx-editor__scroll-container,
.preview-word-editor .ep-root .docx-editor-vue__pages-viewport,
.preview-word-editor .docx-editor-vue__pages-viewport {
  scrollbar-gutter: auto !important;
  background: var(--file-viewer-bg, #fff) !important;
  background-color: var(--file-viewer-bg, #fff) !important;
  border-left: 0 !important;
  padding-left: 0 !important;
  margin-left: 0 !important;
}
html, body, .preview-root, .preview-shell, .preview-content, .preview-word-editor {
  margin-left: 0 !important;
  padding-left: 0 !important;
  border-left: 0 !important;
  scrollbar-gutter: auto !important;
}`;
          document.head.appendChild(style);
        }
        if (!response.ok) throw new Error(`无法读取文档（HTTP ${response.status}）`);
        const bytes = await response.arrayBuffer();
        if (disposed) return;
        setDocxEditor(() => Editor as unknown as React.ComponentType<Record<string, unknown>>);
        setBuffer(bytes);
        setLoading(false);
      } catch (reason) {
        if (!disposed) {
          setError(reason);
          setLoading(false);
        }
      }
    }
    void boot();
    return () => { disposed = true; };
  }, [descriptor.contentUrl, descriptor.sessionId]);

  // Inline-beat any remaining left gutter after mount / layout.
  React.useEffect(() => {
    if (loading || !buffer) return;
    const apply = () => {
      document.querySelectorAll<HTMLElement>(
        [
          '.preview-word-editor .docx-editor__scroll-container',
          '.preview-word-editor .docx-editor-vue__pages-viewport',
          '.preview-word-editor .ep-root',
        ].join(','),
      ).forEach((el) => {
        el.style.setProperty('scrollbar-gutter', 'auto', 'important');
        el.style.setProperty('background', 'var(--file-viewer-bg, #fff)', 'important');
        el.style.setProperty('background-color', 'var(--file-viewer-bg, #fff)', 'important');
        el.style.setProperty('border-left', '0', 'important');
        el.style.setProperty('padding-left', '0', 'important');
        el.style.setProperty('margin-left', '0', 'important');
      });
      for (const el of [document.documentElement, document.body]) {
        el.style.setProperty('padding-left', '0', 'important');
        el.style.setProperty('margin-left', '0', 'important');
        el.style.setProperty('scrollbar-gutter', 'auto', 'important');
      }
    };
    apply();
    const timer = window.setTimeout(apply, 50);
    return () => window.clearTimeout(timer);
  }, [buffer, loading, themeMode]);

  const persist = React.useCallback(async (bytes: ArrayBuffer) => {
    if (!host.writeBytes) throw new Error('当前宿主未提供文档保存能力');
    const result: PreviewWriteResult = await host.writeBytes(descriptor.sessionId, new Uint8Array(bytes));
    setDirty(false);
    setSaveMessage(`已保存 · ${(result.size / 1024).toFixed(result.size >= 10240 ? 0 : 1)} KB`);
    return result;
  }, [descriptor.sessionId, host]);

  const save = React.useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const bytes = await editorRef.current?.save();
      if (!bytes) throw new Error('文档尚未就绪，无法保存');
      await persist(bytes);
    } catch (reason) {
      setSaveMessage(reason instanceof Error ? reason.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [persist, saving]);

  const exportDocx = React.useCallback(async () => {
    try {
      const bytes = await editorRef.current?.save();
      if (!bytes) throw new Error('文档尚未就绪，无法导出');
      const blob = new Blob([bytes], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = descriptor.fileName.replace(/\.docx$/i, '') + '.docx';
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (reason) {
      setSaveMessage(reason instanceof Error ? reason.message : '导出失败');
    }
  }, [descriptor.fileName]);

  const printDoc = React.useCallback(() => {
    editorRef.current?.print();
  }, []);

  const documentActions = React.useMemo(() => (
    h(React.Fragment, null,
      h('button', {
        type: 'button',
        className: 'preview-chrome-btn preview-chrome-btn--icon',
        title: '导出为 DOCX 文件',
        'aria-label': '导出',
        disabled: !buffer || saving,
        onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
          event.stopPropagation();
          void exportDocx();
        },
      }, h(DocumentExportIcon, null)),
      h('button', {
        type: 'button',
        className: 'preview-chrome-btn preview-chrome-btn--icon',
        title: '打印',
        'aria-label': '打印',
        disabled: !buffer,
        onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
          event.stopPropagation();
          printDoc();
        },
      }, h(DocumentPrintIcon, null)),
    )
  ), [buffer, exportDocx, printDoc, saving]);

  const toolbarExtra = React.useMemo(() => (
    pinnedOpen
      ? h(DocumentChromeActions, {
          embedded: true,
          themeMode,
          onCycleTheme: cycleTheme,
          onTogglePinned: togglePinned,
          dirty,
          saving,
          saveDisabled: !buffer,
          saveMessage,
          onSave: () => { void save(); },
          documentActions,
        })
      : null
  ), [buffer, cycleTheme, dirty, documentActions, pinnedOpen, save, saveMessage, saving, themeMode, togglePinned]);

  if (error) return h(ViewerError, { error });

  return h(DocumentRouteShell, {
    className: 'preview-word-editor',
    themeMode,
    style: viewerVars,
    'data-ext': extension(descriptor.fileName),
    embedChrome: true,
    pinnedOpen,
    onTogglePinned: togglePinned,
    onCycleTheme: cycleTheme,
  },
    loading || !DocxEditor || !buffer
      ? loadingElement('正在加载 Word 编辑器…')
      : h('div', { className: 'preview-word-mount' },
          h(DocxEditor, {
            ref: editorRef,
            key: `docx-${descriptor.sessionId}`,
            documentBuffer: buffer,
            mode: 'editing',
            // Display-only mapping from EasyView theme. Never 'system'; no editor-local theme persistence.
            // colorMode updates in place — do not key on it (remount would wipe edits and auto-open comments).
            colorMode,
            showToolbar: pinnedOpen,
            showFileOpen: false,
            showHelpMenu: false,
            showZoomControl: true,
            showOutlineButton: true,
            showRuler: false,
            // Filename + File/Format/Insert menu row are hidden via CSS; keep a single formatting bar.
            // EasyView chrome is injected into that same formatting-bar via toolbarExtra.
            renderLogo: () => null,
            toolbarExtra,
            author: 'EasyView',
            documentName: descriptor.fileName,
            commentsSidebarOpen,
            onCommentsSidebarOpenChange,
            onChange: () => setDirty(true),
            onSave: (next: ArrayBuffer) => {
              void (async () => {
                setSaving(true);
                setSaveMessage(null);
                try {
                  await persist(next);
                } catch (reason) {
                  setSaveMessage(reason instanceof Error ? reason.message : '保存失败');
                } finally {
                  setSaving(false);
                }
              })();
            },
            onError: (err: Error) => setError(err),
            style: { height: '100%', width: '100%' },
          }),
        ),
  );
}
