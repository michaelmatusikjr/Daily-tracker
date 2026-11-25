// Invite codes (backlog #35). The owner (this device has the server's register key) makes a single-use
// code per friend: Settings › Account › Invite someone. The friend's side (the link, the code input) is
// in setup.js. The server only keeps a hash of each code, so a code is shown once, when it is made.
// All text goes through h() (never innerHTML).
import { h, openSheet, toast, confirmDialog } from './ui.js';
import { icon } from './icons.js';
import { registerKeyMeta } from './push.js';
import { fmtDateShort, toKey } from './dates.js';
import * as S from './sync.js';
import { makeSwipeable } from './rowSwipe.js';

// ---------- codes and the link ----------
/** "7k3q x9pm" → "7K3QX9PM"; '' when it can't be a code (8 symbols, no 0/O/1/I). */
export function normalizeCode(v) {
  const s = String(v || '').toUpperCase().replace(/[\s-]+/g, '');
  return /^[2-9A-HJ-NP-Z]{8}$/.test(s) ? s : '';
}
/** A code out of pasted text: a bare code, a whole invite link, or a message that contains one. */
export function extractCode(text) {
  const t = String(text || '');
  const direct = normalizeCode(t);
  if (direct) return direct;
  const m = /invite=([^\s&]+)/i.exec(t);
  if (m) { let v = m[1]; try { v = decodeURIComponent(v); } catch { /* keep */ } const n = normalizeCode(v); if (n) return n; }
  const f = /\b([2-9A-HJ-NP-Z]{4})[-\s]?([2-9A-HJ-NP-Z]{4})\b/i.exec(t);
  return f ? normalizeCode(f[1] + f[2]) : '';
}
export const formatCode = (v) => { const n = normalizeCode(v); return n ? `${n.slice(0, 4)}-${n.slice(4)}` : String(v || ''); };
/** The link to send: this app's address plus "#invite=CODE" (the fragment never goes to any server). */
export const inviteLink = (code) => `${location.origin}${location.pathname.replace(/[^/]*$/, '')}#invite=${encodeURIComponent(formatCode(code))}`;

const KEY = 'dailyTracker:invite'; // sessionStorage: survives a reload of this tab, not the browser
let pending = '';
/**
 * Read "#invite=CODE" from the address and remove it (the code shouldn't stay in the URL / history).
 * Returns { present, code }: present = the link carried an invite fragment (even a mistyped one).
 */
export function captureInviteFromUrl() {
  const m = /^#invite=(.*)$/i.exec(location.hash || '');
  if (m) {
    let raw = m[1];
    try { raw = decodeURIComponent(raw); } catch { /* keep as is */ }
    pending = normalizeCode(raw);
    try { if (pending) sessionStorage.setItem(KEY, pending); } catch { /* ignore */ }
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
    return { present: true, code: pending };
  }
  if (!pending) { try { pending = normalizeCode(sessionStorage.getItem(KEY)); } catch { /* ignore */ } }
  return { present: false, code: pending };
}
export const pendingInvite = () => pending;
export function clearPendingInvite() { pending = ''; try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } }

// ---------- server calls ----------
async function call(method, path, body, { key = '' } = {}) {
  const base = S.serverUrl();
  if (!base) throw new S.SyncError(0, 'No server is set up');
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['X-Register-Key'] = key;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), 15000) : null;
  let res;
  try {
    res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), mode: 'cors', credentials: 'omit', signal: ctl?.signal });
  } catch { throw new S.SyncError(0, navigator.onLine === false ? 'offline' : 'network'); } finally { clearTimeout(timer); }
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new S.SyncError(res.status, data?.error || `HTTP ${res.status}`);
  return data || {};
}
/** Is this code usable? (Doesn't use it up.) Throws on network problems / rate limits. */
export async function checkInvite(code) {
  const n = normalizeCode(code);
  if (!n) return false;
  return !!(await call('POST', '/api/invites/check', { code: n })).valid;
}
const ownerKey = () => registerKeyMeta().key;
export const isOwner = () => S.accountsAvailable() && !!ownerKey() && !S.isInvitedAccount();
function ownerError(e) {
  if (e?.status === 403) return 'The server didn’t accept this device’s register key.';
  if (e?.status === 429) return 'Too many attempts – try again later';
  return S.plainError(e);
}
export const createInvite = (name) => call('POST', '/api/invites', { name: String(name || '').trim() }, { key: ownerKey() });
export const listInvites = async () => (await call('GET', '/api/invites', undefined, { key: ownerKey() })).invites || [];
export const purgeInvite = (id) => call('DELETE', '/api/invites/' + encodeURIComponent(id) + '?purge=1', undefined, { key: ownerKey() });
export const revokeInvite = (id) => call('DELETE', '/api/invites/' + encodeURIComponent(id), undefined, { key: ownerKey() });

// ---------- owner UI ----------
// Invites deleted from the list whose server delete is still waiting for the Undo window (kept at module level: reopening the sheet must not show them again).
const hidden = new Set();
const dateOf = (ms) => (Number.isFinite(ms) ? fmtDateShort(toKey(new Date(ms))) : '');
export async function copyText(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done, { force: true }); return true; } catch { toast('Couldn’t copy – select the text and copy it', { force: true }); return false; }
}

/** The Account panel's "Invite friends" row (owners only). */
export function inviteRow() {
  if (!isOwner()) return null;
  return h('div.set-row.col.acct-block',
    h('span.set-label', 'Invite friends'),
    h('span.set-desc', 'Give each friend their own single-use code. They can set up an account and reminders without your register key.'),
    h('div.set-actions', h('button.btn.secondary.small', { type: 'button', id: 'acct-invite', onclick: () => openInviteSheet() }, icon('share', { size: 16 }), 'Invite someone')));
}

