import * as React from 'react';
import { extension, h, UniversalFilePreview, loadingElement, ViewerError, usePreviewAppearance, type ViewerProps } from './shared';
import { usePreviewAssets } from '../assets';

export function ImageViewer({ descriptor }: ViewerProps): React.ReactElement {
  const suffix = extension(descriptor.fileName);
  const assets = usePreviewAssets();
  // HEIC needs an isolated decoder host (Desktop provides heicHostUrl in phase-2).
  if (['.heic', '.heif'].includes(suffix)) {
    if (!assets.heicHostUrl) {
      return h('div', { className: 'preview-viewer-message' }, '当前宿主暂不支持 HEIC/HEIF 预览。');
    }
    return h(HeicImageViewer, { descriptor, heicHostUrl: assets.heicHostUrl });
  }
  return h(UniversalFilePreview, { descriptor, loadingLabel: '正在加载图片预览器…' });
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
      if (event.data.type === 'heic-error') setError(new Error(event.data.message || 'HEIC 图片解码失败'));
    };
    window.addEventListener('message', receive);
    const send = async () => {
      try {
        const response = await fetch(descriptor.contentUrl);
        if (!response.ok) throw new Error(`无法读取 HEIC 文件（HTTP ${response.status}）`);
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
  return h('div', { className: 'preview-image-viewer preview-heic-viewer' },
    !ready ? loadingElement('正在隔离解码 HEIC 图片…') : null,
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
