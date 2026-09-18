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

const AGENT_SYSTEM_INSTRUCTION = `You are editing a Markdown document inside an editor.
When the user asks for a modification to the document, output the COMPLETE updated document inside a single fenced code block tagged \`markdown\`, with no text before or after the block. If the document itself contains triple-backtick fenced blocks, use four backticks for the outer fence. Preserve all content the user did not ask to change.
When no modification is requested, reply normally without any fenced document block.`;

const CHAT_SYSTEM_INSTRUCTION = `You are a helpful assistant inside a Markdown editor. Reply in the same language the user writes in.`;

/** Documents larger than this are truncated before being sent as context. */
export const MAX_DOCUMENT_CONTEXT_CHARS = 150_000;

function truncateDocument(content: string): string {
  if (content.length <= MAX_DOCUMENT_CONTEXT_CHARS) return content;
  const truncated = content.slice(0, MAX_DOCUMENT_CONTEXT_CHARS);
  return `${truncated}\n\n[... 文档过长，已截断 ...]`;
}

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
    const label = documentFileName ? `当前文档: ${documentFileName}` : '当前文档';
    systemParts.push(`${label}\n\n${truncateDocument(documentContent)}`);
  }
  messages.push({ role: 'system', content: systemParts.join('\n\n') });

  for (const entry of history) {
    messages.push({ role: entry.role, content: entry.content });
  }

  messages.push({ role: 'user', content: buildUserContent(userMessage, attachments) });
  return messages;
}
