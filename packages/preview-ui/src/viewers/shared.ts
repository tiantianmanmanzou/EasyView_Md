import * as React from 'react';
import { createPortal } from 'react-dom';
import type { FileViewerHandle, FileViewerProps, ViewerOptions, ViewerState } from '@file-viewer/react-full';
import type { PreviewDescriptor } from '@easyview/contracts';
import { EASYVIEW_THEME_PALETTE } from '@easyview/contracts';
import { getLocale } from '@easyview/contracts/i18n';
import { usePreviewAssets } from '../assets';
import {
  PREVIEW_THEME_ICONS,
  createLocalPreviewThemeStorage,
  cyclePreviewThemeMode,
  previewThemeCssVars,
  previewThemeTitle,
  previewThemeToViewerTheme,
  resolvePreviewThemeMode,
  useLiftPreviewThemeSurface,
  type PreviewThemeMode,
  type PreviewThemeStorage,
} from '../theme';
import { revokeSameOriginWorkerUrl, toSameOriginWorkerUrl } from '../workers/sameOriginWorker';
import { tPreview } from '../preview.i18n';
import { useToolbarPinned } from '../useToolbarPinned';
import { PreviewAppearanceContext } from '../appearanceContext';
import { installCompactToolbarIcons } from '../toolbarIcons';
import { installPptxThumbnails } from './pptxThumbnails';
import { installPptxViewerRegistry, pptxSlideMaterializer } from './pptxSlideMaterializer';
import { PPTX_OUTLINE_SUFFIX, readPptxSlideTitles } from './pptxOutline';
import { installDocFloatingPictures, readDocFloatingPictures } from './docFloatingPictures';
import { installPdfOutlineFirst } from './pdfOutlineFirst';
import { installPdfPageNavEnhance } from './pdfPageNavEnhance';
import { installPreviewSidebarResize } from '../previewSidebarResize';
import { installWordOutline, wordOutlineLabels, type WordOutlineController } from './wordOutlinePane';
import { createDocxPreviewOutlineSource, createMsdocOutlineSource, readDocxPackageHeadings } from './wordOutlineSources';
import { installPreviewSidebarToggle } from '../previewSidebarToggle';
import { installCompactToolbarSearch } from '../toolbarSearch';
import { DocumentStatusBar, useDocumentPages } from './DocumentStatusBar';
import { readTwoPageView, TwoPageButton, twoPageFitScale, writeTwoPageView } from './twoPageView';

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

