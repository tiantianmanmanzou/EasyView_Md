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
  | 'java-class'
  | 'video'
  | 'audio';

/** Top chrome family for preview UI: BasicChrome vs DocumentChrome. */
export type PreviewChrome = 'basic' | 'document';

/**
 * Routes the host may accept for `writeBytes`. Suffix-level writability is
 * finer-grained via `writableSuffixes` / `isPreviewWritableFile`.
 */
export const WRITABLE_PREVIEW_ROUTES = ['text', 'word', 'spreadsheet'] as const;
export type WritablePreviewRoute = (typeof WRITABLE_PREVIEW_ROUTES)[number];

export interface PreviewRouteDefinition {
  readonly route: PreviewRoute;
  /** Lowercase suffixes, including the leading dot. Longest suffix wins. */
  readonly suffixes: readonly string[];
  /** The maximum original file size accepted by the host for this route. */
  readonly maxSourceBytes: number;
  readonly mimeType: string;
  /**
   * Which shared preview shell to use. One route → one chrome family
   * (no per-suffix chrome forks in the contract).
   */
  readonly chrome: PreviewChrome;
  /**
   * Suffixes that may be saved via writeBytes when the host supports it.
   * `'*'` means every suffix on this route (used by text). Omit / empty = never.
   */
  readonly writableSuffixes?: readonly string[] | '*';
}

const MEBIBYTE = 1024 * 1024;
/** Audio is read into memory (for the live spectrum), so it gets a tighter cap than streamed video. */
const AUDIO_MAX_BYTES = 512 * MEBIBYTE;

/** Exact basenames (case-insensitive) routed to text preview — no extension. */
export const TEXT_PREVIEW_BASENAMES = [
  'dockerfile',
  'makefile',
  'gnumakefile',
  'jenkinsfile',
  'cmakelists.txt',
  'gemfile',
  'podfile',
  'procfile',
  'vagrantfile',
] as const;

const TEXT_PREVIEW_BASENAME_SET = new Set<string>(TEXT_PREVIEW_BASENAMES);

