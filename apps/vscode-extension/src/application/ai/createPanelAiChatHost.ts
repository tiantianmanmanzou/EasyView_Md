import * as vscode from 'vscode';
import * as path from 'node:path';
import { AiChatHost } from '@easyview/node-runtime';
import type { HostToEditorMessage } from '@easyview/contracts';

const AI_CHAT_API_KEY_SECRET = 'easyview.aiChat.apiKey';

function mimeTypeForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.bmp':
      return 'image/bmp';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

export function createPanelAiChatHost(
  context: vscode.ExtensionContext,
  postMessage: (message: HostToEditorMessage) => void,
): AiChatHost {
  const settingsFilePath = path.join(context.globalStorageUri.fsPath, 'ai-chat-settings.json');
  return new AiChatHost({
    settingsFilePath,
    secretStore: {
      getApiKey: async () => (await context.secrets.get(AI_CHAT_API_KEY_SECRET)) ?? null,
      setApiKey: async (apiKey) => {
        await context.secrets.store(AI_CHAT_API_KEY_SECRET, apiKey);
      },
    },
    postMessage,
    pickImages: {
      pickImages: async () => {
        const selected = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: true,
          filters: {
            Images: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'],
          },
        });
        if (!selected?.length) return [];
        const images: Array<{ name: string; dataUrl: string }> = [];
        for (const uri of selected) {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const mimeType = mimeTypeForPath(uri.fsPath);
          const base64 = Buffer.from(bytes).toString('base64');
          images.push({
            name: path.basename(uri.fsPath),
            dataUrl: `data:${mimeType};base64,${base64}`,
          });
        }
        return images;
      },
    },
  });
}
