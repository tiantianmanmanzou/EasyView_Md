/**
 * findCollapsedNodes — finds all blocks that should be hidden under collapsed headings
 *
 * Ported from Outline's findCollapsedNodes query
 */

import type { Node as ProsemirrorNode } from 'prosemirror-model';

export interface NodeWithPos {
  node: ProsemirrorNode;
  pos: number;
}

/** Find all block nodes in document */
function findBlockNodes(doc: ProsemirrorNode): NodeWithPos[] {
  const nodes: NodeWithPos[] = [];
  doc.descendants((node, pos) => {
    if (node.isBlock && node.type.name !== 'doc') {
      nodes.push({ node, pos });
    }
  });
  return nodes;
}

/**
 * Find all nodes that should be collapsed (hidden)
 *
 * When a heading has collapsed=true, all blocks after it until the next
 * heading of same or higher level should be hidden.
 */
export function findCollapsedNodes(doc: ProsemirrorNode): NodeWithPos[] {
  const blocks = findBlockNodes(doc);
  const nodes: NodeWithPos[] = [];

  const collapsedStack: number[] = [];
  for (const block of blocks) {
    if (collapsedStack.length) {
      const top = collapsedStack[collapsedStack.length - 1];
      // if the block encountered same or higher level heading, pop the stack
      if (block.node.type.name === 'heading' && block.node.attrs.level <= top) {
        collapsedStack.pop();

        // if the block is a heading and it is collapsed, push it to the stack
        if (block.node.attrs.collapsed) {
          collapsedStack.push(block.node.attrs.level);
        }
      } else {
        // the deepest level or non-heading block should be added to the nodes
        nodes.push(block);
      }
    } else {
      if (block.node.type.name === 'heading' && block.node.attrs.collapsed) {
        collapsedStack.push(block.node.attrs.level);
      }
    }
  }

  return nodes;
}
