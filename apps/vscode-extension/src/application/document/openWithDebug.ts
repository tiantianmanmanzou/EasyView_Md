import * as vscode from 'vscode';

let output: vscode.OutputChannel | undefined;

function getOutput(): vscode.OutputChannel {
  if (!output) {
    output = vscode.window.createOutputChannel('EasyView_Md Open Debug');
  }
  return output;
}

function stringifyMeta(meta?: Record<string, unknown>): string {
  if (!meta) return '';
  const entries = Object.entries(meta)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
  return entries ? ` ${entries}` : '';
}

export function logOpenWithDebug(stage: string, meta?: Record<string, unknown>): void {
  getOutput().appendLine(`[${new Date().toISOString()}] ${stage}${stringifyMeta(meta)}`);
}

export function showOpenWithDebugChannel(preserveFocus = true): void {
  getOutput().show(preserveFocus);
}
