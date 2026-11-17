import * as React from 'react';
import {
  PREVIEW_THEME_ICONS,
  createLocalPreviewThemeStorage,
  cyclePreviewThemeMode,
  previewThemeCssVars,
  previewThemeTitle,
  resolvePreviewThemeMode,
  useLiftPreviewThemeSurface,
  type PreviewThemeMode,
  type PreviewThemeStorage,
} from '../theme';
import { appearanceFromThemeMode, h, PreviewToolbarPinIcon } from './shared';
import { usePreviewAssets } from '../assets';
import { tPreview } from '../preview.i18n';

export { readToolbarPinned, writeToolbarPinned } from '../toolbarState';
import { useToolbarPinned } from '../useToolbarPinned';
export { useToolbarPinned } from '../useToolbarPinned';

const WORD_COMMENTS_SIDEBAR_STORAGE_KEY = 'easyview.preview.word.commentsSidebarOpen';

/** Word comments sidebar: default closed; remember last user choice. */
export function readWordCommentsSidebarOpen(): boolean {
  try {
    const raw = localStorage.getItem(WORD_COMMENTS_SIDEBAR_STORAGE_KEY);
    if (raw === null) return false;
    return raw === '1' || raw === 'true';
  } catch {
    return false;
  }
}

export function writeWordCommentsSidebarOpen(open: boolean): void {
  try {
    localStorage.setItem(WORD_COMMENTS_SIDEBAR_STORAGE_KEY, open ? '1' : '0');
  } catch {
    // Ignore quota / private-mode failures.
  }
}

const WORD_SHOW_HIGHLIGHTS_STORAGE_KEY = 'easyview.preview.word.showHighlights';

/** Word text highlights (w:highlight): default hidden; remember last user choice. */
export function readWordShowHighlights(): boolean {
  try {
    return localStorage.getItem(WORD_SHOW_HIGHLIGHTS_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeWordShowHighlights(show: boolean): void {
  try {
    localStorage.setItem(WORD_SHOW_HIGHLIGHTS_STORAGE_KEY, show ? '1' : '0');
  } catch {
    // Ignore quota / private-mode failures.
  }
}

function resolveThemeStorage(explicit?: PreviewThemeStorage): PreviewThemeStorage {
  return explicit ?? createLocalPreviewThemeStorage();
}

/**
 * Same per-file theme contract as UniversalFilePreview:
 * product default + optional per-file override (light/gray/dark).
 */
export function useDocumentRouteTheme(relativePath: string): {
  themeMode: PreviewThemeMode;
  cycleTheme: (event: React.MouseEvent<HTMLButtonElement>) => void;
  appearance: ReturnType<typeof appearanceFromThemeMode>;
  viewerVars: React.CSSProperties;
} {
  const assets = usePreviewAssets();
  const themeStorage = React.useMemo(
    () => resolveThemeStorage(assets.themeStorage),
    [assets.themeStorage],
  );
  const [themeMode, setThemeMode] = React.useState<PreviewThemeMode>(() => (
    resolvePreviewThemeMode(themeStorage, relativePath)
  ));

  React.useEffect(() => {
    setThemeMode(resolvePreviewThemeMode(themeStorage, relativePath));
  }, [relativePath, themeStorage]);

  React.useEffect(() => {
    const refreshProductDefault = () => {
      if (themeStorage.readFileTheme(relativePath)) return;
      setThemeMode(themeStorage.getProductTheme());
    };
    window.addEventListener('inlinemd:themeChanged', refreshProductDefault);
    window.addEventListener('easyview:productThemeChanged', refreshProductDefault);
    return () => {
      window.removeEventListener('inlinemd:themeChanged', refreshProductDefault);
      window.removeEventListener('easyview:productThemeChanged', refreshProductDefault);
    };
  }, [relativePath, themeStorage]);

  const cycleTheme = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setThemeMode((current) => {
      const next = cyclePreviewThemeMode(current);
      themeStorage.writeFileTheme(relativePath, next);
      return next;
    });
  }, [relativePath, themeStorage]);

  const appearance = appearanceFromThemeMode(themeMode);
  const viewerVars = {
    ...previewThemeCssVars(themeMode),
    height: '100%',
    color: appearance.textColor,
    background: appearance.background,
  } as React.CSSProperties;

  return { themeMode, cycleTheme, appearance, viewerVars };
}

function ChromeIcon(props: { path: string | string[] }): React.ReactElement {
  const paths = Array.isArray(props.path) ? props.path : [props.path];
  return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true },
    ...paths.map((d) => h('path', {
      d,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    })),
  );
}

