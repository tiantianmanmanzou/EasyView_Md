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
  | { kind: 'directory'; path: string; name: string; entry?: ArchiveEntry }
  | { kind: 'file'; entry: ArchiveEntry; name: string };

type SortKey = 'name' | 'modified' | 'size' | 'origin';
type SortDir = 'asc' | 'desc';

type TreeNode = {
  path: string;
  name: string;
  children: TreeNode[];
};

/**
 * Archive preview (explorer layout):
 * - Shared EasyView top chrome (theme + collapse).
 * - Left folder tree (root expanded; nested folders collapsed until opened).
 * - Right detail table for the selected folder (Name / Modified / Size / Origin).
 * - File preview opens under the table when an entry is selected.
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
    entries,
    currentDir,
    rows: listCurrentFolder(entries, currentDir),
    selected,
    onOpenDirectory: (path) => {
      setCurrentDir(path);
      setSelected(null);
    },
    onOpenFile: (path) => {
      void openEntry(descriptor.sessionId, path).then(setSelected).catch(setError);
    },
    onExportFile: (path) => {
      void exportEntry(descriptor.sessionId, path).catch(setError);
    },
    onClearPreview: () => setSelected(null),
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
    const blob = new Blob([Uint8Array.from(bytes)], { type: mimeType });
    const contentUrl = URL.createObjectURL(blob);
    objectUrls.current.push(contentUrl);
    const entry = entries?.find((item) => item.path === path);
    setSelected({
      path,
      directory: false,
      compressedSize: entry?.compressedSize ?? bytes.byteLength,
      uncompressedSize: entry?.uncompressedSize ?? bytes.byteLength,
      lastModified: entry?.lastModified,
      mimeType,
      contentUrl,
    });
  }, [entries, zip]);

  const exportEntry = React.useCallback(async (path: string) => {
    if (!zip) throw new Error('压缩包尚未就绪');
    const file = zip.file(path);
    if (!file || file.dir) throw new Error('压缩包条目不存在');
    const bytes = await file.async('uint8array');
    const blob = new Blob([Uint8Array.from(bytes)], { type: mimeTypeForEntry(path) });
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
    entries,
    currentDir,
    rows: listCurrentFolder(entries, currentDir),
    selected,
    onOpenDirectory: (path) => {
      setCurrentDir(path);
      setSelected(null);
    },
    onOpenFile: (path) => { void openEntry(path).catch(setError); },
    onExportFile: (path) => { void exportEntry(path).catch(setError); },
    onClearPreview: () => setSelected(null),
  });
}

function ArchiveSplitLayout(props: {
  archiveName: string;
  entries: ArchiveEntry[];
  currentDir: string;
  rows: TreeRow[];
  selected: ArchiveEntryPreview | null;
  onOpenDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
  onExportFile: (path: string) => void;
  onClearPreview: () => void;
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set(['']));
  const [sortKey, setSortKey] = React.useState<SortKey>('name');
  const [sortDir, setSortDir] = React.useState<SortDir>('asc');
  const tree = React.useMemo(() => buildArchiveTree(props.entries), [props.entries]);

  React.useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add('');
      let cursor = normalizeDir(props.currentDir);
      while (cursor) {
        next.add(cursor);
        cursor = parentDir(cursor);
      }
      return next;
    });
  }, [props.currentDir]);

  const toggleExpand = (path: string, event: React.MouseEvent) => {
    event.stopPropagation();
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDir('asc');
  };

  const tableRows = sortTableRows(
    props.rows.filter((row) => row.kind !== 'up'),
    sortKey,
    sortDir,
  );

  return h('section', { className: `preview-archive-viewer${props.selected ? ' has-preview' : ''}` },
    h('aside', { className: 'preview-archive-tree', 'aria-label': '压缩包目录树' },
      h('div', {
        className: `preview-archive-tree-row is-root${props.currentDir === '' ? ' is-active' : ''}`,
        role: 'treeitem',
        'aria-expanded': expanded.has(''),
        onClick: () => props.onOpenDirectory(''),
      },
        h('button', {
          type: 'button',
          className: 'preview-archive-tree-twistie',
          'aria-label': expanded.has('') ? '折叠' : '展开',
          onClick: (event: React.MouseEvent) => toggleExpand('', event),
        }, h(ArchiveChevronIcon, { expanded: expanded.has('') })),
        h(ArchiveZipIcon),
        h('span', { className: 'preview-archive-tree-label', title: props.archiveName }, props.archiveName),
      ),
      expanded.has('')
        ? tree.map((node) => renderTreeNode(node, 1, props.currentDir, expanded, toggleExpand, props.onOpenDirectory))
        : null,
    ),
    h('div', { className: 'preview-archive-main' },
      h('div', { className: 'preview-archive-table-wrap' },
        h('table', { className: 'preview-archive-table' },
          h('thead', null,
            h('tr', null,
              sortHeader('名称', 'name', sortKey, sortDir, toggleSort),
              sortHeader('修改时间', 'modified', sortKey, sortDir, toggleSort),
              sortHeader('大小', 'size', sortKey, sortDir, toggleSort),
              sortHeader('原始大小', 'origin', sortKey, sortDir, toggleSort),
            ),
          ),
          h('tbody', null,
            tableRows.length === 0
              ? h('tr', null,
                  h('td', { className: 'preview-archive-empty', colSpan: 4 }, '当前目录为空'),
                )
              : tableRows.map((row) => {
                  if (row.kind === 'directory') {
                    return h('tr', {
                      key: `dir:${row.path}`,
                      className: 'preview-archive-table-row is-directory',
                      onDoubleClick: () => props.onOpenDirectory(row.path),
                      onClick: () => props.onOpenDirectory(row.path),
                    },
                      h('td', { className: 'preview-archive-col-name' },
                        h('div', { className: 'preview-archive-name-cell' },
                          h(ArchiveFolderIcon),
                          h('span', { title: row.name }, row.name),
                        ),
                      ),
                      h('td', { className: 'preview-archive-col-modified' }, formatModified(row.entry?.lastModified)),
                      h('td', { className: 'preview-archive-col-size' }, formatBytes(row.entry?.compressedSize ?? 0)),
                      h('td', { className: 'preview-archive-col-origin' }, formatBytes(row.entry?.uncompressedSize ?? 0)),
                    );
                  }
                  if (row.kind !== 'file') return null;
                  return h('tr', {
                    key: `file:${row.entry.path}`,
                    className: `preview-archive-table-row${props.selected?.path === row.entry.path ? ' is-active' : ''}`,
                    onClick: () => props.onOpenFile(row.entry.path),
                    onDoubleClick: () => props.onOpenFile(row.entry.path),
                  },
                    h('td', { className: 'preview-archive-col-name' },
                      h('div', { className: 'preview-archive-name-cell' },
                        h(ArchiveFileIcon),
                        h('span', { title: row.name }, row.name),
                        h('button', {
                          type: 'button',
                          className: 'preview-archive-export',
                          title: '导出条目',
                          onClick: (event: React.MouseEvent) => {
                            event.stopPropagation();
                            props.onExportFile(row.entry.path);
                          },
                        }, '导出'),
                      ),
                    ),
                    h('td', { className: 'preview-archive-col-modified' }, formatModified(row.entry.lastModified)),
                    h('td', { className: 'preview-archive-col-size' }, formatBytes(row.entry.compressedSize)),
                    h('td', { className: 'preview-archive-col-origin' }, formatBytes(row.entry.uncompressedSize)),
                  );
                }),
          ),
        ),
      ),
      props.selected
        ? h('div', { className: 'preview-archive-preview' },
            h('div', { className: 'preview-archive-preview-head' },
              h('span', { className: 'preview-archive-preview-path', title: props.selected.path }, props.selected.path),
              h('button', {
                type: 'button',
                className: 'preview-archive-preview-action',
                onClick: () => props.onExportFile(props.selected!.path),
              }, '导出'),
              h('button', {
                type: 'button',
                className: 'preview-archive-preview-action',
                onClick: props.onClearPreview,
              }, '关闭'),
            ),
            h('iframe', {
              className: 'preview-archive-content',
              title: props.selected.path,
              src: props.selected.contentUrl,
              sandbox: 'allow-downloads',
              referrerPolicy: 'no-referrer',
            }),
          )
        : null,
    ),
  );
}

function renderTreeNode(
  node: TreeNode,
  depth: number,
  currentDir: string,
  expanded: Set<string>,
  toggleExpand: (path: string, event: React.MouseEvent) => void,
  onOpenDirectory: (path: string) => void,
): React.ReactNode {
  const isOpen = expanded.has(node.path);
  const isActive = normalizeDir(currentDir) === node.path;
  const hasChildren = node.children.length > 0;
  return h(React.Fragment, { key: node.path },
    h('div', {
      className: `preview-archive-tree-row${isActive ? ' is-active' : ''}`,
      style: { paddingLeft: `${8 + depth * 14}px` },
      role: 'treeitem',
      'aria-expanded': hasChildren ? isOpen : undefined,
      onClick: () => onOpenDirectory(node.path),
    },
      h('button', {
        type: 'button',
        className: `preview-archive-tree-twistie${hasChildren ? '' : ' is-leaf'}`,
        'aria-hidden': !hasChildren,
        tabIndex: hasChildren ? 0 : -1,
        onClick: hasChildren
          ? (event: React.MouseEvent) => toggleExpand(node.path, event)
          : undefined,
      }, hasChildren ? h(ArchiveChevronIcon, { expanded: isOpen }) : null),
      h(ArchiveFolderIcon),
      h('span', { className: 'preview-archive-tree-label', title: node.name }, node.name),
    ),
    isOpen
      ? node.children.map((child) =>
          renderTreeNode(child, depth + 1, currentDir, expanded, toggleExpand, onOpenDirectory))
      : null,
  );
}

function sortHeader(
  label: string,
  key: SortKey,
  sortKey: SortKey,
  sortDir: SortDir,
  onSort: (key: SortKey) => void,
): React.ReactElement {
  const active = sortKey === key;
  return h('th', {
    className: `preview-archive-th${active ? ' is-active' : ''}`,
    scope: 'col',
    onClick: () => onSort(key),
  },
    h('span', null, label),
    h('span', { className: 'preview-archive-sort', 'aria-hidden': true }, active ? (sortDir === 'asc' ? '↑' : '↓') : '↕'),
  );
}

function sortTableRows(rows: TreeRow[], sortKey: SortKey, sortDir: SortDir): TreeRow[] {
  const factor = sortDir === 'asc' ? 1 : -1;
  return [...rows].sort((left, right) => {
    if (left.kind === 'directory' && right.kind !== 'directory') return -1;
    if (left.kind !== 'directory' && right.kind === 'directory') return 1;
    const leftValue = sortValue(left, sortKey);
    const rightValue = sortValue(right, sortKey);
    if (typeof leftValue === 'number' && typeof rightValue === 'number') {
      return (leftValue - rightValue) * factor;
    }
    return String(leftValue).localeCompare(String(rightValue), 'zh-CN') * factor;
  });
}

function sortValue(row: TreeRow, key: SortKey): string | number {
  if (row.kind === 'up') return '';
  if (row.kind === 'directory') {
    if (key === 'name') return row.name;
    if (key === 'modified') return row.entry?.lastModified || '';
    if (key === 'size') return row.entry?.compressedSize ?? 0;
    return row.entry?.uncompressedSize ?? 0;
  }
  if (key === 'name') return row.name;
  if (key === 'modified') return row.entry.lastModified || '';
  if (key === 'size') return row.entry.compressedSize;
  return row.entry.uncompressedSize;
}

function formatModified(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function buildArchiveTree(entries: ArchiveEntry[]): TreeNode[] {
  const root: TreeNode[] = [];
  const byPath = new Map<string, TreeNode>();

  const ensureDir = (dirPath: string, name: string): TreeNode => {
    const existing = byPath.get(dirPath);
    if (existing) return existing;
    const node: TreeNode = { path: dirPath, name, children: [] };
    byPath.set(dirPath, node);
    const parent = parentDir(dirPath);
    if (!parent) root.push(node);
    else ensureDir(parent, parent.replace(/\/+$/u, '').split('/').pop() || parent).children.push(node);
    return node;
  };

  for (const entry of entries) {
    const path = normalizeEntryPath(entry.path);
    if (!path) continue;
    const parts = path.replace(/\/+$/u, '').split('/').filter(Boolean);
    for (let index = 1; index <= parts.length; index += 1) {
      const isLast = index === parts.length;
      if (isLast && !entry.directory && !path.endsWith('/')) continue;
      const dirPath = `${parts.slice(0, index).join('/')}/`;
      ensureDir(dirPath, parts[index - 1]);
    }
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    for (const node of nodes) sortNodes(node.children);
  };
  sortNodes(root);
  return root;
}

function ArchiveChevronIcon({ expanded }: { expanded: boolean }): React.ReactElement {
  return h('svg', {
    className: `preview-archive-icon preview-archive-chevron${expanded ? ' is-expanded' : ''}`,
    viewBox: '0 0 16 16',
    width: 12,
    height: 12,
    'aria-hidden': true,
  }, h('path', {
    d: 'M6 3.5 10.5 8 6 12.5',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }));
}

function ArchiveFolderIcon(): React.ReactElement {
  return h('svg', {
    className: 'preview-archive-icon preview-archive-folder',
    viewBox: '0 0 16 16',
    width: 14,
    height: 14,
    'aria-hidden': true,
  }, h('path', {
    d: 'M1.5 3.5h4l1.2 1.5H14.5v7.5H1.5z',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.2,
    strokeLinejoin: 'round',
  }));
}

function ArchiveFileIcon(): React.ReactElement {
  return h('svg', {
    className: 'preview-archive-icon preview-archive-file',
    viewBox: '0 0 16 16',
    width: 14,
    height: 14,
    'aria-hidden': true,
  }, h('path', {
    d: 'M4 1.5h5.5L12.5 5v9.5H4z',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.2,
    strokeLinejoin: 'round',
  }), h('path', {
    d: 'M9.5 1.5V5H12.5',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.2,
    strokeLinejoin: 'round',
  }));
}

function ArchiveZipIcon(): React.ReactElement {
  return h('svg', {
    className: 'preview-archive-icon preview-archive-zip',
    viewBox: '0 0 16 16',
    width: 14,
    height: 14,
    'aria-hidden': true,
  }, h('path', {
    d: 'M3.5 2.5h9v11h-9z',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.2,
  }), h('path', {
    d: 'M7.5 3.5h1v1.2h-1zm0 2.2h1v1.2h-1zm0 2.2h1V10h1v1.5H7.5z',
    fill: 'currentColor',
  }));
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

  const directories = new Map<string, { name: string; entry?: ArchiveEntry }>();
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
      const existing = directories.get(dirPath);
      if (!existing) {
        directories.set(dirPath, {
          name,
          entry: (entry.directory || path.endsWith('/')) && segments.length === 1 ? entry : undefined,
        });
      } else if (!existing.entry && (entry.directory || path.endsWith('/')) && segments.length === 1) {
        existing.entry = entry;
      }
      continue;
    }

    files.push({ entry: { ...entry, path }, name: segments[0] });
  }

  const directoryRows = [...directories.entries()]
    .sort((left, right) => left[1].name.localeCompare(right[1].name, 'zh-CN'))
    .map(([path, item]) => ({ kind: 'directory' as const, path, name: item.name, entry: item.entry }));
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
    const lastModified = file.date instanceof Date && !Number.isNaN(file.date.getTime())
      ? file.date.toISOString()
      : undefined;
    entries.push({
      path,
      directory: file.dir || path.endsWith('/'),
      compressedSize: 0,
      uncompressedSize: 0,
      ...(lastModified ? { lastModified } : {}),
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
