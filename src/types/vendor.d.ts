/** Local declarations for JavaScript-only dependencies used by the editor. */

declare module 'refractor' {
  export type RefractorSyntax = (refractor: unknown) => void;

  export interface RefractorElementNode {
    type: 'element';
    tagName: string;
    properties: { className?: string[]; [key: string]: unknown };
    children: RefractorNode[];
  }

  export interface RefractorTextNode {
    type: 'text';
    value: string;
  }

  export type RefractorNode = RefractorElementNode | RefractorTextNode;
}

declare module 'refractor/core' {
  import type { RefractorNode, RefractorSyntax } from 'refractor';

  interface Refractor {
    registered(language: string): boolean;
    register(syntax: RefractorSyntax): void;
    highlight(value: string, language: string): RefractorNode[];
  }

  const refractor: Refractor;
  export default refractor;
}

declare module 'refractor/lang/*' {
  import type { RefractorSyntax } from 'refractor';
  const syntax: RefractorSyntax;
  export default syntax;
}

declare module 'markdown-it-footnote' {
  import type MarkdownIt from 'markdown-it';
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module 'markdown-it-deflist' {
  import type MarkdownIt from 'markdown-it';
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module 'bpmn-auto-layout' {
  export function layoutProcess(source: string): Promise<string>;
}

declare module 'jsdom' {
  export class JSDOM {
    readonly window: {
      readonly document: Document;
      readonly DOMParser: typeof DOMParser;
    };
    constructor(html?: string);
  }
}
