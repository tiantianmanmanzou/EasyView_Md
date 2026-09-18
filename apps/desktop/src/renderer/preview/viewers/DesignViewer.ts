import * as React from 'react';
import { DrawioViewer } from './DrawioViewer';
import { extension, h, UniversalFilePreview, type ViewerProps } from './shared';

export function DesignViewer({ descriptor }: ViewerProps): React.ReactElement {
  const suffix = extension(descriptor.fileName);
  if (suffix === '.drawio' || suffix === '.dio') {
    return h(DrawioViewer, { descriptor });
  }
  return h(UniversalFilePreview, {
    descriptor,
    loadingLabel: `正在加载 ${suffix.slice(1).toUpperCase() || '设计文件'} 预览器…`,
  });
}
