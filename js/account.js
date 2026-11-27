// Settings › Account (SYNC.md › Client flows): create / sign in / passkeys / recovery, the profile
// picker, devices, password, sign out and delete. All text goes through h() (never innerHTML).
import { h, openSheet, toast, confirmDialog, choose } from './ui.js';
import { icon } from './icons.js';
import { getProfiles, getActiveProfile, updateProfile, readProfileForSync, removePlaceholderProfile, isFreshInstall, switchProfile, addProfile } from './store.js';
import * as HH from './household.js';
import { linkKeys, normUsername } from './syncCrypto.js';
import { pushConfig, pushConfigured, pushEnabled } from './push.js';
import { isOwner, inviteRow } from './invites.js';
import { fmtDateShort, toKey } from './dates.js';
import * as S from './sync.js';
import { avatarEl, performDeleteProfile, openProfileEditor } from './profiles.js';
import { photosOfProfiles } from './attachments.js';
import { ctx } from './ctx.js';

const nameKey = (n) => String(n || '').trim().toLowerCase();
const dateOf = (ms) => (Number.isFinite(ms) ? fmtDateShort(toKey(new Date(ms))) : '');

function field(label, input, hint = null) {
  return h('label.field.acct-field', h('span.field-label', label), input, hint ? h('span.field-hint', hint) : null);
}
const pwInput = (label, auto = 'current-password') => h('input.input', { type: 'password', autocomplete: auto, 'aria-label': label, spellcheck: false });

/** Run an async action with the button disabled and a busy label; errors go to errEl. */
async function busy(btn, label, errEl, fn) {
  const old = [...btn.childNodes];
  btn.disabled = true;
  btn.replaceChildren(label);
  if (errEl) errEl.textContent = '';
  try { return await fn(); } catch (e) {
    if (errEl) errEl.textContent = e?.message || 'Something went wrong';
    else toast(e?.message || 'Something went wrong', { force: true, duration: 6000 });
    return undefined;
  } finally { btn.disabled = false; btn.replaceChildren(...old); }
}

// ---------------- The panel (Settings section and the Account sheet) ----------------
/** Settings › Account. null when no server is set up (the app stays fully local). */
export function accountSection() {
  if (!S.accountsAvailable()) return null;
  return h('section.set-group.acct-group', { id: 'set-account' }, h('h2.set-title', 'Account'), h('div.card.set-card.acct-card', accountPanel()));
}

/** "On this device only" label → this sheet. */
export function openAccountSheet() {
  const sheet = openSheet({ title: 'Account', content: h('div.acct-sheet', accountPanel({ onNavigate: () => sheet.close() })), cls: 'acct' });
  return sheet;
}

function accountPanel({ onNavigate = null } = {}) {
  const root = h('div.acct-panel');
  // Full render only when what's shown changes shape; otherwise just the status line (no refetch).
  const sig = () => { const s = S.syncState(); const st = S.syncStatus(); return JSON.stringify([S.hasAccount(), s.username, st?.kind === 'busy' ? 'ok' : st?.kind, s.synced, !!s.pulled, S.cantSyncNote(), getProfiles().map((p) => [p.id, p.name])]); };
  let last = null;
  const render = () => { last = sig(); root.replaceChildren(...(S.hasAccount() ? signedInView(render) : signedOutView())); };
  render();
  // Keep the status fresh while it's on screen.
  const off = S.onSyncChange(() => {
    if (!root.isConnected) { off(); return; }
    // Don't wipe what someone is typing (inline rename / unlock).
    if (root.contains(document.activeElement) && document.activeElement.matches('input, textarea')) return;
    if (sig() !== last) { render(); return; }
    const line = root.querySelector('.acct-status');
    const next = statusLine();
    if (line && next) line.replaceWith(next);
  });
  void onNavigate;
  return root;
}

function signedOutView() {
  return [
    householdSignedOutRow(),
    h('div.set-row.col.acct-block', h('span.set-label', 'Profiles'), profileList(() => ctx.rerender(), { signedIn: false })),
    h('div.set-row.col',
      h('div.set-text',
        h('span.set-label', 'Sync across your devices'),
        h('span.set-desc', 'One account for your household holds your profiles and keeps them the same on every device. It’s end-to-end encrypted: only your devices can read it.')),
      h('div.set-actions.acct-actions',
        h('button.btn.primary', { type: 'button', onclick: () => openCreate() }, 'Create account'),
        h('button.btn.secondary', { type: 'button', onclick: () => openSignIn() }, 'Sign in'),
        S.passkeysSupported() ? h('button.btn.secondary', { type: 'button', onclick: (e) => passkeyFlow(e.currentTarget) }, icon('key', { size: 16 }), 'Sign in with passkey') : null),
      h('button.link-btn.acct-link', { type: 'button', onclick: () => openRecovery() }, 'Forgot password? Use recovery key'),
      h('button.link-btn.acct-link', { type: 'button', id: 'acct-have-invite', onclick: () => ctx.startInviteFlow?.({}) }, 'I have an invite code')),
    inviteRow(),
  ].filter(Boolean);
}

function statusLine() {
  const st = S.syncStatus();
  if (!st) return null;
  const kids = [h('span', st.text)];
  if (st.kind === 'update') kids.push(h('button.btn.primary.small', { type: 'button', onclick: () => location.reload() }, icon('refresh', { size: 16 }), 'Reload'));
  return h(`p.acct-status.${st.kind}`, { role: 'status', 'aria-live': 'polite' }, ...kids);
}

/** What can't be uploaded (too large, refused by the server): it stays on this device only. */
function cantSyncLine() {
  const t = S.cantSyncNote();
  return t ? h('p.acct-cantsync', { role: 'status' }, t) : null;
}

function signedInView(rerender) {
  const s = S.syncState();
  const st = S.syncStatus();
  const out = [];
  out.push(h('div.set-row.acct-head',
    h('span.acct-user', icon('user', { size: 20 })),
    h('div.set-text', h('span.set-label', s.username || 'Account'), statusLine(), cantSyncLine()),
    st && ['ok', 'error', 'offline'].includes(st.kind) ? h('button.btn.ghost.small', { type: 'button', onclick: async (e) => { await busy(e.currentTarget, 'Syncing…', null, () => S.syncNow()); rerender(); } }, icon('refresh', { size: 16 }), 'Sync now') : null));
  if (st?.kind === 'expired') {
    out.push(h('div.set-actions.pad',
      h('button.btn.primary.small', { type: 'button', onclick: () => openSignIn({ username: s.username }) }, 'Sign in again'),
      S.passkeysSupported() ? h('button.btn.secondary.small', { type: 'button', onclick: (e) => passkeyFlow(e.currentTarget) }, icon('key', { size: 16 }), 'Passkey') : null,
      h('button.btn.ghost.small', { type: 'button', onclick: () => openSignOut() }, 'Sign out')));
    out.push(profilesBlock(rerender));
    return out;
  }
  if (st?.kind === 'locked') { out.push(unlockForm(rerender)); return out; }
  out.push(profilesBlock(rerender));
  const hh = householdBlock(rerender);
  if (hh) out.push(hh);
  out.push(detailsBlock(rerender));
  if (pushConfigured() && !pushEnabled()) {
    out.push(h('div.set-row.col.acct-block',
      h('span.set-label', 'Get set up'),
      h('span.set-desc', 'Closed-app reminders aren’t on for this device yet. The setup guide turns them on in a few taps and sends a test notification.'),
      h('div.set-actions', h('button.btn.secondary.small', { type: 'button', id: 'acct-setup', onclick: () => ctx.startInviteFlow?.({ start: 'notify' }) }, icon('bell', { size: 16 }), 'Set up notifications'))));
  }
  const inv = inviteRow();
  if (inv) out.push(inv);
  out.push(h('div.set-actions.pad.acct-bottom',
    h('button.btn.secondary.small', { type: 'button', onclick: () => openChangePassword() }, 'Change password'),
    h('button.btn.secondary.small', { type: 'button', onclick: () => openSignOut() }, icon('logOut', { size: 16 }), 'Sign out'),
    h('button.btn.danger-ghost.small', { type: 'button', onclick: () => openDeleteAccount() }, 'Delete account')));
  return out;
}

