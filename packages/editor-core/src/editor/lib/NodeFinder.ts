/**
 * ProseMirror node finding utilities
 *
 * Functions for traversing and searching ProseMirror document trees.
 * Copied from Outline's shared/editor/queries/findChildren.ts and findParentNode.ts
 */

import type { Node, ResolvedPos } from "prosemirror-model";
import type { Selection } from "prosemirror-state";

// ─── Types ──────────────────────────────────────────────────────────────────

export type NodeWithPos = {
  pos: number;
  node: Node;
};

type Predicate = (node: Node) => boolean;

type ContentNodeWithPos = {
  pos: number;
  start: number;
  depth: number;
  node: Node;
};

// ─── Child node finders ─────────────────────────────────────────────────────

export function flatten(node: Node, descend = true): NodeWithPos[] {
  if (!node) {
    throw new Error('Invalid "node" parameter');
  }
  const result: NodeWithPos[] = [];
  node.descendants((child, pos) => {
    result.push({ node: child, pos });
    if (!descend) {
      return false;
    }
    return undefined;
  });
  return result;
}

/**
 * Iterates over descendants of a given `node`, returning child nodes predicate
 * returns truthy for. It doesn't descend into a node when descend argument is
 * `false` (defaults to `true`).
 *
 * @param node The node to iterate over
 * @param predicate Filtering predicate function
 * @param descend Whether to descend into a node
 * @returns Child nodes
 */
export function findChildren(
  node: Node,
  predicate: Predicate,
  descend = false
) {
  if (!node) {
    throw new Error('Invalid "node" parameter');
  } else if (!predicate) {
    throw new Error('Invalid "predicate" parameter');
  }
  return flatten(node, descend).filter((child) => predicate(child.node));
}

/**
 * Iterates over descendants of a given `node`, returning child nodes that
 * are blocks.
 *
 * @param node The node to iterate over
 * @param descend Whether to descend into a node
 * @returns Child nodes that are blocks
 */
export function findBlockNodes(node: Node, descend = false): NodeWithPos[] {
  return findChildren(node, (child) => child.isBlock, descend);
}

// ─── Parent node finders ────────────────────────────────────────────────────

export const findParentNode =
  (predicate: Predicate) =>
  ({ $from }: Selection) =>
    findParentNodeClosestToPos($from, predicate);

/**
 * Iterates over parent nodes starting from the given `$pos`, returning the
 * closest node and its start position `predicate` returns truthy for. `start`
 * points to the start position of the node, `pos` points directly before the node.
 *
 * @param $pos position to start from
 * @param predicate filtering predicate function
 * @returns node and its start position
 */
export const findParentNodeClosestToPos = (
  $pos: ResolvedPos,
  predicate: Predicate
): ContentNodeWithPos | undefined => {
  for (let i = $pos.depth; i > 0; i--) {
    const node = $pos.node(i);
    if (predicate(node)) {
      return {
        pos: i > 0 ? $pos.before(i) : 0,
        start: $pos.start(i),
        depth: i,
        node,
      };
    }
  }

  return undefined;
};
