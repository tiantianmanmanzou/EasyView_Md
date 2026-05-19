/**
 * PdfPalette — color palettes for light and dark PDF export themes.
 */

export interface PdfPalette {
  // Page
  pageBackground: string;
  text: string;
  textMuted: string;       // #666 light
  textFaint: string;       // #999 light
  textDark: string;        // #333 light
  textMedium: string;      // #555 light
  textSecondary: string;   // #444 light
  link: string;

  // Table
  tableBorder: string;
  tableHeaderFill: string;

  // Code block
  codeBorder: string;
  codeFill: string;
  codeInlineColor: string;
  codeInlineBg: string;

  // Blockquote
  blockquoteBorder: string;
  blockquoteBorderBg: string;
  blockquoteFill: string;

  // Notice
  noticeBg: Record<string, string>;

  // Details
  detailsBorder: string;
  detailsHeaderFill: string;

  // Frontmatter
  frontmatterBorder: string;
  frontmatterStripeFill: string;
  frontmatterLabel: string;

  // Comment block
  commentBorder: string;

  // Footnote
  footnoteSeparator: string;
  footnoteBarBg: string;
  footnoteBarBorder: string;

  // HR
  hrColor: string;

  // Checkbox
  checkboxCheckedBg: string;
  checkboxMutedBg: string;
  checkboxBorder: string;

  // Kbd
  kbdBg: string;

  // Math inline/block
  mathBg: string;
  mathColor: string;
  mathBlockFill: string;

  // Frontmatter values
  fmDateColor: string;
  fmDateBg: string;
  fmBadgeBg: string;
  fmBadgeColor: string;
  fmBoolColor: string;
  fmBoolBg: string;
  fmObjColor: string;
  fmObjBg: string;

  // Table keyword badges
  kwGreenBg: string;
  kwGreenColor: string;
  kwRedBg: string;
  kwRedColor: string;
  kwGrayBg: string;
  kwGrayColor: string;

  // Mark/highlight
  markBg: string;

  // Diff
  diffAddColor: string;
  diffAddBg: string;
  diffDelColor: string;
  diffDelBg: string;

  // Mermaid
  mermaidTheme: string;
  mermaidDarkMode: boolean;
  mermaidThemeVariables?: Record<string, string>;

  // Syntax highlighting (Prism)
  prismColors: Record<string, string>;
  prismDefaultColor: string;
}

// ─── Light Palette ────────────────────────────────────────────────────────

const PRISM_COLORS_LIGHT: Record<string, string> = {
  'comment': '#6a737d',
  'prolog': '#6a737d',
  'doctype': '#6a737d',
  'cdata': '#6a737d',
  'punctuation': '#24292e',
  'property': '#005cc5',
  'tag': '#22863a',
  'boolean': '#005cc5',
  'number': '#005cc5',
  'constant': '#005cc5',
  'symbol': '#005cc5',
  'deleted': '#b31d28',
  'selector': '#22863a',
  'attr-name': '#6f42c1',
  'string': '#032f62',
  'char': '#032f62',
  'builtin': '#6f42c1',
  'inserted': '#22863a',
  'operator': '#d73a49',
  'entity': '#005cc5',
  'url': '#032f62',
  'atrule': '#d73a49',
  'attr-value': '#032f62',
  'keyword': '#d73a49',
  'function': '#6f42c1',
  'class-name': '#6f42c1',
  'regex': '#032f62',
  'important': '#d73a49',
  'variable': '#e36209',
  'parameter': '#e36209',
  'template-string': '#032f62',
  'template-punctuation': '#d73a49',
};

export const LIGHT_PALETTE: PdfPalette = {
  pageBackground: '#ffffff',
  text: '#1a1a1a',
  textMuted: '#666',
  textFaint: '#999',
  textDark: '#333',
  textMedium: '#555',
  textSecondary: '#444',
  link: '#2563eb',

  tableBorder: '#ccc',
  tableHeaderFill: '#f5f5f5',

  codeBorder: '#e1e4e8',
  codeFill: '#f6f8fa',
  codeInlineColor: '#c7254e',
  codeInlineBg: '#f0f0f0',

  blockquoteBorder: '#4080d0',
  blockquoteBorderBg: '#fff',
  blockquoteFill: '#f7f7f7',

  noticeBg: {
    note: '#edf5ff',
    tip: '#eafaec',
    important: '#f1edfc',
    caution: '#fff9e6',
    warning: '#ffeceb',
    info: '#edf5ff',
    success: '#eafaec',
    error: '#ffeceb',
  },

  detailsBorder: '#ddd',
  detailsHeaderFill: '#f5f5f5',

  frontmatterBorder: '#e0e0e0',
  frontmatterStripeFill: '#f5f5f5',
  frontmatterLabel: '#3794ff',

  commentBorder: '#ccc',

  footnoteSeparator: '#ccc',
  footnoteBarBg: '#f5f5f5',
  footnoteBarBorder: '#3794ff',

  hrColor: '#ccc',

  checkboxCheckedBg: '#4CAF50',
  checkboxMutedBg: '#999',
  checkboxBorder: '#999',

  kbdBg: '#e0e0e0',

  mathBg: '#e8e8e8',
  mathColor: '#222',
  mathBlockFill: '#f9f9f9',

  fmDateColor: '#c7254e',
  fmDateBg: '#f0e6e6',
  fmBadgeBg: '#e0e0e0',
  fmBadgeColor: '#333',
  fmBoolColor: '#0550ae',
  fmBoolBg: '#e6edf5',
  fmObjColor: '#555',
  fmObjBg: '#f0f0f0',

  kwGreenBg: '#dcf0e0',
  kwGreenColor: '#1a7f37',
  kwRedBg: '#fddcdb',
  kwRedColor: '#cf222e',
  kwGrayBg: '#e8e8e8',
  kwGrayColor: '#656d76',

  markBg: '#FFF9C4',

  diffAddColor: '#22863a',
  diffAddBg: '#e6ffec',
  diffDelColor: '#cb2431',
  diffDelBg: '#ffeef0',

  mermaidTheme: 'base',
  mermaidDarkMode: false,
  mermaidThemeVariables: {
    background: '#ffffff',
    mainBkg: '#f8fafc',
    secondBkg: '#eef6ff',
    tertiaryColor: '#f8fafc',
    primaryColor: '#f8fafc',
    primaryTextColor: '#1f2328',
    primaryBorderColor: '#8c959f',
    secondaryColor: '#eef6ff',
    secondaryTextColor: '#1f2328',
    secondaryBorderColor: '#8c959f',
    tertiaryTextColor: '#1f2328',
    tertiaryBorderColor: '#8c959f',
    nodeBorder: '#8c959f',
    clusterBkg: '#f6f8fa',
    clusterBorder: '#d0d7de',
    lineColor: '#8c959f',
    textColor: '#1f2328',
    edgeLabelBackground: '#ffffff',
    labelBackground: '#ffffff',
  },

  prismColors: PRISM_COLORS_LIGHT,
  prismDefaultColor: '#333',
};

