import * as React from 'react';
import { createPortal } from 'react-dom';
import type { FileViewerProps, ViewerOptions } from '@file-viewer/react-full';
import type { PreviewDescriptor } from '@easyview/contracts';
import { EASYVIEW_THEME_PALETTE } from '@easyview/contracts';
import { usePreviewAssets } from '../assets';
import {
  PREVIEW_THEME_ICONS,
  PREVIEW_THEME_TITLES,
  createLocalPreviewThemeStorage,
  cyclePreviewThemeMode,
  previewThemeCssVars,
  previewThemeToViewerTheme,
  resolvePreviewThemeMode,
  useLiftPreviewThemeSurface,
  type PreviewThemeMode,
  type PreviewThemeStorage,
} from '../theme';
import { revokeSameOriginWorkerUrl, toSameOriginWorkerUrl } from '../workers/sameOriginWorker';

export type { PreviewDescriptor };

export interface ViewerProps {
  descriptor: PreviewDescriptor;
}

export type PreviewAppearance = {
  theme: 'light' | 'dark';
  mode: PreviewThemeMode;
  background: string;
  panelBackground: string;
  foreground: string;
  textColor: string;
  accent: string;
};

export const h = React.createElement;

/** Collapse / expand use sideways chevrons (toolbar pin), not up/down. */
export function PreviewToolbarPinIcon(props: { expand: boolean }): React.ReactElement {
  return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true, className: 'preview-toolbar-pin-icon' }, h('path', {
    // expand = point left «open»; collapse = point right «stow»
    d: props.expand ? 'M10.2 2.6 4.8 8l5.4 5.4' : 'M5.8 2.6 11.2 8 5.8 13.4',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }));
}

