import { clipboard, dialog, shell } from 'electron';
import os from 'node:os';
import {
  buildXlsxBuffer,
  ImageServiceError,
  pickImage,
  readImageAsDataUrl,
  savePastedImage,
  writeDocxExport,
  writeFileAtomically,
  writeHtmlExport,
  writePdfBase64,
} from '@easyview/node-runtime';
import { hashContent } from '@easyview/editor-sync';
import type { EditorToHostMessage } from '@easyview/contracts';
import { getAiChatHost } from '../ai/createDesktopAiChatHost';
import {
  chooseExportPath,
  documentDirectory,
  renameCurrent,
  requireDocumentPath,
  saveSession,
  showExportCompleted,
  showOperationError,
} from '../document/documentWorkflow';
import {
  activeSession,
  getActiveTerminalSessionId,
  currentEditorDocumentMessage,
  notifyActiveGitChanges,
  documentSessions,
  editorDocumentMessage,
  isAllowedExternalUrl,
  failure,
  fileNameWithoutExtension,
  isNonEmptyString,
  isRecord,
  getMainWindow,
  sendEditorMessage,
  setActiveTerminalSessionId,
  setTableFirstRowStickyDefault,
  setTerminalService,
  syncTabState,
  tabRegistry,
  getTerminalService as currentTerminalService,
} from '../host/desktopRuntime';
import { TerminalService } from '@easyview/node-runtime';

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalPosition(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
}

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord);
}

function imageErrorMessage(error: unknown): string {
  if (error instanceof ImageServiceError) return error.message;
  return error instanceof Error ? error.message : '图片处理失败';
}

function ensureTerminalService(): TerminalService {
  const existing = currentTerminalService();
  if (existing) return existing;
  const created = new TerminalService({
    defaultCwd: documentDirectory(),
    onData: (sessionId, data) => {
      sendEditorMessage({ type: 'terminalData', sessionId, data });
    },
    onExit: (sessionId, exitCode, signal) => {
      if (getActiveTerminalSessionId() === sessionId) setActiveTerminalSessionId(undefined);
      sendEditorMessage({ type: 'terminalExit', sessionId, code: exitCode, signal: signal ?? null });
    },
  });
  setTerminalService(created);
  return created;
}