/** Collapse = chevron up (bar slides up); expand = chevron down (bar slides down). */
export function PreviewToolbarPinIcon(props: { expand: boolean }): React.ReactElement {
  return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true, className: 'preview-toolbar-pin-icon' }, h('path', {
    // expand=true → down; expand=false → up (matches Markdown / desktop toggle)
    d: props.expand ? 'M3.5 6 8 10.5 12.5 6' : 'M3.5 10 8 5.5 12.5 10',
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
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function Loading({ label = tPreview('common.loading') }: { label?: string }): React.ReactElement {
  return h('div', { className: 'preview-viewer-message' }, label);
}

/** Prefer this over createElement(Loading) — React 19 typings reject loose FC createElement calls. */
export function loadingElement(label = tPreview('common.loading')): React.ReactElement {
  return Loading({ label });
}

/** JSZip's wording when the bytes have no ZIP central directory (OOXML, EPUB, ZIP-based archives). */
const NOT_ZIP_ERROR = /end of central directory|is this a zip file/i;

export function viewerErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return tPreview('common.failed');
  return NOT_ZIP_ERROR.test(error.message) ? tPreview('common.notZipDocument') : error.message;
}

export function ViewerError({ error }: { error: unknown }): React.ReactElement {
  const message = viewerErrorMessage(error);
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
  const inheritedMode = React.useContext(PreviewAppearanceContext);
  mode ??= inheritedMode;
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
  // The registry must wrap PptxViewer before any deck opens so thumbnails can mount every slide.
  const [module] = await Promise.all([import('@file-viewer/react-full'), installPptxViewerRegistry()]);
  module.setDefaultFullAssetBaseUrl(assetBaseUrl);
  return module.default;
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
  compact: boolean,
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
      el.setAttribute('aria-label', tPreview('toolbar.group'));
      hostRef.current = el;
      setHost(el);
    }
    const chrome = hostRef.current;

    let observedToolbar: HTMLElement | null = null;
    let toolbarObserver: MutationObserver | null = null;
    let disposeSearch: (() => void) | null = null;

    const attach = () => {
      const root = rootRef.current;
      if (!root) return;
      const toolbar = root.querySelector('.file-viewer-web-toolbar') as HTMLElement | null;
      if (!toolbar || toolbar.hidden) return;

      stabilizeFileViewerToolbar(toolbar);

      if (observedToolbar !== toolbar) {
        toolbarObserver?.disconnect();
        disposeSearch?.();
        observedToolbar = toolbar;
        if (compact) {
          const disposers = [
            installCompactToolbarSearch(toolbar),
            installCompactToolbarIcons(toolbar),
            installPreviewSidebarToggle(toolbar, root, tPreview('toolbar.toggleSidebar')),
          ];
          disposeSearch = () => disposers.forEach(dispose => dispose());
        } else {
          disposeSearch = null;
        }
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
      disposeSearch?.();
      rootObserver?.disconnect();
      chrome.remove();
    };
  }, [enabled, rootRef, compact]);

  return host;
}

/** The first rendered element matching `selector`, followed across renderer re-mounts. */
function useRenderedElement(
  rootRef: React.RefObject<HTMLElement | null>,
  selector: string | null,
): HTMLElement | null {
  const [element, setElement] = React.useState<HTMLElement | null>(null);

  React.useEffect(() => {
    const root = rootRef.current;
    if (!selector || !root) return;
    const find = () => setElement(root.querySelector<HTMLElement>(selector));
    find();
    const observer = new MutationObserver(find);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      setElement(null);
    };
  }, [selector, rootRef]);

  return element;
}

/** Mounts the PPTX thumbnail rail on each rendered deck; theme reloads replace the deck DOM. */
function usePptxThumbnails(
  rootRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
  contentUrl: string,
  fileName: string,
): void {
  React.useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return;
    const titles: Promise<string[]> = PPTX_OUTLINE_SUFFIX.test(fileName)
      ? fetch(contentUrl)
          .then(response => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status)))))
          .then(readPptxSlideTitles)
          .catch(() => [])
      : Promise.resolve([]);
    let content: HTMLElement | null = null;
    let dispose: (() => void) | null = null;
    const attach = (): void => {
      const next = root.querySelector<HTMLElement>('.flyfish-pptx-content:not(.preview-pptx-thumb-stage)');
      if (next === content) return;
      dispose?.();
      dispose = null;
      content = next;
      if (next) {
        dispose = installPptxThumbnails(next, {
          list: tPreview('pptx.thumbnails'),
          outline: tPreview('nav.outline'),
          pages: tPreview('nav.pages'),
          outlineEmpty: tPreview('nav.outlineEmpty'),
          slide: index => tPreview('pptx.slide', { index }),
        }, titles, pptxSlideMaterializer(next));
      }
    };
    attach();
    const observer = new MutationObserver(attach);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      dispose?.();
    };
  }, [enabled, rootRef, contentUrl, fileName]);
}

/** OOXML Word files the read-only renderer shows with docx-preview (macro-enabled or not writable). */
const WORD_PACKAGE_SUFFIX = /\.(docx|docm|dotx|dotm)$/i;
const WORD_BINARY_SUFFIX = /\.doc$/i;

