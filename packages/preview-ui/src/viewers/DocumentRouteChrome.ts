import * as React from 'react';
import {
  PREVIEW_THEME_ICONS,
  PREVIEW_THEME_TITLES,
  createLocalPreviewThemeStorage,
  cyclePreviewThemeMode,
  previewThemeCssVars,
  resolvePreviewThemeMode,
  useLiftPreviewThemeSurface,
  type PreviewThemeMode,
  type PreviewThemeStorage,
} from '../theme';
import { appearanceFromThemeMode, h, PreviewToolbarPinIcon } from './shared';
import { usePreviewAssets } from '../assets';

const TOOLBAR_PINNED_STORAGE_KEY = 'easyview.preview.toolbarPinned';
const WORD_COMMENTS_SIDEBAR_STORAGE_KEY = 'easyview.preview.word.commentsSidebarOpen';

export function readToolbarPinned(): boolean {
  try {
    const raw = localStorage.getItem(TOOLBAR_PINNED_STORAGE_KEY);
    if (raw === null) return true;
    return raw === '1' || raw === 'true';
  } catch {
    return true;
  }
}

export function writeToolbarPinned(pinned: boolean): void {
  try {
    localStorage.setItem(TOOLBAR_PINNED_STORAGE_KEY, pinned ? '1' : '0');
  } catch {
    // Ignore quota / private-mode failures.
  }
}

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

export function useToolbarPinned(): {
  pinnedOpen: boolean;
  togglePinned: (event: React.MouseEvent<HTMLButtonElement>) => void;
} {
  const [pinnedOpen, setPinnedOpen] = React.useState(readToolbarPinned);
  const togglePinned = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setPinnedOpen((open) => {
      const next = !open;
      writeToolbarPinned(next);
      return next;
    });
  }, []);
  return { pinnedOpen, togglePinned };
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

export function DocumentPrintIcon(): React.ReactElement {
  return h(ChromeIcon, { path: PRINT_ICON_PATHS });
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
    title: PREVIEW_THEME_TITLES[props.themeMode],
    'aria-label': PREVIEW_THEME_TITLES[props.themeMode],
    'data-mode': props.themeMode,
    onClick: props.onCycleTheme,
    dangerouslySetInnerHTML: { __html: PREVIEW_THEME_ICONS[props.themeMode] },
  });
}

export function DocumentCollapseButton(props: {
  onTogglePinned: (event: React.MouseEvent<HTMLButtonElement>) => void;
}): React.ReactElement {
  return h('button', {
    type: 'button',
    className: 'preview-chrome-btn preview-chrome-btn--icon preview-toolbar-toggle preview-toolbar-collapse-dock',
    title: '收起预览工具栏',
    'aria-label': '收起预览工具栏',
    'aria-expanded': true,
    onClick: props.onTogglePinned,
  }, h(PreviewToolbarPinIcon, { expand: false }));
}

/** Shared EasyView chrome: save / extras / theme / collapse (collapse always last). */
export function DocumentChromeActions(props: DocumentChromeActionsProps): React.ReactElement {
  const documentGroup = (props.onSave || props.documentActions)
    ? h('div', {
        role: 'group',
        'aria-label': '文档操作',
        'data-toolbar-group': 'document',
      },
        props.onSave
          ? h('button', {
              type: 'button',
              className: 'preview-chrome-btn preview-chrome-btn--icon preview-document-route-save',
              title: props.saveMessage || (props.dirty ? '保存更改' : '已保存'),
              'aria-label': props.saving ? '保存中' : '保存',
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
    'aria-label': '视图',
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
}): React.ReactElement {
  return h('button', {
    type: 'button',
    className: 'preview-chrome-btn preview-chrome-btn--icon preview-toolbar-toggle preview-toolbar-expand-dock',
    'data-tooltip': '展开预览工具栏',
    'aria-label': '展开预览工具栏',
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
    'data-ext': props['data-ext'],
    style: props.style,
  },
    props.children,
    pinnedOpen && !props.embedChrome
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
