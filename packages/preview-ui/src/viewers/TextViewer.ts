import * as React from 'react';
import type { PreviewTextResult } from '@easyview/contracts';
import { h, Loading, ViewerError, type ViewerProps } from './shared';

export interface TextViewerProps extends ViewerProps {
  readText(sessionId: string): Promise<PreviewTextResult>;
}

export function TextViewer({ descriptor, readText }: TextViewerProps): React.ReactElement {
  const [content, setContent] = React.useState<string | null>(null);
  const [truncated, setTruncated] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  React.useEffect(() => {
    let disposed = false;
    setContent(null); setError(null);
    void readText(descriptor.sessionId).then((value) => {
      if (!disposed) { setContent(value.content); setTruncated(value.truncated); }
    }).catch((reason) => { if (!disposed) setError(reason); });
    return () => { disposed = true; };
  }, [descriptor.sessionId, readText]);
  if (error) return h(ViewerError, { error });
  if (content === null) return h(Loading, {});
  return h('section', { className: 'preview-text-viewer' },
    truncated ? h('p', { className: 'preview-notice' }, '内容过大，仅显示可安全读取的前段内容。') : null,
    h('pre', null, content),
  );
}
