import * as React from 'react';
import type { EasyViewThemeMode } from '@easyview/contracts';
import {
  EASYVIEW_THEME_PALETTE,
  easyViewThemeToViewerTheme,
  nextEasyViewThemeMode,
  readLocalFileTheme,
  readLocalProductTheme,
  writeLocalFileTheme,
} from '@easyview/contracts';

export type PreviewThemeMode = EasyViewThemeMode;

export interface PreviewThemeStorage {
  getProductTheme(): PreviewThemeMode;
  readFileTheme(relativePath: string): PreviewThemeMode | null;
  writeFileTheme(relativePath: string, mode: PreviewThemeMode): void;
}

export function createLocalPreviewThemeStorage(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null | undefined = typeof localStorage === 'undefined' ? null : localStorage,
  fallback: PreviewThemeMode = 'light',
): PreviewThemeStorage {
  return {
    getProductTheme: () => readLocalProductTheme(storage, fallback),
    readFileTheme: (relativePath) => readLocalFileTheme(storage, relativePath),
    writeFileTheme: (relativePath, mode) => writeLocalFileTheme(storage, relativePath, mode),
  };
}

export function resolvePreviewThemeMode(
  storage: PreviewThemeStorage,
  relativePath: string,
): PreviewThemeMode {
  return storage.readFileTheme(relativePath) ?? storage.getProductTheme();
}

export function cyclePreviewThemeMode(mode: PreviewThemeMode): PreviewThemeMode {
  return nextEasyViewThemeMode(mode);
}

/** Chrome tokens that must not leak the IDE theme into EasyView light/gray/dark. */
const PREVIEW_CHROME_BY_THEME: Record<PreviewThemeMode, {
  border: string;
  hoverBackground: string;
  inputBackground: string;
  groupBackground: string;
  muted: string;
}> = {
  light: {
    border: '#d0d7de',
    hoverBackground: '#eaeef2',
    inputBackground: '#ffffff',
    groupBackground: 'rgba(31, 35, 40, 0.04)',
    muted: '#656d76',
  },
  gray: {
    border: '#7a8290',
    hoverBackground: '#8b93a0',
    inputBackground: '#a8afb9',
    groupBackground: 'rgba(15, 23, 42, 0.12)',
    muted: '#4b5563',
  },
  dark: {
    border: '#3c3c3c',
    hoverBackground: '#2a2d2e',
    inputBackground: '#1e1e1e',
    groupBackground: 'rgba(148, 163, 184, 0.1)',
    muted: '#9da5b4',
  },
};

export function previewThemeCssVars(mode: PreviewThemeMode): Record<string, string> {
  const palette = EASYVIEW_THEME_PALETTE[mode];
  const chrome = PREVIEW_CHROME_BY_THEME[mode];
  return {
    '--vscode-editor-background': palette.background,
    '--vscode-editor-foreground': palette.textColor,
    '--vscode-editorWidget-background': palette.panelBackground,
    '--vscode-editorWidget-foreground': palette.foreground,
    '--vscode-input-background': chrome.inputBackground,
    '--vscode-input-foreground': palette.textColor,
    '--vscode-input-border': chrome.border,
    '--vscode-panel-border': chrome.border,
    '--vscode-toolbar-hoverBackground': chrome.hoverBackground,
    '--easyview-preview-text-color': palette.textColor,
    '--file-viewer-bg': palette.background,
    '--file-viewer-content-bg': palette.background,
    '--file-viewer-text': palette.textColor,
    '--file-viewer-muted': chrome.muted,
    '--file-viewer-border': chrome.border,
    '--file-viewer-toolbar-bg': palette.panelBackground,
    '--file-viewer-toolbar-border': chrome.border,
    '--file-viewer-group-bg': chrome.groupBackground,
    '--file-viewer-group-border': chrome.border,
    '--file-viewer-button-color': palette.textColor,
    '--file-viewer-button-hover-bg': chrome.hoverBackground,
    '--file-viewer-button-hover-color': palette.textColor,
    '--file-viewer-button-disabled-color': chrome.muted,
    '--file-viewer-input-bg': chrome.inputBackground,
    '--file-viewer-input-color': palette.textColor,
  };
}

export function previewThemeToViewerTheme(mode: PreviewThemeMode): 'light' | 'dark' {
  return easyViewThemeToViewerTheme(mode);
}

export const PREVIEW_THEME_ICONS: Record<PreviewThemeMode, string> = {
  light: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.2v1.8M8 13v1.8M1.2 8h1.8M13 8h1.8M3.1 3.1l1.3 1.3M11.6 11.6l1.3 1.3M12.9 3.1l-1.3 1.3M4.4 11.6l-1.3 1.3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  gray: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11Z" fill="currentColor" stroke="none"/></svg>',
  dark: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 10.4A6 6 0 0 1 5.6 2.8 6 6 0 1 0 13.2 10.4Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
};

export const PREVIEW_THEME_TITLES: Record<PreviewThemeMode, string> = {
  light: '亮色主题（点击切换本文件）',
  gray: '灰色主题（点击切换本文件）',
  dark: '暗色主题（点击切换本文件）',
};

/** Resolve which elements should receive preview theme tokens. */
export function resolvePreviewThemeLiftTargets(
  doc: Pick<Document, 'getElementById' | 'querySelector' | 'documentElement' | 'body'> = document,
): HTMLElement[] {
  const isolatedPreviewWebview = !doc.getElementById('desktop-root');
  const candidates = [
    ...(isolatedPreviewWebview ? [doc.documentElement, doc.body] : []),
    doc.getElementById('file-preview-root'),
    doc.querySelector('.preview-root'),
  ];
  const targets: HTMLElement[] = [];
  for (const node of candidates) {
    if (!node) continue;
    const el = node as HTMLElement;
    if (targets.includes(el)) continue;
    targets.push(el);
  }
  return targets;
}

/**
 * Scope preview theme tokens to the preview surface.
 *
 * - Extension preview webview is isolated → also paint html/body so IDE chrome
 *   cannot peek through as a left gutter strip.
 * - Desktop shares html/body with the app shell (`#desktop-root`) → never lift
 *   there; toolbar theme must stay file-preview-only.
 */
export function useLiftPreviewThemeSurface(themeMode: PreviewThemeMode): void {
  React.useEffect(() => {
    const vars = previewThemeCssVars(themeMode);
    const bg = String(vars['--file-viewer-bg'] ?? '');
    const targets = resolvePreviewThemeLiftTargets();
    const previous = targets.map((el) => ({
      el,
      props: new Map(
        Object.keys(vars).map((key) => [key, el.style.getPropertyValue(key)] as const),
      ),
      background: el.style.background,
      backgroundColor: el.style.backgroundColor,
    }));
    for (const el of targets) {
      for (const [key, value] of Object.entries(vars)) {
        el.style.setProperty(key, String(value));
      }
      if (bg) {
        el.style.background = bg;
        el.style.backgroundColor = bg;
      }
    }
    return () => {
      for (const entry of previous) {
        for (const [key, value] of entry.props) {
          if (value) entry.el.style.setProperty(key, value);
          else entry.el.style.removeProperty(key);
        }
        entry.el.style.background = entry.background;
        entry.el.style.backgroundColor = entry.backgroundColor;
      }
    };
  }, [themeMode]);
}