export const PREVIEW_ROUTES: readonly PreviewRouteDefinition[] = [
  { route: 'text', chrome: 'basic', writableSuffixes: '*', suffixes: [
    '.txt', '.log', '.json', '.jsonc', '.yaml', '.yml', '.xml', '.ini', '.conf', '.properties', '.toml',
    '.py', '.pyw', '.pyi', '.sql',
    '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx',
    '.css', '.scss', '.sass', '.less',
    '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx',
    '.rs', '.go', '.swift', '.m', '.mm',
    '.java', '.kt', '.kts', '.groovy', '.gradle', '.scala',
    '.cs', '.fs', '.vb',
    '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
    '.rb', '.php', '.lua', '.pl', '.pm', '.r',
    '.dart', '.jl', '.ex', '.exs', '.hs', '.clj', '.cljs',
    '.vue', '.svelte', '.astro',
    '.proto', '.graphql', '.gql', '.tf', '.hcl', '.zig', '.nim',
    '.env', '.editorconfig', '.gitignore', '.dockerignore', '.npmrc',
    '.prettierrc', '.eslintrc',
  ], maxSourceBytes: 32 * MEBIBYTE, mimeType: 'text/plain; charset=utf-8' },
  { route: 'image', chrome: 'document', suffixes: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns', '.tif', '.tiff', '.heic', '.heif'], maxSourceBytes: 128 * MEBIBYTE, mimeType: 'application/octet-stream' },
  { route: 'svg', chrome: 'basic', suffixes: ['.svg'], maxSourceBytes: 16 * MEBIBYTE, mimeType: 'image/svg+xml' },
  { route: 'html', chrome: 'basic', suffixes: ['.html', '.htm'], maxSourceBytes: 32 * MEBIBYTE, mimeType: 'text/html; charset=utf-8' },
  { route: 'pdf', chrome: 'document', suffixes: ['.pdf'], maxSourceBytes: 256 * MEBIBYTE, mimeType: 'application/pdf' },
  { route: 'spreadsheet', chrome: 'document', writableSuffixes: ['.xlsx', '.xlsm'], suffixes: ['.xlsx', '.xlsm', '.xlsb', '.xls', '.ods', '.csv', '.tsv'], maxSourceBytes: 128 * MEBIBYTE, mimeType: 'application/octet-stream' },
  { route: 'word', chrome: 'document', writableSuffixes: ['.docx', '.dotx'], suffixes: ['.docx', '.docm', '.dotx', '.dotm', '.doc'], maxSourceBytes: 128 * MEBIBYTE, mimeType: 'application/octet-stream' },
  { route: 'powerpoint', chrome: 'document', suffixes: ['.pptx', '.pptm', '.potx', '.potm', '.ppsx', '.ppsm', '.ppt'], maxSourceBytes: 128 * MEBIBYTE, mimeType: 'application/octet-stream' },
  { route: 'epub', chrome: 'document', suffixes: ['.epub'], maxSourceBytes: 128 * MEBIBYTE, mimeType: 'application/epub+zip' },
  { route: 'design', chrome: 'document', suffixes: ['.xmind', '.psd', '.drawio', '.dio'], maxSourceBytes: 256 * MEBIBYTE, mimeType: 'application/octet-stream' },
  { route: 'archive', chrome: 'document', suffixes: ['.tar.gz', '.tgz', '.zip', '.jar', '.war', '.ear', '.vsix', '.apk', '.cbz', '.tar', '.gz', '.7z', '.rar', '.cbr'], maxSourceBytes: 1024 * MEBIBYTE, mimeType: 'application/octet-stream' },
  { route: 'font', chrome: 'document', suffixes: ['.ttf', '.otf', '.woff', '.woff2'], maxSourceBytes: 64 * MEBIBYTE, mimeType: 'application/octet-stream' },
  { route: 'http', chrome: 'basic', suffixes: ['.http', '.rest'], maxSourceBytes: 4 * MEBIBYTE, mimeType: 'text/plain; charset=utf-8' },
  { route: 'java-class', chrome: 'basic', suffixes: ['.class'], maxSourceBytes: 16 * MEBIBYTE, mimeType: 'application/java-vm' },
  // Streamed with byte ranges, never read into memory, so the cap only guards against absurd files.
  { route: 'video', chrome: 'basic', suffixes: ['.mp4', '.m4v'], maxSourceBytes: 16 * 1024 * MEBIBYTE, mimeType: 'video/mp4' },
  { route: 'audio', chrome: 'basic', suffixes: ['.mp3'], maxSourceBytes: AUDIO_MAX_BYTES, mimeType: 'audio/mpeg' },
  { route: 'audio', chrome: 'basic', suffixes: ['.m4a'], maxSourceBytes: AUDIO_MAX_BYTES, mimeType: 'audio/mp4' },
  { route: 'audio', chrome: 'basic', suffixes: ['.wav'], maxSourceBytes: AUDIO_MAX_BYTES, mimeType: 'audio/wav' },
  { route: 'audio', chrome: 'basic', suffixes: ['.ogg', '.oga'], maxSourceBytes: AUDIO_MAX_BYTES, mimeType: 'audio/ogg' },
  { route: 'audio', chrome: 'basic', suffixes: ['.flac'], maxSourceBytes: AUDIO_MAX_BYTES, mimeType: 'audio/flac' },
] as const;

const ROUTES_BY_LONGEST_SUFFIX = [...PREVIEW_ROUTES]
  .flatMap((definition) => definition.suffixes.map((suffix) => ({ definition, suffix })))
  .sort((left, right) => right.suffix.length - left.suffix.length);

export function resolvePreviewRoute(fileName: string): PreviewRouteDefinition | null {
  if (typeof fileName !== 'string') return null;
  const normalized = fileName.trim().toLocaleLowerCase();
  if (!normalized || normalized.includes('\0')) return null;
  const baseName = normalized.includes('/') || normalized.includes('\\')
    ? normalized.split(/[/\\]/).pop() ?? normalized
    : normalized;
  if (TEXT_PREVIEW_BASENAME_SET.has(baseName)) {
    return PREVIEW_ROUTES.find((definition) => definition.route === 'text') ?? null;
  }
  return ROUTES_BY_LONGEST_SUFFIX.find(({ suffix }) => normalized.endsWith(suffix))?.definition ?? null;
}

/** Archives the hosts can extract (7z/rar have no Node reader), longest suffix first so `.tar.gz` wins over `.gz`. */
const EXTRACTABLE_ARCHIVE_SUFFIXES = ['.tar.gz', '.tgz', '.tar', '.gz', '.zip', '.jar', '.war', '.ear', '.vsix', '.apk', '.cbz'] as const;
export type ExtractableArchiveSuffix = typeof EXTRACTABLE_ARCHIVE_SUFFIXES[number];

export function extractableArchiveSuffix(fileName: string): ExtractableArchiveSuffix | null {
  const normalized = fileName.toLocaleLowerCase();
  return EXTRACTABLE_ARCHIVE_SUFFIXES.find((suffix) => normalized.endsWith(suffix) && normalized.length > suffix.length) ?? null;
}

/** Folder an archive extracts into: its name without the archive suffix (`docs.tar.gz` → `docs`). */
export function archiveExtractFolderName(fileName: string): string {
  const suffix = extractableArchiveSuffix(fileName);
  return suffix ? fileName.slice(0, -suffix.length) : fileName;
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

export function isWritablePreviewRoute(route: PreviewRoute): route is WritablePreviewRoute {
  return (WRITABLE_PREVIEW_ROUTES as readonly string[]).includes(route);
}

/** Chrome family for a file name, or null when it is not a preview route (e.g. Markdown). */
export function resolvePreviewChrome(fileName: string): PreviewChrome | null {
  return resolvePreviewRoute(fileName)?.chrome ?? null;
}

/**
 * Whether writeBytes may be offered for this file (route + suffix whitelist).
 * Host must still expose writeBytes; truncated text stays read-only in the UI.
 */
export function isPreviewWritableFile(fileName: string): boolean {
  const definition = resolvePreviewRoute(fileName);
  if (!definition?.writableSuffixes) return false;
  if (definition.writableSuffixes === '*') return true;
  const normalized = fileName.trim().toLocaleLowerCase();
  const baseName = normalized.includes('/') || normalized.includes('\\')
    ? normalized.split(/[/\\]/).pop() ?? normalized
    : normalized;
  return definition.writableSuffixes.some((suffix) => baseName.endsWith(suffix));
}
