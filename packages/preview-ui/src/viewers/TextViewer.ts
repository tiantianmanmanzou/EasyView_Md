import * as React from 'react';
import type { PreviewTextResult, PreviewWriteResult } from '@easyview/contracts';
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { searchKeymap, openSearchPanel, highlightSelectionMatches } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { tPreview } from '../preview.i18n';
import { BasicPreviewShell } from '../BasicPreviewShell';
import type { PreviewHost } from '../types';
import { usePreviewUnsaved } from './usePreviewUnsaved';
import { h, Loading, ViewerError, type ViewerProps } from './shared';
import { languageExtensionForFile } from './textLanguage';
import {
  detectTextVisualKind,
  outlineSql,
  parseJsonTree,
  parseXmlTree,
  type JsonTreeNode,
  type SqlStatementOutline,
  type TextVisualKind,
  type XmlTreeNode,
} from './textVisual';

export interface TextViewerProps extends ViewerProps {
  readText(sessionId: string): Promise<PreviewTextResult>;
  writeBytes?(sessionId: string, bytes: Uint8Array): Promise<PreviewWriteResult>;
  host?: PreviewHost;
}

type ViewMode = 'code' | 'tree';

const SEARCH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg>';
const SAVE_ICON_PATH = 'M3.2 2.5h7.1L12.8 4.9v8.6H3.2V2.5Zm1.6 0v3.4h5.2V3.1M5.2 10.2h5.6';

const previewHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#c586c0' },
  { tag: tags.string, color: '#ce9178' },
  { tag: tags.comment, color: '#6a9955', fontStyle: 'italic' },
  { tag: tags.number, color: '#b5cea8' },
  { tag: tags.bool, color: '#569cd6' },
  { tag: tags.null, color: '#569cd6' },
  { tag: tags.propertyName, color: '#9cdcfe' },
  { tag: tags.variableName, color: '#9cdcfe' },
  { tag: tags.typeName, color: '#4ec9b0' },
  { tag: tags.className, color: '#4ec9b0' },
  { tag: tags.function(tags.variableName), color: '#dcdcaa' },
  { tag: tags.operator, color: '#d4d4d4' },
  { tag: tags.meta, color: '#7f848e' },
  { tag: tags.tagName, color: '#569cd6' },
  { tag: tags.attributeName, color: '#9cdcfe' },
  { tag: tags.attributeValue, color: '#ce9178' },
  { tag: tags.heading, fontWeight: 'bold', color: '#4fc1ff' },
]);

const previewEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--vscode-editor-background)',
    color: 'var(--vscode-editor-foreground)',
    fontSize: '13px',
    fontFamily: 'var(--vscode-editor-font-family, ui-monospace, monospace)',
  },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit' },
  '.cm-content': {
    caretColor: 'var(--vscode-editorCursor-foreground, #fff)',
    padding: '8px 0',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--vscode-editor-background)',
    color: 'var(--vscode-editorLineNumber-foreground, rgba(128,128,128,0.45))',
    borderRight: '1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.2))',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--vscode-editorLineNumber-activeForeground, #c6c6c6)',
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--vscode-editor-lineHighlightBackground, rgba(255,255,255,0.04))',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--vscode-editor-selectionBackground, rgba(64,128,208,0.3)) !important',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--vscode-editorCursor-foreground, #fff)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--vscode-editorWidget-background, var(--vscode-editor-background))',
    color: 'var(--vscode-editor-foreground)',
    borderTop: '1px solid var(--vscode-panel-border)',
  },
  '.cm-textfield': {
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
  },
  '.cm-button': {
    background: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground))',
    border: '1px solid var(--vscode-panel-border)',
  },
});

function ChromeIcon(path: string): React.ReactElement {
  return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true },
    h('path', {
      d: path,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  );
}

