/**
 * Prompt assembly for the AI chat feature. Shared by both hosts so the
 * conversation behaves identically in VS Code and the desktop app.
 */

import type { AiChatAttachment, AiChatHistoryEntry } from '@easyview/contracts';
import type { OpenAiChatMessage, OpenAiChatContentPart } from './openai-chat-client';

export interface BuildAiChatMessagesOptions {
  systemPrompt: string;
  mode: 'chat' | 'agent';
  history: AiChatHistoryEntry[];
  userMessage: string;
  attachments: AiChatAttachment[];
  documentContent?: string;
  documentFileName?: string;
}

const AGENT_SYSTEM_INSTRUCTION = `You are editing Markdown and text files inside an editor.
For every modification to an existing file, first call inspect_file to establish the current content, Git working-tree state, and the exact section boundary. Then call apply_patch with one or more small, non-overlapping, semantic patches. Each expectedText must be an exact unique anchor from the inspected content. Never output or rewrite a complete document for a local change.
For a new file, use create_file. Use list_files before assuming a path. Do not claim that a file was changed unless the corresponding tool completed. After tool completion, reply with a concise summary only.`;

const CHAT_SYSTEM_INSTRUCTION = `You are a helpful assistant inside a Markdown editor. Reply in the same language the user writes in.`;

function buildUserContent(
  userMessage: string,
  attachments: AiChatAttachment[],
): string | OpenAiChatContentPart[] {
  if (attachments.length === 0) return userMessage;
  const parts: OpenAiChatContentPart[] = [];
  if (userMessage.length > 0) parts.push({ type: 'text', text: userMessage });
  for (const attachment of attachments) {
    parts.push({ type: 'image_url', image_url: { url: attachment.url } });
  }
  return parts;
}

/** Assembles the OpenAI-compatible message array for one chat turn. */
export function buildAiChatMessages(options: BuildAiChatMessagesOptions): OpenAiChatMessage[] {
  const { systemPrompt, mode, history, userMessage, attachments, documentContent, documentFileName } =
    options;

  const messages: OpenAiChatMessage[] = [];
  const systemParts: string[] = [];
  if (mode === 'agent') {
    systemParts.push(AGENT_SYSTEM_INSTRUCTION);
  } else {
    systemParts.push(CHAT_SYSTEM_INSTRUCTION);
  }
  if (systemPrompt.trim().length > 0) {
    systemParts.push(systemPrompt.trim());
  }
  if (mode === 'agent' && documentContent !== undefined) {
    const label = documentFileName ? `当前打开文档: ${documentFileName}` : '当前打开文档';
    systemParts.push(`${label}。修改它前必须调用不带 path 的 inspect_file 建立编辑基线。`);
  }
  messages.push({ role: 'system', content: systemParts.join('\n\n') });

  for (const entry of history) {
    messages.push({ role: entry.role, content: entry.content });
  }

  messages.push({ role: 'user', content: buildUserContent(userMessage, attachments) });
  return messages;
}
