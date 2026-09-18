import * as React from 'react';
import type { PreviewDescriptor } from '@easyview/contracts';
import { PreviewAssetsProvider } from './assets';
import type { PreviewAssetConfig, PreviewExtraViewers, PreviewHost, PreviewViewerRenderer } from './types';
import { loadingElement } from './viewers/shared';

export interface PreviewShellProps {
  host: PreviewHost;
  assets: PreviewAssetConfig;
  /** Host-specific / phase-2 viewers that override or extend the built-in map. */
  extraViewers?: PreviewExtraViewers;
}

export function PreviewShell({ host, assets, extraViewers }: PreviewShellProps): React.ReactElement {
  const state = React.useSyncExternalStore(host.subscribe, host.getState, host.getState);
  const descriptor = state.descriptor;
  return React.createElement(
    PreviewAssetsProvider,
    { assets },
    React.createElement(
      'section',
      { className: 'preview-shell', 'aria-label': '文件预览' },
      React.createElement(
        'div',
        { className: 'preview-content' },
        state.status === 'loading'
          ? loadingElement('正在创建安全预览会话…')
          : null,
        state.error
          ? React.createElement('div', { className: 'preview-viewer-message preview-viewer-error', role: 'alert' }, state.error)
          : null,
        descriptor ? React.createElement(RouteViewer, { descriptor, host, extraViewers }) : null,
      ),
    ),
  );
}

function RouteViewer({
  descriptor,
  host,
  extraViewers,
}: {
  descriptor: PreviewDescriptor;
  host: PreviewHost;
  extraViewers?: PreviewExtraViewers;
}): React.ReactElement {
  const [renderer, setRenderer] = React.useState<PreviewViewerRenderer | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    setRenderer(null);
    setError(null);
    void loadViewer(descriptor.route, extraViewers).then((loaded) => {
      if (active) setRenderer(() => loaded);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : '预览器加载失败');
    });
    return () => { active = false; };
  }, [descriptor.route, extraViewers]);

  if (error) {
    return React.createElement('div', { className: 'preview-viewer-message preview-viewer-error' }, error);
  }
  if (!renderer) {
    return loadingElement('正在加载预览器…');
  }
  return renderer(descriptor, host);
}

function loadViewer(
  route: PreviewDescriptor['route'],
  extraViewers?: PreviewExtraViewers,
): Promise<PreviewViewerRenderer> {
  const override = extraViewers?.[route];
  if (override) return override();

  switch (route) {
    case 'text':
      return import('./viewers/TextViewer').then(({ TextViewer }) => (descriptor, host) => {
        if (!host.readText) throw new Error('当前宿主未提供文本读取能力');
        return React.createElement(TextViewer, { descriptor, readText: host.readText.bind(host) });
      });
    case 'image':
      return import('./viewers/ImageViewer').then(({ ImageViewer }) => (descriptor) =>
        React.createElement(ImageViewer, { descriptor }));
    case 'svg':
      return import('./viewers/SvgViewer').then(({ SvgViewer }) => (descriptor, host) => {
        if (!host.readText) throw new Error('当前宿主未提供文本读取能力');
        return React.createElement(SvgViewer, { descriptor, readText: host.readText.bind(host) });
      });
    case 'pdf':
      return import('./viewers/PdfViewer').then(({ PdfViewer }) => (descriptor) =>
        React.createElement(PdfViewer, { descriptor }));
    case 'spreadsheet':
      return import('./viewers/SpreadsheetViewer').then(({ SpreadsheetViewer }) => (descriptor, host) =>
        React.createElement(SpreadsheetViewer, { descriptor, host }));
    case 'word':
      return import('./viewers/DocViewer').then(({ DocViewer }) => (descriptor, host) =>
        React.createElement(DocViewer, { descriptor, host }));
    case 'powerpoint':
      return import('./viewers/PresentationViewer').then(({ PresentationViewer }) => (descriptor) =>
        React.createElement(PresentationViewer, { descriptor }));
    case 'design':
      return import('./viewers/DesignViewer').then(({ DesignViewer }) => (descriptor) =>
        React.createElement(DesignViewer, { descriptor }));
    case 'archive':
      return import('./viewers/ArchiveViewer').then(({ ArchiveViewer }) => (descriptor, host) =>
        React.createElement(ArchiveViewer, { descriptor, host }));
    default:
      return Promise.reject(new Error('当前格式没有可用的预览器。'));
  }
}
