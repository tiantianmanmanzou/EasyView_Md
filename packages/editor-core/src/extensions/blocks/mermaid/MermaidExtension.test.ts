/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';
import type { Plugin } from 'prosemirror-state';

import { schema } from '../../../editor/EditorSchema';
import { MermaidExtension } from './MermaidExtension';

type MermaidMouseupHandler = NonNullable<
  NonNullable<Plugin['props']['handleDOMEvents']>['mouseup']
>;

function getMermaidMouseupHandler(extension: MermaidExtension): {
  plugin: Plugin;
  handler: MermaidMouseupHandler;
} {
  const plugin = extension.plugins(schema)[0];
  const handler = plugin.props.handleDOMEvents?.mouseup;
  if (!handler) {
    throw new Error('Mermaid plugin mouseup handler is not registered');
  }
  return { plugin, handler };
}

describe('MermaidExtension host integration', () => {
  it('passes the explicit external-link callback to the Mermaid plugin', () => {
    const openExternalLink = vi.fn();
    const { plugin, handler } = getMermaidMouseupHandler(
      new MermaidExtension(false, openExternalLink),
    );

    const host = document.createElement('div');
    const codeBlock = document.createElement('pre');
    const diagram = document.createElement('div');
    diagram.className = 'mermaid-diagram-wrapper';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const anchor = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'a',
    );
    anchor.setAttribute('xlink:href', 'https://example.com/docs');
    svg.appendChild(anchor);
    diagram.appendChild(svg);
    host.append(codeBlock, diagram);
    document.body.appendChild(host);

    const event = new MouseEvent('mouseup', { bubbles: true });
    Object.defineProperty(event, 'target', { value: anchor });

    const globalRecord = globalThis as Record<string, unknown>;
    const previousSvgaElement = globalRecord.SVGAElement;
    if (!previousSvgaElement) {
      globalRecord.SVGAElement = SVGElement;
    }

    try {
      handler.call(plugin, {} as never, event);
    } finally {
      if (previousSvgaElement) {
        globalRecord.SVGAElement = previousSvgaElement;
      } else {
        delete globalRecord.SVGAElement;
      }
    }

    expect(openExternalLink).toHaveBeenCalledOnce();
    expect(openExternalLink).toHaveBeenCalledWith('https://example.com/docs');
  });
});
