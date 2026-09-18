import * as React from 'react';
import type { PreviewDescriptor } from '@easyview/contracts';
import { expandDrawioXml } from './expandDrawioXml';
import { h, Loading, UniversalFilePreview, ViewerError, type ViewerProps } from './shared';

export function DrawioViewer({ descriptor }: ViewerProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState<PreviewDescriptor | null>(null);
  const [error, setError] = React.useState<unknown>(null);

  React.useEffect(() => {
    let disposed = false;
    let objectUrl: string | null = null;
    setExpanded(null);
    setError(null);

    void (async () => {
      try {
        const response = await fetch(descriptor.contentUrl);
        if (!response.ok) throw new Error(`无法读取 Draw.io 文件（${response.status}）`);
        const text = await response.text();
        const expandedXml = expandDrawioXml(text);
        objectUrl = URL.createObjectURL(new Blob([expandedXml], { type: 'application/xml' }));
        if (disposed) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setExpanded({
          ...descriptor,
          contentUrl: objectUrl,
          mimeType: 'application/xml',
          fileName: descriptor.fileName.toLowerCase().endsWith('.dio')
            ? `${descriptor.fileName.slice(0, -4)}.drawio`
            : descriptor.fileName,
        });
      } catch (reason) {
        if (!disposed) setError(reason);
      }
    })();

    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [descriptor.contentUrl, descriptor.fileName, descriptor.mimeType, descriptor.mtimeMs, descriptor.relativePath, descriptor.route, descriptor.sessionId, descriptor.size]);

  if (error) return h(ViewerError, { error });
  if (!expanded) return h(Loading, { label: '正在解析 Draw.io 图纸…' });
  return h(UniversalFilePreview, { descriptor: expanded, loadingLabel: '正在加载 Draw.io 预览器…' });
}
