import * as React from 'react';
import type { PreviewTextResult } from '@easyview/contracts';
import { h, Loading, ViewerError, type ViewerProps } from './shared';

export interface HtmlViewerProps extends ViewerProps {
  readText?(sessionId: string): Promise<PreviewTextResult>;
}

const HTML_PREVIEW_MESSAGE = 'easyview-html';

/** Directory URL so relative css/img/js resolve next to the HTML file. */
export function htmlPreviewBaseHref(contentUrl: string): string {
  try {
    const url = new URL(contentUrl);
    url.hash = '';
    url.search = '';
    const slash = url.pathname.lastIndexOf('/');
    url.pathname = `${slash >= 0 ? url.pathname.slice(0, slash) : ''}/`;
    return url.toString();
  } catch {
    return contentUrl;
  }
}

export function isLocalHttpPreviewUrl(contentUrl: string): boolean {
  try {
    const url = new URL(contentUrl);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  } catch {
    return false;
  }
}

export function isHtmlPreviewAssetHref(href: string, contentUrl: string): boolean {
  try {
    const allowed = new URL(contentUrl);
    const target = new URL(href);
    return target.protocol === allowed.protocol && target.host === allowed.host;
  } catch {
    return false;
  }
}

export function htmlRewriteRelativeUrls(markup: string, baseHref: string): string {
  return markup.replace(
    /\s(src|href)\s*=\s*(['"])(?!https?:|data:|blob:|javascript:|#|\/\/)(.*?)\2/gi,
    (full, attr: string, quote: string, value: string) => {
      try {
        return ` ${attr}=${quote}${new URL(value, baseHref).toString()}${quote}`;
      } catch {
        return full;
      }
    },
  );
}

export function htmlDocumentWithBase(markup: string, baseHref: string): string {
  const rewritten = htmlRewriteRelativeUrls(markup, baseHref);
  const inject = `<base href="${escapeHtmlAttribute(baseHref)}"><script>${HTML_PREVIEW_FRAME_BOOTSTRAP}</script>`;
  if (/<head\b/i.test(rewritten)) return rewritten.replace(/<head([^>]*)>/i, `<head$1>${inject}`);
  if (/<html\b/i.test(rewritten)) return rewritten.replace(/<html([^>]*)>/i, `<html$1><head>${inject}</head>`);
  return `<!doctype html><html><head>${inject}</head><body>${rewritten}</body></html>`;
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Runs inside the previewed page. Nested iframe.src assignments (this prototype's
 * menu) cannot use vscode-resource / custom-protocol navigation, so they ask the
 * host to fetch and then apply srcDoc.
 */
const HTML_PREVIEW_FRAME_BOOTSTRAP = `'use strict';(function(){if(window.__easyviewHtmlFrame)return;window.__easyviewHtmlFrame=true;var pending={};function postToHost(payload){try{parent.postMessage(payload,'*');}catch(e){}try{if(window.top&&window.top!==parent)window.top.postMessage(payload,'*');}catch(e){}}function reportReady(){postToHost({source:'easyview-html',type:'ready',title:document.title||'',text:((document.body&&document.body.innerText)||'').slice(0,4000)});}window.addEventListener('message',function(event){var data=event.data;if(!data||data.source!=='easyview-html')return;if(data.type==='result'){var job=pending[data.id];if(!job)return;delete pending[data.id];if(data.ok)job.resolve(data);else job.reject(new Error(data.message||'load failed'));return;}if(data.type==='click'&&typeof data.text==='string'){var rows=document.querySelectorAll('.menu-row');for(var i=0;i<rows.length;i++){if(((rows[i].innerText)||'').indexOf(data.text)>=0){rows[i].click();break;}}}});function requestHtml(href){var id=Math.random().toString(36).slice(2);return new Promise(function(resolve,reject){pending[id]={resolve:resolve,reject:reject};try{postToHost({source:'easyview-html',type:'fetch',id:id,href:href});}catch(error){delete pending[id];reject(error);return;}setTimeout(function(){if(!pending[id])return;delete pending[id];reject(new Error('timeout'));},20000);});}function shouldProxy(value){try{var abs=new URL(String(value),document.baseURI);var base=new URL(document.baseURI);return abs.protocol===base.protocol&&abs.host===base.host;}catch(e){return false;}}function loadFrame(iframe,value){var abs=new URL(String(value),document.baseURI).href;requestHtml(abs).then(function(result){iframe.srcdoc=result.html;}).catch(function(error){iframe.srcdoc='<!doctype html><p style="font:13px sans-serif;padding:24px;color:#c00">无法加载页面：'+String(error&&error.message||error)+'</p>';});}var srcDesc=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'src');if(srcDesc&&srcDesc.set){Object.defineProperty(HTMLIFrameElement.prototype,'src',{configurable:true,enumerable:true,get:function(){return srcDesc.get?srcDesc.get.call(this):this.getAttribute('src');},set:function(value){if(shouldProxy(value)){this.setAttribute('data-easyview-src',String(value));loadFrame(this,value);return;}srcDesc.set.call(this,value);}});}var setAttr=Element.prototype.setAttribute;Element.prototype.setAttribute=function(name,value){if(this instanceof HTMLIFrameElement&&String(name).toLowerCase()==='src'){this.src=value;return;}return setAttr.call(this,name,value);};if(document.readyState==='complete')reportReady();else window.addEventListener('load',reportReady);})();`;

/**
 * VS Code webview iframe[src=asWebviewUri] is blank. Render the page in a blob
 * document (no inherited CSP), then proxy sibling iframe navigations through
 * the host fetch so nested HTML/JS/CSS stay on the preview origin.
 */
export function HtmlViewer({ descriptor, readText }: HtmlViewerProps): React.ReactElement {
  const [tab, setTab] = React.useState<'preview' | 'source'>('preview');
  const [source, setSource] = React.useState<string | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [frameSrc, setFrameSrc] = React.useState<string | null>(null);
  const useLocalHttp = isLocalHttpPreviewUrl(descriptor.contentUrl);

  React.useEffect(() => {
    if (tab !== 'source' && useLocalHttp) return;
    let disposed = false;
    const load = async (): Promise<string> => {
      if (readText) {
        const result = await readText(descriptor.sessionId);
        return result.content;
      }
      const response = await fetch(descriptor.contentUrl);
      if (!response.ok) throw new Error(`无法读取 HTML（HTTP ${response.status}）`);
      return response.text();
    };
    void load().then((content) => {
      if (!disposed) {
        setSource(content);
        setError(null);
        window.postMessage({
          source: 'easyview-html',
          type: 'ready',
          title: descriptor.fileName,
          text: content.slice(0, 32_000),
        }, '*');
      }
    }).catch((reason) => {
      if (!disposed) setError(reason);
    });
    return () => { disposed = true; };
  }, [tab, useLocalHttp, descriptor.sessionId, descriptor.contentUrl, readText]);

  React.useEffect(() => {
    if (useLocalHttp) {
      setFrameSrc(descriptor.contentUrl);
      return;
    }
    if (source === null) {
      setFrameSrc(null);
      return;
    }
    const markup = htmlDocumentWithBase(source, htmlPreviewBaseHref(descriptor.contentUrl));
    const url = URL.createObjectURL(new Blob([markup], { type: 'text/html; charset=utf-8' }));
    setFrameSrc(url);
    return () => {
      URL.revokeObjectURL(url);
      setFrameSrc((current) => (current === url ? null : current));
    };
  }, [useLocalHttp, source, descriptor.contentUrl]);

  React.useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const data = event.data;
      if (!data || data.source !== HTML_PREVIEW_MESSAGE || data.type !== 'fetch') return;
      if (typeof data.id !== 'string' || typeof data.href !== 'string') return;
      const sourceWindow = event.source;
      if (!sourceWindow || typeof (sourceWindow as Window).postMessage !== 'function') return;
      void (async () => {
        try {
          if (!isHtmlPreviewAssetHref(data.href, descriptor.contentUrl)) {
            throw new Error('预览不允许加载该地址');
          }
          const response = await fetch(data.href);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const html = htmlDocumentWithBase(await response.text(), htmlPreviewBaseHref(data.href));
          (sourceWindow as Window).postMessage({
            source: HTML_PREVIEW_MESSAGE,
            type: 'result',
            id: data.id,
            ok: true,
            html,
          }, '*');
        } catch (reason) {
          (sourceWindow as Window).postMessage({
            source: HTML_PREVIEW_MESSAGE,
            type: 'result',
            id: data.id,
            ok: false,
            message: reason instanceof Error ? reason.message : '页面加载失败',
          }, '*');
        }
      })();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [descriptor.contentUrl]);

  if (error) return h(ViewerError, { error });
  if (frameSrc === null || (tab === 'source' && source === null)) return h(Loading, {});

  return h('section', { className: 'preview-html-viewer' },
    h('div', { className: 'preview-tabs', role: 'tablist' },
      h('button', { type: 'button', className: tab === 'preview' ? 'active' : '', onClick: () => setTab('preview') }, '预览'),
      h('button', { type: 'button', className: tab === 'source' ? 'active' : '', onClick: () => setTab('source') }, '源码'),
    ),
    tab === 'preview'
      ? h('iframe', {
        className: 'preview-html-frame',
        title: descriptor.fileName,
        src: frameSrc,
        sandbox: 'allow-scripts allow-same-origin allow-popups allow-forms allow-downloads',
        referrerPolicy: 'no-referrer',
      })
      : h('pre', { className: 'preview-html-source' }, source),
  );
}
