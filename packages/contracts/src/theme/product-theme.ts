/** Product-wide EasyView theme (Desktop app shell + Extension EasyView surfaces). */
export type EasyViewThemeMode = 'light' | 'gray' | 'dark';

export const EASYVIEW_THEME_MODES = ['light', 'gray', 'dark'] as const satisfies readonly EasyViewThemeMode[];

/** Canonical product theme storage key. */
export const EASYVIEW_THEME_STORAGE_KEY = 'easyview.themeMode';

/** Legacy key used by MD FileHeader; still read for migration. */
export const EASYVIEW_THEME_LEGACY_STORAGE_KEY = 'mdpre-zalman-theme';

export const EASYVIEW_PREVIEW_FILE_THEME_PREFIX = 'easyview.preview.fileTheme:';

/** Mid-axis palette aligned with FileHeader theme depth defaults. */
export const EASYVIEW_THEME_PALETTE: Record<EasyViewThemeMode, {
  background: string;
  panelBackground: string;
  foreground: string;
  textColor: string;
}> = {
  light: {
    background: '#ffffff',
    panelBackground: '#f6f8fa',
    foreground: '#1f2328',
    textColor: '#1f2328',
  },
  gray: {
    background: '#b0b6c0',
    panelBackground: '#9aa1ac',
    foreground: '#050608',
    textColor: '#050608',
  },
  dark: {
    background: '#1e1e1e',
    panelBackground: '#252526',
    foreground: '#d4d4d4',
    textColor: '#d4d4d4',
  },
};

export function isEasyViewThemeMode(value: unknown): value is EasyViewThemeMode {
  return value === 'light' || value === 'gray' || value === 'dark';
}

export function parseEasyViewThemeMode(value: unknown, fallback: EasyViewThemeMode = 'light'): EasyViewThemeMode {
  return isEasyViewThemeMode(value) ? value : fallback;
}

export function nextEasyViewThemeMode(current: EasyViewThemeMode): EasyViewThemeMode {
  const index = EASYVIEW_THEME_MODES.indexOf(current);
  return EASYVIEW_THEME_MODES[(index + 1) % EASYVIEW_THEME_MODES.length];
}

export function previewFileThemeStorageKey(relativePath: string): string {
  return `${EASYVIEW_PREVIEW_FILE_THEME_PREFIX}${relativePath}`;
}

/** Map product theme to file-viewer light|dark switch. */
export function easyViewThemeToViewerTheme(mode: EasyViewThemeMode): 'light' | 'dark' {
  return mode === 'dark' ? 'dark' : 'light';
}

export function readLocalProductTheme(
  storage: Pick<Storage, 'getItem'> | null | undefined,
  fallback: EasyViewThemeMode = 'light',
): EasyViewThemeMode {
  if (!storage) return fallback;
  try {
    const primary = storage.getItem(EASYVIEW_THEME_STORAGE_KEY);
    if (isEasyViewThemeMode(primary)) return primary;
    const legacy = storage.getItem(EASYVIEW_THEME_LEGACY_STORAGE_KEY);
    if (isEasyViewThemeMode(legacy)) return legacy;
  } catch {
    // Storage may be unavailable in restricted webviews.
  }
  return fallback;
}

export function writeLocalProductTheme(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  mode: EasyViewThemeMode,
): void {
  if (!storage) return;
  try {
    storage.setItem(EASYVIEW_THEME_STORAGE_KEY, mode);
    // Keep legacy key in sync so older readers keep working during migration.
    storage.setItem(EASYVIEW_THEME_LEGACY_STORAGE_KEY, mode);
  } catch {
    // Ignore quota / private-mode failures.
  }
}

export function readLocalFileTheme(
  storage: Pick<Storage, 'getItem'> | null | undefined,
  relativePath: string,
): EasyViewThemeMode | null {
  if (!storage || !relativePath) return null;
  try {
    const raw = storage.getItem(previewFileThemeStorageKey(relativePath));
    return isEasyViewThemeMode(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeLocalFileTheme(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  relativePath: string,
  mode: EasyViewThemeMode,
): void {
  if (!storage || !relativePath) return;
  try {
    storage.setItem(previewFileThemeStorageKey(relativePath), mode);
  } catch {
    // Ignore quota / private-mode failures.
  }
}
