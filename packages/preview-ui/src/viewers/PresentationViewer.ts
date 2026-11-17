import * as React from 'react';
import { h, Loading, ViewerError, extension, UniversalFilePreview, type ViewerProps } from './shared';
import { usePreviewAssets } from '../assets';
import { revokeSameOriginWorkerUrl, toSameOriginWorkerUrl } from '../workers/sameOriginWorker';
import { tPreview } from '../preview.i18n';
import {
  DocumentRouteShell,
  useDocumentRouteTheme,
  useToolbarPinned,
} from './DocumentRouteChrome';
import { DocumentStatusBar, useDocumentPages } from './DocumentStatusBar';

export function PresentationViewer({ descriptor }: ViewerProps): React.ReactElement {
  // Binary .ppt keeps its own canvas renderer but shares DocumentChrome with pptx.
  if (extension(descriptor.fileName) === '.ppt') return h(BinaryPptViewer, { descriptor });
  return h(UniversalFilePreview, { descriptor, loadingLabel: tPreview('presentation.loadingViewer') });
}

function BinaryPptViewer({ descriptor }: ViewerProps): React.ReactElement {
  const assets = usePreviewAssets();
  const root = React.useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [ready, setReady] = React.useState(false);
  const { themeMode, cycleTheme, viewerVars } = useDocumentRouteTheme(descriptor.relativePath);
  const { pinnedOpen, togglePinned } = useToolbarPinned();
  const [zoomPercent, setZoomPercent] = React.useState(100);
  const pages = useDocumentPages(root, ready ? '.flyfish-ppt-viewer > section' : null);
  const applyZoom = (percent: number): void => {
    setZoomPercent(Math.min(400, Math.max(10, Math.round(percent))));
  };

  React.useEffect(() => {
    let closed = false;
    let close: (() => Promise<void>) | undefined;
    let workerBlobUrl: string | null = null;
    void (async () => {
      const pptBase = assets.pptAssetBaseUrl;
      if (!pptBase) throw new Error(tPreview('presentation.assetsUnavailable'));
      const rawWorkerUrl = `${pptBase}worker.mjs`;
      workerBlobUrl = await toSameOriginWorkerUrl(rawWorkerUrl);
      const [{ createPptViewer }, response] = await Promise.all([
        import('@file-viewer/ppt'),
        fetch(descriptor.contentUrl),
      ]);
      if (!response.ok) throw new Error(tPreview('presentation.readFailed', { status: response.status }));
      const viewer = await createPptViewer({
        worker: 'auto',
        workerUrl: workerBlobUrl,
        wasmUrl: `${pptBase}ppt-native.wasm`,
        fontUrl: `${pptBase}ppt-font-cjk.otf`,
        cache: { enabled: true, maxBytes: 64 * 1024 * 1024, maxEntries: 48, maxEntryBytes: 8 * 1024 * 1024 },
      });
      if (closed || !root.current) {
        await viewer.close();
        return;
      }
      const mounted = await viewer.mount(root.current, await response.arrayBuffer(), {
        virtualize: true,
        releaseDelayMs: 800,
      });
      close = async () => {
        await mounted.close();
        await viewer.close();
      };
      if (!closed) setReady(true);
      if (closed) await close();
    })().catch((reason) => { if (!closed) setError(reason); });
    return () => {
      closed = true;
      if (close) void close();
      revokeSameOriginWorkerUrl(workerBlobUrl);
    };
  }, [descriptor.contentUrl, assets.pptAssetBaseUrl]);

  if (error) return h(ViewerError, { error });

  return h(DocumentRouteShell, {
    className: 'preview-ppt-viewer',
    themeMode,
    style: viewerVars,
    'data-ext': 'ppt',
    onCycleTheme: cycleTheme,
    pinnedOpen,
    onTogglePinned: togglePinned,
  },
    h('p', { className: 'preview-notice' }, tPreview('presentation.watermarkNotice')),
    h('div', {
      className: 'preview-ppt-canvas-root',
      ref: root,
      'data-zoomed': zoomPercent === 100 ? undefined : '',
      style: { zoom: zoomPercent / 100 },
    }),
    h(DocumentStatusBar, {
      pages,
      percent: zoomPercent,
      onPercent: applyZoom,
      onStep: (direction) => { applyZoom(zoomPercent + direction * 10); },
      onReset: () => { applyZoom(100); },
      onFit: () => { applyZoom(100); },
    }),
    !ready ? h(Loading, {}) : null,
  );
}
