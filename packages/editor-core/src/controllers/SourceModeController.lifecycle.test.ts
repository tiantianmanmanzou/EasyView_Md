/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceModeController, type SourceModeControllerDeps } from './SourceModeController';

function createSourceEditorStub() {
  const scrollDOM = document.createElement('div');
  return {
    view: {
      state: { selection: { main: { head: 0 } }, doc: { lineAt: () => ({ number: 1, from: 0 }) } },
      scrollDOM,
      requestMeasure: vi.fn(),
    },
    getContent: () => '# Heading',
    setContent: vi.fn(),
    focus: vi.fn(),
    scrollToLine: vi.fn(),
    getLineTopOffset: vi.fn(() => 0),
    destroy: vi.fn(),
  };
}

function createController() {
  const sourceEditor = createSourceEditorStub();
  let currentSourceEditor: typeof sourceEditor | null = sourceEditor;
  let sourceMode = false;
  const sourceButton = document.createElement('button');
  const toc = {
    visible: false,
    sourceClickHandler: null,
    getHeadings: () => [],
    enterSourceMode: vi.fn(),
    exitSourceMode: vi.fn(),
  };

  const openSourceDocument = vi.fn();
  const controller = new SourceModeController({
    editor: {
      getMarkdown: () => '# Heading',
      view: null,
      isUpdatingFromExtension: false,
      flushSync: vi.fn(),
    } as never,
    openSourceDocument,
    fileHeader: { getSourceBtn: () => sourceButton } as never,
    toolbar: { forceHide: vi.fn() },
    toc: toc as never,
    dualHistory: { recordModeSwitch: vi.fn() } as never,
    editOperationLog: {} as never,
    historyPanel: {} as never,
    getSourceEditor: () => currentSourceEditor,
    setSourceEditor: (value: typeof sourceEditor | null) => { currentSourceEditor = value as typeof sourceEditor | null; },
    getView: () => null,
    getCurrentContent: () => '# Heading',
    setCurrentContent: vi.fn(),
    isSourceMode: () => sourceMode,
    setSourceMode: (value: boolean) => { sourceMode = value; },
    getFullWidth: () => true,
    getTocVisible: () => true,
    getTableWrap: () => false,
    getSkipHistoryRecord: () => false,
    setSkipHistoryRecord: vi.fn(),
    setHasEditedInCurrentMode: vi.fn(),
    setModeEntryContent: vi.fn(),
    hideGhost: vi.fn(),
    postEdit: vi.fn(),
    requestTabCompletion: vi.fn(),
    describeSourceDocChange: vi.fn(),
    syncSourceHistory: vi.fn(),
    updateTocStatus: vi.fn(),
    scheduleWysiwygGhost: vi.fn(),
    getWysiwygApproxSourcePosition: vi.fn(() => ({ line: 0, character: 0 })),
  } as unknown as SourceModeControllerDeps);

  return { controller, sourceEditor, sourceButton, toc, openSourceDocument, getSourceEditor: () => currentSourceEditor, isSourceMode: () => sourceMode };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('SourceModeController lifecycle', () => {
  it('delegates native source opening through the explicit host action', () => {
    const { controller, openSourceDocument } = createController();

    controller.openSourceDocument();

    expect(openSourceDocument).toHaveBeenCalledWith({
      content: '# Heading',
      fullWidth: true,
      tocVisible: true,
      tableWrap: false,
      line: 0,
      character: 0,
    });
  });

  it('dispose destroys the source editor and removes source-mode DOM idempotently', () => {
    const scrollArea = document.createElement('div');
    scrollArea.id = 'editor-scroll-area';
    const editorElement = document.createElement('div');
    editorElement.id = 'editor';
    document.body.append(scrollArea, editorElement);

    const { controller, sourceEditor, sourceButton, toc, getSourceEditor, isSourceMode } = createController();
    controller.toggleSourceMode();

    expect(document.getElementById('source-editor')).not.toBeNull();
    expect(isSourceMode()).toBe(true);

    controller.dispose();
    controller.dispose();

    expect(sourceEditor.destroy).toHaveBeenCalledTimes(1);
    expect(getSourceEditor()).toBeNull();
    expect(document.getElementById('source-editor')).toBeNull();
    expect(editorElement.style.display).toBe('');
    expect(sourceButton.classList.contains('active')).toBe(false);
    expect(isSourceMode()).toBe(false);
    expect(toc.exitSourceMode).toHaveBeenCalledTimes(1);
  });
});
