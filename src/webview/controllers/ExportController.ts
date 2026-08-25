import type { EditorView } from 'prosemirror-view';
import type { EditorCore } from '../editor/EditorCore';
import { generateStandaloneHtml } from '../extensions/export/html/ExportHtml';
import { stripSettingsComment } from '../editor/lib/EditorSettings';
import type { VscodeWebviewApi } from '../../shared/protocol';
import type { createFileHeader } from '../ui/FileHeader';

type FileHeader = ReturnType<typeof createFileHeader>;
type SourceEditor = { getContent: () => string };

export interface ExportControllerDeps {
  editor: EditorCore;
  view: EditorView;
  fileHeader: FileHeader;
  vscode: VscodeWebviewApi;
  isSourceMode: () => boolean;
  getSourceEditor: () => SourceEditor | null;
}

export class ExportController {
  private readonly imageCache = new Map<string, Promise<string | null>>();

  constructor(private readonly deps: ExportControllerDeps) {}

  requestImageBase64FromHost(originalSrc: string, timeoutMs = 10000): Promise<string | null> {
    return new Promise((resolve) => {
      const requestId = Math.random().toString(36).slice(2, 11);
      let settled = false;
      const cleanup = () => window.removeEventListener('message', handler);
      const handler = (event: MessageEvent) => {
        const message = event.data;
        if (message?.type !== 'imageBase64Response' || message.requestId !== requestId || settled) return;
        settled = true;
        cleanup();
        resolve(message.base64 || null);
      };

      window.addEventListener('message', handler);
      this.deps.vscode.postMessage({ type: 'getImageBase64', requestId, originalSrc });
      setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        console.warn('[InLineMd] Image request TIMED OUT:', originalSrc, requestId);
        resolve(null);
      }, timeoutMs);
    });
  }

  installImageResolutionBridge(): void {
    (window as Window & {
      __easyviewGetImageDataUrl?: (originalSrc: string) => Promise<string | null>;
    }).__easyviewGetImageDataUrl = (originalSrc) => {
      const cached = this.imageCache.get(originalSrc);
      if (cached) return cached;
      const request = this.requestImageBase64FromHost(originalSrc, 15000).catch(() => null);
      this.imageCache.set(originalSrc, request);
      return request;
    };

    window.addEventListener('inlinemd:resolveImageFallback', ((event: CustomEvent<{
      originalSrc?: string;
      apply?: (resolvedSrc: string | null) => void;
    }>) => {
      const detail = event.detail;
      if (!detail?.originalSrc || typeof detail.apply !== 'function') return;
      void this.requestImageBase64FromHost(detail.originalSrc, 12000)
        .then((base64) => detail.apply?.(base64))
        .catch(() => detail.apply?.(null));
    }) as EventListener);
  }

  registerFileHeaderHandlers(): void {
    this.deps.fileHeader.setExportHtmlLightHandler(() => void this.exportHtml('light'));
    this.deps.fileHeader.setExportHtmlDarkHandler(() => void this.exportHtml('dark'));
    this.deps.fileHeader.setExportPdfLightHandler(() => void this.exportPdf('light'));
    this.deps.fileHeader.setExportPdfDarkHandler(() => void this.exportPdf('dark'));
    this.deps.fileHeader.setExportDocxHandler(() => void this.exportDocx());
  }

  async exportHtml(theme: 'light' | 'dark' = 'light'): Promise<void> {
    try {
      const result = await generateStandaloneHtml(this.deps.view, {
        title: this.title(),
        isDark: theme === 'dark',
      });
      this.deps.vscode.postMessage({ type: 'exportHtml', html: result.html, images: result.images });
    } catch (error) {
      console.error('[InLineMd] Export failed:', error);
      this.deps.vscode.postMessage({ type: 'showInfo', text: `Export failed: ${error}` });
    }
  }

  async exportPdf(theme: 'light' | 'dark' = 'light'): Promise<void> {
    try {
      const { generatePdfBase64 } = await import('../extensions/export/pdf/PdfMakeExport');
      const base64 = await generatePdfBase64(
        this.deps.view.state.doc,
        { title: this.title(), theme },
        (src) => this.requestImageBase64FromHost(src),
      );
      this.deps.vscode.postMessage({ type: 'exportPdfBase64', data: base64 });
    } catch (error) {
      console.error('[InLineMd] PDF export failed:', error);
      this.deps.vscode.postMessage({ type: 'showInfo', text: `PDF export failed: ${error}` });
    }
  }

  async exportDocx(): Promise<void> {
    try {
      const markdown = this.markdown();
      const mermaidImages: Array<{ source: string; pngBase64: string; width: number; height: number }> = [];
      try {
        const { extractMermaidSourcesFromMarkdown, collectExportMermaidPngs, looksLikeMermaid, normalizeMermaidSource } = await import('../extensions/export/pdf/PdfMermaidRenderer');
        const { LIGHT_PALETTE } = await import('../extensions/export/pdf/PdfPalette');
        const sources = extractMermaidSourcesFromMarkdown(markdown);
        this.deps.view.state.doc.descendants((node) => {
          if (node.type.name === 'code_block') {
            const lang = String(node.attrs.language || '').trim().toLowerCase();
            const text = normalizeMermaidSource(node.textContent || '');
            if (text && (lang === 'mermaid' || lang === 'mermaidjs' || looksLikeMermaid(text))) sources.push(text);
          } else if (node.type.name === 'mermaid') {
            const text = normalizeMermaidSource(node.attrs.content || '');
            if (text) sources.push(text);
          }
        });
        const { ordered } = await collectExportMermaidPngs(sources, LIGHT_PALETTE);
        for (const png of ordered) {
          mermaidImages.push({ source: png.source, pngBase64: png.base64, width: png.width, height: png.height });
        }
      } catch (error) {
        console.warn('[InLineMd] Mermaid render for DOCX failed; exporting diagrams as code:', error);
      }
      this.deps.vscode.postMessage({ type: 'exportDocx', title: this.title(), markdown, mermaidImages });
    } catch (error) {
      console.error('[InLineMd] DOCX export failed:', error);
      this.deps.vscode.postMessage({ type: 'showInfo', text: `DOCX export failed: ${error}` });
    }
  }

  private title(): string {
    return this.deps.fileHeader.el.querySelector('.file-header-name')?.textContent?.trim() || 'Document';
  }

  private markdown(): string {
    const sourceEditor = this.deps.getSourceEditor();
    return this.deps.isSourceMode() && sourceEditor
      ? stripSettingsComment(sourceEditor.getContent())
      : this.deps.editor.getMarkdown();
  }
}