/** Each profile with "Synced" or "On this device only" + "Sync to account". */
function profileList(rerender, { signedIn = true } = {}) {
  const active = getActiveProfile();
  return h('ul.acct-profiles', { role: 'list' }, getProfiles().map((p) => {
    const synced = signedIn && S.isSynced(p.id);
    const readable = !!readProfileForSync(p.id);
    const li = h('li.acct-prof');
    const err = h('p.form-error', { role: 'alert' });
    const syncBtn = h('button.btn.secondary.small', { type: 'button', onclick: () => syncOne(p, li, err, rerender) }, icon('cloud', { size: 16 }), 'Sync to account');
    const tag = !S.accountsAvailable() ? null : synced ? h('span.badge.ok.small-badge', icon('cloud', { size: 13 }), 'Synced') : h('span.device-only-tag', icon('phone', { size: 13 }), 'On this device only');
    li.append(...[avatarEl(p, 32), h('div.acct-prof-text',
      h('span.acct-prof-name', p.name, p.id === active?.id ? h('span.acct-prof-current', ' · current') : null), tag),
    signedIn && !synced && readable && S.canSyncProfiles() ? syncBtn : null,
    h('button.btn.ghost.small.acct-prof-edit', { type: 'button', 'aria-label': `Edit ${p.name}`, onclick: () => openProfileEditor(p) }, icon('edit', { size: 16 }), 'Edit'),
    err].filter(Boolean));
    return li;
  }));
}

/** Profiles (no account server set up): the same list, without sync labels. */
export function profilesSection() {
  return h('section.set-group', h('h2.set-title', 'Profiles'), h('div.card.set-card', h('div.set-row.col.acct-block', profileList(() => ctx.rerender(), { signedIn: false }))));
}

function profilesBlock(rerender) {
  const list = profileList(rerender);
  const waiting = S.isSignedIn() && !S.syncState().locked && !S.syncState().pulled && getProfiles().some((p) => !S.isSynced(p.id));
  return h('div.set-row.col.acct-block', h('span.set-label', 'Profiles'), list,
    waiting ? h('p.set-desc', 'Your account hasn’t finished downloading to this device yet. Once it has, you can add this device’s profiles to it.') : null);
}

async function syncOne(p, li, err, rerender) {
  const clash = S.accountNameClash(p.name, p.id);
  if (!clash) {
    if (!(await S.syncProfiles([p.id]))) { err.textContent = 'Your account hasn’t finished downloading yet. Try again once it has synced.'; return; }
    toast(`${p.name} will sync to your account`, { force: true }); rerender(); return;
  }
  // Names are unique in an account: rename first, inline.
  if (li.querySelector('.acct-rename')) return;
  const input = h('input.input', { type: 'text', maxlength: 40, value: p.name, 'aria-label': `New name for ${p.name}` });
  const go = async () => {
    const n = input.value.trim();
    if (!n) { err.textContent = 'Please enter a name.'; return; }
    if (S.accountNameClash(n, p.id)) { err.textContent = `Another profile in your account is called “${n}”. Choose a different name.`; return; }
    if (!S.canSyncProfiles()) { err.textContent = 'Your account hasn’t finished downloading yet. Try again once it has synced.'; return; }
    if (!updateProfile(p.id, { name: n })) { err.textContent = 'Couldn’t save – storage is full.'; return; }
    await S.syncProfiles([p.id]);
    toast(`${n} will sync to your account`, { force: true });
    rerender();
  };
  err.textContent = `Your account already has a profile called “${clash.name}”. Rename this one to sync it.`;
  li.append(h('form.acct-rename.inline-form', { onsubmit: (e) => { e.preventDefault(); go(); } }, input, h('button.btn.primary.small', { type: 'submit' }, 'Rename and sync')));
  input.focus();
}

/** Passkeys and signed-in devices (loaded from the server). */
// Last passkeys/devices answer, per account: every Settings re-render (any toggle) rebuilds this block,
// and showing "Loading…" until the server answers made everything below it jump (flicker on iOS).
let infoCache = null; // { user, json, info }
function detailsBlock(rerender) {
  const user = S.syncState().username;
  const cached = infoCache && infoCache.user === user ? infoCache : null;
  const box = h('div.acct-details');
  const fill = (info) => {
    const pk = h('div.set-row.col.acct-block',
      h('span.set-label', 'Passkeys'),
      h('span.set-desc', 'Sign in with Face ID, Touch ID or your device’s screen lock.'),
      info.passkeys.length ? h('ul.acct-list', { role: 'list' }, info.passkeys.map((k) => h('li',
        h('div.set-text', h('span', k.name), h('span.set-desc', `Added ${dateOf(k.createdAt)}${k.prf ? '' : ' · needs your password on a new device'}`)),
        h('button.btn.ghost.small', { type: 'button', 'aria-label': `Remove passkey ${k.name}`, onclick: async (e) => {
          if (!(await confirmDialog('Remove this passkey?', `“${k.name}” won’t sign in to your account any more.`, { ok: 'Remove', danger: true }))) return;
          const ok = await busy(e.currentTarget, 'Removing…', null, async () => { await S.removePasskey(k.id); return true; });
          if (ok) toast('Passkey removed', { force: true });
          rerender();
        } }, 'Remove')))) : null,
      S.passkeysSupported() ? h('div.set-actions', h('button.btn.secondary.small', { type: 'button', onclick: () => openAddPasskey(rerender) }, icon('key', { size: 16 }), 'Add a passkey')) : null);
    const dv = h('div.set-row.col.acct-block',
      h('span.set-label', 'Signed-in devices'),
      h('ul.acct-list', { role: 'list' }, info.sessions.map((d) => h('li',
        h('div.set-text', h('span', d.deviceName), h('span.set-desc', d.current ? 'This device' : `Last used ${dateOf(d.lastSeen)}`)),
        d.current ? null : h('button.btn.ghost.small', { type: 'button', 'aria-label': `Sign out ${d.deviceName}`, onclick: async () => {
          if (!(await confirmDialog(`Sign out ${d.deviceName}?`, 'That device stops syncing until someone signs in there again. Its data stays on it.', { ok: 'Sign out', danger: true }))) return;
          try { await S.signOutDevice(d.id); toast('Signed out that device', { force: true }); } catch (x) { toast(x.message, { force: true }); }
          rerender();
        } }, 'Sign out')))));
    box.replaceChildren(pk, dv);
  };
  if (cached) fill(cached.info); else box.append(h('p.set-desc.pad', 'Loading passkeys and devices…'));
  // Always refresh in the background, but only touch the DOM when something changed.
  S.accountInfo().then((info) => {
    const json = JSON.stringify(info);
    const same = infoCache && infoCache.user === user && infoCache.json === json;
    infoCache = { user, json, info };
    if (!same || !cached) fill(info);
  }).catch((e) => { if (!cached) box.replaceChildren(h('p.set-desc.pad', `Couldn’t load passkeys and devices: ${e.message}`)); });
  return box;
}

