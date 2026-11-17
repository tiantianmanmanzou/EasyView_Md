/**
 * @easyview/docx-react
 *
 * Curated root entry for the documented React editor API. Advanced surfaces
 * stay public through explicit subpaths:
 * - `@easyview/docx-react/ui`
 * - `@easyview/docx-react/dialogs`
 * - `@easyview/docx-react/hooks`
 * - `@easyview/docx-react/plugin-api`
 *
 * Framework-agnostic document utilities live in `@easyview/docx-core`.
 * Agent/MCP surfaces live in `@easyview/docx-agents`.
 *
 * @packageDocumentation
 * @public
 */

export const VERSION = '0.0.2';

// Main editor contract
export {
  DocxEditor,
  type DocxEditorProps,
  type DocxEditorRef,
  type EditorMode,
} from './components/DocxEditor';
export { renderAsync, type RenderAsyncOptions, type DocxEditorHandle } from './renderAsync';

// Document factory helpers — re-exported from `@easyview/docx-core` so
// the common "spawn a blank editor" affordance is available without forcing
// consumers to add `-core` to their dependency tree alongside `-react`.
export {
  createEmptyDocument,
  createDocumentWithText,
  type CreateEmptyDocumentOptions,
} from '@easyview/docx-core';

// i18n contract — runtime only. Locale string types (LocaleStrings,
// Translations, PartialLocaleStrings, TranslationKey) live in
// `@easyview/docx-i18n`; import them from there.
export { LocaleProvider, useTranslation, type LocaleProviderProps } from './i18n';
