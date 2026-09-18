import * as React from 'react';
import { h, Loading, ViewerError, extension, UniversalFilePreview, type ViewerProps } from './shared';
import { usePreviewAssets } from '../assets';
import { revokeSameOriginWorkerUrl, toSameOriginWorkerUrl } from '../workers/sameOriginWorker';

export function PresentationViewer({ descriptor }: ViewerProps): React.ReactElement {
  if (extension(descriptor.fileName) === '.ppt') return h(BinaryPptViewer, { descriptor });
  return h(UniversalFilePreview, { descriptor, loadingLabel: '正在加载演示文稿预览器…' });
}

function BinaryPptViewer({ descriptor }: ViewerProps): React.ReactElement {
  const assets = usePreviewAssets();
  const root = React.useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    let closed = false;
    let close: (() => Promise<void>) | undefined;
    let workerBlobUrl: string | null = null;
    void (async () => {
      const pptBase = assets.pptAssetBaseUrl;
      if (!pptBase) throw new Error('当前宿主未提供 PPT 预览资源');
      const rawWorkerUrl = `${pptBase}worker.mjs`;
      workerBlobUrl = await toSameOriginWorkerUrl(rawWorkerUrl);
      const [{ createPptViewer }, response] = await Promise.all([
        import('@file-viewer/ppt'),
        fetch(descriptor.contentUrl),
      ]);
      if (!response.ok) throw new Error(`无法读取 PPT（HTTP ${response.status}）`);
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
  return h('section', { className: 'preview-ppt-viewer' },
    h('p', { className: 'preview-notice' }, '旧版 PPT 预览包含 Flyfish Viewer 可见水印。'),
    h('div', { className: 'preview-ppt-canvas-root', ref: root }),
    !ready ? h(Loading, {}) : null,
  );
}
