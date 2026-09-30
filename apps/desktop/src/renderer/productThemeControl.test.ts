import { describe, expect, it } from 'vitest';
import { EASYVIEW_THEME_STORAGE_KEY } from '@easyview/contracts';
import { cycleDesktopProductTheme } from './productThemeControl';

function memoryStorage(initial?: Record<string, string>): Storage {
  const data = new Map(Object.entries(initial ?? {}));
  return {
    get length() { return data.size; },
    clear() { data.clear(); },
    getItem(key: string) { return data.get(key) ?? null; },
    key(index: number) { return [...data.keys()][index] ?? null; },
    removeItem(key: string) { data.delete(key); },
    setItem(key: string, value: string) { data.set(key, value); },
  };
}

describe('cycleDesktopProductTheme', () => {
  it('cycles light → gray → dark → light and persists the product key', () => {
    const storage = memoryStorage({ [EASYVIEW_THEME_STORAGE_KEY]: 'light' });
    expect(cycleDesktopProductTheme(storage, 'light')).toBe('gray');
    expect(storage.getItem(EASYVIEW_THEME_STORAGE_KEY)).toBe('gray');
    expect(cycleDesktopProductTheme(storage)).toBe('dark');
    expect(cycleDesktopProductTheme(storage)).toBe('light');
  });
});
