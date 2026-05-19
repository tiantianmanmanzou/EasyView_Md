/**
 * ToolbarButtons — all button definitions for the floating toolbar.
 */

import { toggleMark, setBlockType } from 'prosemirror-commands';
import { wrapInList, liftListItem } from 'prosemirror-schema-list';
import { TextSelection } from 'prosemirror-state';
import { schema } from '../../../editor/EditorSchema';
import {
  type ToolbarButton,
  isMarkActive,
  isBlockActive,
  getClosestListType,
  convertListType,
  liftFromNodeType,
  wrapInBlockSmart,
} from '../../../editor/EditorCommands';
import { linkEditPopup } from './ToolbarLinkPopup';
import { htmlTagDropdown } from './ToolbarHtmlDropdown';
import { hasMarkdownPatterns, interpretAsMarkdown } from './ToolbarMarkdownInterpreter';

// ─── Button Definitions ──────────────────────────────────────────────────────

export const buttons: ToolbarButton[] = [
  {
    id: 'bold',
    icon: '<svg fill="currentColor" width="20" height="20" viewBox="0 0 24 24"><path d="M18 15.4286C18 17.9533 16.2091 20 14 20H8C7.44772 20 7 19.4883 7 18.8571V5.14286C7 4.51167 7.44772 4 8 4H13C15.2091 4 17 6.0467 17 8.57143C17 9.69102 16.6478 10.7166 16.0632 11.5114C17.2239 12.3116 18 13.7665 18 15.4286ZM9 17.7143H14C15.1046 17.7143 16 16.6909 16 15.4286C16 14.1662 15.1046 13.1429 14 13.1429H9V17.7143ZM9 10.8571H13C14.1046 10.8571 15 9.83379 15 8.57143C15 7.30906 14.1046 6.28571 13 6.28571H9V10.8571Z"></path></svg>',
    title: 'Bold (Ctrl+B)',
    command: toggleMark(schema.marks.strong),
    isActive: (state) => isMarkActive(state, schema.marks.strong),
  },
  {
    id: 'italic',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/></svg>',
    title: 'Italic (Ctrl+I)',
    command: toggleMark(schema.marks.em),
    isActive: (state) => isMarkActive(state, schema.marks.em),
  },
  {
    id: 'underline',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3"/><line x1="4" y1="21" x2="20" y2="21"/></svg>',
    title: 'Underline (Ctrl+U)',
    command: toggleMark(schema.marks.underline),
    isActive: (state) => isMarkActive(state, schema.marks.underline),
  },
  {
    id: 'strikethrough',
    icon: '<svg fill="currentColor" width="20" height="20" viewBox="0 0 24 24"><path d="M9.26756 9C9.09739 8.70583 9 8.36429 9 8C9 6.89543 9.89543 6 11 6H16C16.5523 6 17 5.55228 17 5C17 4.44772 16.5523 4 16 4H11C8.79086 4 7 5.79086 7 8C7 8.3453 7.04375 8.68038 7.12602 9H9.26756ZM16.874 15C16.9562 15.3196 17 15.6547 17 16C17 18.2091 15.2091 20 13 20H8C7.44772 20 7 19.5523 7 19C7 18.4477 7.44772 18 8 18H13C14.1046 18 15 17.1046 15 16C15 15.6357 14.9026 15.2942 14.7324 15H16.874Z"></path><path d="M5 12C5 11.4477 5.44772 11 6 11H18C18.5523 11 19 11.4477 19 12V12C19 12.5523 18.5523 13 18 13H6C5.44772 13 5 12.5523 5 12V12Z"></path></svg>',
    title: 'Strikethrough (Ctrl+D)',
    command: toggleMark(schema.marks.strikethrough),
    isActive: (state) => isMarkActive(state, schema.marks.strikethrough),
  },
  {
    id: 'highlight',
    icon: '<svg fill="currentColor" width="20" height="20" viewBox="0 0 24 24"><path d="M19,4 C19.5128358,4 19.9355072,4.38604019 19.9932723,4.88337888 L20,5 L20,9.61483519 C20,9.69690861 19.9966323,9.77881993 19.9899356,9.8603674 C19.9966912,9.90581613 20,9.95252166 20,10 C20,10.1805703 19.9521405,10.3499624 19.8684145,10.4961832 C19.8658881,10.5018105 19.864041,10.5077569 19.8621752,10.513698 L19.7854301,10.7290072 L18,15.191 L18,19 C18,19.5128358 17.6139598,19.9355072 17.1166211,19.9932723 L17,20 L5,20 C4.44771525,20 4,19.5522847 4,19 C4,18.4871642 4.38604019,18.0644928 4.88337888,18.0067277 L5,18 L12,18 L12,15.194 L10.2145699,10.7290072 C10.1839016,10.6523364 10.1564596,10.5745518 10.1322835,10.495859 C10.0478595,10.3499624 10,10.1805703 10,10 C10,9.95252166 10.0033088,9.90581613 10.0097083,9.86010142 C10.0095959,9.85466244 10.0091437,9.84895569 10.0087078,9.84324723 L10,9.61483519 L10,5 C10,4.44771525 10.4477152,4 11,4 C11.5128358,4 11.9355072,4.38604019 11.9932723,4.88337888 L12,5 L12,9 L18,9 L18,5 C18,4.44771525 18.4477153,4 19,4 Z M16,16 L14,16 L14,18 L16,18 L16,16 Z M17.522,11 L12.477,11 L13.677,14 L16.322,14 L17.522,11 Z"></path></svg>',
    title: 'Highlight (Ctrl+Shift+H)',
    command: toggleMark(schema.marks.highlight),
    isActive: (state) => isMarkActive(state, schema.marks.highlight),
  },
  {
    id: 'separator-0',
    icon: '',
    title: '',
    command: () => false,
  },
  {
    id: 'code',
    icon: '<svg fill="currentColor" width="20" height="20" viewBox="0 0 24 24"><path d="M11.9806 19.1961C11.8723 19.7377 11.3454 20.0889 10.8039 19.9806C10.2623 19.8723 9.91111 19.3455 10.0194 18.8039L12.0194 4.80389C12.1277 4.26233 12.6546 3.91112 13.1961 4.01943C13.7377 4.12774 14.0889 4.65457 13.9806 5.19613L11.9806 19.1961ZM5.41421 12L8.70711 15.2929C9.09763 15.6834 9.09763 16.3166 8.70711 16.7071C8.31658 17.0976 7.68342 17.0976 7.29289 16.7071L3.29289 12.7071C2.90237 12.3166 2.90237 11.6834 3.29289 11.2929L7.29289 7.2929C7.68342 6.90238 8.31658 6.90238 8.70711 7.2929C9.09763 7.68343 9.09763 8.31659 8.70711 8.70712L5.41421 12ZM15.2929 15.2929L18.5858 12L15.2929 8.70712C14.9024 8.31659 14.9024 7.68343 15.2929 7.2929C15.6834 6.90238 16.3166 6.90238 16.7071 7.2929L20.7071 11.2929C21.0976 11.6834 21.0976 12.3166 20.7071 12.7071L16.7071 16.7071C16.3166 17.0976 15.6834 17.0976 15.2929 16.7071C14.9024 16.3166 14.9024 15.6834 15.2929 15.2929Z"></path></svg>',
    title: 'Code (Ctrl+E)',
    command: toggleMark(schema.marks.code_inline),
    isActive: (state) => isMarkActive(state, schema.marks.code_inline),
  },
  {
    id: 'blockquote',
    icon: '<svg fill="currentColor" width="20" height="20" viewBox="0 0 24 24"><path d="M7,11 L9.00208688,11 C10.1055038,11 11,11.8982606 11,12.9979131 L11,15.0020869 C11,16.1055038 10.1017394,17 9.00208688,17 L6.99791312,17 C5.89449617,17 5,16.1017394 5,15.0020869 L5,12.9989566 L5,11 C5,8.790861 6.790861,7 9,7 L10,7 C10.5522847,7 11,7.44771525 11,8 C11,8.55228475 10.5522847,9 10,9 L9,9 C7.8954305,9 7,9.8954305 7,11 Z M15,11 L17.0020869,11 C18.1055038,11 19,11.8982606 19,12.9979131 L19,15.0020869 C19,16.1055038 18.1017394,17 17.0020869,17 L14.9979131,17 C13.8944962,17 13,16.1017394 13,15.0020869 L13,12.9989566 L13,11 C13,8.790861 14.790861,7 17,7 L18,7 C18.5522847,7 19,7.44771525 19,8 C19,8.55228475 18.5522847,9 18,9 L17,9 C15.8954305,9 15,9.8954305 15,11 Z"></path></svg>',
    title: 'Blockquote (Ctrl+Shift+B)',
    command: (state, dispatch) => {
      const isActive = isBlockActive(state, schema.nodes.blockquote);
      if (isActive) {
        return liftFromNodeType(schema.nodes.blockquote)(state, dispatch);
      }
      return wrapInBlockSmart(schema.nodes.blockquote)(state, dispatch);
    },
    isActive: (state) => isBlockActive(state, schema.nodes.blockquote),
  },
  {
    id: 'separator-1',
    icon: '',
    title: '',
    command: () => false,
  },
  {
    id: 'heading1',
    icon: '<span style="font-weight:700;font-size:13px">H1</span>',
    title: 'Heading 1 (Ctrl+Shift+1)',
    command: (state, dispatch) => {
      const isActive = isBlockActive(state, schema.nodes.heading, { level: 1 });
      if (isActive) {
        return setBlockType(schema.nodes.paragraph)(state, dispatch);
      }
      return setBlockType(schema.nodes.heading, { level: 1 })(state, dispatch);
    },
    isActive: (state) => isBlockActive(state, schema.nodes.heading, { level: 1 }),
  },
  {
    id: 'heading2',
    icon: '<span style="font-weight:700;font-size:12px">H2</span>',
    title: 'Heading 2 (Ctrl+Shift+2)',
    command: (state, dispatch) => {
      const isActive = isBlockActive(state, schema.nodes.heading, { level: 2 });
      if (isActive) {
        return setBlockType(schema.nodes.paragraph)(state, dispatch);
      }
      return setBlockType(schema.nodes.heading, { level: 2 })(state, dispatch);
    },
    isActive: (state) => isBlockActive(state, schema.nodes.heading, { level: 2 }),
  },
  {
    id: 'heading3',
    icon: '<span style="font-weight:600;font-size:11px">H3</span>',
    title: 'Heading 3 (Ctrl+Shift+3)',
    command: (state, dispatch) => {
      const isActive = isBlockActive(state, schema.nodes.heading, { level: 3 });
      if (isActive) {
        return setBlockType(schema.nodes.paragraph)(state, dispatch);
      }
      return setBlockType(schema.nodes.heading, { level: 3 })(state, dispatch);
    },
    isActive: (state) => isBlockActive(state, schema.nodes.heading, { level: 3 }),
  },
  {
    id: 'separator-2',
    icon: '',
    title: '',
    command: () => false,
  },
  {
    id: 'checkbox-list',
    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M9.99992841,5.99992841 L19.0000716,5.99992841 L19.0000716,5.99992841 C19.5523168,5.99992841 20,6.4476116 20,6.99985681 L20,6.99985681 C20,7.55210202 19.5523168,7.99978522 19.0000716,7.99978522 L9.99992841,7.99978522 L9.99992841,7.99978522 C9.4476832,7.99978522 9,7.55210202 9,6.99985681 C9,6.4476116 9.4476832,5.99992841 9.99992841,5.99992841 L9.99992841,5.99992841 Z M9.99992841,15.9992125 L19.0000716,15.9992125 L19.0000716,15.9992125 C19.5523168,15.9992125 20,16.4468957 20,16.9991409 L20,16.9991409 L20,16.9991409 C20,17.5513861 19.5523168,17.9990693 19.0000716,17.9990693 L9.99992841,17.9990693 C9.4476832,17.9990693 9,17.5513861 9,16.9991409 C9,16.4468957 9.4476832,15.9992125 9.99992841,15.9992125 Z M9.99992841,10.9995704 L19.0000716,10.9995704 L19.0000716,10.9995704 C19.5523168,10.9995704 20,11.4472536 20,11.9994988 L20,11.9994988 C20,12.5517441 19.5523168,12.9994273 19.0000716,12.9994273 L9.99992841,12.9994273 C9.4476832,12.9994273 9,12.5517441 9,11.9994988 C9,11.4472536 9.4476832,10.9995704 9.99992841,10.9995704 Z M5.22935099,7.69420576 L7.09998441,5.20002786 C7.26566855,4.97911569 7.57906677,4.93434451 7.79997895,5.10002864 C8.02089112,5.26571278 8.0656623,5.579111 7.89997817,5.80002318 L5.64999574,8.79999974 C5.45636149,9.05817875 5.07249394,9.06801504 4.86589123,8.82009178 L3.61590099,7.3201035 C3.43912033,7.10796671 3.46778214,6.79268682 3.67991893,6.61590616 C3.89205572,6.4391255 4.20733561,6.46778731 4.38411627,6.6799241 L5.22935099,7.69420576 Z M5.22935099,12.6942058 L7.09998441,10.2000279 C7.26566855,9.97911569 7.57906677,9.93434451 7.79997895,10.1000286 C8.02089112,10.2657128 8.0656623,10.579111 7.89997817,10.8000232 L5.64999574,13.7999997 C5.45636149,14.0581787 5.07249394,14.068015 4.86589123,13.8200918 L3.61590099,12.3201035 C3.43912033,12.1079667 3.46778214,11.7926868 3.67991893,11.6159062 C3.89205572,11.4391255 4.20733561,11.4677873 4.38411627,11.6799241 L5.22935099,12.6942058 Z M5.22935099,17.6942058 L7.09998441,15.2000279 C7.26566855,14.9791157 7.57906677,14.9343445 7.79997895,15.1000286 C8.02089112,15.2657128 8.0656623,15.579111 7.89997817,15.8000232 L5.64999574,18.7999997 C5.45636149,19.0581787 5.07249394,19.068015 4.86589123,18.8200918 L3.61590099,17.3201035 C3.43912033,17.1079667 3.46778214,16.7926868 3.67991893,16.6159062 C3.89205572,16.4391255 4.20733561,16.4677873 4.38411627,16.6799241 L5.22935099,17.6942058 Z"></path></svg>',
    title: 'Checkbox List (Ctrl+Shift+7)',
    command: (state, dispatch, view) => {
      const closestList = getClosestListType(state);

      if (closestList === schema.nodes.checkbox_list) {
        // Exit checkbox list
        return liftListItem(schema.nodes.checkbox_item)(state, dispatch);
      } else if (closestList === schema.nodes.bullet_list || closestList === schema.nodes.ordered_list) {
        // Convert from other list type
        return convertListType(schema.nodes.list_item, schema.nodes.checkbox_list)(state, dispatch, view);
      }
      // Create new checkbox list
      return wrapInList(schema.nodes.checkbox_list)(state, dispatch);
    },
    isActive: (state) => getClosestListType(state) === schema.nodes.checkbox_list,
  },
  {
    id: 'bullet-list',
    icon: '<svg fill="currentColor" width="24" height="24" viewBox="0 0 24 24"><path d="M10,6 L19,6 C19.5522847,6 20,6.44771525 20,7 L20,7 C20,7.55228475 19.5522847,8 19,8 L10,8 C9.44771525,8 9,7.55228475 9,7 L9,7 L9,7 C9,6.44771525 9.44771525,6 10,6 Z M10,16 L19,16 C19.5522847,16 20,16.4477153 20,17 C20,17.5522847 19.5522847,18 19,18 L10,18 C9.44771525,18 9,17.5522847 9,17 C9,16.4477153 9.44771525,16 10,16 Z M10,11 L19,11 C19.5522847,11 20,11.4477153 20,12 C20,12.5522847 19.5522847,13 19,13 L10,13 C9.44771525,13 9,12.5522847 9,12 C9,11.4477153 9.44771525,11 10,11 Z M5,10.5 L5,10.5 C5.82842712,10.5 6.5,11.1715729 6.5,12 C6.5,12.8284271 5.82842712,13.5 5,13.5 C4.17157288,13.5 3.5,12.8284271 3.5,12 C3.5,11.1715729 4.17157288,10.5 5,10.5 L5,10.5 Z M5,5.5 L5,5.5 C5.82842712,5.5 6.5,6.17157288 6.5,7 L6.5,7 C6.5,7.82842712 5.82842712,8.5 5,8.5 C4.17157288,8.5 3.5,7.82842712 3.5,7 L3.5,7 L3.5,7 C3.5,6.17157288 4.17157288,5.5 5,5.5 L5,5.5 Z M5,15.5 L5,15.5 C5.82842712,15.5 6.5,16.1715729 6.5,17 C6.5,17.8284271 5.82842712,18.5 5,18.5 C4.17157288,18.5 3.5,17.8284271 3.5,17 C3.5,16.1715729 4.17157288,15.5 5,15.5 L5,15.5 Z"></path></svg>',
    title: 'Bullet List (Ctrl+Shift+8)',
    command: (state, dispatch, view) => {
      const closestList = getClosestListType(state);

      if (closestList === schema.nodes.bullet_list) {
        // Exit bullet list
        return liftListItem(schema.nodes.list_item)(state, dispatch);
      } else if (closestList === schema.nodes.checkbox_list) {
        // Convert from checkbox to bullet
        return convertListType(schema.nodes.checkbox_item, schema.nodes.bullet_list)(state, dispatch, view);
      } else if (closestList === schema.nodes.ordered_list) {
        // Convert from ordered to bullet
        return convertListType(schema.nodes.list_item, schema.nodes.bullet_list)(state, dispatch, view);
      }
      // Create new bullet list
      return wrapInList(schema.nodes.bullet_list)(state, dispatch);
    },
    isActive: (state) => getClosestListType(state) === schema.nodes.bullet_list,
  },
  {
    id: 'ordered-list',
    icon: '<svg fill="currentColor" width="24" height="24" viewBox="0 0 24 24"><path d="M5,7.99978522 L5,6.70798687 L4.85355339,6.85442299 C4.65829124,7.04967116 4.34170876,7.04967116 4.14644661,6.85442299 C3.95118446,6.65917483 3.95118446,6.342615 4.14644661,6.14736684 L5.14644661,5.14743843 C5.46142904,4.83247855 6,5.05554597 6,5.50096651 L6,7.99978522 L6.5000358,7.99978522 L6.5000358,7.99978522 C6.7761584,7.99978522 7,8.22362682 7,8.49974942 C7,8.77587203 6.7761584,8.99971363 6.5000358,8.99971363 L5.53191883,8.99971363 C5.52136474,9.00037848 5.51072178,9.00071593 5.5,9.00071593 C5.48927822,9.00071593 5.47863526,9.00037848 5.46808117,8.99971363 L4.4999642,8.99971363 L4.4999642,8.99971363 C4.2238416,8.99971363 4,8.77587203 4,8.49974942 C4,8.22362682 4.2238416,7.99978522 4.4999642,7.99978522 L4.4999642,7.99978522 L5,7.99978522 Z M9.99992841,5.99992841 L19.0000716,5.99992841 L19.0000716,5.99992841 C19.5523168,5.99992841 20,6.4476116 20,6.99985681 L20,6.99985681 L20,6.99985681 C20,7.55210202 19.5523168,7.99978522 19.0000716,7.99978522 L9.99992841,7.99978522 L9.99992841,7.99978522 C9.4476832,7.99978522 9,7.55210202 9,6.99985681 L9,6.99985681 L9,6.99985681 C9,6.4476116 9.4476832,5.99992841 9.99992841,5.99992841 Z M9.99992841,15.9992125 L19.0000716,15.9992125 L19.0000716,15.9992125 C19.5523168,15.9992125 20,16.4468957 20,16.9991409 L20,16.9991409 L20,16.9991409 C20,17.5513861 19.5523168,17.9990693 19.0000716,17.9990693 L9.99992841,17.9990693 C9.4476832,17.9990693 9,17.5513861 9,16.9991409 C9,16.4468957 9.4476832,15.9992125 9.99992841,15.9992125 Z M9.99992841,10.9995704 L19.0000716,10.9995704 L19.0000716,10.9995704 C19.5523168,10.9995704 20,11.4472536 20,11.9994988 L20,11.9994988 C20,12.5517441 19.5523168,12.9994273 19.0000716,12.9994273 L9.99992841,12.9994273 L9.99992841,12.9994273 C9.4476832,12.9994273 9,12.5517441 9,11.9994988 C9,11.4472536 9.4476832,10.9995704 9.99992841,10.9995704 Z M4.64644661,16.6466151 L5.29289322,16.0002148 L4.5,16.0002148 C4.22385763,16.0002148 4,15.7763732 4,15.5002506 C4,15.224128 4.22385763,15.0002864 4.5,15.0002864 L6.5,15.0002864 C6.94545243,15.0002864 7.16853582,15.5388188 6.85355339,15.8537787 L6.14380887,16.5634724 C6.64120863,16.728439 7,17.1973672 7,17.7500895 C7,18.440396 6.44035594,19 5.75,19 L4.5,19 C4.22385763,19 4,18.7761584 4,18.5000358 C4,18.2239132 4.22385763,18.0000716 4.5,18.0000716 L5.75,18.0000716 C5.88807119,18.0000716 6,17.8881508 6,17.7500895 C6,17.6120282 5.88807119,17.5001074 5.75,17.5001074 L5,17.5001074 C4.55454757,17.5001074 4.33146418,16.961575 4.64644661,16.6466151 Z M6.40096969,12.700451 L6.00096969,13.0004296 L6.50096969,13.0004296 C6.77711207,13.0004296 7.00096969,13.2242712 7.00096969,13.5003938 C7.00096969,13.7765164 6.77711207,14.000358 6.50096969,14.000358 L4.50096969,14.000358 C4.02046355,14.000358 3.81656478,13.3887054 4.20096969,13.1004224 L5.80096969,11.9005083 C5.92687261,11.8060879 6.00096969,11.6579043 6.00096969,11.5005369 L6.00096969,11.2505548 C6.00096969,11.1124935 5.88904088,11.0005727 5.75096969,11.0005727 L5.50096969,11.0005727 C5.22482732,11.0005727 5.00096969,11.2244143 5.00096969,11.5005369 C5.00096969,11.7766596 4.77711207,12.0005012 4.50096969,12.0005012 C4.22482732,12.0005012 4.00096969,11.7766596 4.00096969,11.5005369 C4.00096969,10.6721691 4.67254257,10.0006443 5.50096969,10.0006443 L5.75096969,10.0006443 C6.44132563,10.0006443 7.00096969,10.5602483 7.00096969,11.2505548 L7.00096969,11.5005369 C7.00096969,11.9726391 6.77867846,12.4171897 6.40096969,12.700451 Z"></path></svg>',
    title: 'Ordered List (Ctrl+Shift+9)',
    command: (state, dispatch, view) => {
      const closestList = getClosestListType(state);

      if (closestList === schema.nodes.ordered_list) {
        // Exit ordered list
        return liftListItem(schema.nodes.list_item)(state, dispatch);
      } else if (closestList === schema.nodes.checkbox_list) {
        // Convert from checkbox to ordered
        return convertListType(schema.nodes.checkbox_item, schema.nodes.ordered_list)(state, dispatch, view);
      } else if (closestList === schema.nodes.bullet_list) {
        // Convert from bullet to ordered
        return convertListType(schema.nodes.list_item, schema.nodes.ordered_list)(state, dispatch, view);
      }
      // Create new ordered list
      return wrapInList(schema.nodes.ordered_list)(state, dispatch);
    },
    isActive: (state) => getClosestListType(state) === schema.nodes.ordered_list,
  },
  {
    id: 'separator-3',
    icon: '',
    title: '',
    command: () => false,
  },
  {
    id: 'notice-note',
    icon: '<svg fill="#5B9DD9" width="24" height="24" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M20 12C20 7.58172 16.4183 4 12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20C16.4183 20 20 16.4183 20 12ZM11 8C11 8.55228 11.4477 9 12 9C12.5523 9 13 8.55228 13 8C13 7.44772 12.5523 7 12 7C11.4477 7 11 7.44772 11 8ZM12 10C13 10 13 11 13 11V16C13 16 13 17 12 17C11 17 11 16 11 16V11C11 11 11 11 10.5 11C10 11 10 10 10 10H12Z"></path></svg>',
    title: 'Note (Ctrl+Shift+N)',
    command: (state, dispatch) => {
      const isActiveThis = isBlockActive(state, schema.nodes.notice, { style: 'note' });
      const isActiveAny = isBlockActive(state, schema.nodes.notice);

      if (isActiveThis) {
        return liftFromNodeType(schema.nodes.notice)(state, dispatch);
      } else if (isActiveAny) {
        if (!dispatch) return true;
        const { $from } = state.selection;
        for (let d = $from.depth; d > 0; d--) {
          const node = $from.node(d);
          if (node.type === schema.nodes.notice) {
            const tr = state.tr.setNodeMarkup($from.before(d), null, { style: 'note' });
            dispatch(tr);
            return true;
          }
        }
        return false;
      }
      return wrapInBlockSmart(schema.nodes.notice, { style: 'note' })(state, dispatch);
    },
    isActive: (state) => isBlockActive(state, schema.nodes.notice, { style: 'note' }),
  },
  {
    id: 'notice-tip',
    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="#66BB6A"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 20C16.4183 20 20 16.4183 20 12C20 7.58172 16.4183 4 12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20ZM9.26825 11.3599L10.9587 13.3885L14.7 8.40006C15.0314 7.95823 15.6582 7.86869 16.1 8.20006C16.5419 8.53143 16.6314 9.15823 16.3 9.60006L11.8 15.6001C11.4128 16.1164 10.645 16.1361 10.2318 15.6402L7.7318 12.6402C7.37824 12.216 7.43556 11.5854 7.85984 11.2318C8.28412 10.8783 8.91468 10.9356 9.26825 11.3599Z"></path></svg>',
    title: 'Tip',
    command: (state, dispatch) => {
      const isActiveThis = isBlockActive(state, schema.nodes.notice, { style: 'tip' });
      const isActiveAny = isBlockActive(state, schema.nodes.notice);

      if (isActiveThis) {
        return liftFromNodeType(schema.nodes.notice)(state, dispatch);
      } else if (isActiveAny) {
        if (!dispatch) return true;
        const { $from } = state.selection;
        for (let d = $from.depth; d > 0; d--) {
          const node = $from.node(d);
          if (node.type === schema.nodes.notice) {
            const tr = state.tr.setNodeMarkup($from.before(d), null, { style: 'tip' });
            dispatch(tr);
            return true;
          }
        }
        return false;
      }
      return wrapInBlockSmart(schema.nodes.notice, { style: 'tip' })(state, dispatch);
    },
    isActive: (state) => isBlockActive(state, schema.nodes.notice, { style: 'tip' }),
  },
  {
    id: 'notice-important',
    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="#9575CD"><path d="M12,16.1500001 L8.79729751,17.8337604 L8.79729751,17.8337604 C8.30845292,18.0907612 7.70382577,17.9028147 7.44682496,17.4139701 C7.34448589,17.2193097 7.30917121,16.9963416 7.34634806,16.779584 L7.95800981,13.2133223 L5.36696906,10.6876818 L5.36696906,10.6876818 C4.97148548,10.3021806 4.96339318,9.66906733 5.34889439,9.27358375 C5.50240299,9.11610012 5.70354541,9.01361294 5.92118244,8.98198843 L9.50191268,8.46167787 L11.1032639,5.21698585 L11.1032639,5.21698585 C11.3476862,4.72173219 11.9473121,4.51839319 12.4425657,4.76281548 C12.6397783,4.86014572 12.7994058,5.01977324 12.8967361,5.21698585 L14.4980873,8.46167787 L18.0788176,8.98198843 L18.0788176,8.98198843 C18.6253624,9.06140605 19.0040439,9.5688489 18.9246263,10.1153938 C18.8930018,10.3330308 18.7905146,10.5341732 18.6330309,10.6876818 L16.0419902,13.2133223 L16.6536519,16.779584 L16.6536519,16.779584 C16.747013,17.3239204 16.3814251,17.8408763 15.8370887,17.9342373 C15.620331,17.9714142 15.397363,17.9360995 15.2027025,17.8337604 L12,16.1500001 Z"></path></svg>',
    title: 'Important',
    command: (state, dispatch) => {
      const isActiveThis = isBlockActive(state, schema.nodes.notice, { style: 'important' });
      const isActiveAny = isBlockActive(state, schema.nodes.notice);

      if (isActiveThis) {
        return liftFromNodeType(schema.nodes.notice)(state, dispatch);
      } else if (isActiveAny) {
        if (!dispatch) return true;
        const { $from } = state.selection;
        for (let d = $from.depth; d > 0; d--) {
          const node = $from.node(d);
          if (node.type === schema.nodes.notice) {
            const tr = state.tr.setNodeMarkup($from.before(d), null, { style: 'important' });
            dispatch(tr);
            return true;
          }
        }
        return false;
      }
      return wrapInBlockSmart(schema.nodes.notice, { style: 'important' })(state, dispatch);
    },
    isActive: (state) => isBlockActive(state, schema.nodes.notice, { style: 'important' }),
  },
  {
    id: 'notice-caution',
    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="#E8A435"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 20C7.58172 20 4 16.4183 4 12C4 7.58172 7.58172 4 12 4C16.4183 4 20 7.58172 20 12C20 16.4183 16.4183 20 12 20ZM12 15C12.5523 15 13 15.4477 13 16C13 16.5523 12.5523 17 12 17C11.4477 17 11 16.5523 11 16C11 15.4477 11.4477 15 12 15ZM12 14C13 14 13 13 13 13L13 10.5L13 8C13 8 13 7 12 7C11 7 11 8 11 8L11 13C11 13 11 14 12 14Z"></path></svg>',
    title: 'Caution',
    command: (state, dispatch) => {
      const isActiveThis = isBlockActive(state, schema.nodes.notice, { style: 'caution' });
      const isActiveAny = isBlockActive(state, schema.nodes.notice);

      if (isActiveThis) {
        return liftFromNodeType(schema.nodes.notice)(state, dispatch);
      } else if (isActiveAny) {
        if (!dispatch) return true;
        const { $from } = state.selection;
        for (let d = $from.depth; d > 0; d--) {
          const node = $from.node(d);
          if (node.type === schema.nodes.notice) {
            const tr = state.tr.setNodeMarkup($from.before(d), null, { style: 'caution' });
            dispatch(tr);
            return true;
          }
        }
        return false;
      }
      return wrapInBlockSmart(schema.nodes.notice, { style: 'caution' })(state, dispatch);
    },
    isActive: (state) => isBlockActive(state, schema.nodes.notice, { style: 'caution' }),
  },
  {
    id: 'notice-warning',
    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="#E57373"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 20C16.4183 20 20 16.4183 20 12C20 7.58172 16.4183 4 12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20ZM9.29289 9.29289C9.68342 8.90237 10.3166 8.90237 10.7071 9.29289L12 10.5858L13.2929 9.29289C13.6834 8.90237 14.3166 8.90237 14.7071 9.29289C15.0976 9.68342 15.0976 10.3166 14.7071 10.7071L13.4142 12L14.7071 13.2929C15.0976 13.6834 15.0976 14.3166 14.7071 14.7071C14.3166 15.0976 13.6834 15.0976 13.2929 14.7071L12 13.4142L10.7071 14.7071C10.3166 15.0976 9.68342 15.0976 9.29289 14.7071C8.90237 14.3166 8.90237 13.6834 9.29289 13.2929L10.5858 12L9.29289 10.7071C8.90237 10.3166 8.90237 9.68342 9.29289 9.29289Z"></path></svg>',
    title: 'Warning',
    command: (state, dispatch) => {
      const isActiveThis = isBlockActive(state, schema.nodes.notice, { style: 'warning' });
      const isActiveAny = isBlockActive(state, schema.nodes.notice);

      if (isActiveThis) {
        return liftFromNodeType(schema.nodes.notice)(state, dispatch);
      } else if (isActiveAny) {
        if (!dispatch) return true;
        const { $from } = state.selection;
        for (let d = $from.depth; d > 0; d--) {
          const node = $from.node(d);
          if (node.type === schema.nodes.notice) {
            const tr = state.tr.setNodeMarkup($from.before(d), null, { style: 'warning' });
            dispatch(tr);
            return true;
          }
        }
        return false;
      }
      return wrapInBlockSmart(schema.nodes.notice, { style: 'warning' })(state, dispatch);
    },
    isActive: (state) => isBlockActive(state, schema.nodes.notice, { style: 'warning' }),
  },
  {
    id: 'separator-4',
    icon: '',
    title: '',
    command: () => false,
  },
  {
    id: 'link',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    title: 'Link (Ctrl+K)',
    command: (_state, _dispatch, view) => {
      if (view) linkEditPopup.toggle(view);
      return true;
    },
    isActive: (state) => isMarkActive(state, schema.marks.link),
  },
  {
    id: 'separator-5',
    icon: '',
    title: '',
    command: () => false,
  },
  {
    id: 'html-tags',
    icon: '<span style="font-size:11px;font-weight:600;letter-spacing:-0.5px">html</span>',
    title: 'HTML Tags',
    command: (_state, _dispatch, view) => {
      if (view) htmlTagDropdown.toggle(view);
      return true;
    },
    isActive: (state) => {
      const markType = schema.marks.html_tag;
      const { from, $from, to, empty } = state.selection;
      if (empty) {
        return (state.storedMarks || $from.marks()).some((m) => m.type === markType);
      }
      let found = false;
      state.doc.nodesBetween(from, to, (node) => {
        if (found) return false;
        if (node.marks.some((m) => m.type === markType)) found = true;
      });
      return found;
    },
  },
  {
    id: 'separator-6',
    icon: '',
    title: '',
    command: () => false,
  },
  {
    id: 'footnote',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16"/><path d="M12 3v12"/><path d="M8 15l4-4 4 4"/></svg>',
    title: 'Footnote',
    command: (state, dispatch, view) => {
      if (!dispatch || !view) return false;
      const { doc } = state;

      // Find a unique label
      const usedLabels = new Set<string>();
      doc.descendants((node) => {
        if (node.type.name === 'footnote_ref') {
          usedLabels.add(node.attrs.label);
        }
      });
      let num = 1;
      while (usedLabels.has(String(num))) num++;
      const label = String(num);

      // Insert footnote_ref at END of selection (not replacing it)
      const { to } = state.selection;
      const ref = schema.nodes.footnote_ref.create({ label });
      let tr = state.tr.insert(to, ref);

      // Move cursor after the inserted ref
      tr.setSelection(TextSelection.create(tr.doc, to + ref.nodeSize));

      // Append footnote_def at end of document
      const def = schema.nodes.footnote_def.create(
        { label },
        schema.nodes.paragraph.create()
      );
      tr = tr.insert(tr.doc.content.size, def);

      dispatch(tr.scrollIntoView());
      view.focus();
      return true;
    },
  },
  {
    id: 'separator-7',
    icon: '',
    title: '',
    command: () => false,
  },
  {
    id: 'interpret-markdown',
    icon: '<span style="font-size:10px;font-weight:700;letter-spacing:-0.3px">Md&#x2193;</span>',
    title: 'Interpret as Markdown',
    command: interpretAsMarkdown,
    isActive: () => false,
    visible: (state) => hasMarkdownPatterns(state),
  },
];
