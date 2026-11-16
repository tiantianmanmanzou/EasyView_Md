import { describe, expect, it } from 'vitest';
import { filterPaletteCommands, type PaletteCommand } from './commandPalette';

const commands: PaletteCommand[] = [
  { id: 'openBrowser', title: '打开浏览器', keywords: 'browser', run() {} },
  { id: 'openTerminal', title: '内置终端', keywords: 'terminal', run() {} },
];

describe('command palette filter', () => {
  it('matches every term against the title, id, and keywords', () => {
    expect(filterPaletteCommands(commands, '').map((command) => command.id)).toEqual(['openBrowser', 'openTerminal']);
    expect(filterPaletteCommands(commands, '浏览').map((command) => command.id)).toEqual(['openBrowser']);
    expect(filterPaletteCommands(commands, 'browser').map((command) => command.id)).toEqual(['openBrowser']);
    expect(filterPaletteCommands(commands, 'nope')).toEqual([]);
  });
});
