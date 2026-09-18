/** Capabilities exposed by a concrete editor host. */
export interface EditorHostCapabilities {
  sourceMode: 'embedded' | 'native';
  git: boolean;
  terminal: boolean;
  aiCommitMessage: boolean;
  aiChat: boolean;
  documentConversion: boolean;
  shortcutPersistence: boolean;
}