export function validateEditorMessage(value: EditorToHostMessage): string | null {
  const message = value as unknown as Record<string, unknown>;
  switch (value.type) {
    case 'ready':
    case 'save':
    case 'openTerminal':
    case 'stageFile':
    case 'generateCommitMessage':
    case 'terminalClose':
      return null;
    case 'webviewRuntimeError':
      return isNonEmptyString(message.source) && typeof message.message === 'string' && isOptionalString(message.stack) ? null : '运行时错误消息字段无效';
    case 'openWithDebugLog':
      return isNonEmptyString(message.stage) && (message.meta === undefined || isRecord(message.meta)) ? null : '调试日志字段无效';
    case 'rowResizeDebug':
      return isNonEmptyString(message.stage) && isRecord(message.data) ? null : '表格调试字段无效';
    case 'getImageBase64':
      return isNonEmptyString(message.requestId) && typeof message.originalSrc === 'string' ? null : '图片读取请求字段无效';
    case 'pickImage':
      return isOptionalPosition(message.pos) ? null : '图片位置无效';
    case 'dropImages':
      return Array.isArray(message.paths) && message.paths.every((item) => typeof item === 'string') && isOptionalPosition(message.pos) ? null : '拖入图片字段无效';
    case 'pasteImage':
      return typeof message.dataUrl === 'string' && isOptionalString(message.mimeType) && isOptionalString(message.name) && isOptionalPosition(message.pos) ? null : '粘贴图片字段无效';
    case 'exportPdfBase64':
      return isNonEmptyString(message.data) ? null : 'PDF 导出数据无效';
    case 'exportHtml':
      return typeof message.html === 'string' && isRecordArray(message.images) && message.images.every((image) => typeof image.originalSrc === 'string' && isNonEmptyString(image.exportFilename) && typeof image.isExternal === 'boolean') ? null : 'HTML 导出字段无效';
    case 'exportXlsx':
      return isRecord(message.payload) && isNonEmptyString(message.fileName) ? null : 'XLSX 导出字段无效';
    case 'exportDocx':
      return typeof message.title === 'string' && typeof message.markdown === 'string' && isRecordArray(message.mermaidImages) && isRecordArray(message.asciiImages) && [...message.mermaidImages, ...message.asciiImages].every((image) => typeof image.source === 'string' && isNonEmptyString(image.pngBase64) && typeof image.width === 'number' && Number.isFinite(image.width) && image.width > 0 && typeof image.height === 'number' && Number.isFinite(image.height) && image.height > 0) ? null : 'DOCX 导出字段无效';
    case 'terminalInput':
      return typeof message.data === 'string' ? null : 'terminalInput.data 必须是字符串';
    case 'terminalResize':
      return Number.isInteger(message.cols) && (message.cols as number) > 0 && Number.isInteger(message.rows) && (message.rows as number) > 0 ? null : '终端尺寸无效';
    case 'aiChat.getSettings':
    case 'aiChat.abort':
      return isNonEmptyString(message.requestId) ? null : 'AI 对话请求 ID 无效';
    case 'aiChat.pickImage':
      return null;
    case 'aiChat.saveApiKey':
    case 'aiChat.saveWebSearchApiKey':
      return isNonEmptyString(message.requestId) && typeof message.apiKey === 'string' ? null : 'AI API Key 字段无效';
    case 'aiChat.saveSettings':
      return isNonEmptyString(message.requestId) && isRecord(message.settings) ? null : 'AI 设置字段无效';
    case 'aiChat.send':
      return isNonEmptyString(message.requestId)
        && (message.mode === 'chat' || message.mode === 'agent')
        && isNonEmptyString(message.model)
        && typeof message.userMessage === 'string'
        && Array.isArray(message.attachments)
        && Array.isArray(message.history)
        && (message.documentContent === undefined || typeof message.documentContent === 'string')
        && (message.documentFileName === undefined || typeof message.documentFileName === 'string')
        && (message.documentFilePath === undefined || typeof message.documentFilePath === 'string')
        ? null
        : 'AI 对话请求字段无效';
    default:
      return null;
  }
}

