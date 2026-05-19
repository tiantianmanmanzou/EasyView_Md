/**
 * FindReplaceExtension
 *
 * Wraps the existing Find & Replace plugin for search and replace
 * functionality with diacritic-insensitive matching.
 */

import type { Plugin } from 'prosemirror-state';
import type { Schema } from 'prosemirror-model';
import { Extension } from '../../../editor/EditorExtension';
import { findAndReplacePlugin } from './FindReplacePlugin';

// ─── FindReplace Extension ───────────────────────────────────────────────────

export class FindReplaceExtension extends Extension {
  get name() {
    return 'findReplace';
  }

  plugins(_schema: Schema): Plugin[] {
    return [
      findAndReplacePlugin(),
    ];
  }
}
