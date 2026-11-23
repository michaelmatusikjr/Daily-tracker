// v1.14 fixed header: one compact, pinned header for every view.
//   [avatar | back] [title] [actions]
//   [below: week strip / sub-tabs / search box]
import { h, iconBtn } from './ui.js';
import { getActiveProfile } from './store.js';
import { avatarEl, openProfileMenu } from './profiles.js';

/** Round avatar button (no dropdown arrow); tapping opens the profile menu. */
export function avatarButton(onOpen = null) {
  const profile = getActiveProfile();
  return h('button.avatar-btn', {
    type: 'button', onclick: () => { onOpen?.(); openProfileMenu(); },
    'aria-label': `Profile and settings (${profile.name})`, title: 'Profile and settings',
  }, avatarEl(profile, 34));
}

/**
 * title: string or node(s) for the <h1>. back: { label, onclick } shows a back button instead of the avatar.
 * actions: nodes on the right. below: nodes pinned under the title row. cls: extra class on the <header>.
 */
export function appHeader({ title, back = null, actions = [], below = [], cls = '', avatar = true, onAvatar = null } = {}) {
  const lead = back ? iconBtn('arrowLeft', back.label, back.onclick, 'head-back') : avatar ? avatarButton(onAvatar) : null;
  const titleKids = Array.isArray(title) ? title : [title];
  return h(`header.app-head${cls ? '.' + cls : ''}`,
    h('div.app-head-row',
      lead,
      h('h1.app-title.page-title', ...titleKids),
      h('div.head-actions', ...actions.filter(Boolean))),
    ...below.filter(Boolean));
}
