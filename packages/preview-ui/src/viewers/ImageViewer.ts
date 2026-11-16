import * as React from 'react';
import { isPreviewWritableFile } from '@easyview/contracts';
import { extension, h, UniversalFilePreview, loadingElement, ViewerError, usePreviewAppearance, type ViewerProps } from './shared';
import { usePreviewAssets } from '../assets';
import { tPreview } from '../preview.i18n';
import { PreviewAppearanceContext } from '../appearanceContext';
import type { PreviewHost } from '../types';
import {
  DocumentRouteShell,
  useDocumentRouteTheme,
  useToolbarPinned,
} from './DocumentRouteChrome';
import { IMAGE_FRAME_SELECTOR, useImageEditor } from './ImageEditor';
import type { FileViewerHandle } from '@file-viewer/react-full';

export function ImageViewer({ descriptor, host }: ViewerProps & { host?: PreviewHost }): React.ReactElement {
  const suffix = extension(descriptor.fileName);
  const assets = usePreviewAssets();
  // HEIC needs an isolated decoder host; chrome matches other images (DocumentChrome).
  if (['.heic', '.heif'].includes(suffix)) {
    if (!assets.heicHostUrl) {
      return h(DocumentImageShell, {
        descriptor,
        body: h('div', {
          className: 'preview-viewer-message preview-viewer-unsupported',
          role: 'status',
        }, tPreview('image.heicUnsupported')),
      });
    }
    // DocumentChrome only — do not also wrap via PreviewShell BasicChrome.
    return h(DocumentImageShell, {
      descriptor,
      body: h(HeicImageViewer, { descriptor, heicHostUrl: assets.heicHostUrl }),
    });
  }
  if (host?.writeBytes && isPreviewWritableFile(descriptor.fileName)) {
    return h(EditableImageViewer, {
      key: descriptor.sessionId,
      descriptor,
      host,
      writeBytes: host.writeBytes.bind(host),
    });
  }
  return h(UniversalFilePreview, { descriptor, loadingLabel: tPreview('image.loadingViewer') });
}

/** Preview whose toolbar carries rotate / crop, applied on the shown picture. After a save it shows the saved picture. */
function EditableImageViewer({ descriptor, host, writeBytes }: ViewerProps & {
  host: PreviewHost;
  writeBytes: NonNullable<PreviewHost['writeBytes']>;
}): React.ReactElement {
  const [savedUrl, setSavedUrl] = React.useState<string | null>(null);
  const viewerRef = React.useRef<FileViewerHandle | null>(null);
  React.useEffect(() => () => {
    if (savedUrl) URL.revokeObjectURL(savedUrl);
  }, [savedUrl]);
  const shown = savedUrl ? { ...descriptor, contentUrl: savedUrl } : descriptor;
  const editor = useImageEditor({
    descriptor,
    sourceUrl: shown.contentUrl,
    viewerRef,
    writeBytes,
    host,
    onSaved: (saved) => setSavedUrl(URL.createObjectURL(saved)),
  });
  return h(UniversalFilePreview, {
    key: shown.contentUrl,
    descriptor: shown,
    loadingLabel: tPreview('image.loadingViewer'),
    toolbarExtra: editor.actions,
    viewerRef,
    overlay: editor.overlay ? { target: IMAGE_FRAME_SELECTOR, content: editor.overlay } : undefined,
  });
}

function DocumentImageShell({
  descriptor,
  body,
}: {
  descriptor: ViewerProps['descriptor'];
  body: React.ReactNode;
}): React.ReactElement {
  const { themeMode, cycleTheme, viewerVars } = useDocumentRouteTheme(descriptor.relativePath);
  const { pinnedOpen, togglePinned } = useToolbarPinned();
  return h(PreviewAppearanceContext.Provider, { value: themeMode },
    h(DocumentRouteShell, {
      className: 'preview-image-viewer preview-heic-shell',
      themeMode,
      style: viewerVars,
      'data-ext': extension(descriptor.fileName),
      onCycleTheme: cycleTheme,
      pinnedOpen,
      onTogglePinned: togglePinned,
    }, body),
  );
}

function HeicImageViewer({ descriptor, heicHostUrl }: ViewerProps & { heicHostUrl: string }): React.ReactElement {
  const appearance = usePreviewAppearance();
  const frame = React.useRef<HTMLIFrameElement>(null);
  const token = React.useMemo(() => crypto.randomUUID(), [descriptor.sessionId]);
  const [error, setError] = React.useState<unknown>(null);
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    let disposed = false;
    const receive = (event: MessageEvent<{ type?: string; token?: string; message?: string }>) => {
      if (event.source !== frame.current?.contentWindow || event.data?.token !== token) return;
      if (event.data.type === 'heic-ready') setReady(true);
      if (event.data.type === 'heic-error') setError(new Error(event.data.message || tPreview('image.heicDecodeFailed')));
    };
    window.addEventListener('message', receive);
    const send = async () => {
      try {
        const response = await fetch(descriptor.contentUrl);
        if (!response.ok) throw new Error(tPreview('image.heicReadFailed', { status: response.status }));
        const bytes = await response.arrayBuffer();
        if (!disposed) {
          frame.current?.contentWindow?.postMessage(
            { type: 'decode-heic', token, bytes, mimeType: 'image/heic', background: appearance.background, color: appearance.textColor },
            '*',
            [bytes],
          );
        }
      } catch (reason) {
        if (!disposed) setError(reason);
      }
    };
    const iframe = frame.current;
    iframe?.addEventListener('load', send, { once: true });
    return () => {
      disposed = true;
      window.removeEventListener('message', receive);
      iframe?.removeEventListener('load', send);
    };
  }, [descriptor.contentUrl, token, appearance.background, appearance.textColor]);
  React.useEffect(() => {
    frame.current?.contentWindow?.postMessage(
      { type: 'set-theme', token, background: appearance.background, color: appearance.textColor },
      '*',
    );
  }, [appearance.background, appearance.textColor, token]);
  if (error) return h(ViewerError, { error });
  return h('div', { className: 'preview-heic-viewer' },
    !ready ? loadingElement(tPreview('image.heicDecoding')) : null,
    h('iframe', {
      ref: frame,
      className: 'preview-heic-frame',
      title: descriptor.fileName,
      src: heicHostUrl,
      sandbox: 'allow-scripts',
      referrerPolicy: 'no-referrer',
    }),
  );
}
