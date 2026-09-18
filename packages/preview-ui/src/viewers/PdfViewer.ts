import * as React from 'react';
import { h, UniversalFilePreview, type ViewerProps } from './shared';

export function PdfViewer({ descriptor }: ViewerProps): React.ReactElement {
  return h(UniversalFilePreview, { descriptor, loadingLabel: '正在加载 PDF 预览器…' });
}
