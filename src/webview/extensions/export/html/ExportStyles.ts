/**
 * CSS styles for standalone HTML export.
 * Contains light/dark theme variables, typography, code tokens, TOC sidebar, etc.
 */

export const EXPORT_CSS = /* css */ `
/* ─── CSS Variables ──────────────────────────────────────────────────────── */

:root,
[data-theme="light"] {
  --bg: #ffffff;
  --bg-secondary: #f6f8fa;
  --bg-tertiary: #f0f2f5;
  --text: #1f2328;
  --text-secondary: #656d76;
  --text-tertiary: #8b949e;
  --border: #d0d7de;
  --border-light: #e8eaed;
  --link: #0969da;
  --link-hover: #0550ae;
  --code-bg: #f6f8fa;
  --code-border: #e8eaed;
  --inline-code-bg: rgba(175, 184, 193, 0.2);
  --blockquote-border: #d0d7de;
  --blockquote-bg: rgba(0, 0, 0, 0.03);
  --blockquote-text: #656d76;
  --table-border: #d0d7de;
  --table-header-bg: #f6f8fa;
  --table-row-hover: #f6f8fa;
  --hr-color: #d8dee4;
  --highlight-bg: #fff8c5;
  --shadow: rgba(0, 0, 0, 0.08);
  --header-bg: #f6f8fa;
  --header-border: #e8eaed;
  --toc-bg: #f6f8fa;
  --toc-hover: #e8eaed;
  --toc-active: #dce5f0;
  --btn-bg: transparent;
  --btn-hover: #e8eaed;
  --notice-info-bg: #ddf4ff;
  --notice-info-border: #54aeff;
  --notice-info-text: #0969da;
  --notice-warning-bg: rgba(248, 81, 73, 0.08);
  --notice-warning-border: #f85149;
  --notice-warning-text: #cf222e;
  --notice-tip-bg: #dafbe1;
  --notice-tip-border: #4ac26b;
  --notice-tip-text: #1a7f37;
  --notice-success-bg: #dafbe1;
  --notice-success-border: #4ac26b;
  --notice-success-text: #1a7f37;
  --notice-error-bg: #ffebe9;
  --notice-error-border: #ff8182;
  --notice-error-text: #cf222e;
  --notice-note-bg: #ddf4ff;
  --notice-note-border: #54aeff;
  --notice-note-text: #0969da;
  --notice-important-bg: rgba(137, 87, 229, 0.08);
  --notice-important-border: #8957e5;
  --notice-important-text: #8957e5;
  --notice-caution-bg: rgba(204, 167, 0, 0.08);
  --notice-caution-border: #cca700;
  --notice-caution-text: #9a6700;
  --diff-add-bg: rgba(46, 160, 67, 0.15);
  --diff-add-text: #1a7f37;
  --diff-del-bg: rgba(248, 81, 73, 0.15);
  --diff-del-text: #cf222e;

  /* Code tokens — GitHub Light */
  --token-comment: #6a737d;
  --token-prolog: #6a737d;
  --token-doctype: #6a737d;
  --token-cdata: #6a737d;
  --token-punctuation: #24292e;
  --token-property: #005cc5;
  --token-tag: #22863a;
  --token-boolean: #005cc5;
  --token-number: #005cc5;
  --token-constant: #005cc5;
  --token-symbol: #005cc5;
  --token-deleted: #b31d28;
  --token-selector: #22863a;
  --token-attr-name: #6f42c1;
  --token-string: #032f62;
  --token-char: #032f62;
  --token-builtin: #e36209;
  --token-inserted: #22863a;
  --token-operator: #d73a49;
  --token-entity: #6f42c1;
  --token-url: #032f62;
  --token-atrule: #d73a49;
  --token-attr-value: #032f62;
  --token-keyword: #d73a49;
  --token-function: #6f42c1;
  --token-class-name: #6f42c1;
  --token-regex: #032f62;
  --token-important: #d73a49;
  --token-variable: #e36209;
}

[data-theme="dark"] {
  --bg: #0d1117;
  --bg-secondary: #161b22;
  --bg-tertiary: #1c2128;
  --text: #e6edf3;
  --text-secondary: #8b949e;
  --text-tertiary: #6e7681;
  --border: #30363d;
  --border-light: #21262d;
  --link: #58a6ff;
  --link-hover: #79c0ff;
  --code-bg: #161b22;
  --code-border: #30363d;
  --inline-code-bg: rgba(110, 118, 129, 0.4);
  --blockquote-border: #30363d;
  --blockquote-bg: rgba(255, 255, 255, 0.03);
  --blockquote-text: #8b949e;
  --table-border: #30363d;
  --table-header-bg: #161b22;
  --table-row-hover: #161b22;
  --hr-color: #21262d;
  --highlight-bg: rgba(187, 128, 9, 0.15);
  --shadow: rgba(0, 0, 0, 0.3);
  --header-bg: #161b22;
  --header-border: #21262d;
  --toc-bg: #161b22;
  --toc-hover: #1c2128;
  --toc-active: #1f2937;
  --btn-bg: transparent;
  --btn-hover: #21262d;
  --notice-info-bg: rgba(56, 139, 253, 0.1);
  --notice-info-border: #388bfd;
  --notice-info-text: #58a6ff;
  --notice-warning-bg: rgba(248, 81, 73, 0.1);
  --notice-warning-border: #f85149;
  --notice-warning-text: #f85149;
  --notice-tip-bg: rgba(46, 160, 67, 0.1);
  --notice-tip-border: #2ea043;
  --notice-tip-text: #3fb950;
  --notice-success-bg: rgba(46, 160, 67, 0.1);
  --notice-success-border: #2ea043;
  --notice-success-text: #3fb950;
  --notice-error-bg: rgba(248, 81, 73, 0.1);
  --notice-error-border: #f85149;
  --notice-error-text: #f85149;
  --notice-note-bg: rgba(56, 139, 253, 0.1);
  --notice-note-border: #388bfd;
  --notice-note-text: #58a6ff;
  --notice-important-bg: rgba(137, 87, 229, 0.1);
  --notice-important-border: #a371f7;
  --notice-important-text: #a371f7;
  --notice-caution-bg: rgba(204, 167, 0, 0.1);
  --notice-caution-border: #bb8009;
  --notice-caution-text: #d29922;
  --diff-add-bg: rgba(46, 160, 67, 0.15);
  --diff-add-text: #3fb950;
  --diff-del-bg: rgba(248, 81, 73, 0.15);
  --diff-del-text: #f85149;

  /* Code tokens — GitHub Dark */
  --token-comment: #8b949e;
  --token-prolog: #8b949e;
  --token-doctype: #8b949e;
  --token-cdata: #8b949e;
  --token-punctuation: #e6edf3;
  --token-property: #79c0ff;
  --token-tag: #7ee787;
  --token-boolean: #79c0ff;
  --token-number: #79c0ff;
  --token-constant: #79c0ff;
  --token-symbol: #79c0ff;
  --token-deleted: #ffa198;
  --token-selector: #7ee787;
  --token-attr-name: #d2a8ff;
  --token-string: #a5d6ff;
  --token-char: #a5d6ff;
  --token-builtin: #ffa657;
  --token-inserted: #7ee787;
  --token-operator: #ff7b72;
  --token-entity: #d2a8ff;
  --token-url: #a5d6ff;
  --token-atrule: #ff7b72;
  --token-attr-value: #a5d6ff;
  --token-keyword: #ff7b72;
  --token-function: #d2a8ff;
  --token-class-name: #d2a8ff;
  --token-regex: #a5d6ff;
  --token-important: #ff7b72;
  --token-variable: #ffa657;
}

/* ─── Base ───────────────────────────────────────────────────────────────── */

*, *::before, *::after {
  box-sizing: border-box;
}

html {
  scroll-padding-top: 60px;
}

body {
  margin: 0;
  padding: 0;
  background: var(--toc-bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Noto Sans, Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 1.7;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  transition: background-color 0.2s, color 0.2s;
  overflow: hidden;
  height: 100vh;
}

/* ─── Header Bar ─────────────────────────────────────────────────────────── */

.export-header {
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: var(--header-bg);
  backdrop-filter: blur(8px);
  min-height: 44px;
  transition: background-color 0.2s, border-color 0.2s;
}

.header-left, .header-right {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 80px;
}

.header-right {
  justify-content: flex-end;
}

.header-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
}

.export-header button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 6px;
  background: var(--btn-bg);
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
  padding: 0;
}

.export-header button:hover {
  background: var(--btn-hover);
  color: var(--text);
}

.export-header button.active {
  background: var(--btn-hover);
  color: var(--text);
}

/* ─── Main Layout ────────────────────────────────────────────────────────── */

.main-layout {
  padding-left: 260px;
  padding-right: 22px;
  padding-bottom: 22px;
  display: flex;
  height: calc(100vh - 44px);
  transition: padding-left 0.25s ease;
}

.main-layout.toc-hidden {
  padding-left: 22px;
}

.content-area {
  flex: 1;
  min-width: 0;
  display: flex;
  justify-content: center;
  padding: 32px 24px 0;
  background: var(--bg);
  border-radius: 8px;
  overflow-y: auto;
  scroll-behavior: smooth;
}

.main-layout.toc-hidden .content-area {
  border-radius: 0;
}

/* Scrollbar for content card */
.content-area::-webkit-scrollbar {
  width: 8px;
}
.content-area::-webkit-scrollbar-track {
  background: transparent;
}
.content-area::-webkit-scrollbar-thumb {
  background: var(--border-light);
  border-radius: 4px;
}
.content-area::-webkit-scrollbar-thumb:hover {
  background: var(--text-tertiary);
}
.content-area {
  scrollbar-color: var(--border-light) transparent;
  scrollbar-width: thin;
}

.document-content {
  width: 100%;
  transition: max-width 0.3s ease;
}

.document-content::after {
  content: '';
  display: block;
  height: 80px;
}

/* Each element constrains itself (like in editor) — tables can be wider */
.document-content > *:not(.table-wrapper) {
  max-width: 832px;
  margin-left: auto;
  margin-right: auto;
}

.document-content > .table-wrapper {
  margin-left: auto;
  margin-right: auto;
}

.document-content.full-width > * {
  max-width: none;
}

/* ─── Scrollbars ─────────────────────────────────────────────────────────── */

.document-content ::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
.document-content ::-webkit-scrollbar-track {
  background: transparent;
}
.document-content ::-webkit-scrollbar-thumb {
  background: var(--border-light);
  border-radius: 3px;
}
.document-content ::-webkit-scrollbar-thumb:hover {
  background: var(--text-tertiary);
}
.document-content * {
  scrollbar-color: var(--border-light) transparent;
  scrollbar-width: thin;
}

/* ─── TOC Sidebar ────────────────────────────────────────────────────────── */

.toc-sidebar {
  width: 260px;
  min-width: 260px;
  background: var(--toc-bg);
  padding: 16px 0;
  overflow-y: auto;
  height: calc(100vh - 44px - 22px);
  position: fixed;
  top: 44px;
  left: 0;
  transition: background-color 0.2s, border-color 0.2s, margin-left 0.25s ease, opacity 0.25s ease;
}

.toc-sidebar::-webkit-scrollbar {
  width: 6px;
}
.toc-sidebar::-webkit-scrollbar-track {
  background: transparent;
}
.toc-sidebar::-webkit-scrollbar-thumb {
  background: var(--border-light);
  border-radius: 3px;
}
.toc-sidebar {
  scrollbar-color: var(--border-light) transparent;
  scrollbar-width: thin;
}

.toc-sidebar.hidden {
  margin-left: -260px;
  opacity: 0;
  pointer-events: none;
}

.toc-header {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-tertiary);
  padding: 0 16px 8px;
}

.toc-filter {
  display: block;
  width: calc(100% - 32px);
  margin: 0 16px 8px;
  padding: 6px 10px;
  border: 1px solid var(--border-light);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s;
}

.toc-filter:focus {
  border-color: var(--link);
}

.toc-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.toc-item {
  display: block;
}

.toc-item a {
  display: block;
  padding: 4px 16px;
  font-size: 13px;
  color: var(--text-secondary);
  text-decoration: none;
  border-radius: 0;
  border-left: 2px solid transparent;
  transition: background-color 0.1s, color 0.1s, border-color 0.1s;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toc-item a:hover {
  background: var(--toc-hover);
  color: var(--text);
}

.toc-item a.active {
  background: var(--toc-active);
  color: var(--text);
  border-left-color: var(--link);
  font-weight: 500;
}

.toc-item[data-level="1"] a { padding-left: 16px; font-weight: 500; }
.toc-item[data-level="2"] a { padding-left: 28px; }
.toc-item[data-level="3"] a { padding-left: 40px; font-size: 12px; }
.toc-item[data-level="4"] a { padding-left: 52px; font-size: 12px; }
.toc-item[data-level="5"] a { padding-left: 64px; font-size: 12px; }
.toc-item[data-level="6"] a { padding-left: 76px; font-size: 12px; }

/* ─── Typography ─────────────────────────────────────────────────────────── */

.document-content h1,
.document-content h2,
.document-content h3,
.document-content h4,
.document-content h5,
.document-content h6 {
  margin-top: 1.5em;
  margin-bottom: 0.5em;
  font-weight: 600;
  line-height: 1.3;
  color: var(--text);
}

.document-content h1 { font-size: 2em; margin-top: 0; padding-bottom: 0.3em; border-bottom: 1px solid var(--border-light); }
.document-content h2 { font-size: 1.5em; padding-bottom: 0.3em; border-bottom: 1px solid var(--border-light); }
.document-content h3 { font-size: 1.25em; }
.document-content h4 { font-size: 1em; }
.document-content h5 { font-size: 0.875em; }
.document-content h6 { font-size: 0.85em; color: var(--text-secondary); }

.document-content p {
  margin-top: 0;
  margin-bottom: 16px;
}

.document-content a {
  color: var(--link);
  text-decoration: none;
}

.document-content a:hover {
  color: var(--link-hover);
  text-decoration: underline;
}

/* ─── Code Blocks ────────────────────────────────────────────────────────── */

.document-content pre {
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  border-radius: 6px;
  padding: 16px;
  overflow-x: auto;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace;
  font-size: 13.6px;
  line-height: 1.5;
  margin-top: 0;
  margin-bottom: 16px;
  tab-size: 2;
  transition: background-color 0.2s, border-color 0.2s;
}

.document-content pre code {
  background: none;
  border: none;
  padding: 0;
  font-size: inherit;
  color: inherit;
  border-radius: 0;
}

.document-content .code-lang-label {
  position: absolute;
  top: 6px;
  right: 10px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--text-tertiary);
  pointer-events: none;
  user-select: none;
}

/* Code tokens */
.token.comment, .token.prolog, .token.doctype, .token.cdata { color: var(--token-comment); font-style: italic; }
.token.punctuation { color: var(--token-punctuation); }
.token.property, .token.tag, .token.boolean, .token.number, .token.constant, .token.symbol { color: var(--token-property); }
.token.tag { color: var(--token-tag); }
.token.boolean, .token.number, .token.constant, .token.symbol { color: var(--token-boolean); }
.token.deleted { color: var(--token-deleted); }
.token.selector, .token.attr-name, .token.string, .token.char, .token.builtin, .token.inserted { color: var(--token-selector); }
.token.attr-name { color: var(--token-attr-name); }
.token.string, .token.char { color: var(--token-string); }
.token.builtin { color: var(--token-builtin); }
.token.inserted { color: var(--token-inserted); }
.token.operator, .token.entity, .token.url,
.language-css .token.string, .style .token.string { color: var(--token-operator); }
.token.entity { color: var(--token-entity); }
.token.url { color: var(--token-url); }
.token.atrule, .token.attr-value { color: var(--token-atrule); }
.token.attr-value { color: var(--token-attr-value); }
.token.keyword { color: var(--token-keyword); }
.token.function, .token.class-name { color: var(--token-function); }
.token.class-name { color: var(--token-class-name); }
.token.regex, .token.important, .token.variable { color: var(--token-regex); }
.token.important { color: var(--token-important); font-weight: bold; }
.token.variable { color: var(--token-variable); }

/* Inline code */
.document-content code {
  background: var(--inline-code-bg);
  padding: 0.2em 0.4em;
  border-radius: 4px;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace;
  font-size: 85%;
}

/* ─── Tables ─────────────────────────────────────────────────────────────── */

.document-content .table-wrapper {
  overflow-x: auto;
  width: fit-content;
  max-width: 100%;
  margin-top: 0;
  margin-bottom: 16px;
}

.document-content table {
  border-collapse: separate;
  border-spacing: 0;
  border-radius: 6px;
  border: 1px solid var(--table-border);
  border-left: 0;
  font-size: 0.95em;
  table-layout: auto;
  transition: border-color 0.2s;
}

.document-content th,
.document-content td {
  border-left: 1px solid var(--table-border);
  border-top: 1px solid var(--table-border);
  padding: 10px 14px;
  text-align: left;
  vertical-align: top;
  word-wrap: break-word;
  overflow-wrap: break-word;
  transition: border-color 0.2s, background-color 0.2s;
}

.document-content tr:first-child th,
.document-content tr:first-child td {
  border-top: 0;
}

.document-content tr:first-child th:first-child,
.document-content tr:first-child td:first-child {
  border-top-left-radius: 6px;
}

.document-content tr:first-child th:last-child,
.document-content tr:first-child td:last-child {
  border-top-right-radius: 6px;
}

.document-content tr:last-child th:first-child,
.document-content tr:last-child td:first-child {
  border-bottom-left-radius: 6px;
}

.document-content tr:last-child th:last-child,
.document-content tr:last-child td:last-child {
  border-bottom-right-radius: 6px;
}

.document-content th {
  background: var(--table-header-bg);
  font-weight: 500;
}

.document-content td p,
.document-content th p {
  margin: 0;
}

.document-content tr:hover td {
  background: var(--table-row-hover);
}

/* Table keyword badges */
.table-kw {
  display: inline;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 0.85em;
  font-weight: 500;
}
.table-kw-green { background: rgba(46, 160, 67, 0.15); color: #1a7f37; }
.table-kw-red   { background: rgba(248, 81, 73, 0.15); color: #cf222e; }
.table-kw-gray  { background: rgba(128, 128, 128, 0.15); color: #656d76; }

[data-theme="dark"] .table-kw-green { background: rgba(46, 160, 67, 0.2); color: #3fb950; }
[data-theme="dark"] .table-kw-red   { background: rgba(248, 81, 73, 0.2); color: #f85149; }
[data-theme="dark"] .table-kw-gray  { background: rgba(128, 128, 128, 0.2); color: #8b949e; }

/* ─── Lists ──────────────────────────────────────────────────────────────── */

.document-content ul,
.document-content ol {
  padding-left: 2em;
  margin-top: 0;
  margin-bottom: 16px;
}

.document-content li {
  margin: 4px 0;
}

.document-content li > p {
  margin: 0;
}

/* Checkbox lists */
.document-content ul.checkbox-list {
  list-style: none;
  padding-left: 0;
}

.document-content li[data-type="checkbox_item"] {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  list-style: none;
}

.document-content li[data-type="checkbox_item"] .checkbox {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  min-width: 18px;
  margin-top: 3px;
  border: 2px solid var(--border);
  border-radius: 3px;
  background: var(--bg);
  transition: background-color 0.15s, border-color 0.15s;
}

.document-content li[data-type="checkbox_item"].checked .checkbox {
  background: var(--link);
  border-color: var(--link);
}

.document-content li[data-type="checkbox_item"].checked .checkbox::after {
  content: '';
  display: block;
  width: 5px;
  height: 9px;
  border: solid white;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg) translateY(-1px);
}

.document-content li[data-type="checkbox_item"].checked .checkbox-content {
  text-decoration: line-through;
  opacity: 0.6;
}

.document-content li[data-type="checkbox_item"].inapplicable .checkbox {
  background: var(--text-tertiary);
  border-color: var(--text-tertiary);
  opacity: 0.7;
}

.document-content li[data-type="checkbox_item"].inapplicable .checkbox::after {
  content: '';
  display: block;
  width: 8px;
  height: 2px;
  background: #fff;
}

.document-content li[data-type="checkbox_item"].inapplicable .checkbox-content {
  opacity: 0.5;
  text-decoration: line-through;
  color: var(--text-tertiary);
}

/* ─── Blockquote ─────────────────────────────────────────────────────────── */

.document-content blockquote {
  border-left: 3px solid var(--blockquote-border);
  background: var(--blockquote-bg);
  margin-top: 0;
  margin-bottom: 16px;
  padding: 8px 16px;
  border-radius: 0 4px 4px 0;
  color: var(--blockquote-text);
  transition: border-color 0.2s, color 0.2s, background-color 0.2s;
}

.document-content blockquote > *:first-child { margin-top: 0; }
.document-content blockquote > *:last-child { margin-bottom: 0; }

/* ─── Notice Blocks ──────────────────────────────────────────────────────── */

.document-content .notice-block {
  border-left: 4px solid;
  border-radius: 0 6px 6px 0;
  padding: 12px 16px;
  transition: background-color 0.2s, border-color 0.2s;
}

.document-content .notice-block > *:first-child { margin-top: 0; }
.document-content .notice-block > *:last-child { margin-bottom: 0; }

.document-content .notice-info      { background: var(--notice-info-bg);      border-color: var(--notice-info-border); }
.document-content .notice-note      { background: var(--notice-note-bg);      border-color: var(--notice-note-border); }
.document-content .notice-warning   { background: var(--notice-warning-bg);   border-color: var(--notice-warning-border); }
.document-content .notice-tip       { background: var(--notice-tip-bg);       border-color: var(--notice-tip-border); }
.document-content .notice-success   { background: var(--notice-success-bg);   border-color: var(--notice-success-border); }
.document-content .notice-error     { background: var(--notice-error-bg);     border-color: var(--notice-error-border); }
.document-content .notice-important { background: var(--notice-important-bg); border-color: var(--notice-important-border); }
.document-content .notice-caution   { background: var(--notice-caution-bg);   border-color: var(--notice-caution-border); }

/* ─── Images ─────────────────────────────────────────────────────────────── */

.document-content img {
  max-width: 100%;
  height: auto;
  border-radius: 6px;
}

/* ─── Horizontal Rule ────────────────────────────────────────────────────── */

.document-content hr {
  border: none;
  border-top: 1px solid var(--hr-color);
  margin-top: 24px;
  margin-bottom: 24px;
  transition: border-color 0.2s;
}

/* ─── Highlight ──────────────────────────────────────────────────────────── */

.document-content mark {
  background: var(--highlight-bg);
  color: inherit;
  padding: 0.1em 0.2em;
  border-radius: 2px;
  transition: background-color 0.2s;
}

.document-content mark[data-color] {
  background: unset;
}

/* ─── Mermaid ────────────────────────────────────────────────────────────── */

.document-content pre.mermaid {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 16px;
  text-align: center;
  overflow: visible;
}

.document-content pre.mermaid svg {
  max-width: 100%;
  height: auto;
}

.document-content .plantuml-export-block {
  margin: 1em 0;
  text-align: center;
}

.document-content .plantuml-export-image {
  max-width: 100%;
  height: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-secondary);
}

/* ─── Strikethrough ──────────────────────────────────────────────────────── */

.document-content del {
  text-decoration: line-through;
  opacity: 0.7;
}

/* ─── Underline ──────────────────────────────────────────────────────────── */

.document-content u {
  text-decoration: underline;
  text-underline-offset: 2px;
}

/* ─── Frontmatter ────────────────────────────────────────────────────────── */

.frontmatter-export {
  margin-top: 0;
  margin-bottom: 24px;
  border-radius: 6px;
  border: 1px solid var(--border);
  overflow: hidden;
  transition: border-color 0.2s;
}

.frontmatter-export-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
}

.frontmatter-export-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--link);
}

.frontmatter-export-grid {
  display: grid;
  grid-template-columns: auto 1fr;
}

.frontmatter-export-row {
  display: contents;
}

.frontmatter-export-row:hover .frontmatter-export-key,
.frontmatter-export-row:hover .frontmatter-export-value {
  background: var(--bg-secondary);
}

.frontmatter-export-key {
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  background: var(--bg-tertiary);
  white-space: nowrap;
  transition: background-color 0.2s, border-color 0.2s;
}

.frontmatter-export-value {
  padding: 6px 14px;
  font-size: 13px;
  color: var(--text);
  word-break: break-word;
  line-height: 1.5;
  border-bottom: 1px solid var(--border);
  transition: border-color 0.2s;
}

.frontmatter-export-row:last-child .frontmatter-export-key,
.frontmatter-export-row:last-child .frontmatter-export-value {
  border-bottom: none;
}

.frontmatter-export-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.frontmatter-export-chip {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 12px;
  background: var(--inline-code-bg);
  color: var(--text);
}

.frontmatter-export-bool {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 500;
}

.frontmatter-export-bool-true {
  background: rgba(46, 160, 67, 0.15);
  color: #3fb950;
}

.frontmatter-export-bool-false {
  background: rgba(248, 81, 73, 0.15);
  color: #f85149;
}

.frontmatter-export-null {
  color: var(--text-tertiary);
  font-style: italic;
}

.frontmatter-export-nested {
  display: block;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  background: none;
  border: none;
  padding: 0;
  border-radius: 0;
}

.frontmatter-export-multiline {
  white-space: pre-wrap;
  font-size: 12px;
  line-height: 1.5;
}

.frontmatter-export-raw {
  margin: 0;
  padding: 10px 14px;
  background: var(--code-bg);
  border: none;
  border-radius: 0;
  font-size: 12px;
}

.frontmatter-export-raw code {
  background: none;
  border: none;
  padding: 0;
  font-size: inherit;
}

/* ─── Details (Collapsible) ──────────────────────────────────────────────── */

.document-content .details-block {
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-top: 0;
  margin-bottom: 16px;
  overflow: hidden;
  transition: border-color 0.2s;
}

.document-content .details-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--bg-secondary);
  cursor: pointer;
  user-select: none;
  font-weight: 500;
  transition: background-color 0.2s;
}

.document-content .details-arrow {
  display: inline-block;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.document-content .details-arrow::before {
  content: '';
  display: block;
  width: 0;
  height: 0;
  border-left: 5px solid var(--text-secondary);
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  margin: 4px 5px;
  transition: transform 0.15s ease;
}

.document-content .details-block:not(.details-collapsed) .details-arrow::before {
  transform: rotate(90deg);
}

.document-content .details-content {
  padding: 8px 16px;
}

.document-content .details-block.details-collapsed > .details-content {
  display: none;
}

/* ─── Description Lists ─────────────────────────────────────────────────── */

.document-content dl.description-list {
  margin-top: 1em;
  margin-bottom: 0;
  padding: 0;
}

.document-content dl.description-list dt {
  font-weight: 600;
  margin-top: 0.75em;
}

.document-content dl.description-list dt:first-child {
  margin-top: 0;
}

.document-content dl.description-list dd {
  margin-left: 0;
  padding-left: 1.5em;
  border-left: 2px solid var(--border);
  transition: border-color 0.2s;
}

/* ─── Footnotes ─────────────────────────────────────────────────────────── */

.document-content sup.footnote-ref {
  color: var(--link);
  font-size: 0.75em;
  font-weight: 600;
  vertical-align: super;
  line-height: 0;
  padding: 0 1px;
  cursor: pointer;
}

.document-content sup.footnote-ref:hover {
  text-decoration: underline;
}

.document-content .footnote-def {
  position: relative;
  margin-top: 0.5em;
  margin-bottom: 0;
  padding: 8px 12px;
  border-left: 3px solid var(--link);
  border-radius: 0 6px 6px 0;
  background: var(--bg-secondary);
  font-size: 0.9em;
  transition: background-color 0.2s, border-color 0.2s;
}

.document-content .footnote-label {
  font-size: 0.8em;
  font-weight: 600;
  color: var(--link);
  margin-bottom: 4px;
  cursor: pointer;
}

.document-content .footnote-label:hover {
  text-decoration: underline;
}

/* ─── Keyboard ──────────────────────────────────────────────────────────── */

.document-content kbd {
  display: inline-block;
  padding: 2px 6px;
  font-size: 0.85em;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 3px;
  box-shadow: 0 1px 0 var(--border-light);
  line-height: 1;
  vertical-align: baseline;
  transition: background-color 0.2s, border-color 0.2s;
}

/* ─── HTML Block ────────────────────────────────────────────────────────── */

.document-content .html-block {
  margin-top: 8px;
  margin-bottom: 0;
  padding: 12px 16px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  position: relative;
  transition: background-color 0.2s, border-color 0.2s;
}

.document-content .html-block-label {
  position: absolute;
  top: 4px;
  right: 8px;
  font-size: 10px;
  color: var(--text-tertiary);
  text-transform: uppercase;
}

.document-content .html-block-code {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace;
  font-size: 13px;
  white-space: pre-wrap;
  margin: 0;
  background: none;
  border: none;
  padding: 0;
}

.document-content .html-inline {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace;
  font-size: 0.85em;
  background: var(--inline-code-bg);
  border-radius: 3px;
  padding: 0 3px;
}

/* ─── HTML Comment ──────────────────────────────────────────────────────── */

.document-content .html-comment {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 12px;
  background: transparent;
  border: 1px dashed var(--border);
  border-radius: 6px;
  opacity: 0.6;
  margin-top: 8px;
  margin-bottom: 0;
  transition: border-color 0.2s;
}

.document-content .html-comment-icon {
  flex-shrink: 0;
  color: var(--text-tertiary);
  line-height: 0;
  margin-top: 1px;
}

.document-content .html-comment-label {
  font-size: 12px;
  font-style: italic;
  color: var(--text-tertiary);
  white-space: pre-wrap;
  flex: 1;
}

/* ─── Video / Audio ─────────────────────────────────────────────────────── */

.document-content video {
  max-width: 100%;
  border-radius: 6px;
  border: 1px solid var(--border);
  margin-top: 0.5em;
  margin-bottom: 0;
  display: block;
  transition: border-color 0.2s;
}

.document-content audio {
  width: 100%;
  max-width: 400px;
  margin-top: 0.5em;
  margin-bottom: 0;
  display: block;
}

/* ─── Inline Diff ───────────────────────────────────────────────────────── */

.document-content ins.diff-add {
  background: var(--diff-add-bg);
  color: var(--diff-add-text);
  text-decoration: none;
  padding: 1px 2px;
  border-radius: 2px;
}

.document-content del.diff-del {
  background: var(--diff-del-bg);
  color: var(--diff-del-text);
  text-decoration: line-through;
  padding: 1px 2px;
  border-radius: 2px;
  opacity: 1;
}

/* ─── Math ──────────────────────────────────────────────────────────────── */

math-inline {
  display: inline;
}

math-block {
  display: block;
  text-align: center;
  margin: 1em 0;
  padding: 0.75em 1em;
}

/* ─── TOC Block ─────────────────────────────────────────────────────────── */

.document-content .toc-block {
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-top: 0.8em;
  margin-bottom: 0;
  background: transparent;
  transition: border-color 0.2s;
}

.document-content .toc-block-header {
  font-size: 0.75em;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-tertiary);
  padding: 8px 12px 4px;
  background: var(--bg-secondary);
  border-radius: 6px 6px 0 0;
  border-bottom: 1px solid var(--border);
  transition: background-color 0.2s, border-color 0.2s, color 0.2s;
}

.document-content .toc-block-list {
  padding: 6px 0;
}

.document-content .toc-block-item {
  padding: 3px 12px;
}

.document-content .toc-block-link {
  color: var(--link);
  text-decoration: none;
  font-size: 0.9em;
  line-height: 1.5;
}

.document-content .toc-block-link:hover {
  text-decoration: underline;
  color: var(--link-hover);
}

.document-content .toc-block-item[data-level="1"] .toc-block-link {
  font-weight: 600;
}

.document-content .toc-block-item[data-level="2"] {
  padding-left: 24px;
}

.document-content .toc-block-item[data-level="3"] {
  padding-left: 36px;
}

.document-content .toc-block-empty {
  padding: 8px 12px;
  color: var(--text-tertiary);
  font-style: italic;
  font-size: 0.9em;
}

/* ─── Print ──────────────────────────────────────────────────────────────── */

@media print {
  .export-header { display: none !important; }
  .toc-sidebar { display: none !important; }
  .document-content > * { max-width: none !important; }
  .main-layout { padding: 0 !important; height: auto !important; }
  .content-area { padding: 0 !important; overflow: visible !important; height: auto !important; border-radius: 0 !important; }
  body { background: white !important; color: black !important; overflow: visible !important; height: auto !important; }
  .document-content pre { border: 1px solid #ddd !important; }
  .document-content a { color: inherit !important; text-decoration: underline !important; }
  .document-content a::after { content: " (" attr(href) ")"; font-size: 80%; opacity: 0.7; }
}
`;
