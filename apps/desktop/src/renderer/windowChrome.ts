interface WindowChromeElements {
  workbench: HTMLElement;
  leading: HTMLElement;
  trailing: HTMLElement;
}

/** Reserve only the part of a top-edge tab strip occupied by native/panel controls.
 * Panel docking and split groups keep their own tab strips; no tabs are copied or reparented.
 */
export function installWindowChrome({ workbench, leading, trailing }: WindowChromeElements): () => void {
  // Electron resolves -webkit-app-region in document order, ignoring z-index: the no-drag controls must come
  // after the draggable tab strips they overlap, or Windows treats clicks on them as title-bar drags.
  const chrome = leading.parentElement;
  if (chrome && chrome === trailing.parentElement && chrome.parentElement) chrome.parentElement.append(chrome);
  let frame = 0;
  const layout = (): void => {
    frame = 0;
    const top = workbench.getBoundingClientRect().top;
    const left = leading.getBoundingClientRect();
    const right = trailing.getBoundingClientRect();
    for (const tabs of workbench.querySelectorAll<HTMLElement>('.desktop-tab-bar')) {
      const rect = tabs.getBoundingClientRect();
      const atTop = rect.height > 0 && Math.abs(rect.top - top) < 2;
      const start = atTop ? Math.max(0, left.right - rect.left) : 0;
      const end = atTop ? Math.max(0, rect.right - right.left) : 0;
      tabs.style.setProperty('--chrome-leading-space', `${start}px`);
      tabs.style.setProperty('--chrome-trailing-space', `${end}px`);
    }
  };
  const schedule = (): void => { if (!frame) frame = requestAnimationFrame(layout); };
  const resize = new ResizeObserver(schedule);
  for (const node of [workbench, leading, trailing]) resize.observe(node);
  const mutations = new MutationObserver(schedule);
  mutations.observe(workbench, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  window.addEventListener('resize', schedule);
  schedule();
  return () => {
    cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
    window.removeEventListener('resize', schedule);
  };
}
