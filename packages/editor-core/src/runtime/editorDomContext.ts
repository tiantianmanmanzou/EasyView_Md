export type EasyViewEditorRoot = Document | HTMLElement;

export interface EditorDomContext {
  readonly root: EasyViewEditorRoot;
  readonly document: Document;
  readonly window: Window;
  readonly eventTarget: EventTarget;
  readonly overlayRoot: HTMLElement;
  readonly themeRoot: HTMLElement;
  getById<T extends HTMLElement = HTMLElement>(id: string): T | null;
  query<T extends Element = Element>(selector: string): T | null;
  queryAll<T extends Element = Element>(selector: string): T[];
  contains(target: Node | null): boolean;
}

function isDocument(root: EasyViewEditorRoot): root is Document {
  return root.nodeType === Node.DOCUMENT_NODE;
}

/**
 * Resolves all DOM ownership for one editor instance. An HTMLElement root lets
 * multiple editors use the same legacy ids without leaking lookups or custom
 * events into sibling editor groups. Passing a Document preserves the existing
 * single-page webview behaviour.
 */
export function createEditorDomContext(root: EasyViewEditorRoot = document): EditorDomContext {
  const ownerDocument = isDocument(root) ? root : root.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) {
    throw new Error('EasyView editor root must belong to a live document');
  }

  const query = <T extends Element = Element>(selector: string): T | null =>
    root.querySelector<T>(selector);

  return {
    root,
    document: ownerDocument,
    window: ownerWindow,
    eventTarget: isDocument(root) ? ownerWindow : root,
    overlayRoot: isDocument(root) ? ownerDocument.body : root,
    themeRoot: isDocument(root) ? ownerDocument.body : root,
    getById: <T extends HTMLElement = HTMLElement>(id: string): T | null =>
      Array.from(root.querySelectorAll<HTMLElement>('[id]')).find((element) => element.id === id) as T | undefined ?? null,
    query,
    queryAll: <T extends Element = Element>(selector: string): T[] =>
      Array.from(root.querySelectorAll<T>(selector)),
    contains: (target: Node | null): boolean => {
      if (!target) return false;
      return isDocument(root) ? target.ownerDocument === ownerDocument : root.contains(target);
    },
  };
}
