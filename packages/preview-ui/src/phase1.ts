import type { PreviewRoute } from '@easyview/contracts';

/** Phase-1 routes shared by Desktop and Extension preview hosts. */
export const PHASE1_PREVIEW_ROUTES = [
  'text',
  'image',
  'svg',
  'pdf',
  'spreadsheet',
  'word',
  'powerpoint',
  'design',
  'archive',
] as const satisfies readonly PreviewRoute[];

export type Phase1PreviewRoute = (typeof PHASE1_PREVIEW_ROUTES)[number];

const PHASE1_SET = new Set<string>(PHASE1_PREVIEW_ROUTES);

export function isPhase1PreviewRoute(route: PreviewRoute | string | null | undefined): route is Phase1PreviewRoute {
  return typeof route === 'string' && PHASE1_SET.has(route);
}

/** Filename patterns for VS Code customEditors selector (phase-1 only). */
export const PHASE1_FILENAME_PATTERNS = [
  '*.txt', '*.log', '*.json', '*.jsonc', '*.yaml', '*.yml', '*.xml', '*.csv', '*.tsv', '*.ini', '*.conf', '*.properties', '*.toml',
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.bmp', '*.ico', '*.icns', '*.tif', '*.tiff',
  '*.svg',
  '*.pdf',
  '*.xlsx', '*.xlsm', '*.xlsb', '*.xls', '*.ods',
  '*.docx', '*.docm', '*.dotx', '*.dotm', '*.doc',
  '*.pptx', '*.pptm', '*.potx', '*.potm', '*.ppsx', '*.ppsm', '*.ppt',
  '*.xmind',
  '*.zip', '*.jar', '*.war', '*.ear', '*.vsix', '*.apk', '*.cbz',
  '*.tar', '*.tar.gz', '*.tgz', '*.gz',
  '*.7z', '*.rar', '*.cbr',
] as const;
