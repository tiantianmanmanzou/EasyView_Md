import * as React from 'react';
import { h, Loading, ViewerError, type ViewerProps } from './shared';

export interface JavaClassViewerProps extends ViewerProps { decompile(sessionId: string): Promise<string>; }

export function JavaClassViewer({ descriptor, decompile }: JavaClassViewerProps): React.ReactElement {
  const [content, setContent] = React.useState<string | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  React.useEffect(() => {
    let disposed = false;
    void decompile(descriptor.sessionId).then((result) => { if (!disposed) setContent(result); }).catch((reason) => { if (!disposed) setError(reason); });
    return () => { disposed = true; };
  }, [descriptor.sessionId, decompile]);
  if (error) return h(ViewerError, { error });
  if (content === null) return h(Loading, { label: '正在反编译 Java Class…' });
  return h('pre', { className: 'preview-text-viewer preview-code-viewer' }, content);
}
