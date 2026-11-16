import type { DesktopBrowserApi, DesktopBrowserLayout } from '../../contracts';
import { isBrowserSurfaceObscured } from './browserOverlay';

export function installBrowserBounds(options: {
  browser: Pick<DesktopBrowserApi, 'setLayout'>;
  onZoomChanged(listener: () => void): { unsubscribe(): void };
}): () => void {
  let frame = 0;
  let last = '';
  const report = (): void => {
    frame = 0;
    const obscured = isBrowserSurfaceObscured(document);
    const views: DesktopBrowserLayout['views'] = [];
    for (const slot of document.querySelectorAll<HTMLElement>('.desktop-browser-slot')) {
      const host = slot.closest<HTMLElement>('.desktop-browser-host');
      const tabId = host?.dataset.tabId;
      if (!host || !tabId) continue;
      if (host.hidden || slot.getClientRects().length === 0) {
        views.push({ tabId, bounds: null });
        continue;
      }
      const rect = slot.getBoundingClientRect();
      views.push({ tabId, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
    }
    const payload = { obscured, views };
    const encoded = JSON.stringify(payload);
    if (encoded === last) return;
    last = encoded;
    options.browser.setLayout(payload);
  };
  const schedule = (): void => { if (!frame) frame = requestAnimationFrame(report); };
  const resize = new ResizeObserver(schedule);
  const workbench = document.getElementById('desktop-workbench');
  if (workbench) resize.observe(workbench);
  const watchSlots = (): void => {
    for (const slot of document.querySelectorAll<HTMLElement>('.desktop-browser-slot')) resize.observe(slot);
  };
  const mutations = new MutationObserver(() => { watchSlots(); schedule(); });
  mutations.observe(document.body, { attributes: true, attributeFilter: ['class', 'hidden'], childList: true, subtree: true });
  window.addEventListener('resize', schedule);
  window.addEventListener('pointermove', schedule);
  const zoom = options.onZoomChanged(schedule);
  watchSlots();
  schedule();
  return () => {
    cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
    window.removeEventListener('resize', schedule);
    window.removeEventListener('pointermove', schedule);
    zoom.unsubscribe();
  };
}
