import * as React from 'react';
import type { HttpPreviewResponse, PreviewTextResult } from '@easyview/contracts';
import { h, Loading, ViewerError, type ViewerProps } from './shared';

export interface HttpViewerProps extends ViewerProps {
  readText(sessionId: string): Promise<PreviewTextResult>;
  send(request: { url: string; method: 'GET'; headers: Record<string, string> }): Promise<HttpPreviewResponse>;
}

/** HTTP files remain inert until the user explicitly presses Send. */
export function HttpViewer({ descriptor, readText, send }: HttpViewerProps): React.ReactElement {
  const [url, setUrl] = React.useState<string | null>(null);
  const [response, setResponse] = React.useState<HttpPreviewResponse | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [pending, setPending] = React.useState(false);
  React.useEffect(() => {
    let disposed = false;
    void readText(descriptor.sessionId).then(({ content }) => {
      if (disposed) return;
      const requestLine = content.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('#')) ?? '';
      const match = requestLine.match(/^(?:GET\s+)?(https?:\/\/\S+)/i);
      setUrl(match?.[1] ?? '');
    }).catch((reason) => { if (!disposed) setError(reason); });
    return () => { disposed = true; };
  }, [descriptor.sessionId, readText]);
  if (url === null) return h(Loading, { label: '正在读取 HTTP 请求文件…' });
  const submit = () => {
    if (!url.trim() || pending) return;
    setPending(true); setError(null);
    void send({ url: url.trim(), method: 'GET', headers: {} }).then(setResponse).catch(setError).finally(() => setPending(false));
  };
  return h('section', { className: 'preview-http-viewer' },
    h('div', { className: 'preview-http-request' }, h('input', { value: url, placeholder: 'https://example.com/api', onChange: (event: React.ChangeEvent<HTMLInputElement>) => setUrl(event.currentTarget.value) }), h('button', { type: 'button', disabled: pending, onClick: submit }, pending ? '发送中…' : '发送')),
    error ? h(ViewerError, { error }) : null,
    response ? h('article', { className: 'preview-http-response' }, h('p', null, `${response.status} ${response.statusText}`), response.truncated ? h('p', { className: 'preview-notice' }, '响应内容已按安全上限截断。') : null, h('pre', null, response.body)) : null,
  );
}
