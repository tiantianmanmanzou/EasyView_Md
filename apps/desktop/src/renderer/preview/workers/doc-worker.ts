import { parseMsDoc, renderMsDoc } from '@file-viewer/doc';

interface RenderRequest { id: number; bytes: ArrayBuffer; }
interface RenderResponse { id: number; ok: boolean; html?: string; css?: string; error?: string; }

self.onmessage = (event: MessageEvent<RenderRequest>) => {
  const { id, bytes } = event.data;
  try {
    const rendered = renderMsDoc(parseMsDoc(bytes));
    const response: RenderResponse = { id, ok: true, html: rendered.html, css: rendered.css };
    self.postMessage(response);
  } catch (error) {
    const response: RenderResponse = { id, ok: false, error: error instanceof Error ? error.message : '旧版 Word 文档解析失败' };
    self.postMessage(response);
  }
};