export function TextViewer({ descriptor, readText, writeBytes, host }: TextViewerProps): React.ReactElement {
  const visualKind = React.useMemo(() => detectTextVisualKind(descriptor.fileName), [descriptor.fileName]);
  const canVisual = visualKind !== null;

  const [content, setContent] = React.useState<string | null>(null);
  const [truncated, setTruncated] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saveMessage, setSaveMessage] = React.useState<string | null>(null);
  const [viewMode, setViewMode] = React.useState<ViewMode>('code');
  const [editorReady, setEditorReady] = React.useState(false);

  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const viewRef = React.useRef<EditorView | null>(null);
  const languageCompartment = React.useRef(new Compartment()).current;
  const editableCompartment = React.useRef(new Compartment()).current;
  const dirtyRef = React.useRef(false);
  const contentRef = React.useRef<string>('');
  const truncatedRef = React.useRef(false);
  const writeBytesRef = React.useRef(writeBytes);
  writeBytesRef.current = writeBytes;
  const sessionIdRef = React.useRef(descriptor.sessionId);
  sessionIdRef.current = descriptor.sessionId;
  const previewHostRef = React.useRef(host);
  previewHostRef.current = host;
  const runSaveRef = React.useRef<() => void>(() => {});

  React.useEffect(() => {
    let disposed = false;
    setContent(null);
    setError(null);
    setDirty(false);
    setSaveMessage(null);
    setViewMode('code');
    dirtyRef.current = false;
    void readText(descriptor.sessionId).then((value) => {
      if (disposed) return;
      setContent(value.content);
      setTruncated(value.truncated);
      contentRef.current = value.content;
      truncatedRef.current = value.truncated;
    }).catch((reason) => {
      if (!disposed) setError(reason);
    });
    return () => { disposed = true; };
  }, [descriptor.sessionId, readText]);

  const canEdit = Boolean(writeBytes) && !truncated;
  const canSave = Boolean(writeBytes) && !truncated;

  const performSave = React.useCallback(async () => {
    const write = writeBytesRef.current;
    if (!write || truncatedRef.current || saving) return;
    const text = viewRef.current ? viewRef.current.state.doc.toString() : contentRef.current;
    setSaving(true);
    setSaveMessage(null);
    try {
      const bytes = new TextEncoder().encode(text);
      const result = await write(sessionIdRef.current, bytes);
      contentRef.current = text;
      dirtyRef.current = false;
      setDirty(false);
      setContent(text);
      setSaveMessage(tPreview('common.savedSize', { size: (result.size / 1024).toFixed(1) }));
    } catch (reason) {
      setSaveMessage(reason instanceof Error ? reason.message : tPreview('common.saveFailed'));
      throw reason;
    } finally {
      setSaving(false);
    }
  }, [saving]);

  usePreviewUnsaved(host, dirty, performSave);

  const runSave = React.useCallback(() => {
    if (host?.requestHostSave) host.requestHostSave();
    else void performSave();
  }, [host, performSave]);
  runSaveRef.current = runSave;

  React.useEffect(() => {
    if (content === null || viewMode !== 'code') {
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
        setEditorReady(false);
      }
      return;
    }
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      history(),
      bracketMatching(),
      highlightSelectionMatches(),
      syntaxHighlighting(previewHighlightStyle),
      previewEditorTheme,
      EditorView.lineWrapping,
      languageCompartment.of([]),
      editableCompartment.of(EditorView.editable.of(canEdit)),
      keymap.of([
        ...searchKeymap,
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        {
          key: 'Mod-s',
          run: () => {
            runSaveRef.current();
            return true;
          },
        },
      ]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const next = update.state.doc.toString();
        contentRef.current = next;
        const isDirty = next !== content;
        dirtyRef.current = isDirty;
        setDirty(isDirty);
      }),
    ];

    const state = EditorState.create({ doc: content, extensions });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    setEditorReady(true);

    void languageExtensionForFile(descriptor.fileName).then((lang) => {
      if (cancelled || !viewRef.current || !lang) return;
      viewRef.current.dispatch({
        effects: languageCompartment.reconfigure(lang),
      });
    });

    return () => {
      cancelled = true;
      view.destroy();
      if (viewRef.current === view) viewRef.current = null;
      setEditorReady(false);
    };
    // Recreate only when file content session/mode changes; dirty tracking compares to initial `content`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, viewMode, descriptor.fileName, canEdit]);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editableCompartment.reconfigure(EditorView.editable.of(canEdit)),
    });
  }, [canEdit, editableCompartment]);

  const openSearch = React.useCallback(() => {
    if (viewMode !== 'code') setViewMode('code');
    requestAnimationFrame(() => {
      const view = viewRef.current;
      if (view) openSearchPanel(view);
    });
  }, [viewMode]);

  if (error) return h(ViewerError, { error });
  if (content === null) return h(Loading, {});

  const treePanel = viewMode === 'tree' && canVisual
    ? renderVisual(visualKind, content)
    : null;

  const documentActions = [
    h('button', {
      key: 'search',
      type: 'button',
      className: 'preview-chrome-btn preview-chrome-btn--icon preview-text-search',
      title: tPreview('text.search'),
      'aria-label': tPreview('text.search'),
      onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        openSearch();
      },
      dangerouslySetInnerHTML: { __html: SEARCH_ICON },
    }),
    canSave
      ? h('button', {
          key: 'save',
          type: 'button',
          className: 'preview-chrome-btn preview-chrome-btn--icon preview-document-route-save',
          title: saveMessage || (dirty ? tPreview('chrome.saveChanges') : tPreview('chrome.saved')),
          'aria-label': saving ? tPreview('chrome.saving') : tPreview('chrome.save'),
          disabled: saving || !dirty,
          onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            runSave();
          },
        }, saving ? '…' : ChromeIcon(SAVE_ICON_PATH))
      : null,
    canVisual
      ? h('div', {
          key: 'view-toggle',
          className: 'preview-text-view-toggle',
          role: 'group',
          'aria-label': tPreview('text.viewMode'),
        },
          h('button', {
            type: 'button',
            className: `preview-chrome-btn preview-text-view-btn${viewMode === 'code' ? ' is-active' : ''}`,
            'aria-pressed': viewMode === 'code',
            onClick: () => setViewMode('code'),
          }, tPreview('text.viewCode')),
          h('button', {
            type: 'button',
            className: `preview-chrome-btn preview-text-view-btn${viewMode === 'tree' ? ' is-active' : ''}`,
            'aria-pressed': viewMode === 'tree',
            onClick: () => {
              if (viewRef.current) {
                const next = viewRef.current.state.doc.toString();
                contentRef.current = next;
                setContent(next);
              }
              setViewMode('tree');
            },
          }, visualKind === 'sql' ? tPreview('text.viewOutline') : tPreview('text.viewTree')),
        )
      : null,
  ];

  return h(BasicPreviewShell, {
    descriptor,
    className: 'preview-text-shell',
    documentActions,
  },
    truncated
      ? h('p', { className: 'preview-notice' }, tPreview('text.truncated'))
      : null,
    h('div', { className: 'preview-text-content', style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 } },
      viewMode === 'code'
        ? h('div', {
            className: 'preview-text-editor-host',
            ref: hostRef,
            'data-editor-ready': editorReady ? '1' : '0',
            style: { flex: 1, minHeight: 0 },
          })
        : treePanel,
    ),
  );
}