const SAVE_ICON_PATH = 'M3.2 2.5h7.1L12.8 4.9v8.6H3.2V2.5Zm1.6 0v3.4h5.2V3.1M5.2 10.2h5.6';
const EXPORT_ICON_PATHS = ['M8 2.5v7.2', 'M5.4 7.2 8 9.8l2.6-2.6', 'M3.2 12.8h9.6'];
const PRINT_ICON_PATHS = [
  'M4.2 2.5h7.6v3.2H4.2V2.5Z',
  'M3.2 7.2h9.6v5.1H3.2V7.2Z',
  'M5 10h6',
];

export function DocumentExportIcon(): React.ReactElement {
  return h(ChromeIcon, { path: EXPORT_ICON_PATHS });
}

const EXTRACT_ICON_PATHS = ['M2.5 2.8h11v2.4h-11V2.8Z', 'M3.4 5.2v7.8h9.2V5.2', 'M8 6.8v4.4', 'M6.2 9.5 8 11.2l1.8-1.7'];

export function ArchiveExtractIcon(): React.ReactElement {
  return h(ChromeIcon, { path: EXTRACT_ICON_PATHS });
}

export function ImageRotateLeftIcon(): React.ReactElement {
  return h(ChromeIcon, { path: ['M2 8a6 6 0 1 0 6-6 6.5 6.5 0 0 0-4.49 1.83L2 5.33', 'M2 2v3.33h3.33'] });
}

export function ImageRotateRightIcon(): React.ReactElement {
  return h(ChromeIcon, { path: ['M14 8a6 6 0 1 1-6-6 6.5 6.5 0 0 1 4.49 1.83L14 5.33', 'M14 2v3.33h-3.33'] });
}

export function ImageCropIcon(): React.ReactElement {
  return h(ChromeIcon, { path: ['M4 1.3v9.4a1.3 1.3 0 0 0 1.3 1.3h9.4', 'M12 14.7V5.3A1.3 1.3 0 0 0 10.7 4H1.3'] });
}

export function DocumentSaveIcon(): React.ReactElement {
  return h(ChromeIcon, { path: SAVE_ICON_PATH });
}

export function DocumentDiscardIcon(): React.ReactElement {
  return h(ChromeIcon, { path: ['M12 4 4 12', 'M4 4l8 8'] });
}

export function DocumentPrintIcon(): React.ReactElement {
  return h(ChromeIcon, { path: PRINT_ICON_PATHS });
}

export function DocumentHighlightIcon(): React.ReactElement {
  return h(ChromeIcon, { path: ['M9.6 2.6 13.4 6.4 7.6 12.2H3.8V8.4L9.6 2.6Z', 'M7.8 4.4l3.8 3.8', 'M2.5 14h11'] });
}

export type DocumentChromeActionsProps = {
  themeMode: PreviewThemeMode;
  onCycleTheme: (event: React.MouseEvent<HTMLButtonElement>) => void;
  /** When set, collapse is rendered as the last control in the view group. */
  onTogglePinned?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  dirty?: boolean;
  saving?: boolean;
  saveDisabled?: boolean;
  saveMessage?: string | null;
  onSave?: () => void;
  /** Extra document actions rendered before theme (e.g. Word export/print). */
  documentActions?: React.ReactNode;
  /** Use inside DocxEditor formatting-bar via toolbarExtra. */
  embedded?: boolean;
};

export function DocumentThemeButton(props: {
  themeMode: PreviewThemeMode;
  onCycleTheme: (event: React.MouseEvent<HTMLButtonElement>) => void;
}): React.ReactElement {
  return h('button', {
    type: 'button',
    className: 'preview-chrome-btn preview-chrome-btn--icon preview-toolbar-theme',
    title: previewThemeTitle(props.themeMode),
    'aria-label': previewThemeTitle(props.themeMode),
    'data-mode': props.themeMode,
    onClick: props.onCycleTheme,
    dangerouslySetInnerHTML: { __html: PREVIEW_THEME_ICONS[props.themeMode] },
  });
}

export function DocumentCollapseButton(props: {
  onTogglePinned: (event: React.MouseEvent<HTMLButtonElement>) => void;
}): React.ReactElement | null {
  if (usePreviewAssets().compactToolbars) return null;
  return h('button', {
    type: 'button',
    className: 'preview-chrome-btn preview-chrome-btn--icon preview-toolbar-toggle preview-toolbar-collapse-dock',
    title: tPreview('toolbar.collapse'),
    'aria-label': tPreview('toolbar.collapse'),
    'aria-expanded': true,
    onClick: props.onTogglePinned,
  }, h(PreviewToolbarPinIcon, { expand: false }));
}