/** Word outline rail beside the read-only .doc / .docm renderer; theme reloads replace the shell. */
function useWordOutline(
  rootRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
  contentUrl: string,
  fileName: string,
): void {
  React.useEffect(() => {
    const root = rootRef.current;
    const binary = WORD_BINARY_SUFFIX.test(fileName);
    if (!enabled || !root || (!binary && !WORD_PACKAGE_SUFFIX.test(fileName))) return;
    const headings = binary
      ? null
      : fetch(contentUrl)
          .then(response => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status)))))
          .then(readDocxPackageHeadings);
    headings?.catch(() => undefined);
    let shell: HTMLElement | null = null;
    let controller: WordOutlineController | null = null;
    let resize: ResizeObserver | null = null;
    const place = (): void => {
      const content = shell?.querySelector<HTMLElement>(':scope > .file-viewer-web-content');
      if (controller && content) controller.pane.style.top = `${content.offsetTop}px`;
    };
    const detach = (): void => {
      resize?.disconnect();
      resize = null;
      controller?.dispose();
      controller = null;
      shell?.classList.remove('has-word-outline');
    };
    const attach = (): void => {
      const next = root.querySelector<HTMLElement>('.file-viewer-web-shell');
      if (next === shell && (!next || controller)) {
        place();
        return;
      }
      detach();
      shell = next;
      if (!next || !next.querySelector('.file-viewer-web-content')) return;
      const source = binary
        ? createMsdocOutlineSource(root)
        : createDocxPreviewOutlineSource(root, headings ?? Promise.resolve([]));
      next.classList.add('has-word-outline');
      controller = installWordOutline(next, source, wordOutlineLabels());
      if (typeof ResizeObserver === 'function') {
        resize = new ResizeObserver(place);
        resize.observe(next);
      }
      place();
    };
    attach();
    const observer = new MutationObserver(attach);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      detach();
    };
  }, [enabled, rootRef, contentUrl, fileName]);
}

/** Floating pictures (stamps, signatures, logos) that the .doc renderer leaves out. */
function useDocFloatingPictures(
  rootRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
  contentUrl: string,
  fileName: string,
): void {
  React.useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root || !WORD_BINARY_SUFFIX.test(fileName)) return;
    let disposed = false;
    let uninstall: (() => void) | null = null;
    void fetch(contentUrl)
      .then(response => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status)))))
      .then((data) => {
        const layer = readDocFloatingPictures(data);
        if (layer && !disposed) uninstall = installDocFloatingPictures(root, layer);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      uninstall?.();
    };
  }, [enabled, rootRef, contentUrl, fileName]);
}

/** PDF navigation opens on the outline; documents without one fall back to pages. */
function usePdfOutlineFirst(rootRef: React.RefObject<HTMLDivElement | null>, enabled: boolean): void {
  React.useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return;
    return installPdfOutlineFirst(root);
  }, [enabled, rootRef]);
}

function usePdfPageNavEnhance(rootRef: React.RefObject<HTMLDivElement | null>, enabled: boolean): void {
  React.useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return;
    return installPdfPageNavEnhance(root);
  }, [enabled, rootRef]);
}

function usePreviewSidebarResize(rootRef: React.RefObject<HTMLDivElement | null>, enabled: boolean): void {
  React.useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return;
    return installPreviewSidebarResize(root);
  }, [enabled, rootRef]);
}

/** Routes with the bottom status bar, and the elements their renderers draw one page or slide into. */
const DOCUMENT_PAGE_SELECTORS: Partial<Record<string, string>> = {
  pdf: '.pdfViewer > .page',
  powerpoint: '.flyfish-pptx-slide-slot',
  word: '.msdoc-page, .docx-wrapper > section',
};

