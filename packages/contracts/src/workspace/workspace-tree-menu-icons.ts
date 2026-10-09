/**
 * Line icons for the workspace tree "view / sort / display" menu, shared by the Desktop DOM tree
 * and the VS Code/Cursor Extension sidebar webview. Drawn on a 24px grid with a round 1.6 stroke
 * in `currentColor`, so they follow menu text and hover/selection colors.
 */
export type WorkspaceTreeMenuIconId =
  | 'viewList'
  | 'viewIcons'
  | 'sortCreated'
  | 'sortName'
  | 'sortCustom'
  | 'showCreated'
  | 'showUpdated'
  | 'showTimeOnHover'
  | 'showDotEntries';

const ICON_PATHS: Record<WorkspaceTreeMenuIconId, string> = {
  viewList:
    '<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/>'
    + '<circle cx="4.5" cy="6" r="1" fill="currentColor" stroke="none"/>'
    + '<circle cx="4.5" cy="12" r="1" fill="currentColor" stroke="none"/>'
    + '<circle cx="4.5" cy="18" r="1" fill="currentColor" stroke="none"/>',
  viewIcons:
    '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/>'
    + '<rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  sortCreated:
    '<path d="M20 11V6.5A2 2 0 0 0 18 4.5H5.5a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2H11"/>'
    + '<path d="M3.5 9.5h16.5"/><path d="M8 3v3"/><path d="M15.5 3v3"/>'
    + '<path d="M18 14v7"/><path d="m15 18 3 3 3-3"/>',
  sortName:
    '<path d="M7 4v16"/><path d="m4 17 3 3 3-3"/>'
    + '<path d="M14 10.5V7a2.5 2.5 0 0 1 5 0v3.5"/><path d="M14 8.5h5"/>'
    + '<path d="M14 14h5l-5 6h5"/>',
  sortCustom:
    '<circle cx="9" cy="5.5" r="1.25" fill="currentColor" stroke="none"/>'
    + '<circle cx="15" cy="5.5" r="1.25" fill="currentColor" stroke="none"/>'
    + '<circle cx="9" cy="12" r="1.25" fill="currentColor" stroke="none"/>'
    + '<circle cx="15" cy="12" r="1.25" fill="currentColor" stroke="none"/>'
    + '<circle cx="9" cy="18.5" r="1.25" fill="currentColor" stroke="none"/>'
    + '<circle cx="15" cy="18.5" r="1.25" fill="currentColor" stroke="none"/>',
  showCreated:
    '<path d="M20.9 13.3A9 9 0 1 0 13.3 20.9"/><path d="M12 7v5l3 1.8"/>'
    + '<path d="M19 15.5v6"/><path d="M16 18.5h6"/>',
  showUpdated:
    '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 3.5V7.5h-4"/><path d="M12 7.5V12l3 1.8"/>',
  showTimeOnHover:
    '<path d="M4 4.5h16a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5h-5.5L12 20.5l-2.5-3H4A1.5 1.5 0 0 1 2.5 16V6A1.5 1.5 0 0 1 4 4.5z"/>'
    + '<circle cx="12" cy="11" r="4"/><path d="M12 9v2l1.4 1"/>',
  showDotEntries:
    '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/>'
    + '<circle cx="12" cy="12" r="2.75"/>',
};

export function workspaceTreeMenuIconSvg(id: WorkspaceTreeMenuIconId): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + `${ICON_PATHS[id]}</svg>`;
}
