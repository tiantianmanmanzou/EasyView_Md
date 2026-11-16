/**
 * Host-side AI chat controller: settings persistence, secret API key storage,
 * streaming completions, and image attachment picking.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EditorToHostMessage, HostToEditorMessage } from '@easyview/contracts';
import { normalizeAiChatSettings, type AiChatSettings } from '@easyview/contracts';
import { buildAiChatMessages } from './chatPrompt';
import { OpenAiChatError, streamOpenAiChat } from './openai-chat-client';
import { createAiAgentTools } from './agent-tools';
import { tAi } from './ai.i18n';
import {
  createOfficeAgentTools,
  officeDocumentKind,
  type OfficeCommitRecord,
  type OfficeEditDecision,
  type OfficeProposalView,
} from './office-tools';
import { undoOfficeCommit } from './docx-edit';
import { OfficeBackupStore, describeOfficeBackup, type OfficeBackupRef } from './office-backups';

export interface AiChatSecretStore {
  getApiKey(): Promise<string | null>;
  setApiKey(apiKey: string): Promise<void>;
  getWebSearchApiKey(): Promise<string | null>;
  setWebSearchApiKey(apiKey: string): Promise<void>;
}

export interface AiChatToolContext {
  workspaceRootPath: string | null;
}

export interface AiChatImagePicker {
  pickImages(): Promise<Array<{ name: string; dataUrl: string }>>;
}

export interface AiChatHostOptions {
  settingsFilePath: string;
  secretStore: AiChatSecretStore;
  postMessage: (message: HostToEditorMessage) => void;
  pickImages?: AiChatImagePicker;
  getToolContext?: () => Promise<AiChatToolContext> | AiChatToolContext;
  fetchImpl?: typeof fetch;
  /**
   * Enables Agent mode for Office files (.xlsx / .docx). The host shows the
   * proposal to the user; the decision comes back through
   * `AiChatHost.resolveOfficeEdit`.
   */
  officeEdits?: {
    /** Overrides how a proposal is shown; defaults to posting `aiChat.officeProposal`. */
    showProposal?(requestId: string, proposal: OfficeProposalView): void;
    /** App-data directory for backups of files outside Git; defaults to `ai-backups/` beside the settings file. */
    backupDirectory?: string;
    onCommitted?(requestId: string, commit: { id: string; filePath: string; backup: OfficeBackupRef }): void;
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof OpenAiChatError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export class AiChatHost {
  private readonly patchRequests = new Map<string, { requestId: string; finish(error?: string): void }>();
  private settings: AiChatSettings | null = null;
  private settingsLoaded = false;
  private readonly activeRequests = new Map<string, AbortController>();
  private readonly officeProposals = new Map<string, { requestId: string; resolve(decision: OfficeEditDecision): void }>();
  private readonly officeCommits = new Map<string, OfficeCommitRecord>();
  private officeBackups?: OfficeBackupStore;

  constructor(private readonly options: AiChatHostOptions) {}

  handles(message: EditorToHostMessage): boolean {
    return message.type.startsWith('aiChat.');
  }

  async handle(message: EditorToHostMessage): Promise<void> {
    switch (message.type) {
      case 'aiChat.getSettings':
        await this.respondSettings(message.requestId);
        return;
      case 'aiChat.saveSettings':
        await this.saveSettings(message.requestId, message.settings);
        return;
      case 'aiChat.saveApiKey':
        await this.saveApiKey(message.requestId, message.apiKey);
        return;
      case 'aiChat.saveWebSearchApiKey':
        await this.saveWebSearchApiKey(message.requestId, message.apiKey);
        return;
      case 'aiChat.send':
        void this.runSend(message);
        return;
      case 'aiChat.abort':
        this.activeRequests.get(message.requestId)?.abort();
        return;
      case 'aiChat.patchesApplied': {
        const pending = this.patchRequests.get(message.operationId);
        if (pending?.requestId === message.requestId) pending.finish(message.error);
        return;
      }
      case 'aiChat.pickImage':
        await this.pickImages(message.requestId);
        return;
      case 'aiChat.officeDecision':
        this.resolveOfficeEdit(message.proposalId, {
          accepted: message.accepted,
          resolution: message.resolution,
          itemDecisions: message.itemDecisions,
        });
        return;
      case 'aiChat.officeUndo':
        try {
          const filePath = this.officeCommits.get(message.commitId)?.filePath;
          await this.undoOfficeEdit(message.commitId);
          this.options.postMessage({ type: 'aiChat.officeUndone', requestId: message.requestId, commitId: message.commitId, filePath });
        } catch (error) {
          this.options.postMessage({ type: 'aiChat.officeUndone', requestId: message.requestId, commitId: message.commitId, error: toErrorMessage(error) });
        }
        return;
      default:
        return;
    }
  }

  /** Delivers the user's Apply / Reject decision for a pending Office proposal. */
  resolveOfficeEdit(
    proposalId: string,
    acceptedOrDecision: boolean | OfficeEditDecision,
    reason?: string,
  ): boolean {
    const pending = this.officeProposals.get(proposalId);
    if (!pending) return false;
    const decision: OfficeEditDecision =
      typeof acceptedOrDecision === 'boolean'
        ? { accepted: acceptedOrDecision, reason }
        : acceptedOrDecision;
    pending.resolve(decision);
    return true;
  }

  /** Restores the backup taken before an applied Office edit. */
  async undoOfficeEdit(commitId: string): Promise<void> {
    const record = this.officeCommits.get(commitId);
    if (!record) throw new Error(tAi('docx.undoStale'));
    await undoOfficeCommit(record);
    this.officeCommits.delete(commitId);
  }

  private confirmOfficeEdit(
    requestId: string,
    proposal: OfficeProposalView,
    signal: AbortSignal,
  ): Promise<OfficeEditDecision> {
    return new Promise((resolve) => {
      const finish = (decision: OfficeEditDecision) => {
        signal.removeEventListener('abort', aborted);
        this.officeProposals.delete(proposal.id);
        resolve(decision);
      };
      const aborted = () => finish({ accepted: false, reason: tAi('host.editCancelled') });
      this.officeProposals.set(proposal.id, { requestId, resolve: finish });
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) { aborted(); return; }
      try {
        const office = this.options.officeEdits!;
        if (office.showProposal) office.showProposal(requestId, proposal);
        else if (proposal.kind === 'docx') {
          this.options.postMessage({
            type: 'aiChat.officeProposal',
            requestId,
            proposalId: proposal.id,
            fileName: proposal.fileName,
            kind: 'docx',
            changes: proposal.diff.changes.map((change) => ({
              sheet: `¶${change.paragraphIndex}`,
              ref: change.search || '∅',
              before: change.before,
              after: change.after,
            })),
            total: proposal.diff.total,
            structural: proposal.diff.structural,
            truncated: proposal.diff.truncated,
            docxChanges: proposal.diff.changes,
            docxComments: proposal.diff.comments,
          });
        } else if (proposal.kind === 'pptx') {
          this.options.postMessage({
            type: 'aiChat.officeProposal',
            requestId,
            proposalId: proposal.id,
            fileName: proposal.fileName,
            kind: 'xlsx',
            changes: proposal.diff.changes.map((change) => ({
              sheet: `slide ${change.slideIndex}`,
              ref: change.shapeName,
              before: change.before,
              after: change.after,
            })),
            total: proposal.diff.total,
            structural: proposal.diff.structural,
            truncated: proposal.diff.truncated,
          });
        } else {
          this.options.postMessage({
            type: 'aiChat.officeProposal',
            requestId,
            proposalId: proposal.id,
            fileName: proposal.fileName,
            kind: 'xlsx',
            changes: proposal.diff.changes,
            total: proposal.diff.total,
            structural: proposal.diff.structural,
            truncated: proposal.diff.truncated,
          });
        }
      }
      catch (error) { finish({ accepted: false, reason: toErrorMessage(error) }); }
    });
  }

  dispose(): void {
    for (const pending of this.officeProposals.values()) pending.resolve({ accepted: false, reason: tAi('host.editCancelled') });
    this.officeProposals.clear();
    for (const controller of this.activeRequests.values()) {
      controller.abort();
    }
    this.activeRequests.clear();
  }

  private async loadSettings(): Promise<AiChatSettings> {
    if (this.settingsLoaded && this.settings) return this.settings;
    try {
      const raw = await fs.readFile(this.options.settingsFilePath, 'utf8');
      this.settings = normalizeAiChatSettings(JSON.parse(raw));
    } catch {
      this.settings = normalizeAiChatSettings(undefined);
    }
    this.settingsLoaded = true;
    return this.settings;
  }

  private async persistSettings(settings: AiChatSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.options.settingsFilePath), { recursive: true });
    await fs.writeFile(this.options.settingsFilePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    this.settings = settings;
    this.settingsLoaded = true;
  }

  private async respondSettings(requestId: string): Promise<void> {
    const settings = await this.loadSettings();
    const [apiKey, webSearchApiKey] = await Promise.all([
      this.options.secretStore.getApiKey(),
      this.options.secretStore.getWebSearchApiKey(),
    ]);
    this.options.postMessage({
      type: 'aiChat.settingsResponse',
      requestId,
      settings,
      hasApiKey: Boolean(apiKey?.trim()),
      hasWebSearchApiKey: Boolean(webSearchApiKey?.trim()),
    });
  }

  private async saveSettings(requestId: string, value: AiChatSettings): Promise<void> {
    try {
      const settings = normalizeAiChatSettings(value);
      await this.persistSettings(settings);
      this.options.postMessage({
        type: 'aiChat.settingsSaved',
        requestId,
        ok: true,
        message: tAi('host.saved'),
      });
    } catch (error) {
      this.options.postMessage({
        type: 'aiChat.settingsSaved',
        requestId,
        ok: false,
        message: toErrorMessage(error),
      });
    }
  }

  private async saveApiKey(requestId: string, apiKey: string): Promise<void> {
    try {
      const trimmed = apiKey.trim();
      if (!trimmed) throw new Error(tAi('host.apiKeyEmpty'));
      await this.options.secretStore.setApiKey(trimmed);
      this.options.postMessage({
        type: 'aiChat.settingsSaved',
        requestId,
        ok: true,
        message: tAi('host.apiKeySaved'),
      });
    } catch (error) {
      this.options.postMessage({
        type: 'aiChat.settingsSaved',
        requestId,
        ok: false,
        message: toErrorMessage(error),
      });
    }
  }

  private async saveWebSearchApiKey(requestId: string, apiKey: string): Promise<void> {
    try {
      const trimmed = apiKey.trim();
      if (!trimmed) throw new Error(tAi('host.webSearchApiKeyEmpty'));
      await this.options.secretStore.setWebSearchApiKey(trimmed);
      this.options.postMessage({
        type: 'aiChat.settingsSaved',
        requestId,
        ok: true,
        message: tAi('host.webSearchApiKeySaved'),
      });
    } catch (error) {
      this.options.postMessage({
        type: 'aiChat.settingsSaved',
        requestId,
        ok: false,
        message: toErrorMessage(error),
      });
    }
  }

  private async pickImages(requestId: string): Promise<void> {
    if (!this.options.pickImages) return;
    try {
      const images = await this.options.pickImages.pickImages();
      this.options.postMessage({ type: 'aiChat.imagePicked', requestId, images });
    } catch (error) {
      this.options.postMessage({ type: 'aiChat.imagePicked', requestId, images: [], error: toErrorMessage(error) });
    }
  }

  private applyPatches(requestId: string, path: string, patches: import('@easyview/contracts').AiTextPatch[], signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const operationId = randomUUID();
      const finish = (error?: string) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', aborted);
        this.patchRequests.delete(operationId);
        if (error) reject(new Error(error)); else resolve();
      };
      const aborted = () => finish(tAi('host.editCancelled'));
      const timer = setTimeout(() => finish(tAi('host.editUnacknowledged')), 8000);
      this.patchRequests.set(operationId, { requestId, finish });
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) { aborted(); return; }
      try { this.options.postMessage({ type: 'aiChat.applyPatches', requestId, operationId, path, patches }); }
      catch (error) { finish(toErrorMessage(error)); }
    });
  }

  private async runSend(message: Extract<EditorToHostMessage, { type: 'aiChat.send' }>): Promise<void> {
    const { requestId } = message;
    const controller = new AbortController();
    this.activeRequests.set(requestId, controller);
    try {
      const settings = await this.loadSettings();
      const apiKey = await this.options.secretStore.getApiKey();
      if (!apiKey?.trim()) {
        throw new OpenAiChatError('AUTH', tAi('host.apiKeyMissing'));
      }
      const officeKind = message.mode === 'agent' && message.documentFilePath && this.options.officeEdits
        ? officeDocumentKind(message.documentFilePath)
        : null;
      const messages = buildAiChatMessages({
        documentKind: officeKind ?? 'text',
        systemPrompt: settings.systemPrompt,
        mode: message.mode,
        history: message.history,
        userMessage: message.userMessage,
        attachments: message.attachments,
        documentContent: message.documentContent,
        documentFileName: message.documentFileName,
      });
      const [toolContext, webSearchApiKey] = await Promise.all([
        this.options.getToolContext?.() ?? { workspaceRootPath: null },
        this.options.secretStore.getWebSearchApiKey(),
      ]);
      const tools = await createAiAgentTools({
        workspaceRootPath: toolContext.workspaceRootPath,
        activeDocument: !officeKind && message.mode === 'agent' && message.documentFilePath && message.documentContent !== undefined
          ? {
            path: message.documentFilePath,
            content: message.documentContent,
            applyPatches: (patches) => this.applyPatches(requestId, message.documentFilePath!, patches, controller.signal),
          }
          : undefined,
        // Office edits are bound to the open file only: no workspace read/write tools.
        includeWorkspaceTools: message.mode === 'agent' && !officeKind,
        webSearchApiKey,
        fetchImpl: this.options.fetchImpl,
      });
      if (officeKind && message.documentFilePath) {
        const root = toolContext.workspaceRootPath ? path.resolve(toolContext.workspaceRootPath) : null;
        // Preview tabs send a workspace-relative path; editors send an absolute one.
        const filePath = path.isAbsolute(message.documentFilePath)
          ? path.resolve(message.documentFilePath)
          : root ? path.resolve(root, message.documentFilePath) : null;
        const relative = filePath && root ? path.relative(root, filePath) : '';
        if (!filePath || relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error(tAi('tools.pathOutsideWorkspace'));
        }
        const office = this.options.officeEdits!;
        Object.assign(tools, createOfficeAgentTools({
          kind: officeKind,
          filePath,
          backups: this.officeBackups ??= new OfficeBackupStore(office.backupDirectory ?? path.join(path.dirname(this.options.settingsFilePath), 'ai-backups')),
          confirmEdit: (proposal) => this.confirmOfficeEdit(requestId, proposal, controller.signal),
          onCommitted: (record, proposalId) => {
            this.officeCommits.set(proposalId, record);
            this.options.postMessage({ type: 'aiChat.officeCommitted', requestId, commitId: proposalId, filePath: record.filePath, backup: describeOfficeBackup(record.backup) });
            office.onCommitted?.(requestId, { id: proposalId, filePath: record.filePath, backup: record.backup });
          },
        }));
      }
      const result = await streamOpenAiChat(
        {
          baseUrl: settings.baseUrl,
          apiKey: apiKey.trim(),
          model: message.model,
          messages,
          temperature: settings.temperature,
          topP: settings.topP,
          maxTokens: settings.maxTokens,
          stream: settings.stream,
          signal: controller.signal,
          tools,
          fetchImpl: this.options.fetchImpl,
        },
        (event) => {
          if (event.type === 'delta') {
            this.options.postMessage({
              type: 'aiChat.delta',
              requestId,
              text: event.text,
              reasoning: event.reasoning,
            });
            return;
          }
          this.options.postMessage({
            type: 'aiChat.tool',
            requestId,
            phase: event.type === 'tool-call' ? 'call' : 'result',
            toolName: event.toolName,
            input: event.input,
            ...(event.type === 'tool-result' ? { output: event.output } : {}),
          });
        },
      );
      this.options.postMessage({
        type: 'aiChat.done',
        requestId,
        content: result.content,
        reasoning: result.reasoning,
        finishReason: result.finishReason,
      });
    } catch (error) {
      if (error instanceof OpenAiChatError && error.code === 'ABORTED') {
        this.options.postMessage({
          type: 'aiChat.error',
          requestId,
          message: error.message,
          aborted: true,
        });
        return;
      }
      this.options.postMessage({
        type: 'aiChat.error',
        requestId,
        message: toErrorMessage(error),
      });
    } finally {
      this.activeRequests.delete(requestId);
    }
  }
}
