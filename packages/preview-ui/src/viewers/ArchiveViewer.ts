import * as React from 'react';
import JSZip from 'jszip';
import type { ArchiveEntry, ArchiveEntryPreview, PreviewDescriptor } from '@easyview/contracts';
import type { PreviewHost } from '../types';
import {
  DocumentChromeActions,
  DocumentRouteShell,
  useDocumentRouteTheme,
  useToolbarPinned,
} from './DocumentRouteChrome';
import {
  extension,
  formatBytes,
  h,
  loadingElement,
  UniversalFilePreview,
  ViewerError,
  type ViewerProps,
} from './shared';

export interface ArchiveViewerProps extends ViewerProps {
  host: PreviewHost;
}

const ZIP_FAMILY = new Set(['.zip', '.jar', '.war', '.ear', '.vsix', '.apk', '.cbz']);
const LIBARCHIVE_ONLY = new Set(['.7z', '.rar', '.cbr']);
const MAX_CLIENT_ENTRY_BYTES = 4 * 1024 * 1024;

type ArchiveListFn = (sessionId: string) => Promise<ArchiveEntry[]>;
type ArchiveOpenFn = (sessionId: string, path: string) => Promise<ArchiveEntryPreview>;
type ArchiveExportFn = (sessionId: string, path: string) => Promise<void>;

type TreeRow =
  | { kind: 'up'; path: string; label: string }
  | { kind: 'directory'; path: string; name: string }
  | { kind: 'file'; entry: ArchiveEntry; name: string };

/**
 * Archive preview (vscode-office style):
 * - Left pane shows only the current folder level (not a fully expanded tree).
 * - ZIP family uses host APIs when present, otherwise client-side JSZip.
 * - RAR / 7z keep @file-viewer libarchive (already has shared toolbar).
 * - ZIP path uses the same EasyView top chrome (theme + collapse).
 */
export function ArchiveViewer({ descriptor, host }: ArchiveViewerProps): React.ReactElement {
  const suffix = extension(descriptor.fileName);
  if (LIBARCHIVE_ONLY.has(suffix)) {
    return h(UniversalFilePreview, {
      descriptor,
      loadingLabel: '正在加载压缩包预览器…',
    });
  }

  const canUseHost = !!(host.listArchive && host.openArchiveEntry && host.exportArchiveEntry);
  if (canUseHost) {
    return h(ArchiveChromeShell, {
      descriptor,
      body: h(FolderArchiveViewer, {
        descriptor,
        list: host.listArchive!.bind(host),
        openEntry: host.openArchiveEntry!.bind(host),
        exportEntry: host.exportArchiveEntry!.bind(host),
      }),
    });
  }

  if (ZIP_FAMILY.has(suffix)) {
    return h(ArchiveChromeShell, {
      descriptor,
      body: h(ClientZipArchiveViewer, { descriptor }),
    });
  }

  return h(UniversalFilePreview, {
    descriptor,
    loadingLabel: '正在加载压缩包预览器…',
  });
}

function ArchiveChromeShell(props: {
  descriptor: PreviewDescriptor;
  body: React.ReactNode;
}): React.ReactElement {
  const { themeMode, cycleTheme, viewerVars } = useDocumentRouteTheme(props.descriptor.relativePath);
  const { pinnedOpen, togglePinned } = useToolbarPinned();

  return h(DocumentRouteShell, {
    className: 'preview-archive-editor',
    themeMode,
    style: viewerVars,
    'data-ext': extension(props.descriptor.fileName),
    embedChrome: true,
    pinnedOpen,
    onTogglePinned: togglePinned,
    onCycleTheme: cycleTheme,
  },
    pinnedOpen
      ? h('div', { className: 'preview-archive-toolbar', 'data-toolbar-chrome': 'easyview' },
          h(DocumentChromeActions, {
            embedded: true,
            themeMode,
            onCycleTheme: cycleTheme,
            onTogglePinned: togglePinned,
          }),
        )
      : null,
    h('div', { className: 'preview-archive-body' }, props.body),
  );
}

function FolderArchiveViewer(props: {
  descriptor: ViewerProps['descriptor'];
  list: ArchiveListFn;
  openEntry: ArchiveOpenFn;
  exportEntry: ArchiveExportFn;
}): React.ReactElement {
  const { descriptor, list, openEntry, exportEntry } = props;
  const [entries, setEntries] = React.useState<ArchiveEntry[] | null>(null);
  const [currentDir, setCurrentDir] = React.useState('');
  const [selected, setSelected] = React.useState<ArchiveEntryPreview | null>(null);
  const [error, setError] = React.useState<unknown>(null);

  React.useEffect(() => {
    let disposed = false;
    setCurrentDir('');
    setSelected(null);
    void list(descriptor.sessionId)
      .then((result) => { if (!disposed) setEntries(normalizeArchiveEntries(result)); })
      .catch((reason) => { if (!disposed) setError(reason); });
    return () => { disposed = true; };
  }, [descriptor.sessionId, list]);

  if (error) return h(ViewerError, { error });
  if (!entries) return loadingElement('正在读取压缩包目录…');

  return h(ArchiveSplitLayout, {
    archiveName: descriptor.fileName,
    currentDir,
    rows: listCurrentFolder(entries, currentDir),
    selected,
    onOpenDirectory: setCurrentDir,
    onOpenFile: (path) => {
      void openEntry(descriptor.sessionId, path).then(setSelected).catch(setError);
    },
    onExportFile: (path) => {
      void exportEntry(descriptor.sessionId, path).catch(setError);
    },
  });
}

