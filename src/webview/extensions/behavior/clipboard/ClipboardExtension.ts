/**
 * ClipboardExtension
 *
 * Serializes clipboard content as markdown when copying.
 * Handles special cases for code blocks and table cells.
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import { Slice, type Schema } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { Extension } from '../../../editor/EditorExtension';
import { serializer } from '../../../editor/lib/MarkdownSerializer';

type ImageDataUrlResolver = (originalSrc: string) => Promise<string | null>;

let copySequence = 0;
let hasCopySequenceTracker = false;

function installCopySequenceTracker(): void {
  if (hasCopySequenceTracker) return;
  hasCopySequenceTracker = true;
  // Capture every copy before ProseMirror handles it. A later text copy must
  // invalidate any in-flight image conversion from an earlier image copy.
  document.addEventListener('copy', () => { copySequence++; }, true);
}

function selectionContainsImage(view: EditorView): boolean {
  let containsImage = false;
  view.state.selection.content().content.descendants((node) => {
    if (node.type.name === 'image') {
      containsImage = true;
      return false;
    }
    return !containsImage;
  });
  return containsImage;
}

function getImageDataUrlResolver(): ImageDataUrlResolver | undefined {
  return (window as Window & {
    __easyviewGetImageDataUrl?: ImageDataUrlResolver;
  }).__easyviewGetImageDataUrl;
}

async function inlineClipboardImages(html: string, sequence: number): Promise<string> {
  const container = document.createElement('div');
  container.innerHTML = html;
  const resolveImageDataUrl = getImageDataUrlResolver();

  await Promise.all([...container.querySelectorAll('img')].map(async (image) => {
    const originalSrc = image.getAttribute('data-original-src') || image.getAttribute('src') || '';
    if (!originalSrc || originalSrc.startsWith('data:image/')) {
      image.removeAttribute('data-original-src');
      return;
    }

    const dataUrl = await resolveImageDataUrl?.(originalSrc);
    if (sequence !== copySequence) {
      throw new Error('Copy was superseded by a newer selection.');
    }
    if (dataUrl) image.setAttribute('src', dataUrl);
    image.removeAttribute('data-original-src');
  }));

  if (sequence !== copySequence) {
    throw new Error('Copy was superseded by a newer selection.');
  }
  container.querySelectorAll('[data-pm-slice]').forEach((element) => {
    element.removeAttribute('data-pm-slice');
  });
  return container.innerHTML;
}

function copySelectedImages(view: EditorView, event: ClipboardEvent, sequence: number): boolean {
  const selection = view.state.selection.content();
  const { dom, text } = view.serializeForClipboard(new Slice(selection.content, selection.openStart, selection.openEnd));
  const html = dom.innerHTML;

  event.preventDefault();
  if (event.clipboardData) {
    event.clipboardData.clearData();
    event.clipboardData.setData('text/html', html);
    event.clipboardData.setData('text/plain', text);
  }

  if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    const htmlBlob = inlineClipboardImages(html, sequence)
      .then((value) => new Blob([value], { type: 'text/html' }));
    const textBlob = new Blob([text], { type: 'text/plain' });
    void navigator.clipboard.write([
      new ClipboardItem({
        'text/html': htmlBlob,
        'text/plain': textBlob,
      }),
    ]).catch(() => {
      // The synchronous clipboard payload is retained when rich writing fails.
    });
  }

  return true;
}

export class ClipboardExtension extends Extension {
  get name() {
    return 'clipboard';
  }

  plugins(schema: Schema): Plugin[] {
    installCopySequenceTracker();
    return [
      new Plugin({
        key: new PluginKey('clipboardTextSerializer'),
        props: {
          handleDOMEvents: {
            copy(view, event) {
              if (!selectionContainsImage(view)) return false;
              return copySelectedImages(view, event as ClipboardEvent, copySequence);
            },
          },
          clipboardTextSerializer(slice) {
            if (slice.content.childCount === 1) {
              const firstChild = slice.content.firstChild;

              // Handle code_block: return raw text
              if (firstChild?.type.name === 'code_block') {
                return firstChild.textContent;
              }

              // Handle single-cell table: extract cell content
              if (firstChild?.type.name === 'table') {
                const table = firstChild;
                if (table.childCount === 1) {
                  const row = table.firstChild;
                  if (row && row.childCount === 1) {
                    const cell = row.firstChild;
                    if (
                      cell &&
                      (cell.type.name === 'table_cell' ||
                        cell.type.name === 'table_header')
                    ) {
                      const cellDoc = schema.nodes.doc.create(
                        null,
                        cell.content
                      );
                      return serializer.serialize(cellDoc);
                    }
                  }
                }
              }
            }

            // Default: serialize entire slice as markdown
            const doc = schema.nodes.doc.create(null, slice.content);
            return serializer.serialize(doc);
          },
        },
      }),
    ];
  }
}
