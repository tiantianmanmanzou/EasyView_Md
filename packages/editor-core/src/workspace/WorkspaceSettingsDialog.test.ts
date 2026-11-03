/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest';
import { openWorkspaceSettingsDialog, type WorkspaceSettingsValues } from './WorkspaceSettingsDialog';

afterEach(() => document.body.replaceChildren());

const values: WorkspaceSettingsValues = {
  displayMode: 'list',
  sortMode: 'name',
  showCreatedAt: false,
  showUpdatedAt: false,
  showSize: false,
  showSizeHover: false,
  showTimestampHover: true,
  showNameHover: true,
  showDotEntries: true,
  fontSizeOffset: 0,
};

const open = () => {
  const onPreview = vi.fn();
  const onSave = vi.fn();
  const onClose = vi.fn();
  const handle = openWorkspaceSettingsDialog({ values, baseFontSize: 16, onPreview, onSave, onClose });
  const query = <T extends Element>(selector: string) => handle.element.querySelector<T>(selector)!;
  return { handle, onPreview, onSave, onClose, query };
};

it('previews every edit live and keeps them on Save', () => {
  const { handle, onPreview, onSave, onClose, query } = open();
  expect(handle.element.parentElement).toBe(document.body);
  const dialog = query('[role="dialog"]');
  expect(document.activeElement).toBe(dialog);
  expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('文件面板设置');
  expect([...handle.element.querySelectorAll('.easyview-settings-label')].map((label) => label.textContent))
    .toEqual(['显示方式', '排序方式', '字号', '显示内容', '悬停信息', '显示类型']);
  expect([...handle.element.querySelectorAll('.easyview-settings-check span')].map((label) => label.textContent))
    .toEqual(['创建时间', '修改时间', '大小', '悬停时显示时间', '悬停时显示完整名称', '悬停时显示大小', '以点开头的文件和文件夹']);

  query<HTMLButtonElement>('[role="radio"][data-value="list"]').click();
  expect(onPreview).not.toHaveBeenCalled();
  query<HTMLButtonElement>('[role="radio"][data-value="icons"]').click();
  expect(query('[role="radio"][data-value="icons"]').getAttribute('aria-checked')).toBe('true');
  expect(query('[role="radio"][data-value="list"]').getAttribute('aria-checked')).toBe('false');
  expect(onPreview).toHaveBeenLastCalledWith({ ...values, displayMode: 'icons' });
  query<HTMLButtonElement>('[role="radio"][data-value="custom"]').click();
  query<HTMLButtonElement>('[aria-label="增大字号"]').click();
  expect(query('.easyview-settings-stepper-value').textContent).toBe('17px');
  const created = query<HTMLInputElement>('.easyview-settings-check input');
  created.checked = true;
  created.dispatchEvent(new Event('change'));
  const edited = { ...values, displayMode: 'icons', sortMode: 'custom', fontSizeOffset: 1, showCreatedAt: true };
  expect(onPreview).toHaveBeenCalledTimes(4);
  expect(onPreview).toHaveBeenLastCalledWith(edited);
  expect(onSave).not.toHaveBeenCalled();

  [...handle.element.querySelectorAll<HTMLButtonElement>('.easyview-settings-footer button')]
    .find((button) => button.textContent === '保存')!.click();
  expect(onSave).toHaveBeenCalledWith(edited);
  expect(onPreview).toHaveBeenCalledTimes(4);
  expect(onClose).toHaveBeenCalledOnce();
  expect(handle.element.isConnected).toBe(false);
});

it('closing untouched does not preview', () => {
  const { onPreview, onClose, query } = open();
  query<HTMLButtonElement>('.easyview-settings-close').click();
  expect(onPreview).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
});

it('reverts edits on Cancel, Escape, the close button and backdrop clicks', () => {
  const close = [
    (query: ReturnType<typeof open>['query']) => [...query('.easyview-settings-footer').querySelectorAll<HTMLButtonElement>('button')][0].click(),
    (query: ReturnType<typeof open>['query']) => query('.easyview-settings-dialog').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    (query: ReturnType<typeof open>['query']) => query<HTMLButtonElement>('.easyview-settings-close').click(),
    (query: ReturnType<typeof open>['query']) => query('.easyview-settings-overlay').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })),
  ];
  for (const action of close) {
    const { handle, onPreview, onSave, onClose, query } = open();
    query<HTMLButtonElement>('[role="radio"][data-value="icons"]').click();
    query('.easyview-settings-dialog').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
    action((selector) => (selector === '.easyview-settings-overlay' ? handle.element : handle.element.querySelector(selector)!) as never);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
    expect(onPreview).toHaveBeenLastCalledWith(values);
    expect(handle.element.isConnected).toBe(false);
  }
});
