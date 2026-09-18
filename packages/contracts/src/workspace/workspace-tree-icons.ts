/**
 * Shared workspace-tree icons for Desktop + Extension.
 * File glyphs come from Seti-UI (same source as VS Code's default file icon theme).
 * Folders / roots use Seti-aligned silhouettes; Desktop paints SVG, Extension prefers
 * `resourceUri` + the workbench file-icon theme (Seti by default) for files/folders.
 */

import setiDefinitions from './seti/definitions.json';
import setiIcons from './seti/icons.json';

export type WorkspaceTreeIconKind = 'root' | 'directory' | 'file' | 'symlink';

export interface WorkspaceTreeIconDescriptor {
  /** Stable id for tests / debugging. */
  id: string;
  /** VS Code ThemeIcon / codicon id (used when a host opts into ThemeIcon). */
  codicon: string;
  /** Hex fill used by Desktop SVG. */
  color: string;
  /** Inline SVG markup (fill via currentColor on the host). */
  svg: string;
}

export interface ResolveWorkspaceTreeIconInput {
  kind: WorkspaceTreeIconKind;
  name: string;
  expanded?: boolean;
}

/** VS Code dark-theme Seti palette (from theme-seti iconDefinitions). */
export const SETI_THEME = {
  blue: '#519aba',
  grey: '#6d8086',
  'grey-light': '#748389',
  green: '#8dc149',
  orange: '#e37933',
  pink: '#f55385',
  purple: '#a074c4',
  red: '#cc3e44',
  white: '#d4d7d6',
  yellow: '#cbcb41',
  ignore: '#41535b',
} as const;

type SetiColorName = keyof typeof SETI_THEME;

type IconDetails = [string, string];

interface SetiDefinitions {
  default: IconDetails;
  extensions: Record<string, IconDetails>;
  files: Record<string, IconDetails>;
  partials: [string, IconDetails][];
}

const definitions = setiDefinitions as unknown as SetiDefinitions;
const icons = setiIcons as Record<string, string>;

/** Extra associations Seti-UI does not ship (common office/preview formats). */
const EXTRA_EXTENSIONS: Record<string, IconDetails> = {
  '.pptx': ['powerpoint', 'orange'],
  '.ppt': ['powerpoint', 'orange'],
  '.pptm': ['powerpoint', 'orange'],
  '.odp': ['powerpoint', 'orange'],
  '.xlsx': ['xls', 'green'],
  '.xlsm': ['xls', 'green'],
  '.ods': ['xls', 'green'],
  '.docx': ['word', 'blue'],
  '.docm': ['word', 'blue'],
  '.odt': ['word', 'blue'],
  '.drawio': ['drawio', 'orange'],
  '.dio': ['drawio', 'orange'],
};

/**
 * Custom Seti-aligned glyphs for formats missing from the upstream Seti icon font.
 * PowerPoint uses a slide + play mark so it stays distinct from the PDF glyph.
 */
const CUSTOM_ICONS: Record<string, string> = {
  powerpoint:
    '<svg viewBox="0 0 32 32"><path d="M4.5 6.2h16.2c1.2 0 2.2 1 2.2 2.2v15.2c0 1.2-1 2.2-2.2 2.2H4.5c-1.2 0-2.2-1-2.2-2.2V8.4c0-1.2 1-2.2 2.2-2.2zm18.8 4.1 6.4 5.1c.5.4.5 1.2 0 1.6l-6.4 5.1c-.7.5-1.6 0-1.6-.8V11.1c0-.8.9-1.3 1.6-.8zM7.2 11.2h8.6v1.8H7.2v-1.8zm0 4.1h10.8v1.8H7.2v-1.8zm0 4.1h6.4v1.8H7.2v-1.8z"/></svg>',
  drawio:
    '<svg viewBox="0 0 32 32"><path d="M7.2 5.5h8.4c1 0 1.8.8 1.8 1.8v5.2c0 1-.8 1.8-1.8 1.8H7.2c-1 0-1.8-.8-1.8-1.8V7.3c0-1 .8-1.8 1.8-1.8zm9.2 9.8 5.4 3.2c.9.5.9 1.8 0 2.3l-5.4 3.2c-.9.5-2-.1-2-1.2v-6.3c0-1.1 1.1-1.7 2-1.2zM6.8 20.2h8c.9 0 1.6.7 1.6 1.6v4.1c0 .9-.7 1.6-1.6 1.6h-8c-.9 0-1.6-.7-1.6-1.6v-4.1c0-.9.7-1.6 1.6-1.6z"/></svg>',
};

const FOLDER_CLOSED_PATH =
  'M27.4 8.5H15.8V7.2c0-1.3-1-2.3-2.3-2.3H3.5v20.3h25.1V10.8c0-1.3-.9-2.3-2.2-2.3z';
const FOLDER_OPEN_PATH =
  'M28.2 12.2H16.1l-1.5-2.1c-.3-.4-.8-.7-1.3-.7H3.8c-1.2 0-2.2 1-2.2 2.2v14.1c0 1.2 1 2.2 2.2 2.2h24.4c1.2 0 2.2-1 2.2-2.2v-11.3c0-1.2-1-2.2-2.2-2.2z';