function unlockForm(rerender) {
  const pw = pwInput('Password');
  const err = h('p.form-error', { role: 'alert' });
  let useRec = false;
  const rec = h('input.input.mono', { type: 'text', autocomplete: 'off', spellcheck: false, 'aria-label': 'Recovery key', placeholder: 'XXXX XXXX …', hidden: true });
  const label = h('span.field-label', 'Password');
  const btn = h('button.btn.primary.small', { type: 'submit' }, 'Unlock');
  const toggle = h('button.link-btn', { type: 'button', onclick: () => { useRec = !useRec; pw.hidden = useRec; rec.hidden = !useRec; label.textContent = useRec ? 'Recovery key' : 'Password'; toggle.textContent = useRec ? 'Use password instead' : 'Use recovery key instead'; } }, 'Use recovery key instead');
  const form = h('form.set-row.col', { onsubmit: async (e) => {
    e.preventDefault();
    const r = await busy(btn, 'Unlocking…', err, () => S.unlock(useRec ? { recovery: rec.value } : { password: pw.value }));
    if (r) { rerender(); afterSignIn({ created: false }); }
  } },
  h('span.set-desc', 'This passkey can’t unlock your data on this device by itself. Enter your password once (or your recovery key).'),
  h('label.field.acct-field', label, pw, rec), err, h('div.set-actions', btn, toggle));
  return form;
}