function renderVisual(kind: TextVisualKind, content: string): React.ReactElement {
  if (kind === 'json') {
    const parsed = parseJsonTree(content);
    if (!parsed.ok) {
      return h('div', { className: 'preview-text-visual preview-text-visual-error' },
        h('p', null, tPreview('text.visualParseFailed')),
        h('pre', null, parsed.error),
      );
    }
    return h('div', { className: 'preview-text-visual preview-text-json-tree' },
      h(JsonTreeView, { node: parsed.root, name: 'root' }),
    );
  }
  if (kind === 'sql') {
    const statements = outlineSql(content);
    if (statements.length === 0) {
      return h('div', { className: 'preview-text-visual preview-text-visual-empty' }, tPreview('text.sqlEmpty'));
    }
    return h('div', { className: 'preview-text-visual preview-text-sql-outline' },
      ...statements.map((item) => h(SqlStatementCard, { key: item.index, item })),
    );
  }
  if (kind === 'xml') {
    const parsed = parseXmlTree(content);
    if (!parsed.ok) {
      return h('div', { className: 'preview-text-visual preview-text-visual-error' },
        h('p', null, tPreview('text.visualParseFailed')),
        h('pre', null, parsed.error),
      );
    }
    return h('div', { className: 'preview-text-visual preview-text-xml-tree' },
      h(XmlTreeView, { node: parsed.root }),
    );
  }
  return h('div', { className: 'preview-text-visual' }, tPreview('text.visualUnavailable'));
}

