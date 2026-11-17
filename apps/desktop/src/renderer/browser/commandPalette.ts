export interface PaletteCommand {
  id: string;
  title: string;
  shortcut?: string;
  keywords?: string;
  run(): void;
}

export function filterPaletteCommands(commands: readonly PaletteCommand[], query: string): PaletteCommand[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...commands];
  return commands.filter((command) => {
    const haystack = `${command.title} ${command.id} ${command.keywords ?? ''}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export interface CommandPaletteController {
  open(): void;
  close(): void;
  dispose(): void;
}

export function installCommandPalette(options: {
  placeholder: string;
  emptyLabel: string;
  commands(): readonly PaletteCommand[];
}): CommandPaletteController {
  const root = document.createElement('div');
  root.className = 'desktop-command-palette';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  const input = document.createElement('input');
  input.className = 'desktop-command-palette-input';
  input.type = 'text';
  input.placeholder = options.placeholder;
  input.setAttribute('aria-label', options.placeholder);
  const list = document.createElement('div');
  list.className = 'desktop-command-palette-list';
  list.setAttribute('role', 'listbox');
  root.append(input, list);
  document.body.append(root);

  let commands: PaletteCommand[] = [];
  let selected = 0;

  const render = (): void => {
    commands = filterPaletteCommands(options.commands(), input.value);
    selected = Math.min(selected, Math.max(0, commands.length - 1));
    list.replaceChildren();
    if (commands.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'desktop-command-palette-empty';
      empty.textContent = options.emptyLabel;
      list.append(empty);
      return;
    }
    commands.forEach((command, index) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'desktop-command-palette-item';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(index === selected));
      item.classList.toggle('is-selected', index === selected);
      const title = document.createElement('span');
      title.textContent = command.title;
      item.append(title);
      if (command.shortcut) {
        const shortcut = document.createElement('kbd');
        shortcut.textContent = command.shortcut;
        item.append(shortcut);
      }
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        run(command);
      });
      list.append(item);
    });
    list.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
  };

  const close = (): void => {
    root.classList.remove('is-open');
    input.value = '';
  };

  const run = (command: PaletteCommand): void => {
    close();
    command.run();
  };

  const open = (): void => {
    selected = 0;
    input.value = '';
    root.classList.add('is-open');
    render();
    input.focus();
  };

  input.addEventListener('input', () => { selected = 0; render(); });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); selected = Math.min(commands.length - 1, selected + 1); render(); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); selected = Math.max(0, selected - 1); render(); return; }
    if (event.key === 'Enter' && commands[selected]) { event.preventDefault(); run(commands[selected]); }
  });
  root.addEventListener('mousedown', (event) => {
    if (event.target === root) close();
  });

  return {
    open,
    close,
    dispose() { root.remove(); },
  };
}
