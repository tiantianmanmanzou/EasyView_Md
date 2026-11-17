import * as React from 'react';
import type { PreviewDescriptor } from '@easyview/contracts';
import { PreviewAssetsProvider, usePreviewAssets } from './assets';
import { BasicPreviewShell, needsBasicPreviewToolbar } from './BasicPreviewShell';
import type { PreviewAssetConfig, PreviewExtraViewers, PreviewHost, PreviewViewerRenderer } from './types';
import { loadingElement } from './viewers/shared';
import { tPreview } from './preview.i18n';

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
      { className: 'preview-shell', 'aria-label': tPreview('shell.ariaLabel') },
      React.createElement(
        'div',
        { className: 'preview-content' },
        state.status === 'loading'
          ? loadingElement(tPreview('shell.creatingSession'))
          : null,
        state.error
          ? React.createElement('div', { className: 'preview-viewer-message preview-viewer-error', role: 'alert' }, state.error)
          : null,
        descriptor ? React.createElement(RouteViewer, { descriptor, host, extraViewers }) : null,
      ),
    ),
  );
}

const OFFICE_DOCUMENT_ROUTES: ReadonlySet<PreviewDescriptor['route']> = new Set(['spreadsheet', 'word', 'powerpoint']);

/** Office / WPS write a small `~$name` owner file next to an open document; it is not a document. */
export function isOfficeLockFile(descriptor: Pick<PreviewDescriptor, 'fileName' | 'route'>): boolean {
  return OFFICE_DOCUMENT_ROUTES.has(descriptor.route) && descriptor.fileName.startsWith('~$');
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
  const assets = usePreviewAssets();
  const [renderer, setRenderer] = React.useState<PreviewViewerRenderer | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const lockFile = isOfficeLockFile(descriptor);

  React.useEffect(() => {
    if (lockFile) return undefined;
    let active = true;
    setRenderer(null);
    setError(null);
    void loadViewer(descriptor.route, extraViewers).then((loaded) => {
      if (active) setRenderer(() => loaded);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : tPreview('shell.viewerLoadFailed'));
    });
    return () => { active = false; };
  }, [descriptor.route, extraViewers, lockFile]);

  if (lockFile) {
    return React.createElement('div', { className: 'preview-viewer-message' }, tPreview('shell.officeLockFile', { fileName: descriptor.fileName }));
  }
  if (error) {
    return React.createElement('div', { className: 'preview-viewer-message preview-viewer-error' }, error);
  }
  if (!renderer) {
    return loadingElement(tPreview('shell.loadingViewer'));
  }
  const viewer = renderer(descriptor, host);
  return assets.compactToolbars && needsBasicPreviewToolbar(descriptor)
    ? React.createElement(BasicPreviewShell, { descriptor }, viewer)
    : viewer;
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
        if (!host.readText) throw new Error(tPreview('shell.readTextUnavailable'));
        return React.createElement(TextViewer, {
          descriptor,
          host,
          readText: host.readText.bind(host),
          ...(host.writeBytes ? { writeBytes: host.writeBytes.bind(host) } : {}),
        });
      });
    case 'image':
      return import('./viewers/ImageViewer').then(({ ImageViewer }) => (descriptor, host) =>
        React.createElement(ImageViewer, { descriptor, host }));
    case 'svg':
      return import('./viewers/SvgViewer').then(({ SvgViewer }) => (descriptor, host) => {
        if (!host.readText) throw new Error(tPreview('shell.readTextUnavailable'));
        return React.createElement(SvgViewer, { descriptor, readText: host.readText.bind(host) });
      });
    case 'html':
      return import('./viewers/HtmlViewer').then(({ HtmlViewer }) => (descriptor, host) =>
        React.createElement(HtmlViewer, {
          descriptor,
          ...(host.readText ? { readText: host.readText.bind(host) } : {}),
        }));
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
    case 'epub':
    case 'font':
    case 'design':
      return import('./viewers/DesignViewer').then(({ DesignViewer }) => (descriptor) =>
        React.createElement(DesignViewer, { descriptor }));
    case 'archive':
      return import('./viewers/ArchiveViewer').then(({ ArchiveViewer }) => (descriptor, host) =>
        React.createElement(ArchiveViewer, { descriptor, host }));
    case 'video':
      return import('./viewers/VideoViewer').then(({ VideoViewer }) => (descriptor) =>
        React.createElement(VideoViewer, { descriptor }));
    case 'audio':
      return import('./viewers/AudioViewer').then(({ AudioViewer }) => (descriptor) =>
        React.createElement(AudioViewer, { descriptor }));
    default:
      return Promise.reject(new Error(tPreview('shell.noViewer')));
  }
}