function JsonTreeView({ node, name }: { node: JsonTreeNode; name?: string }): React.ReactElement {
  const [open, setOpen] = React.useState(true);
  if (node.kind === 'scalar') {
    return h('div', { className: `preview-json-node preview-json-${node.type}` },
      name != null ? h('span', { className: 'preview-json-key' }, name) : null,
      name != null ? h('span', { className: 'preview-json-sep' }, ': ') : null,
      h('span', { className: 'preview-json-value' }, node.value),
    );
  }
  const label = node.kind === 'array'
    ? `Array(${node.items.length})`
    : `Object(${node.entries.length})`;
  return h('div', { className: `preview-json-node preview-json-${node.kind}` },
    h('button', {
      type: 'button',
      className: 'preview-json-toggle',
      'aria-expanded': open,
      onClick: () => setOpen((value) => !value),
    }, open ? '▼' : '▶'),
    name != null ? h('span', { className: 'preview-json-key' }, name) : null,
    name != null ? h('span', { className: 'preview-json-sep' }, ': ') : null,
    h('span', { className: 'preview-json-label' }, label),
    open
      ? h('div', { className: 'preview-json-children' },
          node.kind === 'array'
            ? node.items.map((child, index) => h(JsonTreeView, { key: index, node: child, name: String(index) }))
            : node.entries.map((entry) => h(JsonTreeView, { key: entry.key, node: entry.value, name: entry.key })),
        )
      : null,
  );
}

function XmlTreeView({ node }: { node: XmlTreeNode }): React.ReactElement {
  const [open, setOpen] = React.useState(true);
  return h('div', { className: 'preview-xml-node' },
    h('button', {
      type: 'button',
      className: 'preview-json-toggle',
      'aria-expanded': open,
      onClick: () => setOpen((value) => !value),
    }, open ? '▼' : '▶'),
    h('span', { className: 'preview-xml-tag' }, `<${node.tag}`),
    ...node.attrs.map((attr) => h('span', { key: attr.name, className: 'preview-xml-attr' },
      ` ${attr.name}=`,
      h('span', { className: 'preview-xml-attr-value' }, JSON.stringify(attr.value)),
    )),
    h('span', { className: 'preview-xml-tag' }, '>'),
    open
      ? h('div', { className: 'preview-json-children' },
          ...node.children.map((child, index) => (
            'tag' in child
              ? h(XmlTreeView, { key: index, node: child })
              : h('div', { key: index, className: 'preview-xml-text' }, child.text)
          )),
        )
      : null,
  );
}

function SqlStatementCard({ item }: { item: SqlStatementOutline }): React.ReactElement {
  return h('article', { className: 'preview-sql-card' },
    h('header', { className: 'preview-sql-card-head' },
      h('span', { className: 'preview-sql-kind' }, item.kind),
      h('span', { className: 'preview-sql-summary' }, item.summary),
    ),
    h('pre', { className: 'preview-sql-pretty' }, item.pretty),
  );
}
