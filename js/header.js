// v1.14 fixed header: one compact, pinned header for every view.
//   [avatar | back] [title] [actions]
//   [below: week strip / sub-tabs / search box]
import { h, iconBtn } from './ui.js';
import { getActiveProfile } from './store.js';
import { avatarEl, openProfileMenu } from './profiles.js';
import { isDeviceOnly } from './sync.js';
import { icon } from './icons.js';

/** Round avatar button (no dropdown arrow); tapping opens the profile menu. */
export function avatarButton(onOpen = null) {
  const profile = getActiveProfile();
  // "On this device only" (not in the account; also before anyone signed in): a small badge.
  const local = isDeviceOnly(profile.id);
  return h(`button.avatar-btn${local ? '.device-only' : ''}`, {
    type: 'button', onclick: () => { onOpen?.(); openProfileMenu(); },
    'aria-label': `Profile and settings (${profile.name}${local ? ', on this device only' : ''})`, title: 'Profile and settings',
  }, avatarEl(profile, 34), local ? h('span.device-badge', { 'aria-hidden': 'true' }, icon('phone', { size: 10 })) : null);
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
