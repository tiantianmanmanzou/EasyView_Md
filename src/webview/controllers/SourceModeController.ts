import type { EditorView } from 'prosemirror-view';
import type { EditorState as CodeMirrorState } from '@codemirror/state';
import { createSourceEditor } from '../editor/SourceEditor';
import type { EditorCore } from '../editor/EditorCore';
import { stripSettingsComment } from '../editor/lib/EditorSettings';
import type { DualModeHistory } from '../editor/DualModeHistory';
import type { EditOperationLog } from '../editor/EditOperationLog';
import type { FloatingToolbar } from '../extensions/behavior/toolbar/ToolbarFloating';
import type { TableOfContents } from '../extensions/blocks/heading/TableOfContents';
import type { HistoryPanel } from '../ui/HistoryPanel';
import type { createFileHeader } from '../ui/FileHeader';
import type { VscodeWebviewApi } from '../../shared/protocol';

type SourceEditor = ReturnType<typeof createSourceEditor>;
type FileHeader = ReturnType<typeof createFileHeader>;

export interface SourceModeControllerDeps {
  editor: EditorCore;
  vscode: VscodeWebviewApi;
  fileHeader: FileHeader;
  toolbar: Pick<FloatingToolbar, 'forceHide'>;
  toc: TableOfContents;
  dualHistory: DualModeHistory;
  editOperationLog: EditOperationLog;
  historyPanel: HistoryPanel;
  getSourceEditor: () => SourceEditor | null;
  setSourceEditor: (editor: SourceEditor) => void;
  getView: () => EditorView | null;
  getCurrentContent: () => string;
  setCurrentContent: (content: string) => void;
  isSourceMode: () => boolean;
  setSourceMode: (value: boolean) => void;
  getFullWidth: () => boolean;
  getTocVisible: () => boolean;
  getTableWrap: () => boolean;
  getSkipHistoryRecord: () => boolean;
  setSkipHistoryRecord: (value: boolean) => void;
  setHasEditedInCurrentMode: (value: boolean) => void;
  setModeEntryContent: (content: string) => void;
  hideGhost: () => void;
  postEdit: (content: string) => void;
  requestTabCompletion: (line: number, character: number, wordPrefix: string) => Promise<{ insertText: string; replaceStartCharacter?: number; replaceEndCharacter?: number } | null>;
  describeSourceDocChange: (before: string, after: string) => string | null;
  syncSourceHistory: (state: CodeMirrorState) => void;
  updateTocStatus: () => void;
  scheduleWysiwygGhost: (view: EditorView) => void;
  getWysiwygApproxSourcePosition: (view: EditorView) => { line: number; character: number };
}

export class SourceModeController {
  constructor(private readonly deps: SourceModeControllerDeps) {}

  getNativeSourcePosition(): { line: number; character: number } {
    const sourceEditor = this.deps.getSourceEditor();
    if (this.deps.isSourceMode() && sourceEditor) {
      const head = sourceEditor.view.state.selection.main.head;
      const line = sourceEditor.view.state.doc.lineAt(head);
      return { line: Math.max(0, line.number - 1), character: Math.max(0, head - line.from) };
    }
    const view = this.deps.getView();
    return view ? this.deps.getWysiwygApproxSourcePosition(view) : { line: 0, character: 0 };
  }

  openNativeSourceMode(): void {
    const sourceEditor = this.deps.getSourceEditor();
    const sourcePosition = this.getNativeSourcePosition();
    const content = this.deps.isSourceMode() && sourceEditor
      ? stripSettingsComment(sourceEditor.getContent())
      : this.deps.editor.getMarkdown();
    this.deps.hideGhost();
    this.deps.editor.flushSync();
    this.deps.setCurrentContent(content);
    this.deps.vscode.postMessage({
      type: 'openNativeSourceMode',
      content,
      fullWidth: this.deps.getFullWidth(),
      tocVisible: this.deps.getTocVisible(),
      tableWrap: this.deps.getTableWrap(),
      line: sourcePosition.line,
      character: sourcePosition.character,
    });
  }

