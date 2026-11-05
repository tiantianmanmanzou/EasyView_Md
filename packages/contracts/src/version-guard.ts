export interface GuardRepository { id: string; rootPath: string; name: string }
export interface GuardFile { path: string; oldPath?: string; index: string; worktree: string; submodule: boolean }
export interface GuardStatus { files: GuardFile[]; branch: string; head: string; upstream?: string; ahead: number; behind: number; checkedAt?: number }
export interface GuardBranch { name: string; remote: boolean; current: boolean; upstream?: string; ahead?: number; behind?: number; subject: string; author: string; timestamp: number }
export interface GuardCommit { hash: string; parents: string[]; message: string; author: string; timestamp: number }
export interface GuardHistory { entries: GuardCommit[]; cursor?: string }
export interface GuardComparison { base: string; content: string; baseLabel: string; contentLabel: string; path: string; key: string; binary?: boolean; spreadsheet?: import('./spreadsheet-diff').SpreadsheetComparison }
/** `confirm` shows a modal host dialog (`message`, `detail`, one button per `choices` entry plus Cancel) and resolves to the chosen index, or -1. */
export interface GuardRequest { method: 'discover' | 'init' | 'cancel' | 'diagnostics' | 'status' | 'stage' | 'unstage' | 'discard' | 'commit' | 'undoCommit' | 'stash' | 'stashPop' | 'fetch' | 'pull' | 'push' | 'history' | 'commitFiles' | 'comparison' | 'branches' | 'checkout' | 'openFile' | 'openDiff' | 'copyPath' | 'copyRelativePath' | 'copyText' | 'revealInIndexArea' | 'confirm' | 'active'; repository?: string; paths?: string[]; message?: string; text?: string; stageAll?: boolean; amend?: boolean; branch?: string; create?: boolean; revision?: string; cursor?: string; source?: 'working' | 'staged' | 'commit'; active?: boolean; detail?: string; choices?: string[] }
export interface GuardClient { onDiscovery?(listener: (repositories: GuardRepository[], warnings: string[]) => void): { dispose(): void }; request(request: GuardRequest): Promise<unknown>; subscribe(listener: (paths: string[] | null) => void): { dispose(): void }; loadState(): GuardUiState | undefined; saveState(state: GuardUiState): void }
/** `smartCommit`: the user chose "Always" for staging every change when committing with nothing staged. */
export interface GuardUiState { selected?: string; expanded: string[]; drafts: Record<string, string>; historyHeight?: number; smartCommit?: boolean }
/** Adapter for the existing read-only comparison tab; never passed to Timeline restore. */
export function guardTimelineComparison(value: GuardComparison): import('./timeline/timeline').TimelineComparison {
  return { entry: { id: value.key, source: 'git', filePath: value.path, timestamp: 0, label: value.contentLabel }, base: value.binary ? '' : value.base, content: value.binary ? 'Binary file changed.' : value.content, baseLabel: value.baseLabel, contentLabel: value.contentLabel, ...(value.spreadsheet ? { spreadsheet: value.spreadsheet } : {}) };
}
