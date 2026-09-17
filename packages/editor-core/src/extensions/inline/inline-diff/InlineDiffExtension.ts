/**
 * InlineDiffExtension — GitLab inline diff marks: {+ added +} / {- removed -}
 *
 * Renders additions in green (ins) and deletions in red (del).
 * Also supports bracket syntax: [+ added +] / [- removed -]
 *
 * Schema marks are defined in EditorSchema.ts.
 * Parsing rules are in MarkdownParser.ts.
 * Serialization is in MarkdownSerializer.ts.
 */

import { Extension } from '../../../editor/EditorExtension';

export class InlineDiffExtension extends Extension {
  get name() {
    return 'inline-diff';
  }
}
