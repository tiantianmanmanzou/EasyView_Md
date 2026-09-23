/**
 * The preview contract is intentionally framework-free. Both the Electron main
 * process and the renderer consume this module, so extension matching remains a
 * single source of truth.
 */
export type PreviewRoute =
  | 'text'
  | 'image'
  | 'svg'
  | 'html'
  | 'pdf'
  | 'spreadsheet'
  | 'word'
  | 'powerpoint'
  | 'epub'
  | 'design'
  | 'archive'
  | 'font'
  | 'http'
  | 'java-class';

export interface PreviewRouteDefinition {
  readonly route: PreviewRoute;
  /** Lowercase suffixes, including the leading dot. Longest suffix wins. */
  readonly suffixes: readonly string[];
  /** The maximum original file size accepted by the host for this route. */
  readonly maxSourceBytes: number;
  readonly mimeType: string;
}

const MEBIBYTE = 1024 * 1024;

export const PREVIEW_ROUTES: readonly PreviewRouteDefinition[] = [
  { route: 'text', suffixes: ['.txt', '.log', '.json', '.jsonc', '.yaml', '.yml', '.xml', '.ini', '.conf', '.properties', '.toml'], maxSourceBytes: 32 * MEBIBYTE, mimeType: 'text/plain; charset=utf-8' },
  { route: 'image', suffixes: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns', '.tif', '.tiff', '.heic', '.heif'], maxSourceBytes: 128 * MEBIBYTE, mimeType: 'application/octet-stream' },
  { route: 'svg', suffixes: ['.svg'], maxSourceBytes: 16 * MEBIBYTE, mimeType: 'image/svg+xml' },
  { route: 'html', suffixes: ['.html', '.htm'], maxSourceBytes: 32 * MEBIBYTE, mimeType: 'text/html; charset=utf-8' },
  { route: 'pdf', suffixes: ['.pdf'], maxSourceBytes: 256 * MEBIBYTE, mimeType: 'application/pdf' },
  { route: 'spreadsheet', suffixes: ['.xlsx', '.xlsm', '.xlsb', '.xls', '.ods', '.csv', '.tsv'], maxSourceBytes: 128 * MEBIBYTE, mimeType: 'application/octet-stream' },
  { route: 'word', suffixes: ['.docx', '.docm', '.dotx', '.dotm', '.doc'], maxSourceBytes: 128 * MEBIBYTE, mimeType: 'application/octet-stream' },
  { route: 'powerpoint', suffixes: ['.pptx', '.pptm', '.potx', '.potm', '.ppsx', '.ppsm', '.ppt'], maxSourceBytes: 128 * MEBIBYTE, mimeType: 'application/octet-stream' },
  { route: 'epub', suffixes: ['.epub'], maxSourceBytes: 128 * MEBIBYTE, mimeType: 'application/epub+zip' },
  { route: 'design', suffixes: ['.xmind', '.psd', '.drawio', '.dio'], maxSourceBytes: 256 * MEBIBYTE, mimeType: 'application/octet-stream' },
  { route: 'archive', suffixes: ['.tar.gz', '.tgz', '.zip', '.jar', '.war', '.ear', '.vsix', '.apk', '.cbz', '.tar', '.gz', '.7z', '.rar', '.cbr'], maxSourceBytes: 128 * MEBIBYTE, mimeType: 'application/octet-stream' },
  { route: 'font', suffixes: ['.ttf', '.otf', '.woff', '.woff2'], maxSourceBytes: 64 * MEBIBYTE, mimeType: 'application/octet-stream' },
  { route: 'http', suffixes: ['.http', '.rest'], maxSourceBytes: 4 * MEBIBYTE, mimeType: 'text/plain; charset=utf-8' },
  { route: 'java-class', suffixes: ['.class'], maxSourceBytes: 16 * MEBIBYTE, mimeType: 'application/java-vm' },
] as const;

const ROUTES_BY_LONGEST_SUFFIX = [...PREVIEW_ROUTES]
  .flatMap((definition) => definition.suffixes.map((suffix) => ({ definition, suffix })))
  .sort((left, right) => right.suffix.length - left.suffix.length);

export function resolvePreviewRoute(fileName: string): PreviewRouteDefinition | null {
  if (typeof fileName !== 'string') return null;
  const normalized = fileName.trim().toLocaleLowerCase();
  if (!normalized || normalized.includes('\0')) return null;
  return ROUTES_BY_LONGEST_SUFFIX.find(({ suffix }) => normalized.endsWith(suffix))?.definition ?? null;
}

export interface PreviewOpenRequest {
  relativePath: string;
}

export interface PreviewDescriptor {
  sessionId: string;
  relativePath: string;
  fileName: string;
  route: PreviewRoute;
  size: number;
  mtimeMs: number;
  mimeType: string;
  contentUrl: string;
}

export interface PreviewTextResult {
  content: string;
  truncated: boolean;
}

/** Host write-back result after a document route saves bytes to the source file. */
export interface PreviewWriteResult {
  size: number;
  mtimeMs: number;
}

export interface ArchiveEntry {
  path: string;
  directory: boolean;
  compressedSize: number;
  uncompressedSize: number;
  /** ISO 8601 timestamp when the archive format exposes one. */
  lastModified?: string;
}

export interface ArchiveEntryPreview extends ArchiveEntry {
  contentUrl: string;
  mimeType: string;
}

export interface HttpPreviewRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpPreviewResponse {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  contentType: string | null;
  body: string;
  truncated: boolean;
}

export interface JavaDecompileResult {
  engine: 'fernflower';
  output: string;
  truncated: boolean;
}