  toggleSourceMode(): void {
    const scrollArea = document.getElementById('editor-scroll-area');
    const editorElement = document.getElementById('editor');
    if (!scrollArea || !editorElement) return;

    if (!this.deps.isSourceMode()) {
      this.enterSourceMode(scrollArea, editorElement);
    } else {
      this.exitSourceMode(scrollArea, editorElement);
    }
  }

  private enterSourceMode(scrollArea: HTMLElement, editorElement: HTMLElement): void {
    const { editor } = this.deps;
    this.deps.hideGhost();
    if (!this.deps.getSkipHistoryRecord()) {
      this.deps.dualHistory.recordModeSwitch(editor.getMarkdown(), 'wysiwyg', editor.view?.state);
    }
    this.deps.toolbar.forceHide();
    const scrollPct = scrollArea.scrollHeight > scrollArea.clientHeight
      ? scrollArea.scrollTop / (scrollArea.scrollHeight - scrollArea.clientHeight)
      : 0;
    const rawMarkdown = editor.getMarkdown();
    editorElement.style.display = 'none';
    let sourceContainer = document.getElementById('source-editor');
    if (!sourceContainer) {
      sourceContainer = document.createElement('div');
      sourceContainer.id = 'source-editor';
      scrollArea.appendChild(sourceContainer);
    }
    sourceContainer.style.display = 'block';

    if (!this.deps.getSourceEditor()) {
      this.deps.setSourceEditor(createSourceEditor({
        parent: sourceContainer,
        onChange: (rawContent) => {
          this.deps.setHasEditedInCurrentMode(true);
          const content = stripSettingsComment(rawContent);
          if (content !== this.deps.getCurrentContent()) {
            this.deps.setCurrentContent(content);
            this.deps.postEdit(content);
          }
        },
        onDocumentHistoryChange: (update) => {
          const before = update.startState.doc.toString();
          const after = update.state.doc.toString();
          const isHistory = update.transactions.some((tr) => tr.isUserEvent('undo') || tr.isUserEvent('redo'));
          if (!isHistory) {
            const label = this.deps.describeSourceDocChange(before, after);
            if (label) this.deps.editOperationLog.notePendingLabel(label, 'source');
          }
          this.deps.syncSourceHistory(update.state);
          this.deps.historyPanel.refresh();
        },
        onSelectionOrDocChange: () => this.deps.updateTocStatus(),
        requestTabCompletion: ({ line, character, wordPrefix }) => this.deps.requestTabCompletion(line, character, wordPrefix),
        onUndoExhausted: () => this.handleSourceHistory('undo'),
        onRedoExhausted: () => this.handleSourceHistory('redo'),
      }));
    }

    const sourceEditor = this.deps.getSourceEditor();
    if (!sourceEditor) return;
    if (sourceEditor.getContent() !== rawMarkdown) sourceEditor.setContent(rawMarkdown);
    this.deps.updateTocStatus();
    sourceEditor.focus();
    requestAnimationFrame(() => {
      sourceEditor.view.requestMeasure();
      const scroller = sourceEditor.view.scrollDOM;
      if (scroller.scrollHeight > scroller.clientHeight) {
        scroller.scrollTop = scrollPct * (scroller.scrollHeight - scroller.clientHeight);
      }
    });

    const headings = this.deps.toc.getHeadings();
    const fullLines = rawMarkdown.split('\n');
    const headingLineMap = headings.flatMap((heading) => {
      const prefix = `${'#'.repeat(heading.level)} ${heading.text}`;
      const line = fullLines.findIndex((value) => value.startsWith(prefix));
      return line >= 0 ? [{ pos: heading.pos, line: line + 1 }] : [];
    });
    this.deps.toc.sourceClickHandler = (heading) => {
      const current = this.deps.getSourceEditor();
      if (!current) return;
      const index = current.getContent().indexOf(`${'#'.repeat(heading.level)} ${heading.text}`);
      if (index < 0) return;
      current.scrollToLine(current.getContent().slice(0, index).split('\n').length);
      current.focus();
    };
    this.deps.toc.enterSourceMode(() => {
      const current = this.deps.getSourceEditor();
      if (!current) return -1;
      let activePos = -1;
      for (const entry of headingLineMap) {
        const offset = current.getLineTopOffset(entry.line);
        if (offset === -1) continue;
        if (offset > 20) break;
        activePos = entry.pos;
      }
      return activePos;
    }, sourceEditor.view.scrollDOM);

    this.deps.setSourceMode(true);
    this.deps.updateTocStatus();
    this.deps.setHasEditedInCurrentMode(false);
    this.deps.setModeEntryContent(rawMarkdown);
    this.deps.fileHeader.getSourceBtn().classList.add('active');
  }

