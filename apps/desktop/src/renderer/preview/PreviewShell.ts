import * as React from 'react';
import {
  PreviewShell as SharedPreviewShell,
  createLocalPreviewThemeStorage,
  h,
  type PreviewAssetConfig,
  type PreviewExtraViewers,
  type PreviewHost,
} from '@easyview/preview-ui';
import type { PreviewController } from './PreviewController';

const desktopAssets: PreviewAssetConfig = {
  fileViewerAssetBaseUrl: new URL('./vendor/file-viewer/', window.location.href).toString(),
  pptAssetBaseUrl: new URL('./vendor/file-viewer-ppt/', window.location.href).toString(),
  docWorkerUrl: new URL('./workers/doc-worker.js', window.location.href).toString(),
  heicHostUrl: new URL('./heic-host.html', window.location.href).toString(),
  themeStorage: createLocalPreviewThemeStorage(window.localStorage),
};

const extraViewers: PreviewExtraViewers = {
  html: () => import('./viewers/HtmlViewer').then(({ HtmlViewer }) => (descriptor, host) => {
    if (!host.readText) throw new Error('当前宿主未提供文本读取能力');
    return h(HtmlViewer, { descriptor, readText: host.readText.bind(host) });
  }),
  epub: () => import('./viewers/DesignViewer').then(({ DesignViewer }) => (descriptor) => h(DesignViewer, { descriptor })),
  design: () => import('./viewers/DesignViewer').then(({ DesignViewer }) => (descriptor) => h(DesignViewer, { descriptor })),
  font: () => import('./viewers/DesignViewer').then(({ DesignViewer }) => (descriptor) => h(DesignViewer, { descriptor })),
  http: () => import('./viewers/HttpViewer').then(({ HttpViewer }) => (descriptor, host) => {
    if (!host.readText || !host.sendHttp) throw new Error('当前宿主未提供 HTTP 预览能力');
    return h(HttpViewer, {
      descriptor,
      readText: host.readText.bind(host),
      send: host.sendHttp.bind(host),
    });
  }),
  'java-class': () => import('./viewers/JavaClassViewer').then(({ JavaClassViewer }) => (descriptor, host) => {
    if (!host.decompileJava) throw new Error('当前宿主未提供 Java 反编译能力');
    return h(JavaClassViewer, { descriptor, decompile: host.decompileJava.bind(host) });
  }),
};

export interface PreviewShellProps {
  controller: PreviewController;
}

export function PreviewShell({ controller }: PreviewShellProps): React.ReactElement {
  return React.createElement(SharedPreviewShell, {
    host: controller as PreviewHost,
    assets: desktopAssets,
    extraViewers,
  });
}
