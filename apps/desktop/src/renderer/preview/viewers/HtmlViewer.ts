import * as React from 'react';
import DOMPurify from 'dompurify';
import type { PreviewTextResult } from '@easyview/contracts';
import { h, Loading, themedHtmlDocument, usePreviewAppearance, ViewerError, type ViewerProps } from './shared';

export interface HtmlViewerProps extends ViewerProps { readText(sessionId: string): Promise<PreviewTextResult>; }

export function HtmlViewer({ descriptor, readText }: HtmlViewerProps): React.ReactElement {
  const appearance = usePreviewAppearance();
  const [source, setSource] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<'preview' | 'source'>('preview');
  const [error, setError] = React.useState<unknown>(null);
  React.useEffect(() => {
    let disposed = false;
    void readText(descriptor.sessionId).then((result) => {
      if (!disposed) setSource(result.content);
    }).catch((reason) => { if (!disposed) setError(reason); });
    return () => { disposed = true; };
  }, [descriptor.sessionId, readText]);
  if (error) return h(ViewerError, { error });
  if (source === null) return h(Loading, {});
  const safeDocument = DOMPurify.sanitize(source, {
    WHOLE_DOCUMENT: true, FORBID_TAGS: ['script', 'base', 'form', 'object', 'embed', 'meta'],
    FORBID_ATTR: ['src', 'href', 'xlink:href', 'srcset', 'action', 'formaction'],
  });
  return h('section', { className: 'preview-html-viewer' },
    h('div', { className: 'preview-tabs', role: 'tablist' },
      h('button', { type: 'button', className: tab === 'preview' ? 'active' : '', onClick: () => setTab('preview') }, '预览'),
      h('button', { type: 'button', className: tab === 'source' ? 'active' : '', onClick: () => setTab('source') }, '源码'),
    ),
    tab === 'preview'
      ? h('iframe', { className: 'preview-html-frame', title: descriptor.fileName, srcDoc: themedHtmlDocument(safeDocument, appearance), sandbox: '', referrerPolicy: 'no-referrer' })
      : h('pre', { className: 'preview-html-source' }, source),
  );
}
