/**
 * InLineMd ProseMirror Schema
 *
 * Defines all node and mark types for the Markdown WYSIWYG editor.
 * Inspired by Outline's editor architecture but adapted for VS Code webview.
 */

import { Schema } from 'prosemirror-model';
import { blockNodes } from './blockNodes';
import { listNodes } from './listNodes';
import { tableNodes } from './tableNodes';
import { inlineNodes } from './inlineNodes';
import { marks } from './marks';

// ─── Schema ────────────────────────────────────────────────────────────────

export const nodes = {
  ...blockNodes,
  ...listNodes,
  ...tableNodes,
  ...inlineNodes,
};

export { marks };

export const schema = new Schema({ nodes, marks });
