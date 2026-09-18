import * as React from 'react';
import { extension, h, UniversalFilePreview, type ViewerProps } from './shared';

/**
 * Design-route previews that share UniversalFilePreview / @file-viewer
 * (XMind mind maps, PSD, etc.). Host-specific formats like drawio stay in
 * desktop extraViewers.
 */
export function DesignViewer({ descriptor }: ViewerProps): React.ReactElement {
  const suffix = extension(descriptor.fileName);
  const label = suffix === '.xmind'
    ? '正在加载 XMind 脑图预览器…'
    : `正在加载 ${suffix.slice(1).toUpperCase() || '设计文件'} 预览器…`;
  return h(UniversalFilePreview, { descriptor, loadingLabel: label });
}
