/**
 * EditorImageManager — manages image path resolution and image insertion.
 *
 * Extracted from EditorCore. Handles the mapping between original file paths
 * and webview-safe URIs, plus document-level image path conversion.
 */

import { Fragment, type Node as ProsemirrorNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';

import { schema } from './EditorSchema';

export class EditorImageManager {
  private _imagePathMap: Record<string, string> = {};

  get imagePathMap(): Record<string, string> {
    return this._imagePathMap;
  }

  setImagePathMap(map: Record<string, string>): void {
    this._imagePathMap = map;
  }

  addImagePath(original: string, webview: string): void {
    this._imagePathMap[original] = webview;
  }

  insertImage(view: EditorView, src: string, originalSrc?: string, pos?: number): void {
    const effective = originalSrc || src;
    const imgNode = schema.nodes.image.create({
      src,
      originalSrc: effective,
      alt: '',
    });

    if (typeof pos === 'number' && pos >= 0) {
      const node = view.state.doc.nodeAt(pos);
      if (node?.type.name === 'image') {
        const tr = view.state.tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          src,
          originalSrc: effective,
        });
        view.dispatch(tr.scrollIntoView());
      } else {
        const maxPos = view.state.doc.content.size;
        const insertPos = Math.min(Math.max(0, pos), maxPos);
        const $pos = view.state.doc.resolve(insertPos);
        let tr = view.state.tr;

        if ($pos.parent.isTextblock) {
          tr = tr.insert(insertPos, imgNode);
        } else {
          tr = tr.insert(insertPos, schema.nodes.paragraph.create(null, imgNode));
        }

        view.dispatch(tr.scrollIntoView());
      }
    } else {
      view.dispatch(view.state.tr.replaceSelectionWith(imgNode).scrollIntoView());
    }

    if (originalSrc && src !== originalSrc) {
      this._imagePathMap[originalSrc] = src;
    }
  }

  /**
   * Insert one or more images at a specific document position (e.g. from drag & drop).
   */
  insertImagesAtPos(view: EditorView, images: Array<{ src: string; originalSrc: string }>, pos: number): void {
    const nodes = images.map(({ src, originalSrc }) => {
      if (src !== originalSrc) {
        this._imagePathMap[originalSrc] = src;
      }
      return schema.nodes.image.create({ src, originalSrc, alt: '' });
    });

    if (nodes.length === 0) return;

    // Clamp position to valid range
    const maxPos = view.state.doc.content.size;
    const insertPos = Math.min(Math.max(0, pos), maxPos);

    // Wrap images in a paragraph if we're inserting at block level
    const $pos = view.state.doc.resolve(insertPos);
    let tr = view.state.tr;

    if ($pos.parent.isTextblock) {
      // Inside a text block -- insert inline images at position
      const fragment = Fragment.from(nodes);
      tr = tr.insert(insertPos, fragment);
    } else {
      // At block level -- wrap each image in a paragraph
      const paragraphs = nodes.map(n =>
        schema.nodes.paragraph.create(null, n),
      );
      tr = tr.insert(insertPos, paragraphs);
    }

    view.dispatch(tr.scrollIntoView());
  }

  convertImagePaths(doc: ProsemirrorNode): ProsemirrorNode {
    const nodes: ProsemirrorNode[] = [];
    doc.content.forEach((node) => {
      nodes.push(this.convertImageNode(node));
    });
    return doc.type.create(doc.attrs, nodes, doc.marks);
  }

  convertImageNode(node: ProsemirrorNode): ProsemirrorNode {
    if (node.type.name === 'image') {
      const src = node.attrs.src;
      let decoded = src;
      try {
        decoded = decodeURIComponent(src);
      } catch { /* malformed URI -- use original src as-is */ }
      const webview = this._imagePathMap[src] || this._imagePathMap[decoded];
      if (webview) {
        return node.type.create(
          { ...node.attrs, originalSrc: decoded, src: webview },
          node.content,
          node.marks
        );
      }
    }

    if (node.content && node.content.size > 0) {
      const children: ProsemirrorNode[] = [];
      node.content.forEach((child) => {
        children.push(this.convertImageNode(child));
      });
      return node.type.create(node.attrs, children, node.marks);
    }

    return node;
  }
}