export function extension(fileName: string): string {
  const match = /\.[^.]+$/u.exec(fileName.toLocaleLowerCase());
  return match?.[0] ?? '';
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function Loading({ label = '正在加载预览…' }: { label?: string }): React.ReactElement {
  return h('div', { className: 'preview-viewer-message' }, label);
}

/** Prefer this over createElement(Loading) — React 19 typings reject loose FC createElement calls. */
export function loadingElement(label = '正在加载预览…'): React.ReactElement {
  return Loading({ label });
}

export function ViewerError({ error }: { error: unknown }): React.ReactElement {
  const message = error instanceof Error ? error.message : '预览失败';
  return h('div', { className: 'preview-viewer-message preview-viewer-error', role: 'alert' }, message);
}

function resolveThemeStorage(explicit?: PreviewThemeStorage): PreviewThemeStorage {
  return explicit ?? createLocalPreviewThemeStorage();
}

export function appearanceFromThemeMode(mode: PreviewThemeMode): PreviewAppearance {
  const palette = EASYVIEW_THEME_PALETTE[mode];
  return {
    theme: previewThemeToViewerTheme(mode),
    mode,
    background: palette.background,
    panelBackground: palette.panelBackground,
    foreground: palette.foreground,
    textColor: palette.textColor,
    accent: palette.foreground,
  };
}

export function usePreviewAppearance(mode?: PreviewThemeMode): PreviewAppearance {
  const [appearance, setAppearance] = React.useState(() => (
    mode ? appearanceFromThemeMode(mode) : readPreviewAppearance()
  ));
  React.useEffect(() => {
    if (mode) {
      setAppearance(appearanceFromThemeMode(mode));
      return;
    }
    const refresh = () => setAppearance(readPreviewAppearance());
    const observer = new MutationObserver(refresh);
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-mdpre-accent', 'data-easyview-theme', 'class', 'style'] });
    window.addEventListener('inlinemd:themeChanged', refresh);
    let frame: number | null = requestAnimationFrame(refresh);
    return () => {
      observer.disconnect();
      window.removeEventListener('inlinemd:themeChanged', refresh);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [mode]);
  return appearance;
}

export function readPreviewAppearance(): PreviewAppearance {
  const style = getComputedStyle(document.body);
  const root = document.documentElement;
  const attrMode = root.dataset.easyviewTheme || document.body.dataset.easyviewTheme;
  let base: PreviewAppearance;
  if (attrMode === 'light' || attrMode === 'gray' || attrMode === 'dark') {
    base = appearanceFromThemeMode(attrMode);
  } else {
    try {
      base = appearanceFromThemeMode(resolveThemeStorage().getProductTheme());
    } catch {
      const background = cssValue(style, '--vscode-editor-background', '#ffffff');
      const foreground = cssValue(style, '--vscode-editor-foreground', '#1f2328');
      const panelBackground = cssValue(style, '--vscode-editorWidget-background', background);
      const mode: PreviewThemeMode = colorLuminance(background) < 0.48 ? 'dark' : 'light';
      base = {
        theme: mode,
        mode,
        background,
        panelBackground,
        foreground,
        textColor: foreground,
        accent: foreground,
      };
    }
  }

  // Prefer live CSS variables when the host has already applied depth/accent.
  const background = cssValue(style, '--vscode-editor-background', base.background);
  const foreground = cssValue(style, '--vscode-editor-foreground', base.foreground);
  const panelBackground = cssValue(style, '--vscode-editorWidget-background', base.panelBackground);
  const accent = cssValue(style, '--mdpre-accent', base.accent);
  const hasAccent = document.body.dataset.mdpreAccent !== undefined
    && document.body.dataset.mdpreAccent !== 'default';
  const textColor = hasAccent
    ? cssValue(style, '--mdpre-accent-text', accent)
    : cssValue(style, '--vscode-editor-foreground', base.textColor);

  return {
    ...base,
    background,
    panelBackground,
    foreground,
    textColor,
    accent,
  };
}

export function themedHtmlDocument(markup: string, appearance: PreviewAppearance): string {
  const themeStyle = `<style id="easyview-preview-theme">html,body{min-height:100%;margin:0;background:${appearance.background}!important;color:${appearance.textColor}!important}body,body *{color:${appearance.textColor}!important}a{color:${appearance.accent}!important}</style>`;
  if (/<\/head>/i.test(markup)) return markup.replace(/<\/head>/i, `${themeStyle}</head>`);
  if (/<html[^>]*>/i.test(markup)) return markup.replace(/<html([^>]*)>/i, `<html$1><head>${themeStyle}</head>`);
  return `<!doctype html><html><head>${themeStyle}</head><body>${markup}</body></html>`;
}

export function themedSvgDocument(markup: string, appearance: PreviewAppearance): string {
  return `<!doctype html><html><head><style>html,body{width:100%;height:100%;margin:0;background:${appearance.background};color:${appearance.textColor}}body{display:grid;place-items:center;overflow:auto}svg{display:block;max-width:100%;max-height:100%}svg text,svg tspan{fill:${appearance.textColor}!important;color:${appearance.textColor}!important}</style></head><body>${markup}</body></html>`;
}

async function loadUniversalFileViewer(assetBaseUrl: string): Promise<React.ComponentType<FileViewerProps>> {
  const module = await import('@file-viewer/react-full');
  module.setDefaultFullAssetBaseUrl(assetBaseUrl);
  return module.default;
}

const TOOLBAR_PINNED_STORAGE_KEY = 'easyview.preview.toolbarPinned';

function readToolbarPinned(): boolean {
  try {
    const raw = window.localStorage.getItem(TOOLBAR_PINNED_STORAGE_KEY);
    if (raw === null) return true;
    return raw === '1' || raw === 'true';
  } catch {
    return true;
  }
}

function writeToolbarPinned(pinned: boolean): void {
  try {
    window.localStorage.setItem(TOOLBAR_PINNED_STORAGE_KEY, pinned ? '1' : '0');
  } catch {
    // Ignore quota / private-mode failures; in-memory state still works.
  }
}

const STABLE_TOOLBAR_FLAG = '__easyviewStableToolbar';

function fileViewerToolbarSignature(nodes: readonly Node[]): string {
  return nodes.map((node) => {
    if (!(node instanceof HTMLElement)) return node.textContent || '';
    const input = node instanceof HTMLInputElement ? node.value : '';
    const disabled = node.querySelectorAll?.('button:disabled, input:disabled').length ?? 0;
    return [
      node.tagName,
      node.className,
      node.getAttribute('aria-label') || '',
      input,
      String(disabled),
      node.textContent || '',
    ].join('\u0001');
  }).join('\u0002');
}

/**
 * @file-viewer rebuilds the whole toolbar DOM on every notifyState (including PDF
 * scroll / view-state-change). Coalesce no-op rebuilds so the strip does not flash.
 */
function stabilizeFileViewerToolbar(toolbar: HTMLElement): void {
  const flagged = toolbar as HTMLElement & { [STABLE_TOOLBAR_FLAG]?: boolean };
  if (flagged[STABLE_TOOLBAR_FLAG]) return;
  flagged[STABLE_TOOLBAR_FLAG] = true;

  const nativeReplaceChildren = toolbar.replaceChildren.bind(toolbar);
  const nativeAppendChild = toolbar.appendChild.bind(toolbar);
  let lastSignature: string | null = null;
  let collecting = false;
  let collected: Node[] = [];

  toolbar.replaceChildren = ((...nodes: Array<Node | string>) => {
    if (nodes.length > 0) {
      nativeReplaceChildren(...nodes);
      return;
    }

    collected = [];
    if (!collecting) {
      collecting = true;
      toolbar.appendChild = ((node: Node) => {
        // Keep EasyView chrome on the live toolbar; never buffer it into a rebuild.
        if (
          node instanceof HTMLElement
          && node.getAttribute('data-easyview-toolbar-slot') === 'chrome'
        ) {
          return nativeAppendChild(node);
        }
        collected.push(node);
        return node;
      }) as typeof toolbar.appendChild;

      queueMicrotask(() => {
        toolbar.appendChild = nativeAppendChild;
        collecting = false;
        const signature = fileViewerToolbarSignature(collected);
        const chrome = toolbar.querySelector('[data-easyview-toolbar-slot="chrome"]');

        if (lastSignature !== null && signature === lastSignature) {
          collected = [];
          if (chrome && toolbar.lastElementChild !== chrome) {
            nativeAppendChild(chrome);
          }
          return;
        }

        lastSignature = signature;
        nativeReplaceChildren(...collected);
        collected = [];
        if (chrome) nativeAppendChild(chrome);
      });
    }
  }) as typeof toolbar.replaceChildren;
}

/**
 * Stable trailing host inside @file-viewer toolbar for EasyView theme + collapse.
 * Survives toolbar rebuilds via a stable HTMLElement identity + sync re-append.
 */
function useFileViewerToolbarChromeSlot(
  rootRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
): HTMLElement | null {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const [host, setHost] = React.useState<HTMLElement | null>(null);

  React.useEffect(() => {
    if (!enabled) {
      hostRef.current?.remove();
      hostRef.current = null;
      setHost(null);
      return;
    }

    if (!hostRef.current) {
      const el = document.createElement('div');
      el.setAttribute('data-easyview-toolbar-slot', 'chrome');
      el.className = 'file-viewer-web-toolbar-group preview-file-viewer-chrome-slot';
      el.setAttribute('role', 'group');
      el.setAttribute('aria-label', 'EasyView 工具');
      hostRef.current = el;
      setHost(el);
    }
    const chrome = hostRef.current;

    let observedToolbar: HTMLElement | null = null;
    let toolbarObserver: MutationObserver | null = null;

    const attach = () => {
      const root = rootRef.current;
      if (!root) return;
      const toolbar = root.querySelector('.file-viewer-web-toolbar') as HTMLElement | null;
      if (!toolbar || toolbar.hidden) return;

      stabilizeFileViewerToolbar(toolbar);

      if (observedToolbar !== toolbar) {
        toolbarObserver?.disconnect();
        observedToolbar = toolbar;
        // Sync re-append before paint — rAF left a visible gap after replaceChildren.
        toolbarObserver = new MutationObserver(() => {
          attach();
        });
        toolbarObserver.observe(toolbar, { childList: true });
      }

      if (chrome.parentElement !== toolbar || toolbar.lastElementChild !== chrome) {
        toolbar.appendChild(chrome);
      }
    };

    attach();
    const root = rootRef.current;
    // Only watch for toolbar mount/unmount — not PDF page DOM churn under subtree.
    const rootObserver = root
      ? new MutationObserver(() => {
          attach();
        })
      : null;
    rootObserver?.observe(root!, { childList: true, subtree: true });

    return () => {
      toolbarObserver?.disconnect();
      rootObserver?.disconnect();
      chrome.remove();
    };
  }, [enabled, rootRef]);

  return host;
}

export function UniversalFilePreview({ descriptor, loadingLabel = '正在加载文件预览器…' }: ViewerProps & { loadingLabel?: string }): React.ReactElement {
  const assets = usePreviewAssets();
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const themeStorage = React.useMemo(
    () => resolveThemeStorage(assets.themeStorage),
    [assets.themeStorage],
  );
  const [Viewer, setViewer] = React.useState<React.ComponentType<FileViewerProps> | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [pptxWorkerUrl, setPptxWorkerUrl] = React.useState<string | null>(null);
  const [archiveWorkerUrl, setArchiveWorkerUrl] = React.useState<string | null>(null);
  const [pinnedOpen, setPinnedOpen] = React.useState(readToolbarPinned);
  const [themeMode, setThemeMode] = React.useState<PreviewThemeMode>(() => (
    resolvePreviewThemeMode(themeStorage, descriptor.relativePath)
  ));
  const appearance = appearanceFromThemeMode(themeMode);
  const needsPptxWorker = descriptor.route === 'powerpoint';
  const needsArchiveWorker = descriptor.route === 'archive';
  const toolbarChrome = useFileViewerToolbarChromeSlot(rootRef, pinnedOpen && !!Viewer);
  useLiftPreviewThemeSurface(themeMode);

  React.useEffect(() => {
    setThemeMode(resolvePreviewThemeMode(themeStorage, descriptor.relativePath));
  }, [descriptor.relativePath, themeStorage]);

  React.useEffect(() => {
    const refreshProductDefault = () => {
      if (themeStorage.readFileTheme(descriptor.relativePath)) return;
      setThemeMode(themeStorage.getProductTheme());
    };
    window.addEventListener('inlinemd:themeChanged', refreshProductDefault);
    window.addEventListener('easyview:productThemeChanged', refreshProductDefault);
    return () => {
      window.removeEventListener('inlinemd:themeChanged', refreshProductDefault);
      window.removeEventListener('easyview:productThemeChanged', refreshProductDefault);
    };
  }, [descriptor.relativePath, themeStorage]);

  React.useEffect(() => {
    let disposed = false;
    void loadUniversalFileViewer(assets.fileViewerAssetBaseUrl).then((Component) => {
      if (!disposed) setViewer(() => Component);
    }).catch((reason) => { if (!disposed) setError(reason); });
    return () => { disposed = true; };
  }, [assets.fileViewerAssetBaseUrl]);

  React.useEffect(() => {
    if (!needsPptxWorker) {
      setPptxWorkerUrl(null);
      return;
    }
    let disposed = false;
    let created: string | null = null;
    setPptxWorkerUrl(null);
    void (async () => {
      try {
        const rawUrl = new URL('vendor/pptx/pptx.worker.js', assets.fileViewerAssetBaseUrl).href;
        created = await toSameOriginWorkerUrl(rawUrl);
        if (disposed) {
          revokeSameOriginWorkerUrl(created);
          return;
        }
        setPptxWorkerUrl(created);
      } catch (reason) {
        if (!disposed) setError(reason);
      }
    })();
    return () => {
      disposed = true;
      revokeSameOriginWorkerUrl(created);
    };
  }, [needsPptxWorker, assets.fileViewerAssetBaseUrl]);

  React.useEffect(() => {
    if (!needsArchiveWorker) {
      setArchiveWorkerUrl(null);
      return;
    }
    let disposed = false;
    let created: string | null = null;
    setArchiveWorkerUrl(null);
    void (async () => {
      try {
        const rawUrl = new URL('vendor/libarchive/worker-bundle.js', assets.fileViewerAssetBaseUrl).href;
        created = await toSameOriginWorkerUrl(rawUrl);
        if (disposed) {
          revokeSameOriginWorkerUrl(created);
          return;
        }
        setArchiveWorkerUrl(created);
      } catch {
        // ZIP/TAR/GZIP can still use the renderer fallback without libarchive.
        if (!disposed) setArchiveWorkerUrl(null);
      }
    })();
    return () => {
      disposed = true;
      revokeSameOriginWorkerUrl(created);
    };
  }, [needsArchiveWorker, assets.fileViewerAssetBaseUrl]);

  const togglePinned = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setPinnedOpen((open) => {
      const next = !open;
      writeToolbarPinned(next);
      return next;
    });
  }, []);

  const cycleTheme = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setThemeMode((current) => {
      const next = cyclePreviewThemeMode(current);
      themeStorage.writeFileTheme(descriptor.relativePath, next);
      return next;
    });
  }, [descriptor.relativePath, themeStorage]);

  if (error) return h(ViewerError, { error });
  if (!Viewer || (needsPptxWorker && !pptxWorkerUrl)) return loadingElement(loadingLabel);

  const archiveWasmUrl = needsArchiveWorker
    ? new URL('vendor/libarchive/libarchive.wasm', assets.fileViewerAssetBaseUrl).href
    : null;

  const options: ViewerOptions = {
    theme: appearance.theme,
    styleIsolation: 'none',
    toolbar: pinnedOpen ? { theme: false, position: 'top' } : false,
    pdf: { toolbar: false },
    ui: {
      density: 'compact',
      surfaceBackground: appearance.background,
    },
    ...(pptxWorkerUrl
      ? {
          presentation: {
            workerUrl: pptxWorkerUrl,
            // pptx.worker.js is a classic IIFE bundle; module Workers reject it.
            workerType: 'classic',
          },
        }
      : {}),
    ...(needsArchiveWorker
      ? {
          archive: {
            ...(archiveWorkerUrl ? { workerUrl: archiveWorkerUrl } : {}),
            ...(archiveWasmUrl ? { wasmUrl: archiveWasmUrl } : {}),
            cache: true,
          },
        }
      : {}),
  };
  const viewerVars = {
    ...previewThemeCssVars(themeMode),
  } as React.CSSProperties;
  const style = {
    height: '100%',
    color: appearance.textColor,
    background: appearance.background,
    ...viewerVars,
  } as React.CSSProperties;

  const chromePortal = toolbarChrome
    ? createPortal(
        h(React.Fragment, null,
          h('button', {
            type: 'button',
            className: 'preview-chrome-btn preview-chrome-btn--icon preview-toolbar-theme',
            title: PREVIEW_THEME_TITLES[themeMode],
            'aria-label': PREVIEW_THEME_TITLES[themeMode],
            'data-mode': themeMode,
            onClick: cycleTheme,
            dangerouslySetInnerHTML: { __html: PREVIEW_THEME_ICONS[themeMode] },
          }),
          h('button', {
            type: 'button',
            className: 'preview-chrome-btn preview-chrome-btn--icon preview-toolbar-toggle preview-toolbar-collapse-dock',
            title: '收起预览工具栏',
            'aria-label': '收起预览工具栏',
            'aria-expanded': true,
            onClick: togglePinned,
          }, h(PreviewToolbarPinIcon, { expand: false })),
        ),
        toolbarChrome,
      )
    : null;

  return h('div', {
    ref: rootRef,
    className: `preview-universal-viewer${pinnedOpen ? ' is-toolbar-pinned' : ' is-toolbar-collapsed'}`,
    'data-preview-theme': themeMode,
    style: viewerVars,
  },
    h(Viewer, {
      className: 'file-viewer-host',
      url: descriptor.contentUrl,
      filename: descriptor.fileName,
      options,
      style,
    }),
    chromePortal,
    pinnedOpen
      ? null
      : h('button', {
          type: 'button',
          className: 'preview-chrome-btn preview-chrome-btn--icon preview-toolbar-toggle preview-toolbar-expand-dock',
          'data-tooltip': '展开预览工具栏',
          'aria-label': '展开预览工具栏',
          'aria-expanded': false,
          onClick: togglePinned,
        }, h(PreviewToolbarPinIcon, { expand: true })),
  );
}

function cssValue(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback;
}

function colorLuminance(color: string): number {
  const match = color.match(/[\d.]+/g);
  if (!match || match.length < 3) return 1;
  const values = match.slice(0, 3).map((value) => Number(value) / 255).map((value) =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}
