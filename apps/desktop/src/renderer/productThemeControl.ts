import {
  nextEasyViewThemeMode,
  readLocalProductTheme,
  writeLocalProductTheme,
  type EasyViewThemeMode,
} from '@easyview/contracts';

/**
 * Title-bar product theme (light / gray / dark). This is not the preview
 * toolbar's per-file theme — cycling here only writes the shared product key.
 */
export function cycleDesktopProductTheme(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null | undefined,
  current: EasyViewThemeMode = readLocalProductTheme(storage),
): EasyViewThemeMode {
  const next = nextEasyViewThemeMode(current);
  writeLocalProductTheme(storage, next);
  return next;
}
