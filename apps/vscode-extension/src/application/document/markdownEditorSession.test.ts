import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sessionSource = fs.readFileSync(path.resolve(__dirname, 'markdownEditorSession.ts'), 'utf8');
const adapterSource = fs.readFileSync(path.resolve(__dirname, 'vscodeCanonicalDocumentAdapter.ts'), 'utf8');
const providerSource = fs.readFileSync(path.resolve(__dirname, '../../adapters/vscode/provider.ts'), 'utf8');
const handlerSource = fs.readFileSync(path.resolve(__dirname, 'editorMessageHandler.ts'), 'utf8');
const entrySource = fs.readFileSync(path.resolve(__dirname, '../../adapters/vscode/vscodeEntry.ts'), 'utf8');

describe('VS Code markdown sync host boundary', () => {
  it('uses one session with canonical patches and deterministic lifecycle cleanup', () => {
    expect(providerSource).toContain('retainContextWhenHidden: false');
    expect(providerSource).toContain('supportsMultipleEditorsPerDocument: false');
    expect(providerSource).toContain('MarkdownEditorSession');
    expect(providerSource).not.toContain('setInterval(');
    expect(providerSource).not.toContain('lastKnownContent');
    expect(sessionSource).toContain('DocumentSyncSession');
    expect(sessionSource).toContain('applyPatches');
    expect(sessionSource).toContain('setTimeout');
    expect(sessionSource).toContain('this.sync.dispose()');
    expect(adapterSource).toContain('canonicalToRawRange');
    expect(adapterSource).toContain('expectedRawContent');
  });

  it('uses snapshot/patch protocol and keeps HTML free of document content', () => {
    expect(handlerSource).toContain("ctx.postSnapshot('initial')");
    expect(handlerSource).not.toContain("case 'edit'");
    expect(handlerSource).not.toContain("type: 'init'");
    expect(handlerSource).not.toContain("type: 'documentChanged'");
    expect(entrySource).not.toContain('__INITIAL_DATA__');
    expect(entrySource).toContain('getState');
    expect(entrySource).toContain('setState');
  });
});
