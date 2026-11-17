import * as React from 'react';
import { h, UniversalFilePreview, type ViewerProps } from './shared';
import { tPreview } from '../preview.i18n';

export function PdfViewer({ descriptor }: ViewerProps): React.ReactElement {
  return h(UniversalFilePreview, { descriptor, loadingLabel: tPreview('pdf.loadingViewer'), twoPage: true });
}