// ─── Dark Palette ─────────────────────────────────────────────────────────

const PRISM_COLORS_DARK: Record<string, string> = {
  'comment': '#6a9955',
  'prolog': '#6a9955',
  'doctype': '#6a9955',
  'cdata': '#6a9955',
  'punctuation': '#d4d4d4',
  'property': '#9cdcfe',
  'tag': '#4ec9b0',
  'boolean': '#569cd6',
  'number': '#b5cea8',
  'constant': '#4fc1ff',
  'symbol': '#569cd6',
  'deleted': '#ce9178',
  'selector': '#d7ba7d',
  'attr-name': '#9cdcfe',
  'string': '#ce9178',
  'char': '#ce9178',
  'builtin': '#4ec9b0',
  'inserted': '#b5cea8',
  'operator': '#d4d4d4',
  'entity': '#569cd6',
  'url': '#ce9178',
  'atrule': '#c586c0',
  'attr-value': '#ce9178',
  'keyword': '#569cd6',
  'function': '#dcdcaa',
  'class-name': '#4ec9b0',
  'regex': '#d16969',
  'important': '#569cd6',
  'variable': '#9cdcfe',
  'parameter': '#9cdcfe',
  'template-string': '#ce9178',
  'template-punctuation': '#569cd6',
};

export const DARK_PALETTE: PdfPalette = {
  pageBackground: '#1e1e1e',
  text: '#d4d4d4',
  textMuted: '#999',
  textFaint: '#666',
  textDark: '#ccc',
  textMedium: '#aaa',
  textSecondary: '#bbb',
  link: '#569cd6',

  tableBorder: '#444',
  tableHeaderFill: '#2d2d2d',

  codeBorder: '#3e3e3e',
  codeFill: '#1e1e1e',
  codeInlineColor: '#d19a66',
  codeInlineBg: '#2d2d2d',

  blockquoteBorder: '#4080d0',
  blockquoteBorderBg: '#1e1e1e',
  blockquoteFill: '#252525',

  noticeBg: {
    note: '#1a2a3a',
    tip: '#1a2e1a',
    important: '#2a1a3a',
    caution: '#2e2a1a',
    warning: '#2e1a1a',
    info: '#1a2a3a',
    success: '#1a2e1a',
    error: '#2e1a1a',
  },

  detailsBorder: '#444',
  detailsHeaderFill: '#2d2d2d',

  frontmatterBorder: '#3e3e3e',
  frontmatterStripeFill: '#252525',
  frontmatterLabel: '#569cd6',

  commentBorder: '#444',

  footnoteSeparator: '#444',
  footnoteBarBg: '#252525',
  footnoteBarBorder: '#569cd6',

  hrColor: '#444',

  checkboxCheckedBg: '#4CAF50',
  checkboxMutedBg: '#666',
  checkboxBorder: '#666',

  kbdBg: '#3e3e3e',

  mathBg: '#2d2d2d',
  mathColor: '#d4d4d4',
  mathBlockFill: '#252525',

  fmDateColor: '#d19a66',
  fmDateBg: '#2d2222',
  fmBadgeBg: '#3e3e3e',
  fmBadgeColor: '#ccc',
  fmBoolColor: '#569cd6',
  fmBoolBg: '#1e2d3e',
  fmObjColor: '#aaa',
  fmObjBg: '#2d2d2d',

  kwGreenBg: '#1b3026',
  kwGreenColor: '#3fb950',
  kwRedBg: '#3d1c1b',
  kwRedColor: '#f85149',
  kwGrayBg: '#2d2d2d',
  kwGrayColor: '#8b949e',

  markBg: '#5a5000',

  diffAddColor: '#4ec573',
  diffAddBg: '#1e3a1e',
  diffDelColor: '#f48771',
  diffDelBg: '#3e1e1e',

  mermaidTheme: 'dark',
  mermaidDarkMode: true,

  prismColors: PRISM_COLORS_DARK,
  prismDefaultColor: '#d4d4d4',
};
