import type { EditorView } from 'prosemirror-view';
import type { EditorCore } from '../editor/EditorCore';
import { generateStandaloneHtml } from '../extensions/export/html/ExportHtml';
import { stripSettingsComment } from '@easyview/markdown-core/editor-settings';
import type { EditorHostSubscription, EditorHostTransport } from '@easyview/contracts';
import type { createFileHeader } from '../ui/FileHeader';

type FileHeader = ReturnType<typeof createFileHeader>;
type SourceEditor = { getContent: () => string };
type ImageDataUrlResolver = (originalSrc: string) => Promise<string | null>;
type ImageResolutionWindow = Window & {
  __easyviewGetImageDataUrl?: ImageDataUrlResolver;
};

interface PendingImageRequest {
  settled: boolean;
  cleanup: () => void;
  resolve: (value: string | null) => void;
}

export interface ExportControllerDeps {
  editor: EditorCore;
  view: EditorView;
  fileHeader: FileHeader;
  host: EditorHostTransport;
  isSourceMode: () => boolean;
  getSourceEditor: () => SourceEditor | null;
}

export class ExportController {
  private readonly imageCache = new Map<string, Promise<string | null>>();
  private readonly pendingImageRequests = new Set<PendingImageRequest>();
  private disposed = false;
  private imageResolutionBridgeInstalled = false;
  private previousImageDataUrlResolver: ImageDataUrlResolver | undefined;
  private installedImageDataUrlResolver: ImageDataUrlResolver | undefined;
  private imageResolutionFallbackHandler: EventListener | undefined;

  constructor(private readonly deps: ExportControllerDeps) {}

  requestImageBase64FromHost(originalSrc: string, timeoutMs = 10000): Promise<string | null> {
    if (this.disposed) return Promise.resolve(null);

    return new Promise((resolve) => {
      if (this.disposed) {
        resolve(null);
        return;
      }

      const requestId = Math.random().toString(36).slice(2, 11);
      let subscription: EditorHostSubscription | undefined;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const pending: PendingImageRequest = {
        settled: false,
        cleanup: () => {
          subscription?.unsubscribe();
          if (timeoutId !== undefined) clearTimeout(timeoutId);
        },
        resolve,
      };
      const settle = (value: string | null): void => {
        if (pending.settled) return;
        pending.settled = true;
        pending.cleanup();
        this.pendingImageRequests.delete(pending);
        resolve(value);
      };

      this.pendingImageRequests.add(pending);
      try {
        subscription = this.deps.host.subscribe((message) => {
          if (this.disposed || message.type !== 'imageBase64Response' || message.requestId !== requestId) return;
          settle(message.base64 || null);
        });
        timeoutId = setTimeout(() => {
          if (pending.settled || this.disposed) return;
          console.warn('[EasyView_Md] Image request TIMED OUT:', originalSrc, requestId);
          settle(null);
        }, timeoutMs);
        this.deps.host.postMessage({ type: 'getImageBase64', requestId, originalSrc });
      } catch {
        settle(null);
      }
    });
  }

  installImageResolutionBridge(): void {
    if (this.disposed || this.imageResolutionBridgeInstalled) return;

    const target = window as ImageResolutionWindow;
    this.previousImageDataUrlResolver = target.__easyviewGetImageDataUrl;
    const resolver: ImageDataUrlResolver = (originalSrc) => {
      if (this.disposed) return Promise.resolve(null);
      const cached = this.imageCache.get(originalSrc);
      if (cached) return cached;
      const request = this.requestImageBase64FromHost(originalSrc, 15000).catch(() => null);
      this.imageCache.set(originalSrc, request);
      return request;
    };
    this.installedImageDataUrlResolver = resolver;
    target.__easyviewGetImageDataUrl = resolver;

    this.imageResolutionFallbackHandler = ((event: CustomEvent<{
      originalSrc?: string;
      apply?: (resolvedSrc: string | null) => void;
    }>) => {
      if (this.disposed) return;
      const detail = event.detail;
      if (!detail?.originalSrc || typeof detail.apply !== 'function') return;
      void this.requestImageBase64FromHost(detail.originalSrc, 12000)
        .then((base64) => {
          if (!this.disposed) detail.apply?.(base64);
        })
        .catch(() => {
          if (!this.disposed) detail.apply?.(null);
        });
    }) as EventListener;
    window.addEventListener('inlinemd:resolveImageFallback', this.imageResolutionFallbackHandler);
    this.imageResolutionBridgeInstalled = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.imageResolutionFallbackHandler) {
      window.removeEventListener('inlinemd:resolveImageFallback', this.imageResolutionFallbackHandler);
      this.imageResolutionFallbackHandler = undefined;
    }

    const target = window as ImageResolutionWindow;
    if (target.__easyviewGetImageDataUrl === this.installedImageDataUrlResolver) {
      if (this.previousImageDataUrlResolver) {
        target.__easyviewGetImageDataUrl = this.previousImageDataUrlResolver;
      } else {
        delete target.__easyviewGetImageDataUrl;
      }
    }
    this.previousImageDataUrlResolver = undefined;
    this.installedImageDataUrlResolver = undefined;
    this.imageResolutionBridgeInstalled = false;

    for (const pending of [...this.pendingImageRequests]) {
      pending.settled = true;
      pending.cleanup();
      pending.resolve(null);
    }
    this.pendingImageRequests.clear();
    this.imageCache.clear();
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
      this.deps.host.postMessage({ type: 'exportHtml', html: result.html, images: result.images });
    } catch (error) {
      console.error('[EasyView_Md] Export failed:', error);
      this.deps.host.postMessage({ type: 'showInfo', text: `Export failed: ${error}` });
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
      this.deps.host.postMessage({ type: 'exportPdfBase64', data: base64 });
    } catch (error) {
      console.error('[EasyView_Md] PDF export failed:', error);
      this.deps.host.postMessage({ type: 'showInfo', text: `PDF export failed: ${error}` });
    }
  }

  async exportDocx(): Promise<void> {
    try {
      const markdown = this.markdown();
      const mermaidImages: Array<{ source: string; pngBase64: string; width: number; height: number }> = [];
      const asciiImages: Array<{ source: string; pngBase64: string; width: number; height: number }> = [];
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
        console.warn('[EasyView_Md] Mermaid render for DOCX failed; exporting diagrams as code:', error);
      }
      try {
        const { collectAsciiPngs } = await import('../extensions/export/ascii/AsciiDiagramRenderer');
        const rendered = await collectAsciiPngs(markdown);
        asciiImages.push(...rendered);
      } catch (error) {
        console.warn('[EasyView_Md] ASCII diagram render for DOCX failed; exporting as code:', error);
      }
      this.deps.host.postMessage({ type: 'exportDocx', title: this.title(), markdown, mermaidImages, asciiImages });
    } catch (error) {
      console.error('[EasyView_Md] DOCX export failed:', error);
      this.deps.host.postMessage({ type: 'showInfo', text: `DOCX export failed: ${error}` });
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
