import * as React from 'react';
import DOMPurify from 'dompurify';
import type { PreviewTextResult } from '@easyview/contracts';
import { h, Loading, themedSvgDocument, usePreviewAppearance, ViewerError, type ViewerProps } from './shared';

export interface SvgViewerProps extends ViewerProps {
  readText(sessionId: string): Promise<PreviewTextResult>;
}

/** SVG is intentionally rendered in a no-script, opaque-origin iframe. */
export function SvgViewer({ descriptor, readText }: SvgViewerProps): React.ReactElement {
  const appearance = usePreviewAppearance();
  const [source, setSource] = React.useState<string | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  React.useEffect(() => {
    let disposed = false;
    void readText(descriptor.sessionId).then((value) => { if (!disposed) setSource(value.content); }).catch((reason) => { if (!disposed) setError(reason); });
    return () => { disposed = true; };
  }, [descriptor.sessionId, readText]);
  if (error) return h(ViewerError, { error });
  if (source === null) return h(Loading, {});
  const safe = DOMPurify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['foreignObject', 'script', 'animate', 'set'],
    FORBID_ATTR: ['href', 'xlink:href', 'src'],
  });
  return h('iframe', {
    className: 'preview-svg-frame',
    title: descriptor.fileName,
    srcDoc: themedSvgDocument(safe, appearance),
    sandbox: '',
    referrerPolicy: 'no-referrer',
  });
}