function ClientZipArchiveViewer({ descriptor }: ViewerProps): React.ReactElement {
  const [entries, setEntries] = React.useState<ArchiveEntry[] | null>(null);
  const [zip, setZip] = React.useState<JSZip | null>(null);
  const [currentDir, setCurrentDir] = React.useState('');
  const [selected, setSelected] = React.useState<ArchiveEntryPreview | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const objectUrls = React.useRef<string[]>([]);

  React.useEffect(() => {
    let disposed = false;
    setCurrentDir('');
    setSelected(null);
    setEntries(null);
    setZip(null);
    void (async () => {
      try {
        const response = await fetch(descriptor.contentUrl);
        if (!response.ok) throw new Error(`无法读取压缩包（HTTP ${response.status}）`);
        const loaded = await JSZip.loadAsync(await response.arrayBuffer());
        if (disposed) return;
        setZip(loaded);
        setEntries(entriesFromJsZip(loaded));
      } catch (reason) {
        if (!disposed) setError(reason);
      }
    })();
    return () => {
      disposed = true;
      for (const url of objectUrls.current) URL.revokeObjectURL(url);
      objectUrls.current = [];
    };
  }, [descriptor.contentUrl]);

  const openEntry = React.useCallback(async (path: string) => {
    if (!zip) throw new Error('压缩包尚未就绪');
    const file = zip.file(path);
    if (!file || file.dir) throw new Error('压缩包条目不存在');
    const bytes = await file.async('uint8array');
    if (bytes.byteLength > MAX_CLIENT_ENTRY_BYTES) {
      throw new Error('压缩包条目超过 4 MiB 安全预览上限');
    }
    const mimeType = mimeTypeForEntry(path);
    const blob = new Blob([bytes], { type: mimeType });
    const contentUrl = URL.createObjectURL(blob);
    objectUrls.current.push(contentUrl);
    const entry = entries?.find((item) => item.path === path);
    setSelected({
      path,
      directory: false,
      compressedSize: entry?.compressedSize ?? bytes.byteLength,
      uncompressedSize: entry?.uncompressedSize ?? bytes.byteLength,
      mimeType,
      contentUrl,
    });
  }, [entries, zip]);

  const exportEntry = React.useCallback(async (path: string) => {
    if (!zip) throw new Error('压缩包尚未就绪');
    const file = zip.file(path);
    if (!file || file.dir) throw new Error('压缩包条目不存在');
    const bytes = await file.async('uint8array');
    const blob = new Blob([bytes], { type: mimeTypeForEntry(path) });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = path.split('/').pop() || path;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [zip]);

  if (error) return h(ViewerError, { error });
  if (!entries) return loadingElement('正在读取压缩包目录…');

  return h(ArchiveSplitLayout, {
    archiveName: descriptor.fileName,
    currentDir,
    rows: listCurrentFolder(entries, currentDir),
    selected,
    onOpenDirectory: setCurrentDir,
    onOpenFile: (path) => { void openEntry(path).catch(setError); },
    onExportFile: (path) => { void exportEntry(path).catch(setError); },
  });
}

function ArchiveSplitLayout(props: {
  archiveName: string;
  currentDir: string;
  rows: TreeRow[];
  selected: ArchiveEntryPreview | null;
  onOpenDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
  onExportFile: (path: string) => void;
}): React.ReactElement {
  const crumb = props.currentDir ? props.currentDir : '/';
  return h('section', { className: 'preview-archive-viewer' },
    h('div', { className: 'preview-archive-list', role: 'tree', 'aria-label': '压缩包条目' },
      h('div', { className: 'preview-archive-list-head' },
        h('strong', { className: 'preview-archive-list-title' }, props.archiveName),
        h('div', { className: 'preview-archive-crumb', title: crumb }, crumb),
      ),
      props.rows.map((row) => {
        if (row.kind === 'up') {
          return h('div', { key: `up:${row.path}`, className: 'preview-archive-entry is-directory' },
            h('button', {
              type: 'button',
              onClick: () => props.onOpenDirectory(row.path),
            }, row.label),
            h('span', null, '上级'),
          );
        }
        if (row.kind === 'directory') {
          return h('div', { key: `dir:${row.path}`, className: 'preview-archive-entry is-directory' },
            h('button', {
              type: 'button',
              onClick: () => props.onOpenDirectory(row.path),
            }, `${row.name}/`),
            h('span', null, '目录'),
          );
        }
        return h('div', { key: `file:${row.entry.path}`, className: 'preview-archive-entry' },
          h('button', {
            type: 'button',
            onClick: () => props.onOpenFile(row.entry.path),
          }, row.name),
          h('span', null, formatBytes(row.entry.uncompressedSize)),
          h('button', {
            type: 'button',
            title: '导出条目',
            onClick: () => props.onExportFile(row.entry.path),
          }, '导出'),
        );
      }),
      props.rows.length === 0
        ? h('div', { className: 'preview-viewer-message' }, '当前目录为空')
        : null,
    ),
    props.selected
      ? h('iframe', {
          className: 'preview-archive-content',
          title: props.selected.path,
          src: props.selected.contentUrl,
          sandbox: 'allow-downloads',
          referrerPolicy: 'no-referrer',
        })
      : h('div', { className: 'preview-viewer-message' }, '选择一个文件以预览。'),
  );
}

export function normalizeArchiveEntries(entries: ArchiveEntry[]): ArchiveEntry[] {
  const byPath = new Map<string, ArchiveEntry>();
  for (const entry of entries) {
    const path = normalizeEntryPath(entry.path);
    if (!path) continue;
    byPath.set(path, {
      ...entry,
      path,
      directory: entry.directory || path.endsWith('/'),
    });
    const parts = path.replace(/\/+$/u, '').split('/').filter(Boolean);
    for (let index = 1; index < parts.length; index += 1) {
      const dirPath = `${parts.slice(0, index).join('/')}/`;
      if (!byPath.has(dirPath)) {
        byPath.set(dirPath, {
          path: dirPath,
          directory: true,
          compressedSize: 0,
          uncompressedSize: 0,
        });
      }
    }
  }
  return [...byPath.values()];
}

export function listCurrentFolder(entries: ArchiveEntry[], currentDir: string): TreeRow[] {
  const prefix = normalizeDir(currentDir);
  const rows: TreeRow[] = [];
  if (prefix) {
    rows.push({
      kind: 'up',
      path: parentDir(prefix),
      label: '..',
    });
  }

  const directories = new Map<string, string>();
  const files: Array<{ entry: ArchiveEntry; name: string }> = [];

  for (const entry of entries) {
    const path = normalizeEntryPath(entry.path);
    if (!path || path === prefix) continue;
    if (prefix && !path.startsWith(prefix)) continue;
    const relative = prefix ? path.slice(prefix.length) : path;
    if (!relative) continue;
    const segments = relative.replace(/\/+$/u, '').split('/').filter(Boolean);
    if (segments.length === 0) continue;

    if (segments.length > 1 || entry.directory || path.endsWith('/')) {
      const name = segments[0];
      const dirPath = `${prefix}${name}/`;
      if (!directories.has(dirPath)) directories.set(dirPath, name);
      continue;
    }

    files.push({ entry: { ...entry, path }, name: segments[0] });
  }

  const directoryRows = [...directories.entries()]
    .sort((left, right) => left[1].localeCompare(right[1], 'zh-CN'))
    .map(([path, name]) => ({ kind: 'directory' as const, path, name }));
  const fileRows = files
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
    .map((item) => ({ kind: 'file' as const, entry: item.entry, name: item.name }));

  return [...rows, ...directoryRows, ...fileRows];
}

function entriesFromJsZip(zip: JSZip): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  zip.forEach((relativePath, file) => {
    const path = normalizeEntryPath(relativePath);
    if (!path) return;
    entries.push({
      path,
      directory: file.dir || path.endsWith('/'),
      compressedSize: 0,
      uncompressedSize: 0,
    });
  });
  return normalizeArchiveEntries(entries);
}

function normalizeEntryPath(value: string): string {
  return value.replace(/\\/gu, '/').replace(/^\/+/u, '');
}

function normalizeDir(value: string): string {
  const path = normalizeEntryPath(value);
  if (!path) return '';
  return path.endsWith('/') ? path : `${path}/`;
}

function parentDir(dir: string): string {
  const normalized = normalizeDir(dir).replace(/\/+$/u, '');
  if (!normalized) return '';
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '' : `${normalized.slice(0, index)}/`;
}

function mimeTypeForEntry(entryPath: string): string {
  const lower = entryPath.toLowerCase();
  if (/\.(txt|md|markdown|log|json|jsonc|yaml|yml|xml|csv|tsv|ini|conf|properties|toml)$/i.test(lower)) {
    return 'text/plain; charset=utf-8';
  }
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html; charset=utf-8';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.png')) return 'image/png';
  if (/\.(jpg|jpeg)$/i.test(lower)) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return 'application/octet-stream';
}