  private exitSourceMode(scrollArea: HTMLElement, editorElement: HTMLElement): void {
    const sourceEditor = this.deps.getSourceEditor();
    const view = this.deps.getView();
    if (!sourceEditor || !view) return;
    const rawMarkdown = sourceEditor.getContent();
    if (!this.deps.getSkipHistoryRecord()) {
      this.deps.dualHistory.recordModeSwitch(stripSettingsComment(rawMarkdown), 'source', sourceEditor.view.state);
    }
    const scroller = sourceEditor.view.scrollDOM;
    const scrollPct = scroller.scrollHeight > scroller.clientHeight
      ? scroller.scrollTop / (scroller.scrollHeight - scroller.clientHeight)
      : 0;
    const markdown = stripSettingsComment(rawMarkdown);
    document.getElementById('source-editor')?.style.setProperty('display', 'none');
    editorElement.style.display = '';
    editorElement.classList.toggle('full-width', this.deps.getFullWidth());
    editorElement.classList.toggle('table-wrap', this.deps.getTableWrap());
    window.dispatchEvent(new CustomEvent('easyview-table-wrap-layout-change'));
    if (this.deps.getTocVisible() && !this.deps.toc.visible) this.deps.toc.open();
    if (!this.deps.getTocVisible() && this.deps.toc.visible) this.deps.toc.close();

    const snapshot = this.deps.dualHistory.peekUndo();
    if (snapshot?.editorState && snapshot.mode === 'wysiwyg' && markdown === snapshot.markdown) {
      view.updateState(snapshot.editorState);
    } else if (markdown !== this.deps.editor.getMarkdown()) {
      this.deps.editor.isUpdatingFromExtension = true;
      this.deps.editor.setContent(markdown);
      this.deps.editor.isUpdatingFromExtension = false;
    }
    requestAnimationFrame(() => {
      if (scrollArea.scrollHeight > scrollArea.clientHeight) {
        scrollArea.scrollTop = scrollPct * (scrollArea.scrollHeight - scrollArea.clientHeight);
      }
    });
    this.deps.toc.sourceClickHandler = null;
    this.deps.toc.exitSourceMode();
    view.focus();
    this.deps.setSourceMode(false);
    this.deps.updateTocStatus();
    this.deps.scheduleWysiwygGhost(view);
    this.deps.setHasEditedInCurrentMode(false);
    this.deps.setModeEntryContent(markdown);
    this.deps.fileHeader.getSourceBtn().classList.remove('active');
  }

  private handleSourceHistory(direction: 'undo' | 'redo'): boolean {
    const sourceEditor = this.deps.getSourceEditor();
    if (!sourceEditor) return false;
    const markdown = stripSettingsComment(sourceEditor.getContent());
    this.deps.dualHistory.skipIdenticalUndos(markdown);
    const snapshot = direction === 'undo'
      ? this.deps.dualHistory.crossModeUndo(markdown, 'source')
      : this.deps.dualHistory.crossModeRedo(markdown, 'source');
    if (!snapshot) return false;
    if (snapshot.mode === 'wysiwyg') {
      this.deps.setSkipHistoryRecord(true);
      this.toggleSourceMode();
      this.deps.setSkipHistoryRecord(false);
    } else if (snapshot.editorState) {
      sourceEditor.view.setState(snapshot.editorState);
      this.deps.setCurrentContent(snapshot.markdown);
      this.deps.postEdit(snapshot.markdown);
    } else {
      sourceEditor.setContent(snapshot.markdown);
      this.deps.setCurrentContent(snapshot.markdown);
      this.deps.postEdit(snapshot.markdown);
    }
    return true;
  }
}
