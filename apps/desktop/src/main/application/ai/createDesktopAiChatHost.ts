import { app, dialog, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AiChatHost } from '@easyview/node-runtime';
import {
  getAiChatHost as currentAiChatHost,
  getMainWindow,
  sendEditorMessage,
  setAiChatHost,
  workspaceCore,
} from '../host/desktopRuntime';

export function createDesktopAiChatHost(): AiChatHost {
  const userDataPath = app.getPath('userData');
  const settingsFilePath = path.join(userDataPath, 'ai-chat-settings.json');
  const apiKeyPath = path.join(userDataPath, 'ai-chat-api-key.bin');
  const webSearchApiKeyPath = path.join(userDataPath, 'ai-chat-web-search-api-key.bin');
  return new AiChatHost({
    settingsFilePath,
    secretStore: {
      async getApiKey() {
        if (!safeStorage.isEncryptionAvailable()) return null;
        try {
          const encrypted = await fs.readFile(apiKeyPath);
          return safeStorage.decryptString(encrypted);
        } catch {
          return null;
        }
      },
      async setApiKey(apiKey) {
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('当前系统不支持安全存储 API Key');
        }
        const encrypted = safeStorage.encryptString(apiKey);
        await fs.writeFile(apiKeyPath, encrypted);
      },
      async getWebSearchApiKey() {
        if (!safeStorage.isEncryptionAvailable()) return null;
        try {
          return safeStorage.decryptString(await fs.readFile(webSearchApiKeyPath));
        } catch {
          return null;
        }
      },
      async setWebSearchApiKey(apiKey) {
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('当前系统不支持安全存储 Web Search API Key');
        }
        await fs.writeFile(webSearchApiKeyPath, safeStorage.encryptString(apiKey));
      },
    },
    postMessage: sendEditorMessage,
    getToolContext: () => ({ workspaceRootPath: workspaceCore.getRootPath() }),
    pickImages: {
      pickImages: async () => {
        const chosen = await dialog.showOpenDialog(getMainWindow()!, {
          properties: ['openFile', 'multiSelections'],
          filters: [
            {
              name: 'Images',
              extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'],
            },
          ],
        });
        if (chosen.canceled) return [];
        const images: Array<{ name: string; dataUrl: string }> = [];
        for (const filePath of chosen.filePaths) {
          const bytes = await fs.readFile(filePath);
          const extension = path.extname(filePath).toLowerCase();
          const mimeType =
            extension === '.png' ? 'image/png'
              : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg'
                : extension === '.gif' ? 'image/gif'
                  : extension === '.webp' ? 'image/webp'
                    : extension === '.bmp' ? 'image/bmp'
                      : extension === '.svg' ? 'image/svg+xml'
                        : 'application/octet-stream';
          images.push({
            name: path.basename(filePath),
            dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
          });
        }
        return images;
      },
    },
  });
}

export function getAiChatHost(): AiChatHost {
  const existing = currentAiChatHost();
  if (!existing) {
    const host = createDesktopAiChatHost();
    setAiChatHost(host);
    return host;
  }
  return currentAiChatHost()!;
}
