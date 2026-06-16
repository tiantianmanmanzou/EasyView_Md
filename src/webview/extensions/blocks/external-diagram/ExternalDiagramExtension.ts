import type { Plugin } from 'prosemirror-state';
import type { Schema } from 'prosemirror-model';
import { Extension } from '../../../editor/EditorExtension';
import ExternalDiagramPlugin from './ExternalDiagramPlugin';

export class ExternalDiagramExtension extends Extension {
  get name() {
    return 'externalDiagram';
  }

  plugins(_schema: Schema): Plugin[] {
    return [ExternalDiagramPlugin()];
  }
}