/** Shared EasyView chrome: save / extras / theme / collapse (collapse always last). */
export function DocumentChromeActions(props: DocumentChromeActionsProps): React.ReactElement {
  const documentGroup = (props.onSave || props.documentActions)
    ? h('div', {
        role: 'group',
        'aria-label': tPreview('chrome.documentActions'),
        'data-toolbar-group': 'document',
      },
        props.onSave
          ? h('button', {
              type: 'button',
              className: 'preview-chrome-btn preview-chrome-btn--icon preview-document-route-save',
              title: props.saveMessage || (props.dirty ? tPreview('chrome.saveChanges') : tPreview('chrome.saved')),
              'aria-label': props.saving ? tPreview('chrome.saving') : tPreview('chrome.save'),
              disabled: props.saveDisabled || props.saving || props.dirty === false,
              onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
                event.stopPropagation();
                props.onSave?.();
              },
            }, props.saving
              ? '…'
              : h(ChromeIcon, { path: SAVE_ICON_PATH }))
          : null,
        props.documentActions,
      )
    : null;

  const viewGroup = h('div', {
    role: 'group',
    'aria-label': tPreview('chrome.view'),
    'data-toolbar-group': 'view',
  },
    h(DocumentThemeButton, {
      themeMode: props.themeMode,
      onCycleTheme: props.onCycleTheme,
    }),
    props.onTogglePinned
      ? h(DocumentCollapseButton, { onTogglePinned: props.onTogglePinned })
      : null,
  );

  return h('div', {
    className: props.embedded
      ? 'preview-document-chrome preview-document-chrome--embedded'
      : 'preview-document-chrome preview-shell-toolbar-actions preview-document-route-actions',
    'data-toolbar-chrome': 'easyview',
  },
    documentGroup,
    viewGroup,
  );
}

export function DocumentToolbarExpandButton(props: {
  onTogglePinned: (event: React.MouseEvent<HTMLButtonElement>) => void;
}): React.ReactElement | null {
  if (usePreviewAssets().compactToolbars) return null;
  return h('button', {
    type: 'button',
    className: 'preview-chrome-btn preview-chrome-btn--icon preview-toolbar-toggle preview-toolbar-expand-dock',
    'data-tooltip': tPreview('toolbar.expand'),
    'aria-label': tPreview('toolbar.expand'),
    'aria-expanded': false,
    onClick: props.onTogglePinned,
  }, h(PreviewToolbarPinIcon, { expand: true }));
}

export function DocumentRouteShell(props: React.PropsWithChildren<{
  className: string;
  themeMode: PreviewThemeMode;
  style: React.CSSProperties;
  'data-ext'?: string;
  dirty?: boolean;
  saving?: boolean;
  saveDisabled?: boolean;
  saveMessage?: string | null;
  onSave?: () => void;
  documentActions?: React.ReactNode;
  onCycleTheme: (event: React.MouseEvent<HTMLButtonElement>) => void;
  /**
   * When true, save/theme/collapse chrome is owned by the child host (e.g. DocxEditor
   * toolbarExtra). Shell only owns the floating expand control when collapsed.
   */
  embedChrome?: boolean;
  pinnedOpen?: boolean;
  onTogglePinned?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}>): React.ReactElement {
  const localPin = useToolbarPinned();
  const pinnedOpen = props.pinnedOpen ?? localPin.pinnedOpen;
  const togglePinned = props.onTogglePinned ?? localPin.togglePinned;

  useLiftPreviewThemeSurface(props.themeMode);

  return h('div', {
    className: `${props.className} preview-universal-viewer ${pinnedOpen ? 'is-toolbar-pinned' : 'is-toolbar-collapsed'}`,
    'data-preview-theme': props.themeMode,
    'data-preview-chrome': 'document',
    'data-ext': props['data-ext'],
    style: props.style,
  },
    props.children,
    !props.embedChrome
      ? h(DocumentChromeActions, {
          themeMode: props.themeMode,
          onCycleTheme: props.onCycleTheme,
          onTogglePinned: togglePinned,
          dirty: props.dirty,
          saving: props.saving,
          saveDisabled: props.saveDisabled,
          saveMessage: props.saveMessage,
          onSave: props.onSave,
          documentActions: props.documentActions,
        })
      : null,
    !pinnedOpen
      ? h(DocumentToolbarExpandButton, { onTogglePinned: togglePinned })
      : null,
  );
}

/** Map EasyView light/gray/dark onto DocxEditor chrome only (never system / office-local theme). */
export function easyViewThemeToDocxColorMode(mode: PreviewThemeMode): 'light' | 'dark' {
  return mode === 'dark' ? 'dark' : 'light';
}
