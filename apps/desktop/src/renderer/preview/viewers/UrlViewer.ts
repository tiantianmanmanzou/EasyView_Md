import * as React from 'react';
import { h, type ViewerProps } from './shared';

export function UrlViewer({ descriptor }: ViewerProps): React.ReactElement {
  return h('div', { className: 'preview-url-viewer' }, h('iframe', {
    className: 'preview-url-frame', title: descriptor.fileName, src: descriptor.contentUrl,
    sandbox: 'allow-downloads', referrerPolicy: 'no-referrer',
  }));
}