export async function handleEditorMessage(message: EditorToHostMessage): Promise<void> {
  const validationError = validateEditorMessage(message);
  if (validationError) {
    await showOperationError(failure('INVALID_ARGUMENT', validationError));
    return;
  }
  if (
    !activeSession()
    // ready / AI / debug messages may arrive before a document is focused
    && !message.type.startsWith('aiChat.')
    && message.type !== 'ready'
    && message.type !== 'webviewRuntimeError'
    && message.type !== 'openWithDebugLog'
    && message.type !== 'rowResizeDebug'
  ) return;
  switch (message.type) {
    case 'aiChat.send':
    case 'aiChat.abort':
    case 'aiChat.getSettings':
    case 'aiChat.saveSettings':
    case 'aiChat.saveApiKey':
    case 'aiChat.saveWebSearchApiKey':
    case 'aiChat.pickImage':
      await getAiChatHost().handle(message);
      return;
    case 'ready': {
      const snapshot = currentEditorDocumentMessage('initial');
      if (snapshot) sendEditorMessage(snapshot);
      return;
    }
    case 'snapshotApplied': {
      const session = documentSessions.findByDocumentId(message.documentId);
      if (!session || message.revision !== session.sync.snapshot.revision || message.contentHash !== hashContent(session.content)) {
        sendEditorMessage({
          type: 'resyncRequired',
          documentId: session?.documentId ?? message.documentId,
          revision: session?.sync.snapshot.revision ?? message.revision,
          reason: 'Snapshot acknowledgement mismatch',
        });
      }
      return;
    }
    case 'requestResync': {
      const session = documentSessions.findByDocumentId(message.documentId);
      if (session) sendEditorMessage(editorDocumentMessage(session, 'resync'));
      return;
    }
    case 'applyEdits': {
      const session = documentSessions.findByDocumentId(message.documentId);
      if (!session) {
        sendEditorMessage({ type: 'resyncRequired', documentId: message.documentId, revision: message.baseRevision, reason: 'Document session not found' });
        return;
      }
      const applied = documentSessions.applyEdits(session.tabId, {
        documentId: message.documentId,
        baseRevision: message.baseRevision,
        edits: message.edits,
        resultHash: message.resultHash,
      });
      if (!applied.ok) {
        sendEditorMessage({ type: 'resyncRequired', documentId: session.documentId, revision: session.sync.snapshot.revision, reason: applied.message });
        return;
      }
      tabRegistry.setEditorDirty(session.tabId, session.dirty);
      if (applied.value.dirtyChanged) syncTabState();
      sendEditorMessage({ type: 'editsApplied', documentId: session.documentId, clientEditId: message.clientEditId, revision: applied.value.revision, resultHash: applied.value.resultHash });
      void notifyActiveGitChanges(session);
      return;
    }
    case 'save': {
      const session = activeSession();
      if (!session) return;
      const result = await saveSession(session.tabId, session.content);
      await showOperationError(result);
      if (result.ok && result.value) {
        sendEditorMessage({ type: 'fileRenamed', fileName: fileNameWithoutExtension(result.value.fileName) });
      }
      return;
    }
    case 'rename': {
      const result = await renameCurrent(message.newName);
      await showOperationError(result);
      if (result.ok) {
        sendEditorMessage({ type: 'fileRenamed', fileName: fileNameWithoutExtension(result.value.fileName) });
      }
      return;
    }
    case 'setTableFirstRowStickyDefault':
      setTableFirstRowStickyDefault(message.sticky);
      return;
    case 'updateUiState': {
      const session = documentSessions.findByDocumentId(message.documentId);
      if (session) session.uiState = message.state;
      return;
    }
    case 'copyTextToClipboard':
      try {
        clipboard.writeText(message.text);
        sendEditorMessage({ type: 'clipboardCopyCompleted', message: message.successMessage ?? 'Copied' });
      } catch (error) {
        sendEditorMessage({
          type: 'clipboardCopyFailed',
          message: error instanceof Error ? error.message : 'Copy failed',
        });
      }
      return;
    case 'openLink': {
      const url = message.href ?? message.url;
      if (isAllowedExternalUrl(url)) await shell.openExternal(url);
      return;
    }
    case 'showInfo':
      await dialog.showMessageBox(getMainWindow()!, { type: 'info', message: message.text });
      return;
    case 'requestTabCompletion':
      sendEditorMessage({ type: 'tabCompletionResponse', requestId: message.requestId, insertText: null });
      return;
    case 'stageFile': {
      const session = activeSession();
      try {
        if (!session) throw new Error('请先打开 Markdown 文档。');
        const saveResult = await saveSession(session.tabId, session.content);
        if (!saveResult.ok) throw new Error(saveResult.message);
        const result = await documentSessions.stage(session.tabId);
        if (!result.ok) throw new Error(result.message);
        sendEditorMessage({ type: 'stageFileCompleted', message: `已暂存 ${result.value.fileName}` });
        void notifyActiveGitChanges(session);
      } catch (error) {
        sendEditorMessage({ type: 'stageFileFailed', message: error instanceof Error ? error.message : 'Git 暂存失败' });
      }
      return;
    }
    case 'stageHunk': {
      const session = activeSession();
      try {
        if (!session) throw new Error('请先打开 Markdown 文档。');
        if (typeof message.content !== 'string') throw new Error('暂存块内容无效。');
        const saveResult = await saveSession(session.tabId, session.content);
        if (!saveResult.ok) throw new Error(saveResult.message);
        const result = await documentSessions.stageContent(session.tabId, message.content);
        if (!result.ok) throw new Error(result.message);
        sendEditorMessage({ type: 'stageFileCompleted', message: `已暂存变更块：${result.value.fileName}` });
        void notifyActiveGitChanges(session);
      } catch (error) {
        sendEditorMessage({ type: 'stageFileFailed', message: error instanceof Error ? error.message : 'Git 暂存失败' });
      }
      return;
    }
    case 'generateCommitMessage':
      sendEditorMessage({ type: 'commitMessageGenerationFailed', message: '桌面版尚未配置 AI 提交信息服务。' });
      return;
    case 'commitFile': {
      if (typeof message.message !== 'string' || !message.message.trim()) {
        sendEditorMessage({ type: 'commitFileFailed', message: '提交信息不能为空。' });
        return;
      }
      try {
        const session = activeSession();
        if (!session) throw new Error('请先打开 Markdown 文档。');
        const saveResult = await saveSession(session.tabId, session.content);
        if (!saveResult.ok) throw new Error(saveResult.message);
        const result = await documentSessions.commit(session.tabId, message.message);
        if (!result.ok) throw new Error(result.message);
        sendEditorMessage({ type: 'commitFileCompleted', message: `已提交 ${result.value.fileName}` });
        void notifyActiveGitChanges(session);
      } catch (error) {
        sendEditorMessage({ type: 'commitFileFailed', message: error instanceof Error ? error.message : 'Git 提交失败' });
      }
      return;
    }
    case 'syncFile': {
      if (typeof message.message !== 'string' || !message.message.trim()) {
        sendEditorMessage({ type: 'syncFileFailed', message: '提交信息不能为空。' });
        return;
      }
      try {
        const session = activeSession();
        if (!session) throw new Error('请先打开 Markdown 文档。');
        const saveResult = await saveSession(session.tabId, session.content);
        if (!saveResult.ok) throw new Error(saveResult.message);
        const result = await documentSessions.sync(session.tabId, message.message);
        if (!result.ok) throw new Error(result.message);
        sendEditorMessage({ type: 'syncFileCompleted', message: `已同步 ${result.value.fileName}` });
      } catch (error) {
        sendEditorMessage({ type: 'syncFileFailed', message: error instanceof Error ? error.message : 'Git 同步失败' });
      }
      return;
    }
    case 'openTerminal': {
      try {
        if (getActiveTerminalSessionId()) ensureTerminalService().close(getActiveTerminalSessionId()!);
        const terminal = ensureTerminalService().open({ cwd: documentDirectory() });
        setActiveTerminalSessionId(terminal.sessionId);
        sendEditorMessage({
          type: 'terminalOpened',
          sessionId: terminal.sessionId,
          cwd: terminal.cwd,
          platform: process.platform,
          homeDir: os.homedir(),
        });
      } catch (error) {
        sendEditorMessage({ type: 'terminalError', message: error instanceof Error ? error.message : '终端启动失败' });
      }
      return;
    }
    case 'webviewRuntimeError':
      console.error(`[EasyView Renderer] ${message.source}: ${message.message}`, message.stack ?? '');
      return;
    case 'openWithDebugLog':
      console.debug(`[EasyView Renderer] ${message.stage}`, message.meta ?? {});
      return;
    case 'rowResizeDebug':
      console.debug(`[EasyView Table] ${message.stage}`, message.data);
      return;
    case 'getImageBase64': {
      const documentPath = activeSession()?.filePath;
      if (!documentPath) {
        sendEditorMessage({ type: 'imageBase64Response', requestId: message.requestId, base64: null });
        return;
      }
      try {
        const base64 = await readImageAsDataUrl({ documentPath, source: message.originalSrc });
        sendEditorMessage({ type: 'imageBase64Response', requestId: message.requestId, base64 });
      } catch {
        sendEditorMessage({ type: 'imageBase64Response', requestId: message.requestId, base64: null });
      }
      return;
    }
    case 'pickImage': {
      const documentPath = requireDocumentPath();
      if (!documentPath) return;
      try {
        const selected = await pickImage({
          documentPath,
          selectPath: async () => {
        const chosen = await dialog.showOpenDialog(getMainWindow()!, {
              properties: ['openFile'],
              filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'] }],
            });
            return chosen.canceled ? null : (chosen.filePaths[0] ?? null);
          },
        });
        sendEditorMessage({ type: 'imageSelected', src: selected.dataUrl, originalSrc: selected.relativePath, pos: message.pos });
      } catch (error) {
        if (!(error instanceof ImageServiceError && error.code === 'IMAGE_SELECTION_CANCELLED')) {
          await dialog.showMessageBox(getMainWindow()!, { type: 'error', message: imageErrorMessage(error) });
        }
      }
      return;
    }
    case 'dropImages': {
      const documentPath = requireDocumentPath();
      if (!documentPath) return;
      const images = [];
      for (const imagePath of message.paths) {
        try {
          const selected = await pickImage({ documentPath, selectPath: async () => imagePath });
          images.push({ src: selected.dataUrl, originalSrc: selected.relativePath });
        } catch (error) {
          console.warn('[EasyView_Md] Dropped image rejected:', imageErrorMessage(error));
        }
      }
      if (images.length > 0) sendEditorMessage({ type: 'imagesDropped', images, pos: message.pos });
      return;
    }
    case 'pasteImage': {
      const documentPath = requireDocumentPath();
      if (!documentPath) return;
      try {
        const saved = await savePastedImage({ documentPath, dataUrl: message.dataUrl, preferredName: message.name });
        const dataUrl = await readImageAsDataUrl({ documentPath, source: saved.relativePath });
        sendEditorMessage({ type: 'imageSelected', src: dataUrl, originalSrc: saved.relativePath, pos: message.pos });
      } catch (error) {
        await dialog.showMessageBox(getMainWindow()!, { type: 'error', message: imageErrorMessage(error) });
      }
      return;
    }
    case 'exportHtml': {
      const targetPath = await chooseExportPath('html', 'HTML');
      if (!targetPath) return;
      try {
        const result = await writeHtmlExport({ targetPath, documentDir: documentDirectory(), html: message.html, images: message.images });
        await showExportCompleted(result.htmlPath);
      } catch (error) {
        await dialog.showMessageBox(getMainWindow()!, { type: 'error', message: error instanceof Error ? error.message : 'HTML 导出失败' });
      }
      return;
    }
    case 'exportPdfBase64': {
      const targetPath = await chooseExportPath('pdf', 'PDF');
      if (!targetPath) return;
      try {
        await writePdfBase64({ targetPath, data: message.data });
        await showExportCompleted(targetPath);
      } catch (error) {
        await dialog.showMessageBox(getMainWindow()!, { type: 'error', message: error instanceof Error ? error.message : 'PDF 导出失败' });
      }
      return;
    }
    case 'exportXlsx': {
      const targetPath = await chooseExportPath('xlsx', 'Excel Workbook');
      if (!targetPath) return;
      try {
        const buffer = await buildXlsxBuffer(message.payload);
        await writeFileAtomically(targetPath, buffer);
        await showExportCompleted(targetPath);
      } catch (error) {
        await dialog.showMessageBox(getMainWindow()!, { type: 'error', message: error instanceof Error ? error.message : 'XLSX 导出失败' });
      }
      return;
    }
    case 'exportDocx': {
      const targetPath = await chooseExportPath('docx', 'Word Document');
      if (!targetPath) return;
      try {
        await writeDocxExport({
          targetPath,
          markdown: message.markdown,
          title: message.title || fileNameWithoutExtension(activeSession()?.fileName ?? 'Untitled'),
          docDir: documentDirectory(),
          mermaidImages: message.mermaidImages,
          asciiImages: message.asciiImages,
        });
        await showExportCompleted(targetPath);
      } catch (error) {
        await dialog.showMessageBox(getMainWindow()!, { type: 'error', message: error instanceof Error ? error.message : 'DOCX 导出失败' });
      }
      return;
    }
    case 'terminalInput':
      if (getActiveTerminalSessionId() && typeof message.data === 'string') {
        ensureTerminalService().write(getActiveTerminalSessionId()!, message.data);
      }
      return;
    case 'terminalResize':
      if (getActiveTerminalSessionId() && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
        ensureTerminalService().resize(getActiveTerminalSessionId()!, message.cols, message.rows);
      }
      return;
    case 'terminalClose':
      if (getActiveTerminalSessionId()) {
        ensureTerminalService().close(getActiveTerminalSessionId()!);
        setActiveTerminalSessionId(undefined);
      }
      return;
  }
}
