/**
 * ImageExtension
 *
 * Handles image nodes with NodeView wrapper.
 * Wraps existing ImageView class.
 */

import type { NodeViewConstructor, EditorView } from 'prosemirror-view';
import type { NodeSpec, Schema } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import { ImageView } from './ImageView';
import {
  Extension,
  type SerializerNodeHandler,
} from '../../../editor/EditorExtension';

// ─── Image Drop Plugin ───────────────────────────────────────────────────────

const IMAGE_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/svg+xml',
  'image/webp', 'image/bmp', 'image/x-icon',
]);

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i;

/**
 * Plugin that handles drag & drop of image files from the file system.
 * Extracts file paths and dispatches a custom event for the host to resolve.
 */
function imageDropPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey('imageDrop'),
    props: {
      handleDOMEvents: {
        drop(view: EditorView, event: DragEvent) {
          const files = event.dataTransfer?.files;
          if (!files?.length) return false;

          // Filter for image files
          const imageFiles: File[] = [];
          for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (IMAGE_MIME_TYPES.has(file.type) || IMAGE_EXTENSIONS.test(file.name)) {
              imageFiles.push(file);
            }
          }

          if (imageFiles.length === 0) return false;

          event.preventDefault();
          event.stopPropagation();

          // Get drop position in the document
          const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
          const pos = coords?.pos ?? view.state.selection.from;

          // Extract file paths (available in Electron via File.path)
          const paths: string[] = [];
          for (const file of imageFiles) {
            const filePath = (file as any).path;
            if (filePath && typeof filePath === 'string') {
              paths.push(filePath);
            }
          }

          if (paths.length > 0) {
            window.dispatchEvent(new CustomEvent('inlinemd:dropImages', {
              detail: { paths, pos },
            }));
          }

          return true;
        },
      },
    },
  });
}

function formatUrl(url: string): string {
  if (!url) return '';
  if (/[\s()]/.test(url)) return `<${url}>`;
  return url;
}

export class ImageExtension extends Extension {
  get name() {
    return 'image';
  }

  get nodes(): Record<string, NodeSpec> {
    return {
      image: {
        attrs: {
          src: { default: '', validate: 'string' },
          originalSrc: { default: null },
          alt: { default: null },
          title: { default: null },
          width: { default: null },
          height: { default: null },
        },
        inline: true,
        group: 'inline',
        atom: true,
        draggable: true,
        parseDOM: [
          {
            tag: 'img[src]',
            getAttrs(dom: HTMLImageElement) {
              return {
                src: dom.getAttribute('src'),
                originalSrc: dom.getAttribute('data-original-src'),
                alt: dom.getAttribute('alt'),
                title: dom.getAttribute('title'),
                width: dom.getAttribute('width') ? parseInt(dom.getAttribute('width')!, 10) : null,
                height: dom.getAttribute('height') ? parseInt(dom.getAttribute('height')!, 10) : null,
              };
            },
          },
        ],
        toDOM(node) {
          return ['img', {
            src: node.attrs.src,
            ...(node.attrs.originalSrc ? { 'data-original-src': node.attrs.originalSrc } : {}),
            alt: node.attrs.alt,
            title: node.attrs.title,
            ...(node.attrs.width ? { width: node.attrs.width } : {}),
            ...(node.attrs.height ? { height: node.attrs.height } : {}),
          }];
        },
      },
    };
  }

  plugins(_schema: Schema): Plugin[] {
    return [imageDropPlugin()];
  }

  get nodeViews(): Record<string, NodeViewConstructor> {
    return {
      image: (node, view, getPos) => new ImageView(node, view, getPos),
    };
  }

  get serializerNodes(): Record<string, SerializerNodeHandler> {
    return {
      image(state, node) {
        const alt = state.esc(node.attrs.alt || '');
        const src = node.attrs.originalSrc || node.attrs.src || '';
        const title = node.attrs.title
          ? ` "${state.esc(node.attrs.title)}"`
          : '';
        state.write(`![${alt}](${formatUrl(src)}${title})`);
      },
    };
  }
}