export function UniversalFilePreview({ descriptor, loadingLabel = tPreview('common.loadingFileViewer'), toolbarExtra, viewerRef: outerViewerRef, overlay, twoPage = false }: ViewerProps & {
  loadingLabel?: string;
  /** Offer the two-page toggle; the renderer's pages (DOCUMENT_PAGE_SELECTORS) then lay out two per row. */
  twoPage?: boolean;
  /** Route actions placed before the theme button in the viewer toolbar. */
  toolbarExtra?: React.ReactNode;
  /** Receives the viewer handle, for routes that drive the rendered file (e.g. image rotation). */
  viewerRef?: React.RefObject<FileViewerHandle | null>;
  /** Drawn inside the rendered element matching `target`, on top of the file (e.g. the image crop box). */
  overlay?: { target: string; content: React.ReactNode };
}): React.ReactElement {
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
  const { pinnedOpen, togglePinned } = useToolbarPinned();
  const [themeMode, setThemeMode] = React.useState<PreviewThemeMode>(() => (
    resolvePreviewThemeMode(themeStorage, descriptor.relativePath)
  ));
  const appearance = appearanceFromThemeMode(themeMode);
  const pageSelector = DOCUMENT_PAGE_SELECTORS[descriptor.route] ?? null;
  const statusBar = pageSelector !== null;
  const innerViewerRef = React.useRef<FileViewerHandle | null>(null);
  const viewerRef = outerViewerRef ?? innerViewerRef;
  const [zoomPercent, setZoomPercent] = React.useState(100);
  const setZoomPercentRef = React.useRef(setZoomPercent);
  setZoomPercentRef.current = setZoomPercent;
  const onViewerState = React.useCallback((state: ViewerState) => {
    const scale = state.zoom?.scale;
    if (typeof scale !== 'number' || scale <= 0) return;
    const next = Math.round(scale * 100);
    setZoomPercentRef.current((current) => (current === next ? current : next));
  }, []);
  const needsPptxWorker = descriptor.route === 'powerpoint';
  const needsArchiveWorker = descriptor.route === 'archive';
  const pages = useDocumentPages(rootRef, Viewer && (!needsPptxWorker || pptxWorkerUrl) ? pageSelector : null);
  const [twoPageOn, setTwoPageOn] = React.useState(readTwoPageView);
  const spread = twoPage && statusBar && twoPageOn;
  // Zoom the last two-page fit settled on; a resize refits only while the user has not zoomed since.
  const spreadScaleRef = React.useRef<number | null>(null);
  const fitSpread = React.useCallback(() => {
    const root = rootRef.current, handle = viewerRef.current;
    const scale = handle?.getZoomState()?.scale;
    const next = root && pageSelector && scale ? twoPageFitScale(root, pageSelector, scale) : null;
    if (!handle || !next) return;
    void handle.applyViewState({ scale: next }).then(() => {
      spreadScaleRef.current = handle.getZoomState()?.scale ?? next;
    });
  }, [pageSelector, viewerRef]);
  const hasPages = (pages?.count ?? 0) > 0;
  React.useEffect(() => {
    if (spread && hasPages) fitSpread();
  }, [spread, hasPages, fitSpread]);
  React.useEffect(() => {
    const root = rootRef.current;
    if (!spread || !root) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const scale = viewerRef.current?.getZoomState()?.scale;
        if (scale && spreadScaleRef.current && Math.abs(scale - spreadScaleRef.current) < 0.01) fitSpread();
      });
    });
    observer.observe(root);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [spread, fitSpread, viewerRef]);
  const toggleTwoPage = React.useCallback(() => {
    const next = !twoPageOn;
    writeTwoPageView(next);
    setTwoPageOn(next);
    if (next) return;
    spreadScaleRef.current = null;
    // Back to each renderer's opening view: PDF fits the width, DOC fits up to actual size.
    void (descriptor.route === 'pdf' ? viewerRef.current?.fitToView('width') : viewerRef.current?.resetZoom());
  }, [descriptor.route, twoPageOn, viewerRef]);
  const toolbarChrome = useFileViewerToolbarChromeSlot(rootRef, !!Viewer, !!assets.compactToolbars);
  const overlayHost = useRenderedElement(rootRef, Viewer && overlay ? overlay.target : null);
  useLiftPreviewThemeSurface(themeMode);
  usePptxThumbnails(rootRef, needsPptxWorker && !!Viewer && !!pptxWorkerUrl, descriptor.contentUrl, descriptor.fileName);
  usePdfOutlineFirst(rootRef, descriptor.route === 'pdf' && !!Viewer);
  usePdfPageNavEnhance(rootRef, descriptor.route === 'pdf' && !!Viewer);
  useWordOutline(rootRef, descriptor.route === 'word' && !!Viewer, descriptor.contentUrl, descriptor.fileName);
  useDocFloatingPictures(rootRef, descriptor.route === 'word' && !!Viewer, descriptor.contentUrl, descriptor.fileName);
  usePreviewSidebarResize(rootRef, !!Viewer && (descriptor.route === 'pdf' || descriptor.route === 'powerpoint' || descriptor.route === 'word' || extension(descriptor.fileName) === '.xmind'));

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
    locale: getLocale() === 'en' ? 'en-US' : 'zh-CN',
    styleIsolation: 'none',
    // Keep toolbar mounted; .is-toolbar-collapsed animates it upward (do not destroy).
    toolbar: { theme: false, position: 'top', ...(statusBar ? { zoom: false } : {}) },
    pdf: { toolbar: false, thumbnails: true },
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
          toolbarExtra,
          twoPage && statusBar ? h(TwoPageButton, { on: spread, onToggle: toggleTwoPage }) : null,
          h('button', {
            type: 'button',
            className: 'preview-chrome-btn preview-chrome-btn--icon preview-toolbar-theme',
            title: previewThemeTitle(themeMode),
            'aria-label': previewThemeTitle(themeMode),
            'data-mode': themeMode,
            onClick: cycleTheme,
            dangerouslySetInnerHTML: { __html: PREVIEW_THEME_ICONS[themeMode] },
          }),
          !assets.compactToolbars && h('button', {
            type: 'button',
            className: 'preview-chrome-btn preview-chrome-btn--icon preview-toolbar-toggle preview-toolbar-collapse-dock',
            title: tPreview('toolbar.collapse'),
            'aria-label': tPreview('toolbar.collapse'),
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
    'data-preview-chrome': 'document',
    'data-two-page': spread ? 'on' : undefined,
    style: viewerVars,
  },
    h(Viewer as React.ComponentType<FileViewerProps & { ref?: React.Ref<FileViewerHandle | null> }>, {
      ref: viewerRef,
      className: 'file-viewer-host',
      url: descriptor.contentUrl,
      filename: descriptor.fileName,
      options,
      style,
      ...(statusBar ? { onStateChange: onViewerState } : {}),
    }),
    statusBar ? h(DocumentStatusBar, {
      pages,
      percent: zoomPercent,
      onPercent: (percent) => {
        setZoomPercent(percent);
        void viewerRef.current?.applyViewState({ scale: percent / 100 });
      },
      onStep: (direction) => {
        void (direction < 0 ? viewerRef.current?.zoomOut() : viewerRef.current?.zoomIn());
      },
      onReset: () => { void viewerRef.current?.resetZoom(); },
      onFit: () => { if (spread) fitSpread(); else void viewerRef.current?.fitToView('width'); },
    }) : null,
    chromePortal,
    overlayHost && overlay ? createPortal(overlay.content, overlayHost) : null,
    pinnedOpen || assets.compactToolbars
      ? null
      : h('button', {
          type: 'button',
          className: 'preview-chrome-btn preview-chrome-btn--icon preview-toolbar-toggle preview-toolbar-expand-dock',
          'data-tooltip': tPreview('toolbar.expand'),
          'aria-label': tPreview('toolbar.expand'),
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
