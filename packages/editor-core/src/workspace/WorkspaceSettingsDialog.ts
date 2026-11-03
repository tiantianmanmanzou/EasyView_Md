import {
  WORKSPACE_FONT_SIZE_OFFSET_MAX,
  WORKSPACE_FONT_SIZE_OFFSET_MIN,
  WORKSPACE_TREE_SORT_MODE_ICONS,
  clampWorkspaceFontSizeOffset,
  workspaceTreeMenuIconSvg,
  type WorkspaceTreeMenuIconId,
  type WorkspaceTreeSortMode,
} from '@easyview/contracts';
import { openSettingsDialog, settingsCheckbox } from '../ui/SettingsDialog';
import { tWorkspaceSettings } from './workspaceSettings.i18n';

export interface WorkspaceSettingsValues {
  displayMode: 'list' | 'icons';
  sortMode: WorkspaceTreeSortMode;
  showCreatedAt: boolean;
  showUpdatedAt: boolean;
  showSize: boolean;
  showSizeHover: boolean;
  showTimestampHover: boolean;
  showNameHover: boolean;
  showDotEntries: boolean;
  fontSizeOffset: number;
}

export interface WorkspaceSettingsDialogOptions {
  values: WorkspaceSettingsValues;
  /** File-name size at offset 0, shown next to the stepper. */
  baseFontSize: number;
  /** Called after every edit, and with the original values when the dialog closes without Save. */
  onPreview(values: WorkspaceSettingsValues): void;
  onSave(values: WorkspaceSettingsValues): void;
  onClose(): void;
}

export interface WorkspaceSettingsDialogHandle {
  readonly element: HTMLElement;
  close(): void;
}

type ShowKey = 'showSizeHover' | 'showSize' | 'showCreatedAt' | 'showUpdatedAt' | 'showTimestampHover' | 'showNameHover' | 'showDotEntries';

/** Settings for the workspace file panel, shared by Desktop and the Extension sidebar; edits preview live and revert unless saved. */
export function openWorkspaceSettingsDialog(options: WorkspaceSettingsDialogOptions): WorkspaceSettingsDialogHandle {
  const draft: WorkspaceSettingsValues = { ...options.values };
  let dirty = false;
  let saved = false;
  const changed = () => {
    dirty = true;
    options.onPreview({ ...draft });
  };
  return openSettingsDialog({
    title: tWorkspaceSettings('title'),
    wide: true,
    fields: [
      {
        label: tWorkspaceSettings('displayMode'),
        control: segmented(
          tWorkspaceSettings('displayMode'),
          [
            { value: 'list', label: tWorkspaceSettings('displayList'), icon: 'viewList' },
            { value: 'icons', label: tWorkspaceSettings('displayIcons'), icon: 'viewIcons' },
          ],
          () => draft.displayMode,
          (value) => { draft.displayMode = value; changed(); },
        ),
      },
      {
        label: tWorkspaceSettings('sortMode'),
        control: segmented(
          tWorkspaceSettings('sortMode'),
          [
            { value: 'created', label: tWorkspaceSettings('sortCreated'), icon: WORKSPACE_TREE_SORT_MODE_ICONS.created },
            { value: 'name', label: tWorkspaceSettings('sortName'), icon: WORKSPACE_TREE_SORT_MODE_ICONS.name },
            { value: 'custom', label: tWorkspaceSettings('sortCustom'), icon: WORKSPACE_TREE_SORT_MODE_ICONS.custom },
          ],
          () => draft.sortMode,
          (value) => { draft.sortMode = value; changed(); },
        ),
      },
      { label: tWorkspaceSettings('fontSize'), control: fontSizeStepper(draft, options.baseFontSize, changed) },
      { label: tWorkspaceSettings('show'), control: checkboxes(draft, ['showCreatedAt', 'showUpdatedAt', 'showSize'], changed) },
      { label: tWorkspaceSettings('hoverInfo'), control: checkboxes(draft, ['showTimestampHover', 'showNameHover', 'showSizeHover'], changed) },
      { label: tWorkspaceSettings('showTypes'), control: checkboxes(draft, ['showDotEntries'], changed) },
    ],
    onSave: () => {
      saved = true;
      options.onSave({ ...draft });
    },
    onClose: () => {
      if (!saved && dirty) options.onPreview({ ...options.values });
      options.onClose();
    },
  });
}

function segmented<T extends string>(
  label: string,
  choices: Array<{ value: T; label: string; icon: WorkspaceTreeMenuIconId }>,
  get: () => T,
  set: (value: T) => void,
): HTMLElement {
  const group = document.createElement('div');
  group.className = 'easyview-settings-segmented';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', label);
  const buttons = choices.map((choice) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.dataset.value = choice.value;
    const icon = document.createElement('span');
    icon.className = 'easyview-settings-segment-icon';
    icon.innerHTML = workspaceTreeMenuIconSvg(choice.icon);
    const text = document.createElement('span');
    text.textContent = choice.label;
    button.append(icon, text);
    button.addEventListener('click', () => {
      if (get() === choice.value) return;
      set(choice.value);
      sync();
    });
    return button;
  });
  const sync = () => {
    for (const button of buttons) button.setAttribute('aria-checked', String(button.dataset.value === get()));
  };
  sync();
  group.append(...buttons);
  return group;
}

function fontSizeStepper(draft: WorkspaceSettingsValues, baseFontSize: number, changed: () => void): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'easyview-settings-stepper';
  const button = (text: string, title: string, delta: -1 | 1) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = text;
    element.title = title;
    element.setAttribute('aria-label', title);
    element.addEventListener('click', () => {
      draft.fontSizeOffset = clampWorkspaceFontSizeOffset(draft.fontSizeOffset + delta);
      sync();
      changed();
    });
    return element;
  };
  const decrease = button('−', tWorkspaceSettings('fontSizeDecrease'), -1);
  const increase = button('+', tWorkspaceSettings('fontSizeIncrease'), 1);
  const value = document.createElement('output');
  value.className = 'easyview-settings-stepper-value';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'easyview-settings-link';
  reset.textContent = tWorkspaceSettings('fontSizeReset');
  reset.addEventListener('click', () => {
    draft.fontSizeOffset = 0;
    sync();
    changed();
  });
  const sync = () => {
    value.textContent = `${baseFontSize + draft.fontSizeOffset}px`;
    decrease.disabled = draft.fontSizeOffset <= WORKSPACE_FONT_SIZE_OFFSET_MIN;
    increase.disabled = draft.fontSizeOffset >= WORKSPACE_FONT_SIZE_OFFSET_MAX;
    reset.disabled = draft.fontSizeOffset === 0;
  };
  sync();
  const stepper = document.createElement('div');
  stepper.className = 'easyview-settings-stepper-box';
  stepper.append(decrease, value, increase);
  wrapper.append(stepper, reset);
  return wrapper;
}

function checkboxes(draft: WorkspaceSettingsValues, keys: ShowKey[], changed: () => void): HTMLElement {
  const grid = document.createElement('div');
  grid.className = 'easyview-settings-checks';
  for (const key of keys) {
    grid.appendChild(settingsCheckbox(tWorkspaceSettings(key), draft[key], (checked) => { draft[key] = checked; changed(); }));
  }
  return grid;
}
