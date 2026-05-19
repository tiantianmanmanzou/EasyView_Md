/**
 * Anchor Plugin
 *
 * Adds invisible anchor elements (<a id="h-slug">) before each heading
 * as ProseMirror decorations. This enables in-document anchor link navigation
 * (e.g., [text](#h-heading-slug)).
 *
 * Adapted from Outline's AnchorPlugin.
 */

import type { Node } from 'prosemirror-model';
import { Plugin } from 'prosemirror-state';
import type { EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import headingToSlug from './HeadingToSlug';

export interface HeadingAnchor {
  pos: number;
  id: string;
  text: string;
  level: number;
}

/**
 * Compute heading anchors with unique IDs for all headings in the document.
 * Exported for reuse in slash menu, # copy button, etc.
 */
export function getHeadingAnchors(doc: Node): HeadingAnchor[] {
  const previouslySeen: Record<string, number> = {};
  const anchors: HeadingAnchor[] = [];

  doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') {
      return;
    }

    const slug = headingToSlug(node);
    let id = slug;

    // Ensure uniqueness for duplicate heading texts
    if (previouslySeen[slug] > 0) {
      id = headingToSlug(node, previouslySeen[slug]);
    }

    previouslySeen[slug] =
      previouslySeen[slug] !== undefined ? previouslySeen[slug] + 1 : 1;

    anchors.push({
      pos,
      id,
      text: node.textContent,
      level: node.attrs.level,
    });
  });

  return anchors;
}

function createAnchorDecoration(anchor: HeadingAnchor): Decoration {
  return Decoration.widget(
    anchor.pos,
    () => {
      const el = document.createElement('a');
      el.id = anchor.id;
      el.className = 'heading-position-anchor';
      return el;
    },
    { side: -1, key: anchor.id }
  );
}

function createDecorations(state: EditorState): DecorationSet {
  const anchors = getHeadingAnchors(state.doc);
  return DecorationSet.create(
    state.doc,
    anchors.map(createAnchorDecoration)
  );
}

export function anchorPlugin(): Plugin {
  return new Plugin({
    state: {
      init(_, state) {
        return { decorations: createDecorations(state) };
      },
      apply(tr, pluginState, _oldState, newState) {
        if (tr.docChanged) {
          return { decorations: createDecorations(newState) };
        }
        return pluginState;
      },
    },
    props: {
      decorations(state) {
        const pluginState = (this as any).getState(state);
        return pluginState ? pluginState.decorations : null;
      },
    },
  });
}