function describe(inv) {
  if (inv.status === 'used') return `Used by ${inv.username || 'a friend'}${inv.usedAt ? ` on ${dateOf(inv.usedAt)}` : ''}`;
  if (inv.status === 'revoked') return inv.usedAt ? `Revoked · used by ${inv.username || 'a friend'}${inv.usedAt ? ` on ${dateOf(inv.usedAt)}` : ''}` : 'Revoked';
  if (inv.status === 'expired') return `Expired ${dateOf(inv.expiresAt)}`;
  return `Unused · expires ${dateOf(inv.expiresAt)}`;
}

export function openInviteSheet() {
  const name = h('input.input', { type: 'text', maxlength: 40, autocomplete: 'off', placeholder: 'Their name (optional)', 'aria-label': 'Friend’s name', autofocus: true });
  const err = h('p.form-error', { role: 'alert' });
  const result = h('div.invite-result', { 'aria-live': 'polite' });
  const list = h('ul.acct-list.invite-list', { role: 'list' });
  const listNote = h('p.set-desc');
  const make = h('button.btn.primary', { type: 'button' }, 'Create invite');

  const showResult = (inv) => {
    const link = inviteLink(inv.code);
    const kids = [
      h('p.set-desc', `Invite${inv.name ? ` for ${inv.name}` : ''} – single use, valid for 30 days. The code is shown only now: copy or send it before closing.`),
      h('p.invite-code.mono', { 'aria-label': 'Invite code' }, formatCode(inv.code)),
      h('p.invite-link.mono', { 'aria-label': 'Invite link' }, link),
      h('div.set-actions.acct-actions',
        h('button.btn.secondary.small', { type: 'button', onclick: () => copyText(formatCode(inv.code), 'Code copied') }, icon('copy', { size: 16 }), 'Copy code'),
        h('button.btn.secondary.small', { type: 'button', onclick: () => copyText(link, 'Link copied') }, icon('copy', { size: 16 }), 'Copy link'),
        typeof navigator.share === 'function' ? h('button.btn.primary.small', { type: 'button', onclick: async () => {
          try { await navigator.share({ title: 'Daily Tracker invite', text: `Join me on Daily Tracker. Your invite code: ${formatCode(inv.code)}`, url: link }); } catch { /* cancelled */ }
        } }, icon('share', { size: 16 }), 'Share') : null),
    ];
    result.replaceChildren(...kids);
  };

  // Revoked invites can be swiped left to delete them for good. The delete waits for the Undo toast to run out
  // (codes are only stored as hashes, so a deleted invite can't be re-created).
  const rowFor = (li, inv) => {
    if (inv.status !== 'revoked') return li;
    return makeSwipeable(li, (side) => (side === 'left' ? [{ name: 'delete', label: 'Delete', icon: 'trash', run: () => {
      hidden.add(inv.id);
      li.remove();
      if (!list.children.length) listNote.textContent = 'No invites yet.';
      const timer = setTimeout(async () => {
        try { await purgeInvite(inv.id); hidden.delete(inv.id); } catch (x) {
          hidden.delete(inv.id);
          if (x?.status !== 404) toast(`Couldn’t delete the invite: ${ownerError(x)}`, { force: true }); // 404: already gone (the daily clean-up may have deleted it)
        }
        refresh();
      }, 6500);
      toast('Invite deleted', { force: true, duration: 6000, action: 'Undo', onAction: () => { clearTimeout(timer); hidden.delete(inv.id); refresh(); } });
    } }] : []));
  };
  const refresh = async () => {
    try {
      const invs = await listInvites();
      listNote.textContent = invs.length ? '' : 'No invites yet.';
      list.replaceChildren(...invs.filter((inv) => !hidden.has(inv.id)).map((inv) => rowFor(h('li',
        h('div.set-text', h('span', inv.name || 'Invite'), h('span.set-desc', describe(inv))),
        inv.status !== 'revoked' ? h('button.btn.ghost.small', { type: 'button', 'aria-label': `Revoke invite${inv.name ? ' for ' + inv.name : ''}`, onclick: async (e) => {
          const btn = e.currentTarget;
          if (!(await confirmDialog('Revoke this invite?', inv.status === 'used' ? 'This only marks the invite as revoked in your list. The friend’s account stays as it is.' : 'The code stops working. Anyone who hasn’t used it yet can’t create an account with it.', { ok: 'Revoke', danger: true }))) return;
          btn.disabled = true;
          try { await revokeInvite(inv.id); toast('Invite revoked', { force: true }); } catch (x) { toast(ownerError(x), { force: true }); }
          refresh();
        } }, 'Revoke') : null), inv)));
    } catch (e) { listNote.textContent = `Couldn’t load your invites: ${ownerError(e)}`; }
  };

  make.onclick = async () => {
    err.textContent = '';
    make.disabled = true; make.textContent = 'Creating…';
    try {
      const inv = await createInvite(name.value);
      name.value = '';
      showResult(inv);
      refresh();
    } catch (e) { err.textContent = ownerError(e); } finally { make.disabled = false; make.textContent = 'Create invite'; }
  };
  openSheet({
    title: 'Invite someone', cls: 'acct',
    content: h('form.form', { onsubmit: (e) => { e.preventDefault(); make.click(); }, novalidate: true },
      h('p.set-desc', 'Each friend gets their own code, so your register key stays private. After they join they sign in with their own username and password.'),
      h('label.field.acct-field', h('span.field-label', 'Name'), name),
      err, result,
      h('span.set-label', 'Your invites'), listNote, list,
      h('button', { type: 'submit', hidden: true })),
    footer: [h('span'), make],
  });
  refresh();
}