const SYMLINK_PATH =
  'M22.5 6.5h-5.2v2.2h3.3l-6.2 6.2-1.6-1.6-6.3 6.3 1.6 1.6 6.3-6.3 1.6 1.6 6.2-6.2v3.3h2.2V6.5h-1.9zM8.8 8.7H3.6v13.8h13.8v-5.2h-2.2v3H5.8V10.9h3v-2.2z';

function folderSvg(open: boolean, color: string): string {
  const d = open ? FOLDER_OPEN_PATH : FOLDER_CLOSED_PATH;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 32 32" fill="${color}" aria-hidden="true"><path d="${d}"/></svg>`;
}

function symlinkSvg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 32 32" fill="${color}" aria-hidden="true"><path d="${SYMLINK_PATH}"/></svg>`;
}

function paintSvg(raw: string, color: string): string {
  if (raw.includes('fill=')) {
    return raw.replace(/fill="[^"]*"/g, `fill="${color}"`);
  }
  return raw.replace('<svg', `<svg fill="${color}"`);
}

function basenameOf(name: string): string {
  const normalized = name.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function lookupSetiDetails(fileName: string): IconDetails {
  const base = basenameOf(fileName);
  const lower = base.toLowerCase();

  if (Object.prototype.hasOwnProperty.call(definitions.files, base)) {
    return definitions.files[base];
  }
  if (Object.prototype.hasOwnProperty.call(definitions.files, lower)) {
    return definitions.files[lower];
  }

  let extension = lower.includes('.') ? lower.slice(lower.indexOf('.')) : '';
  while (extension) {
    if (Object.prototype.hasOwnProperty.call(EXTRA_EXTENSIONS, extension)) {
      return EXTRA_EXTENSIONS[extension];
    }
    if (Object.prototype.hasOwnProperty.call(definitions.extensions, extension)) {
      return definitions.extensions[extension];
    }
    const nextDot = extension.indexOf('.', 1);
    extension = nextDot >= 0 ? extension.slice(nextDot) : '';
  }

  for (const [partial, details] of definitions.partials) {
    if (lower.includes(partial.toLowerCase())) return details;
  }

  return definitions.default;
}

function setiFileIcon(fileName: string): WorkspaceTreeIconDescriptor {
  const [iconName, colorName] = lookupSetiDetails(fileName);
  const color = SETI_THEME[(colorName as SetiColorName)] ?? SETI_THEME.white;
  const raw = CUSTOM_ICONS[iconName] ?? icons[iconName] ?? icons[definitions.default[0]] ?? icons.default;
  const svg = paintSvg(raw || '<svg viewBox="0 0 32 32"></svg>', color);
  return {
    id: `seti:${iconName}`,
    codicon: codiconForSeti(iconName),
    color,
    svg,
  };
}

function codiconForSeti(iconName: string): string {
  switch (iconName) {
    case 'markdown':
      return 'markdown';
    case 'json':
      return 'json';
    case 'pdf':
      return 'file-pdf';
    case 'powerpoint':
      return 'file-media';
    case 'drawio':
      return 'type-hierarchy';
    case 'xls':
    case 'csv':
      return 'table';
    case 'word':
      return 'file';
    case 'image':
    case 'svg':
    case 'video':
    case 'audio':
      return 'file-media';
    case 'zip':
    case 'rar':
      return 'file-zip';
    case 'git':
      return 'git-commit';
    case 'config':
    case 'settings':
      return 'settings-gear';
    case 'lock':
      return 'lock';
    case 'database':
    case 'sql':
      return 'database';
    case 'python':
    case 'javascript':
    case 'typescript':
    case 'html':
    case 'css':
    case 'c':
    case 'cpp':
    case 'c-sharp':
    case 'java':
    case 'go':
    case 'rust':
    case 'ruby':
    case 'php':
      return 'file-code';
    default:
      return 'file';
  }
}

/** Resolve the shared icon descriptor for a workspace tree node. */
export function resolveWorkspaceTreeIcon(input: ResolveWorkspaceTreeIconInput): WorkspaceTreeIconDescriptor {
  const expanded = Boolean(input.expanded);
  const folderColor = '#dcb67a';

  if (input.kind === 'root') {
    return {
      id: expanded ? 'root-folder-opened' : 'root-folder',
      codicon: expanded ? 'root-folder-opened' : 'root-folder',
      color: folderColor,
      svg: folderSvg(expanded, folderColor),
    };
  }

  if (input.kind === 'directory') {
    return {
      id: expanded ? 'folder-opened' : 'folder',
      codicon: expanded ? 'folder-opened' : 'folder',
      color: folderColor,
      svg: folderSvg(expanded, folderColor),
    };
  }

  if (input.kind === 'symlink') {
    return {
      id: 'file-symlink',
      codicon: 'file-symlink-file',
      color: SETI_THEME.purple,
      svg: symlinkSvg(SETI_THEME.purple),
    };
  }

  return setiFileIcon(input.name);
}

export function workspaceTreeIconCodicon(input: ResolveWorkspaceTreeIconInput): string {
  return resolveWorkspaceTreeIcon(input).codicon;
}
