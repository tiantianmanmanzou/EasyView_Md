import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')) as {
  activationEvents?: string[];
  contributes: {
    commands?: Array<{ command: string }>;
    configuration?: {
      properties?: Record<string, { type?: string; default?: unknown }>;
    };
    customEditors?: Array<{ viewType: string }>;
    keybindings?: Array<{ command: string; when?: string; key?: string }>;
    menus?: Record<string, Array<{ command: string; when?: string }>>;
    views?: Record<string, Array<{ id: string }>>;
    viewsContainers?: { activitybar?: Array<{ id: string }> };
  };
};

describe('workspace explorer contribution', () => {
  it('registers the Activity Bar container, TreeView, commands, and scoped delete keys', () => {
    expect(manifest.activationEvents).toContain('onStartupFinished');
    expect(manifest.activationEvents).toContain('onView:easyviewMd.workspaceFiles');
    expect(manifest.contributes.viewsContainers?.activitybar).toContainEqual(
      expect.objectContaining({ id: 'easyviewMd-workspacePanel' }),
    );
    expect(manifest.contributes.views?.['easyviewMd-workspacePanel']).toContainEqual(
      expect.objectContaining({ id: 'easyviewMd.workspaceFiles' }),
    );
    expect(manifest.contributes.configuration?.properties?.['easyviewMd.workspace.focusFilesOnStartup']).toEqual(
      expect.objectContaining({ type: 'boolean', default: true }),
    );

    const commandIds = new Set(manifest.contributes.commands?.map(({ command }) => command));
    for (const command of [
      'easyviewMd.workspace.openPreview',
      'easyviewMd.workspace.openExternal',
      'easyviewMd.workspace.newFile',
      'easyviewMd.workspace.newFolder',
      'easyviewMd.workspace.refresh',
      'easyviewMd.workspace.copyResourceUri',
      'easyviewMd.workspace.paste',
      'easyviewMd.workspace.copyPath',
      'easyviewMd.workspace.copyRelativePath',
      'easyviewMd.workspace.rename',
      'easyviewMd.workspace.delete',
    ]) {
      expect(commandIds.has(command)).toBe(true);
    }
    expect(commandIds.has('easyviewMd.workspace.openWith')).toBe(false);

    const titleMenus = manifest.contributes.menus?.['view/title'] ?? [];
    expect(titleMenus.map(({ command }) => command)).toEqual([
      'easyviewMd.workspace.newFile',
      'easyviewMd.workspace.newFolder',
      'easyviewMd.workspace.refresh',
    ]);
    expect(titleMenus.every(({ when }) => when?.includes('view == easyviewMd.workspaceFiles'))).toBe(true);

    const deleteBindings = manifest.contributes.keybindings?.filter(
      ({ command }) => command === 'easyviewMd.workspace.delete',
    ) ?? [];
    expect(deleteBindings).toHaveLength(3);
    expect(deleteBindings.every(({ when }) => when?.includes('focusedView == easyviewMd.workspaceFiles'))).toBe(true);
    expect(deleteBindings.every(({ when }) => when?.includes('easyviewMd.workspaceFiles.entrySelected'))).toBe(true);

    const renameBindings = manifest.contributes.keybindings?.filter(
      ({ command }) => command === 'easyviewMd.workspace.rename',
    ) ?? [];
    expect(renameBindings.map(({ key }) => key).sort()).toEqual(['enter', 'f2']);
    expect(renameBindings.every(({ when }) => when?.includes('focusedView == easyviewMd.workspaceFiles'))).toBe(true);
    expect(renameBindings.every(({ when }) => when?.includes('easyviewMd.workspaceFiles.entrySelected'))).toBe(true);
    expect(renameBindings.every(({ when }) => when?.includes('!inputFocus'))).toBe(true);
  });

  it('contributes file and folder actions only to the custom view and no custom editor-tab context menu', () => {
    const fileMenus = manifest.contributes.menus?.['view/item/context'] ?? [];
    expect(fileMenus.length).toBeGreaterThan(0);
    expect(fileMenus.every(({ when }) => when?.includes('view == easyviewMd.workspaceFiles'))).toBe(true);
    const folderMenus = fileMenus.filter(({ when }) => when?.includes('easyviewMd.workspaceDirectory'));
    expect(folderMenus.length).toBeGreaterThan(0);
    expect(folderMenus.some(({ command }) => command === 'easyviewMd.workspace.rename')).toBe(true);
    expect(folderMenus.some(({ command }) => command === 'easyviewMd.workspace.delete')).toBe(true);
    expect(folderMenus.some(({ command }) => command === 'easyviewMd.workspace.paste')).toBe(true);
    expect(folderMenus.every(({ command }) => command !== 'easyviewMd.workspace.openPreview')).toBe(true);
    expect(folderMenus.every(({ command }) => command !== 'easyviewMd.workspace.openWith')).toBe(true);
    expect(fileMenus.every(({ command }) => command !== 'easyviewMd.workspace.openWith')).toBe(true);
    expect(manifest.contributes.customEditors?.some(({ viewType }) => viewType === 'easyviewMd.filePreview')).toBe(true);
    expect(manifest.contributes.menus?.['editor/title/context']).toBeUndefined();
  });

  it('retains multiple editor support for the EasyView custom editor', () => {
    const providerSource = fs.readFileSync(
      path.join(extensionRoot, 'src/adapters/vscode/provider.ts'),
      'utf8',
    );
    expect(providerSource).toContain('supportsMultipleEditorsPerDocument: true');
  });
});