// ---------------- Flows ----------------
function openCreate({ inviteCode = '', onCancel = null, linkAfter = false } = {}) {
  const user = h('input.input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: false, maxlength: 40, 'aria-label': 'Username', autofocus: true });
  const pw = pwInput('Password', 'new-password'), pw2 = pwInput('Confirm password', 'new-password');
  // With an invite code the server's register key is not needed (and never shared).
  const reg = inviteCode ? null : h('input.input', { type: 'password', autocomplete: 'off', spellcheck: false, 'aria-label': 'Register key', value: pushConfig().registerKey || '' });
  const err = h('p.form-error', { role: 'alert' });
  const btn = h('button.btn.primary', { type: 'button' }, 'Create account');
  let created = false;
  const submit = async () => {
    if (!user.value.trim()) { err.textContent = 'Choose a username.'; return; }
    if (pw.value.length < 10) { err.textContent = 'The password needs at least 10 characters.'; return; }
    if (pw.value !== pw2.value) { err.textContent = 'The passwords don’t match.'; return; }
    if (reg && !reg.value.trim()) { err.textContent = 'Enter the server’s register key.'; return; }
    const r = await busy(btn, 'Creating…', err, () => S.createAccount({ username: user.value, password: pw.value, registerKey: reg ? reg.value : '', inviteCode }));
    if (!r) return;
    if (linkAfter) await linkWithPassword(user.value, pw.value);
    created = true;
    sheet.close();
    showRecovery(r.recovery);
  };
  btn.onclick = submit;
  const sheet = openSheet({
    title: 'Create account', cls: 'acct',
    content: h('form.form', { onsubmit: (e) => { e.preventDefault(); submit(); }, novalidate: true },
      h('p.set-desc', 'Your data is encrypted on this device before it’s uploaded. Only your devices can read it.'),
      field('Username', user, '3–40 letters, digits, dots, dashes or underscores.'),
      field('Password', pw, 'At least 10 characters. It never leaves this device.'),
      field('Confirm password', pw2),
      reg ? field('Register key', reg, 'The key of your server (the same one as for reminders).') : null,
      err, h('button', { type: 'submit', hidden: true })),
    footer: [h('span'), btn],
    onClose: () => { if (!created) onCancel?.(); },
  });
}

// A setup-wizard account step (js/setup.js): create the account with the invite code; `onDone` runs when
// the whole creation flow (recovery key, profile picker, passkey offer) is finished.
let createdHook = null;
/** onDone({ offerPicker }) runs when the flow ends; onCancel() when the sheet is closed without creating. */
export function openCreateWithInvite({ code, onDone, onCancel }) {
  const fresh = isFreshInstall();
  // A brand-new install continues like the first screen's sign-in: the tour comes first, then the picker.
  if (fresh) { firstFlow = { onDone: (r) => onDone(r) }; createdHook = null; } else { firstFlow = null; createdHook = () => onDone({ offerPicker: false }); }
  openCreate({ inviteCode: code, onCancel: () => { firstFlow = null; createdHook = null; onCancel?.(); } });
}
/** Plain sign-in sheet (the wizard's "I already have an account"). */
export const openSignInSheet = () => openSignIn();

/** The recovery key, shown once. Continuing needs the "I've saved it" box. */
function showRecovery(text) {
  const box = h('input', { type: 'checkbox', id: 'rec-saved' });
  const next = h('button.btn.primary', { type: 'button', disabled: true }, 'Continue');
  box.addEventListener('change', () => { next.disabled = !box.checked; });
  const keyEl = h('p.recovery-key.mono', { 'aria-label': 'Recovery key' }, text);
  const copy = h('button.btn.secondary.small', { type: 'button', onclick: async () => {
    try { await navigator.clipboard.writeText(text); toast('Recovery key copied', { force: true }); } catch { toast('Couldn’t copy – select the key and copy it', { force: true }); }
  } }, icon('copy', { size: 16 }), 'Copy');
  let done = false;
  next.onclick = () => { if (!box.checked) return; done = true; sheet.close(); afterSignIn({ created: true }); };
  const sheet = openSheet({
    title: 'Your recovery key', cls: 'acct',
    content: [
      h('p.set-desc', 'If you forget your password, this key is the only way back into your data. Save it somewhere safe (a password manager, or on paper). It’s shown only now.'),
      keyEl, h('div.set-actions', copy),
      h('label.check-row', { for: 'rec-saved' }, box, h('span', 'I’ve saved my recovery key')),
    ],
    footer: [h('span'), next],
    onClose: () => { if (!done) setTimeout(() => afterSignIn({ created: true }), 300); },
  });
}

// First screen of a brand-new install: signing in replaces the untouched placeholder profile.
let firstFlow = null;
/** Open the sign-in sheet from the first screen; onDone({ offerPicker }) runs once the account is on this device. */
export function openFirstSignIn({ onDone }) { firstFlow = { onDone }; openSignIn({ first: true }); }
/** The first screen was left another way (Get started): a later sign-in is an ordinary one. */
export function cancelFirstSignIn() { firstFlow = null; stopFirstWait?.(); }
/** Already signed in on a fresh install (e.g. after "Later" on the download dialog): continue the signed-in flow instead of asking again. */
export function resumeFirstSignIn({ onDone }) { firstFlow = { onDone }; stopFirstWait?.(); afterSignIn({ created: false }); }
let stopFirstWait = null; // listener that continues the first-screen flow once a download that was postponed completes
/** Offer this device's profiles for sync (the tour came first for an empty account). */
export function offerSyncPicker() {
  const candidates = getProfiles().filter((p) => !S.isSynced(p.id) && readProfileForSync(p.id));
  if (candidates.length && S.canSyncProfiles()) openPicker(candidates, { preselect: false, onDone: () => ctx.rerender?.() });
}

function openSignIn({ username = '', first = false, linkAfter = false } = {}) {
  const user = h('input.input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: false, maxlength: 40, 'aria-label': 'Username', value: username, autofocus: !username });
  const pw = pwInput('Password');
  if (username) pw.setAttribute('autofocus', '');
  const err = h('p.form-error', { role: 'alert' });
  const btn = h('button.btn.primary', { type: 'button' }, 'Sign in');
  const submit = async () => {
    if (!user.value.trim() || !pw.value) { err.textContent = 'Enter your username and password.'; return; }
    const r = await busy(btn, 'Signing in…', err, () => S.signIn({ username: user.value, password: pw.value }));
    if (!r) return;
    if (linkAfter) await linkWithPassword(user.value, pw.value);
    sheet.close();
    afterSignIn({ created: false, error: r.error });
  };
  // Household (Google) sign-in first: no password needed once an owner has linked the account.
  const google = linkAfter ? null : googleButton({ onSignedIn: (me) => { sheet.close(); continueWithGoogle(me); } });
  btn.onclick = submit;
  const sheet = openSheet({
    title: 'Sign in', cls: 'acct',
    content: h('form.form', { onsubmit: (e) => { e.preventDefault(); submit(); }, novalidate: true },
      google ? h('div.hh-signin', google, h('p.hh-or', { 'aria-hidden': 'true' }, h('span', 'or use your Daily Tracker username'))) : null,
      linkAfter ? h('p.set-desc', 'Sign in once with your Daily Tracker username and password. Then everyone in your household signs in with Google.') : null,
      field('Username', user), field('Password', pw), err,
      first && S.passkeysSupported() ? h('button.btn.secondary', { type: 'button', onclick: async (e) => {
        const r = await busy(e.currentTarget, 'Waiting for passkey…', err, () => S.passkeySignIn());
        if (!r) return;
        sheet.close();
        if (r.needsUnlock) openUnlock(); else afterSignIn({ created: false, error: r.error });
      } }, icon('key', { size: 16 }), 'Sign in with passkey') : null,
      h('button.link-btn', { type: 'button', onclick: () => { sheet.close(); openRecovery(user.value); } }, 'Forgot password? Use recovery key'),
      h('button', { type: 'submit', hidden: true })),
    footer: [h('span'), btn],
  });
}

async function passkeyFlow(btn) {
  const r = await busy(btn, 'Waiting for passkey…', null, () => S.passkeySignIn());
  if (!r) return;
  if (r.needsUnlock) { openUnlock(); return; }
  afterSignIn({ created: false, error: r.error });
}

function openUnlock() {
  const pw = pwInput('Password');
  pw.setAttribute('autofocus', '');
  const rec = h('input.input.mono', { type: 'text', autocomplete: 'off', spellcheck: false, 'aria-label': 'Recovery key', hidden: true });
  const err = h('p.form-error', { role: 'alert' });
  const btn = h('button.btn.primary', { type: 'button' }, 'Unlock');
  let useRec = false;
  const label = h('span.field-label', 'Password');
  const toggle = h('button.link-btn', { type: 'button', onclick: () => { useRec = !useRec; pw.hidden = useRec; rec.hidden = !useRec; label.textContent = useRec ? 'Recovery key' : 'Password'; toggle.textContent = useRec ? 'Use password instead' : 'Use recovery key instead'; } }, 'Use recovery key instead');
  const submit = async () => {
    const r = await busy(btn, 'Unlocking…', err, () => S.unlock(useRec ? { recovery: rec.value } : { password: pw.value }));
    if (!r) return;
    sheet.close();
    afterSignIn({ created: false, error: r.error });
  };
  btn.onclick = submit;
  const sheet = openSheet({
    title: 'Unlock your data', cls: 'acct',
    content: h('form.form', { onsubmit: (e) => { e.preventDefault(); submit(); }, novalidate: true },
      h('p.set-desc', `Signed in as ${S.syncState().username}. This passkey can’t unlock your encrypted data by itself, so enter your password once on this device.`),
      h('label.field.acct-field', label, pw, rec), err, toggle, h('button', { type: 'submit', hidden: true })),
    footer: [h('span'), btn],
  });
}

function openRecovery(username = '') {
  const user = h('input.input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: false, maxlength: 40, 'aria-label': 'Username', value: username, autofocus: true });
  const rec = h('textarea.input.mono', { rows: 2, autocomplete: 'off', spellcheck: false, autocapitalize: 'characters', 'aria-label': 'Recovery key' });
  const pw = pwInput('New password', 'new-password'), pw2 = pwInput('Confirm new password', 'new-password');
  const err = h('p.form-error', { role: 'alert' });
  const btn = h('button.btn.primary', { type: 'button' }, 'Recover');
  const submit = async () => {
    if (pw.value.length < 10) { err.textContent = 'The new password needs at least 10 characters.'; return; }
    if (pw.value !== pw2.value) { err.textContent = 'The passwords don’t match.'; return; }
    const r = await busy(btn, 'Recovering…', err, () => S.recoverAccount({ username: user.value, recovery: rec.value, newPassword: pw.value }));
    if (!r) return;
    sheet.close();
    toast('Password changed. Other devices were signed out.', { force: true, duration: 6000 });
    afterSignIn({ created: false, error: r.error });
  };
  btn.onclick = submit;
  const sheet = openSheet({
    title: 'Use recovery key', cls: 'acct',
    content: h('form.form', { onsubmit: (e) => { e.preventDefault(); submit(); }, novalidate: true },
      h('p.set-desc', 'Sets a new password. Every other device is signed out and needs the new password.'),
      field('Username', user), field('Recovery key', rec), field('New password', pw, 'At least 10 characters.'), field('Confirm new password', pw2), err,
      h('button', { type: 'submit', hidden: true })),
    footer: [h('span'), btn],
  });
}

/**
 * After signing in or up: the account's profiles are on this device now. Ask which of this device's
 * own profiles to sync (rename step for name clashes), then offer a passkey (new accounts).
 */
function afterSignIn({ created, error = null }) {
  // The account must be downloaded completely before this device's profiles can be added to it
  // (otherwise it isn't known which profiles and names it already has).
  if (!created && !S.syncState().pulled) { openDownloadFailed(error, () => afterSignIn({ created })); return; }
  // First screen of a new install: the account's profiles replace the untouched placeholder.
  const first = firstFlow;
  firstFlow = null;
  const hook = createdHook;
  createdHook = null;
  const removed = first ? removePlaceholderProfile() : false;
  // A new account is offered a passkey in every flow (after the picker, before the first screen / wizard moves on).
  const passkey = async () => { if (created && S.passkeysSupported()) await offerPasskey(); };
  if (first && !removed && getProfiles().length <= 1) { passkey().finally(() => { first.onDone({ offerPicker: true }); applyMyProfile(); }); return; } // empty account: tour first
  const candidates = getProfiles().filter((p) => !S.isSynced(p.id) && readProfileForSync(p.id));
  let advanced = false; // runs once, whether the picker was finished or dismissed
  const then = async () => {
    if (advanced) return;
    advanced = true;
    try { await passkey(); } catch { /* the offer is optional */ }
    if (first) first.onDone({ offerPicker: false });
    else { ctx.rerender?.(); hook?.(); }
    applyMyProfile();
  };
  if (!candidates.length) { then(); return; }
  openPicker(candidates, { preselect: created, onDone: then });
}

/** Signed in, but the account didn't download completely: say why, offer Retry. */
function openDownloadFailed(error, onPulled) {
  const msg = h('p.set-desc', `Signed in, but your account couldn’t be downloaded to this device: ${error || 'the download didn’t finish'}. This device’s own profiles can be added to the account once it has downloaded. It keeps trying automatically.`);
  const err = h('p.form-error', { role: 'alert' });
  const btn = h('button.btn.primary', { type: 'button' }, icon('refresh', { size: 16 }), 'Retry');
  let done = false;
  const proceed = () => { if (done) return; done = true; off(); sheet.close(); onPulled(); };
  const off = S.onSyncChange(() => { if (S.syncState().pulled) proceed(); });
  btn.onclick = async () => {
    const r = await busy(btn, 'Downloading…', err, () => S.retryFirstSync());
    if (r?.pulled) proceed();
    else if (r) err.textContent = `Still couldn’t download: ${r.error}`;
  };
  const sheet = openSheet({
    title: 'Download didn’t finish', cls: 'acct',
    content: [msg, err],
    footer: [h('button.btn.ghost', { type: 'button', onclick: () => sheet.close() }, 'Later'), btn],
    onClose: () => {
      off();
      if (done) return;
      if (firstFlow) {
        // First screen still up ("Later"): keep waiting for the automatic retry, then carry on from there.
        stopFirstWait?.();
        const wait = S.onSyncChange(() => { if (S.syncState().pulled) { wait(); stopFirstWait = null; onPulled(); } });
        stopFirstWait = wait;
        return;
      }
      done = true; ctx.rerender?.();
    },
  });
}

/** Per device profile: Sync to account / Keep on this device only (default) / Delete from this device. */
function openPicker(candidates, { preselect, onDone }) {
  const rows = candidates.map((p) => {
    const group = 'pick-' + p.id;
    const opt = (value, label, checked) => h('label.check-row.picker-opt', h('input', { type: 'radio', name: group, value, checked }), h('span', label));
    const opts = h('div.picker-opts', { role: 'radiogroup', 'aria-label': `What to do with ${p.name}` },
      opt('sync', 'Sync to account', !!preselect), opt('keep', 'Keep on this device only', !preselect), opt('delete', 'Delete from this device', false));
    const rename = h('input.input', { type: 'text', maxlength: 40, value: p.name, 'aria-label': `New name for ${p.name}` });
    const note = h('p.field-hint');
    const renameWrap = h('div.picker-rename', { hidden: true }, note, rename);
    const li = h('li.picker-row', h('div.picker-head', avatarEl(p, 32), h('span.picker-name', p.name)), opts, renameWrap);
    const choice = () => opts.querySelector('input:checked')?.value || 'keep';
    return { p, choice, rename, renameWrap, note, li, opts };
  });
  const err = h('p.form-error', { role: 'alert' });
  const refresh = () => {
    for (const r of rows) {
      const clash = r.choice() === 'sync' && S.accountNameClash(r.p.name, r.p.id);
      r.renameWrap.hidden = !clash && nameKey(r.rename.value) === nameKey(r.p.name);
      if (clash) r.note.textContent = `Your account already has “${clash.name}”. Rename this profile to sync it:`;
    }
  };
  rows.forEach((r) => r.opts.addEventListener('change', () => { err.textContent = ''; refresh(); }));
  refresh();
  const btn = h('button.btn.primary', { type: 'button' }, 'Done');
  let finished = false;
  btn.onclick = async () => {
    err.textContent = '';
    const chosen = rows.filter((r) => r.choice() === 'sync');
    const doomed = rows.filter((r) => r.choice() === 'delete');
    if (chosen.length && !S.canSyncProfiles()) { err.textContent = 'Your account hasn’t finished downloading yet. Try again once it has synced.'; return; }
    // The app always keeps at least one profile.
    const gone = new Set(doomed.map((r) => r.p.id));
    if (getProfiles().every((p) => gone.has(p.id))) { err.textContent = 'Keep at least one profile: choose Sync or Keep for one of them.'; return; }
    const taken = new Set(S.syncedIds().map((id) => nameKey(getProfiles().find((p) => p.id === id)?.name)));
    for (const r of chosen) {
      const n = (r.renameWrap.hidden ? r.p.name : r.rename.value).trim();
      if (!n) { err.textContent = 'Every profile needs a name.'; r.rename.focus(); return; }
      if (taken.has(nameKey(n))) { r.renameWrap.hidden = false; r.note.textContent = `“${n}” is already used in your account. Choose another name:`; err.textContent = 'Names must be unique in your account.'; r.rename.focus(); return; }
      taken.add(nameKey(n));
      r.newName = n;
    }
    if (doomed.length) {
      const names = doomed.map((r) => r.p.name);
      const who = names.length === 1 ? names[0] : names.join(', ');
      if (!(await confirmDialog(names.length === 1 ? `Delete ${who}?` : `Delete ${names.length} profiles?`, `All of ${names.length === 1 ? `${who}’s` : 'their'} tasks, habits, workouts, journal and settings will be removed from this device${names.length === 1 ? '' : `: ${who}`}.`, { ok: 'Continue', danger: true }))) return;
      if (!(await confirmDialog('Are you absolutely sure?', `This cannot be undone: ${who} ${names.length === 1 ? 'is' : 'are'} deleted from this device. Export a backup first if you might need ${names.length === 1 ? 'it' : 'them'}.`, { ok: names.length === 1 ? `Delete ${who}` : `Delete ${names.length} profiles`, danger: true }))) return;
    }
    for (const r of chosen) if (r.newName !== r.p.name && !updateProfile(r.p.id, { name: r.newName })) { err.textContent = 'Couldn’t rename – storage is full.'; return; }
    if (chosen.length && !(await S.syncProfiles(chosen.map((r) => r.p.id)))) { err.textContent = 'Couldn’t add the profiles – try again once your account has synced.'; return; }
    finished = true; // before the deletes: deleting the active profile closes sheets (onClose) mid-loop
    // Another tab may have synced a profile while this picker was open: "this device" deletes never reach the account.
    const kept = [];
    for (const r of doomed) { if (S.isSynced(r.p.id)) kept.push(r.p.name); else performDeleteProfile(r.p); }
    sheet.close();
    if (kept.length) toast(`${kept.join(', ')} ${kept.length === 1 ? 'is' : 'are'} now synced, so ${kept.length === 1 ? 'it was' : 'they were'} not deleted. Delete ${kept.length === 1 ? 'it' : 'them'} from the profile menu to remove from the account.`, { force: true, duration: 8000 });
    if (chosen.length) toast(`${chosen.length === 1 ? chosen[0].newName : `${chosen.length} profiles`} will sync to your account`, { force: true });
    onDone?.();
  };
  const sheet = openSheet({
    title: 'Sync this device’s profiles?', cls: 'acct',
    content: [
      h('p.set-desc', 'Profiles already in your account are on this device now. For each of this device’s profiles, choose to add it to the account, keep it on this device only (you can sync it later in Settings › Account), or delete it from this device.'),
      h('ul.picker-list', { role: 'list' }, rows.map((r) => r.li)),
      err,
    ],
    footer: [h('button.btn.ghost', { type: 'button', onclick: () => sheet.close() }, 'Not now'), btn],
    onClose: () => { if (!finished) onDone?.(); },
  });
}

async function offerPasskey() {
  const yes = await confirmDialog('Add a passkey?', 'Sign in on your other devices with Face ID, Touch ID or the screen lock instead of typing your password.', { ok: 'Add a passkey' });
  if (!yes) { ctx.rerender?.(); return; }
  try {
    const r = await S.addPasskey({});
    toast(r.prf ? 'Passkey added' : 'Passkey added. New devices will ask for your password once.', { force: true, duration: 6000 });
  } catch (e) { toast(e.message, { force: true }); }
  ctx.rerender?.();
}

function openAddPasskey(rerender) {
  if (S.hasFlowKey()) {
    S.addPasskey({}).then((r) => toast(r.prf ? 'Passkey added' : 'Passkey added. New devices will ask for your password once.', { force: true, duration: 6000 }))
      .catch((e) => toast(e.message, { force: true })).finally(() => rerender());
    return;
  }
  const pw = pwInput('Password');
  pw.setAttribute('autofocus', '');
  const err = h('p.form-error', { role: 'alert' });
  const btn = h('button.btn.primary', { type: 'button' }, 'Add passkey');
  const submit = async () => {
    if (!pw.value) { err.textContent = 'Enter your password.'; return; }
    const r = await busy(btn, 'Adding…', err, () => S.addPasskey({ password: pw.value }));
    if (!r) return;
    sheet.close();
    toast(r.prf ? 'Passkey added' : 'Passkey added. New devices will ask for your password once.', { force: true, duration: 6000 });
    rerender();
  };
  btn.onclick = submit;
  const sheet = openSheet({
    title: 'Add a passkey', cls: 'acct',
    content: h('form.form', { onsubmit: (e) => { e.preventDefault(); submit(); }, novalidate: true },
      h('p.set-desc', 'Your password lets the new passkey unlock your encrypted data on other devices.'),
      field('Password', pw), err, h('button', { type: 'submit', hidden: true })),
    footer: [h('span'), btn],
  });
}

function openChangePassword() {
  const cur = pwInput('Current password'), next = pwInput('New password', 'new-password'), next2 = pwInput('Confirm new password', 'new-password');
  cur.setAttribute('autofocus', '');
  const err = h('p.form-error', { role: 'alert' });
  const btn = h('button.btn.primary', { type: 'button' }, 'Change password');
  const submit = async () => {
    if (next.value.length < 10) { err.textContent = 'The new password needs at least 10 characters.'; return; }
    if (next.value !== next2.value) { err.textContent = 'The new passwords don’t match.'; return; }
    const r = await busy(btn, 'Changing…', err, async () => { await S.changePassword({ current: cur.value, next: next.value }); return true; });
    if (!r) return;
    sheet.close();
    toast('Password changed. Your other devices were signed out.', { force: true, duration: 6000 });
    relinkAfterPasswordChange(next.value);
  };
  btn.onclick = submit;
  const sheet = openSheet({
    title: 'Change password', cls: 'acct',
    content: h('form.form', { onsubmit: (e) => { e.preventDefault(); submit(); }, novalidate: true },
      field('Current password', cur), field('New password', next, 'At least 10 characters.'), field('Confirm new password', next2), err,
      h('button', { type: 'submit', hidden: true })),
    footer: [h('span'), btn],
  });
}

async function openSignOut() {
  const synced = S.syncedIds().map((id) => getProfiles().find((p) => p.id === id)?.name).filter(Boolean);
  const what = synced.length ? `${synced.join(', ')} ${synced.length === 1 ? 'is' : 'are'} in your account.` : '';
  const keepNote = synced.length ? ' If you keep copies, edits you make to them while signed out (deleted tasks and other items too) sync to your account when you sign in again. Deleting a whole kept profile only removes it from this device.' : '';
  let c = await choose('Sign out?', `${what} Your account isn’t changed.${keepNote}`.trim(), [
    { value: 'keep', label: 'Keep copies on this device', style: 'primary' },
    { value: 'remove', label: 'Remove from this device', style: 'danger' },
    { value: null, label: 'Cancel', style: 'ghost' },
  ]);
  if (!c) return;
  const cantRemove = (reason) => choose('Can’t remove yet', reason, [
    { value: 'keep', label: 'Keep copies on this device', style: 'primary' },
    { value: null, label: 'Cancel', style: 'ghost' },
  ]);
  if (c === 'remove') {
    toast('Checking that everything is uploaded…', { force: true });
    const why = await S.checkRemove();
    if (why) {
      c = await cantRemove(why);
      if (!c) return;
    }
  }
  if (c === 'remove') {
    const ids = S.syncedIds();
    let photos = 0;
    try { photos = await photosOfProfiles(ids); } catch { /* ignore */ }
    const names = synced.length ? synced.join(', ') : 'The account’s profiles';
    // Remove is only offered once every photo on this device is in the account (checkRemove).
    const photoNote = photos ? ` Their ${photos} photo${photos === 1 ? ' is' : 's are'} deleted from this device too (${photos === 1 ? 'it stays' : 'they stay'} in your account).` : '';
    if (!(await confirmDialog('Remove from this device?', `Everything in ${names} has been uploaded. ${synced.length === 1 ? 'It is' : 'They are'} removed from this device, stay in your account and come back when you sign in again.${photoNote}`, { ok: 'Remove', danger: true }))) return;
  }
  const viaGoogle = S.syncState().via === 'google';
  let r = await S.signOut({ remove: c === 'remove' });
  if (!r.ok) {
    const again = await cantRemove(r.reason);
    if (!again) { ctx.rerender?.(); return; }
    c = 'keep';
    r = await S.signOut({ remove: false });
  }
  if (viaGoogle) await HH.signOutHousehold();
  toast(c === 'remove' ? 'Signed out and removed from this device' : 'Signed out. Your profiles stay on this device.', { force: true });
  ctx.rerender?.();
}

async function openDeleteAccount() {
  if (!(await confirmDialog('Delete your account?', 'All synced data is deleted from the server, and every device is signed out. The copies on your devices stay as device-only profiles.', { ok: 'Continue', danger: true }))) return;
  const pw = pwInput('Password');
  pw.setAttribute('autofocus', '');
  const err = h('p.form-error', { role: 'alert' });
  const btn = h('button.btn.danger', { type: 'button' }, 'Delete account');
  const submit = async () => {
    if (!pw.value) { err.textContent = 'Enter your password.'; return; }
    const r = await busy(btn, 'Deleting…', err, async () => { await S.deleteAccount(pw.value); return true; });
    if (!r) return;
    sheet.close();
    toast('Account deleted. Your profiles stay on this device.', { force: true });
    ctx.rerender?.();
  };
  btn.onclick = submit;
  const sheet = openSheet({
    title: 'Are you absolutely sure?', cls: 'acct',
    content: h('form.form', { onsubmit: (e) => { e.preventDefault(); submit(); }, novalidate: true },
      h('p.set-desc', 'This can’t be undone. Enter your password to delete the account.'), field('Password', pw), err, h('button', { type: 'submit', hidden: true })),
    footer: [h('button.btn.ghost', { type: 'button', onclick: () => sheet.close() }, 'Cancel'), btn],
  });
}


// ---------------- Household sign-in (Sign in with Google, shared with ToozBudgeting) ----------------
const personName = (me) => me?.user?.displayName || me?.user?.name || me?.user?.email || 'you';
const firstNameOf = (me) => String(personName(me)).trim().split(/\s+/)[0].slice(0, 40) || 'Me';

/** The official Google button (rendered once it's on the page). null when household sign-in isn't set up. */
function googleButton({ onSignedIn }) {
  if (!HH.householdAvailable()) return null;
  const host = h('div.gsi-host');
  const err = h('p.form-error', { role: 'alert' });
  const box = h('div.gsi-wrap', host, err);
  requestAnimationFrame(() => HH.renderGoogleButton(host, {
    onSignedIn: (me) => { err.textContent = ''; onSignedIn(me); },
    onError: (m) => { err.textContent = m; },
  }));
  return box;
}

function householdSignedOutRow() {
  if (!HH.householdAvailable()) return null;
  return h('div.set-row.col.acct-block.hh-block',
    h('div.set-text', h('span.set-label', 'Sign in with Google'),
      h('span.set-desc', 'Use the Google account you use for ToozBudgeting. Everyone in your household signs in the same way, with no Daily Tracker password.')),
    googleButton({ onSignedIn: (me) => continueWithGoogle(me) }));
}

/** Daily Tracker's own account, given the household's linked keys. One flow at a time. */
let googleBusy = false;
async function continueWithGoogle(me = HH.householdMe()) {
  if (googleBusy) return;
  googleBusy = true;
  try {
    let keys;
    try { keys = await HH.appKeys(); } catch (e) {
      if (e.data?.code === 'NOT_LINKED') { notLinked(me); return; }
      throw e;
    }
    const s = S.syncState();
    if (S.isSignedIn() && s.username === keys.username) {
      toast(`Signed in with Google as ${personName(me)}`, { force: true });
      ctx.rerender?.();
      applyMyProfile();
      return;
    }
    if (S.isSignedIn()) {
      toast(`This device is signed in to the Daily Tracker account “${s.username}”, but your household uses “${keys.username}”. Sign out first to switch.`, { force: true, duration: 9000 });
      ctx.rerender?.();
      return;
    }
    toast('Signing in to your household’s Daily Tracker…', { force: true });
    const r = await S.signInWithLink(keys);
    afterSignIn({ created: false, error: r.error });
  } catch (e) {
    toast(e?.message || 'Google sign-in didn’t finish', { force: true, duration: 9000 });
    ctx.rerender?.();
  } finally { googleBusy = false; }
}

/** The household has no linked Daily Tracker account yet. Owners link it once; anyone else is told who can. */
function notLinked(me) {
  const hh = me?.household?.name || 'your household';
  if (me?.role !== 'owner') {
    choose('Not linked yet', `Signed in with Google as ${personName(me)}, but Daily Tracker isn’t linked to ${hh} yet. Ask an owner to open Daily Tracker › Settings › Account and link it once. Then you can sign in here with Google.`, [{ value: null, label: 'OK', style: 'primary' }]);
    ctx.rerender?.();
    return;
  }
  if (S.isSignedIn()) { openLinkWithPassword(); return; }
  choose('Link Daily Tracker to your household', `Signed in with Google as ${personName(me)} (owner of ${hh}). Sign in to your Daily Tracker account once with its username and password (or create one) to link it. After that, you and everyone you invite in ToozBudgeting just sign in with Google.`, [
    { value: 'signin', label: 'Sign in with password', style: 'primary' },
    { value: 'create', label: 'Create a Daily Tracker account', style: 'secondary' },
    { value: null, label: 'Not now', style: 'ghost' },
  ]).then((c) => {
    if (c === 'signin') openSignIn({ linkAfter: true });
    else if (c === 'create') openCreate({ linkAfter: true });
    else ctx.rerender?.();
  });
}

/** Link the account that was just signed in to (or created) with this password. Errors become a toast. */
async function linkWithPassword(username, password) {
  try {
    const uname = normUsername(username);
    await HH.setLink({ username: uname, ...(await linkKeys(uname, password)) });
    hhCache = null;
    toast('Linked. Everyone in your household can now sign in with Google.', { force: true, duration: 6000 });
    return true;
  } catch (e) {
    toast(`Signed in, but linking to your household didn’t work: ${e.message}`, { force: true, duration: 9000 });
    return false;
  }
}

/** Signed in already: link (or update the link of) this account with its password. */
function openLinkWithPassword(rerender = () => ctx.rerender?.()) {
  const pw = pwInput('Password');
  pw.setAttribute('autofocus', '');
  const err = h('p.form-error', { role: 'alert' });
  const btn = h('button.btn.primary', { type: 'button' }, 'Link');
  const hh = HH.householdMe()?.household?.name || 'your household';
  const submit = async () => {
    if (!pw.value) { err.textContent = 'Enter your password.'; return; }
    const ok = await busy(btn, 'Linking…', err, async () => { await HH.setLink(await S.linkKeysFromPassword(pw.value)); return true; });
    if (!ok) return;
    hhCache = null;
    sheet.close();
    toast('Linked. Everyone in your household can now sign in with Google.', { force: true, duration: 6000 });
    rerender();
    applyMyProfile();
  };
  btn.onclick = submit;
  const sheet = openSheet({
    title: 'Link to your household', cls: 'acct',
    content: h('form.form', { onsubmit: (e) => { e.preventDefault(); submit(); }, novalidate: true },
      h('p.set-desc', `Enter the password of “${S.syncState().username}” once. Your password never leaves this device. The household server keeps sign-in keys made from it, encrypted, and gives them only to owners and members of ${hh} when they sign in with Google. View-only people never get them.`),
      field('Password', pw), err, h('button', { type: 'submit', hidden: true })),
    footer: [h('span'), btn],
  });
}

/** After a password change on this device: an owner's link is updated so Google sign-in keeps working. */
async function relinkAfterPasswordChange(password) {
  if (!HH.isHouseholdSignedIn()) return;
  try {
    const st = await HH.appStatus();
    const uname = S.syncState().username;
    if (!st.linked || st.username !== uname) return;
    if (!st.canManage) { toast('Ask a household owner to link Daily Tracker again, so Google sign-in works with the new password.', { force: true, duration: 8000 }); return; }
    await HH.setLink({ username: uname, ...(await linkKeys(uname, password)) });
    hhCache = null;
    toast('Household link updated for the new password', { force: true });
  } catch { toast('Couldn’t update the household link. Link it again in Settings › Account.', { force: true, duration: 8000 }); }
}

/**
 * Who's who: a person's own profile opens whenever they sign in with Google (kept on the household server,
 * per person). Asked once per person when it isn't known yet.
 */
let asking = false;
async function applyMyProfile() {
  if (asking || !HH.isHouseholdSignedIn() || !S.hasAccount() || !S.isSignedIn()) return;
  asking = true;
  try {
    let prefs;
    try { prefs = await HH.getPrefs(); } catch { return; }
    const me = HH.householdMe();
    const mine = prefs.profileId && getProfiles().find((p) => p.id === prefs.profileId);
    if (mine) {
      if (getActiveProfile()?.id !== mine.id && switchProfile(mine.id)) toast(`Opened ${mine.name}`, { force: true });
      return;
    }
    const synced = getProfiles().filter((p) => S.isSynced(p.id));
    const first = firstNameOf(me);
    const options = synced.map((p) => ({ value: p.id, label: p.name, style: 'secondary' }));
    if (S.canSyncProfiles() && !S.accountNameClash(first)) options.push({ value: '__new', label: `Add a profile for ${first}`, style: 'secondary' });
    if (!options.length) return;
    options.push({ value: null, label: 'Not now', style: 'ghost' });
    const c = await choose('Which profile is yours?', `Signed in with Google as ${personName(me)}. Daily Tracker opens your profile whenever you sign in with Google, on any device.`, options);
    if (!c) return;
    let id = c;
    if (c === '__new') {
      id = addProfile({ name: first });
      if (!id) { toast('Couldn’t add the profile – storage is full.', { force: true }); return; }
      await S.syncProfiles([id]);
    } else switchProfile(id);
    try { await HH.setPrefs({ ...prefs, profileId: id }); } catch (e) { toast(`Couldn’t save which profile is yours: ${e.message}`, { force: true }); }
    hhCache = null;
    ctx.rerender?.();
  } finally { asking = false; }
}

/** The redirect sign-in (installed iPhone app) came back: #signin=<code> or #signin-error=<message>. */
export async function resumeGoogleRedirect(ret, { onFirstDone = null } = {}) {
  if (!ret || !HH.householdAvailable()) return;
  if (ret.error) { toast(`Google sign-in didn’t finish: ${ret.error}`, { force: true, duration: 9000 }); return; }
  let me;
  try { me = await HH.redeemCode(ret.code); } catch (e) { toast(`Google sign-in didn’t finish: ${e.message}`, { force: true, duration: 9000 }); return; }
  if (onFirstDone) firstFlow = { onDone: onFirstDone };
  continueWithGoogle(me);
}

// Settings › Account › Household sign-in (signed in). The server's answer is cached per account so
// Settings re-renders don't flicker.
let hhCache = null; // { key, status, prefs }
function householdBlock(rerender) {
  if (!HH.householdAvailable()) return null;
  const box = h('div.set-row.col.acct-block.hh-block', h('span.set-label', 'Household sign-in'));
  if (!HH.isHouseholdSignedIn()) {
    const reason = HH.householdState()?.signedOutReason;
    box.append(h('span.set-desc', `${reason ? reason + ' ' : ''}Sign in with the Google account you use for ToozBudgeting. Once this account is linked, everyone in your household opens Daily Tracker with Google, with no password.`),
      googleButton({ onSignedIn: (me) => continueWithGoogle(me) }));
    return box;
  }
  const me = HH.householdMe();
  const uname = S.syncState().username;
  box.append(h('div.hh-who', h('span.hh-name', personName(me)), h('span.set-desc', `${me?.user?.email || ''} · ${HH.ROLE_LABEL[me?.role] || me?.role} · ${me?.household?.name || 'Household'}`)));
  const body = h('div.hh-body');
  box.append(body);
  const key = `${me?.user?.id}|${me?.household?.id}|${uname}`;
  const fill = ({ status: st, prefs }) => {
    const kids = [];
    const actions = [];
    if (!st.canUse) kids.push(h('p.set-desc', 'View-only people can’t open Daily Tracker with Google yet. An owner can make you a member in ToozBudgeting › Settings › Household.'));
    if (st.linked && st.username === uname) {
      kids.push(h('p.set-desc.hh-linked', icon('check', { size: 14 }), ` Linked: people in ${me?.household?.name || 'your household'} sign in to “${uname}” with Google.`));
      if (st.canManage) {
        actions.push(h('button.btn.secondary.small', { type: 'button', onclick: () => openLinkWithPassword(rerender) }, 'Update link'));
        actions.push(h('button.btn.ghost.small', { type: 'button', onclick: async (e) => {
          const b = e.currentTarget; // gone once the event has been handled
          if (!(await confirmDialog('Unlink Daily Tracker?', 'People in your household won’t be able to sign in here with Google any more. Daily Tracker’s data and devices that are signed in now aren’t changed.', { ok: 'Unlink', danger: true }))) return;
          const ok = await busy(b, 'Unlinking…', null, async () => { await HH.removeLink(); return true; });
          if (ok) { hhCache = null; toast('Unlinked', { force: true }); rerender(); }
        } }, 'Unlink'));
      }
    } else if (st.linked) {
      kids.push(h('p.set-desc', `Your household is linked to the Daily Tracker account “${st.username}”, not this one (“${uname}”).`));
      if (st.canManage) actions.push(h('button.btn.secondary.small', { type: 'button', onclick: () => openLinkWithPassword(rerender) }, 'Link this account instead'));
    } else if (st.canManage) {
      kids.push(h('p.set-desc', 'Not linked yet. Link this account so everyone in your household can sign in with Google.'));
      actions.push(h('button.btn.primary.small', { type: 'button', id: 'hh-link', onclick: () => openLinkWithPassword(rerender) }, 'Link this account'));
    } else kids.push(h('p.set-desc', 'An owner hasn’t linked Daily Tracker to your household yet.'));
    // Which profile is mine.
    const synced = getProfiles().filter((p) => S.isSynced(p.id));
    if (synced.length) {
      const sel = h('select.input.hh-mine', { 'aria-label': 'Your profile' },
        h('option', { value: '' }, 'Not chosen'),
        ...synced.map((p) => h('option', { value: p.id, selected: prefs.profileId === p.id }, p.name)));
      sel.addEventListener('change', async () => {
        try { const next = await HH.setPrefs({ ...prefs, profileId: sel.value || null }); hhCache = { key, status: st, prefs: next }; toast(sel.value ? 'Saved: this profile opens when you sign in with Google' : 'Saved', { force: true }); } catch (e) { toast(e.message, { force: true }); }
      });
      kids.push(field('Your profile', sel, 'Opens when you sign in with Google, on any device.'));
    }
    actions.push(h('button.btn.ghost.small', { type: 'button', onclick: async () => { await HH.signOutHousehold(); hhCache = null; toast('Signed out of Google here. Daily Tracker stays signed in.', { force: true }); rerender(); } }, 'Sign out of Google'));
    body.replaceChildren(...kids, h('div.set-actions', ...actions));
  };
  const cached = hhCache && hhCache.key === key ? hhCache : null;
  if (cached) fill(cached); else body.append(h('p.set-desc', 'Checking the household link…'));
  Promise.all([HH.appStatus(), HH.getPrefs().catch(() => ({}))]).then(([status, prefs]) => {
    const fresh = { key, status, prefs };
    const same = cached && JSON.stringify([cached.status, cached.prefs]) === JSON.stringify([status, prefs]);
    hhCache = fresh;
    if (!same && body.isConnected) fill(fresh);
  }).catch((e) => {
    if (!body.isConnected) return;
    if (!HH.isHouseholdSignedIn()) { rerender(); return; }
    if (!cached) body.replaceChildren(h('p.set-desc', `Couldn’t reach the household server: ${e.message}`), h('div.set-actions', h('button.btn.ghost.small', { type: 'button', onclick: async () => { await HH.signOutHousehold(); rerender(); } }, 'Sign out of Google')));
  });
  return box;
}
