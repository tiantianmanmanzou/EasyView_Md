import type { Plugin } from 'prosemirror-state';
import type { Schema } from 'prosemirror-model';
import { Extension } from '../../../editor/EditorExtension';
import PlantUmlPlugin from './PlantUmlPlugin';

export class PlantUmlExtension extends Extension {
  get name() {
    return 'plantuml';
  }

  plugins(_schema: Schema): Plugin[] {
    return [PlantUmlPlugin()];
  }
}
