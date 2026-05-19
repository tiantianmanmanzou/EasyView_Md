/**
 * SlashMenuExtension
 *
 * Wraps the slash command menu plugin (core/SlashMenu.ts).
 * The slash menu shows when the user types "/" at the start of an empty paragraph.
 */

import type { Schema } from 'prosemirror-model';
import type { Plugin } from 'prosemirror-state';
import { Extension } from '../../../editor/EditorExtension';
import { slashMenuPlugin } from './SlashMenu';

export class SlashMenuExtension extends Extension {
  get name() {
    return 'slashMenu';
  }

  plugins(_schema: Schema): Plugin[] {
    return [slashMenuPlugin()];
  }
}
