export interface GuardRepository { id: string; rootPath: string; name: string }
export interface GuardFile { path: string; oldPath?: string; index: string; worktree: string; submodule: boolean }
export interface GuardStatus { files: GuardFile[]; branch: string; head: string; upstream?: string; ahead: number; behind: number; checkedAt?: number }
export interface GuardBranch { name: string; remote: boolean; current: boolean; upstream?: string; ahead?: number; behind?: number; subject: string; author: string; timestamp: number }
export interface GuardCommit { hash: string; parents: string[]; message: string; author: string; timestamp: number }
export interface GuardHistory { entries: GuardCommit[]; cursor?: string }
export interface GuardComparison { base: string; content: string; baseLabel: string; contentLabel: string; path: string; key: string; binary?: boolean; spreadsheet?: import('./spreadsheet-diff').SpreadsheetComparison }
export interface GuardRequest { method: 'discover' | 'init' | 'cancel' | 'diagnostics' | 'status' | 'stage' | 'unstage' | 'discard' | 'commit' | 'fetch' | 'pull' | 'push' | 'sync' | 'history' | 'commitFiles' | 'comparison' | 'branches' | 'checkout' | 'openFile' | 'openDiff' | 'copyText' | 'active'; repository?: string; paths?: string[]; message?: string; text?: string; stageAll?: boolean; branch?: string; create?: boolean; revision?: string; cursor?: string; source?: 'working' | 'staged' | 'commit'; active?: boolean }
export interface GuardClient { onDiscovery?(listener: (repositories: GuardRepository[], warnings: string[]) => void): { dispose(): void }; request(request: GuardRequest): Promise<unknown>; subscribe(listener: (paths: string[] | null) => void): { dispose(): void }; loadState(): GuardUiState | undefined; saveState(state: GuardUiState): void }
export interface GuardUiState { selected?: string; expanded: string[]; drafts: Record<string, string>; historyHeight?: number }
/** Adapter for the existing read-only comparison tab; never passed to Timeline restore. */
export function guardTimelineComparison(value: GuardComparison): import('./timeline/timeline').TimelineComparison {
  return { entry: { id: value.key, source: 'git', filePath: value.path, timestamp: 0, label: value.contentLabel }, base: value.binary ? '' : value.base, content: value.binary ? 'Binary file changed.' : value.content, baseLabel: value.baseLabel, contentLabel: value.contentLabel, ...(value.spreadsheet ? { spreadsheet: value.spreadsheet } : {}) };
}
