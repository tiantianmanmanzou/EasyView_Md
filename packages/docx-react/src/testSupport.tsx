import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
export { act };
export function cleanup(): void {
  for (const { root, container } of mounted.splice(0)) { act(() => root.unmount()); container.remove(); }
}
export function render(element: ReactNode) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); mounted.push({ root, container });
  act(() => root.render(element));
  const queryByRole = (role: string, options: { name: string }) => [...container.querySelectorAll<HTMLElement>(role)]
    .find((item) => (item.getAttribute('aria-label') || item.textContent?.trim()) === options.name) ?? null;
  const queryByText = (text: string) => [...container.querySelectorAll<HTMLElement>('*')]
    .find((item) => item.textContent?.trim() === text && ![...item.children].some((child) => child.textContent?.trim() === text)) ?? null;
  const required = <T,>(item: T | null): T => { if (!item) throw new Error('Element not found'); return item; };
  return { container, queryByRole, queryByText, getByRole: (role: string, options: { name: string }) => required(queryByRole(role, options)),
    getByText: (text: string) => required(queryByText(text)),
    getByLabelText: (label: string) => required(container.querySelector<HTMLElement>(`[aria-label="${label}"]`)) };
}
export const fireEvent = {
  click(element: HTMLElement) { act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true }))); },
  change(element: HTMLElement, data: { target: { files: File[] } }) {
    Object.defineProperty(element, 'files', { configurable: true, value: data.target.files });
    act(() => element.dispatchEvent(new Event('change', { bubbles: true })));
  },
};
export async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1000;
  for (;;) { try { assertion(); return; } catch (error) { if (Date.now() >= deadline) throw error; await new Promise((resolve) => setTimeout(resolve, 10)); } }
}
export function renderHook<T, P>(callback: (props: P) => T, options?: { initialProps: P }) {
  const result = { current: undefined as T }; let props = options?.initialProps as P;
  function Harness({ value }: { value: P }) { result.current = callback(value); return null; }
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); mounted.push({ root, container });
  const rerender = (next: P) => { props = next; act(() => root.render(createElement(Harness, { value: props }))); };
  rerender(props);
  return { result, rerender };
}
