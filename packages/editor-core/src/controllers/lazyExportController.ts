import type { ExportControllerDeps } from './ExportController';

/** Defers export code and its large format-specific dependencies until export. */
export class LazyExportController {
  private controller: import('./ExportController').ExportController | undefined;
  private loadPromise: Promise<import('./ExportController').ExportController | undefined> | undefined;
  private disposed = false;

  constructor(private readonly deps: ExportControllerDeps) {}

  private load(): Promise<import('./ExportController').ExportController | undefined> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = import('./ExportController')
      .then(({ ExportController }) => {
        if (this.disposed) return undefined;
        this.controller = new ExportController(this.deps);
        return this.controller;
      })
      .catch((error) => {
        this.loadPromise = undefined;
        console.error('[EasyView_Md] Failed to load export controller:', error);
        return undefined;
      });
    return this.loadPromise;
  }

  installImageResolutionBridge(): void {
    // Keep image copy/fallback behavior available from editor startup, while
    // the format-specific export dependencies remain deferred inside the
    // controller's export methods.
    void this.load().then((controller) => controller?.installImageResolutionBridge());
  }

  registerFileHeaderHandlers(): void {
    this.deps.fileHeader.setExportHtmlLightHandler(() => void this.exportHtml('light'));
    this.deps.fileHeader.setExportHtmlDarkHandler(() => void this.exportHtml('dark'));
    this.deps.fileHeader.setExportPdfLightHandler(() => void this.exportPdf('light'));
    this.deps.fileHeader.setExportPdfDarkHandler(() => void this.exportPdf('dark'));
    this.deps.fileHeader.setExportDocxHandler(() => void this.exportDocx());
  }

  async exportHtml(theme: 'light' | 'dark' = 'light'): Promise<void> {
    const controller = await this.load();
    if (!controller) return;
    controller.installImageResolutionBridge();
    await controller.exportHtml(theme);
  }

  async exportPdf(theme: 'light' | 'dark' = 'light'): Promise<void> {
    const controller = await this.load();
    if (!controller) return;
    controller.installImageResolutionBridge();
    await controller.exportPdf(theme);
  }

  async exportDocx(): Promise<void> {
    const controller = await this.load();
    if (!controller) return;
    controller.installImageResolutionBridge();
    await controller.exportDocx();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller?.dispose();
    this.controller = undefined;
  }
}
