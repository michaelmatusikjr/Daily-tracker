// The friend's side of invites (backlog #35): the "Install first" screen for iPhone/iPad browser tabs and
// the "Get set up" wizard (invite code → account → notifications → done). Every step can be skipped and
// the wizard can be reopened from Settings › Account. All text goes through h() (never innerHTML).
import { h, isSheetOpen, confirmDialog } from './ui.js';
import { icon } from './icons.js';
import { promptInstall } from './pwa.js';
import { platformContext, needsGate, offersInstall } from './platform.js';
import * as S from './sync.js';
import { pushConfigured, pushEnabled, enablePush, registerKeyMeta } from './push.js';
import { showNotification } from './notify.js';
import { openCreateWithInvite, openSignInSheet, openFirstSignIn } from './account.js';
import { isFreshInstall } from './store.js';
import { normalizeCode, formatCode, extractCode, checkInvite, clearPendingInvite, copyText, inviteLink } from './invites.js';

/** A screen to go through before the wizard: an in-app browser, or an iPhone/iPad browser tab (web push needs the Home Screen app). */
export const needsInstallFirst = () => needsGate();

const BEHIND = 'body > .app, body > .fab, body > .skip-link, body > #toasts';
function mount(root, focusSel) {
  const behind = [...document.querySelectorAll(BEHIND)];
  behind.forEach((el) => el.setAttribute('inert', ''));
  document.body.append(root);
  requestAnimationFrame(() => { root.classList.add('show'); root.querySelector(focusSel)?.focus(); });
  return () => { behind.forEach((el) => el.removeAttribute('inert')); root.remove(); };
}

// ---------- The gate: "Open in your browser" / "Open in Safari" / "Install it first" ----------
/** Shows only what fits this device (see platform.js). Shows the code with Copy when the link carried one. */
export function showInstallFirst({ code = '', onContinue = null } = {}) {
  if (document.querySelector('.ob-install')) return;
  const c = platformContext();
  const link = code ? inviteLink(code) : location.origin + location.pathname.replace(/[^/]*$/, '');
  const step = (n, art, title, text) => h('li.setup-step',
    h('span.setup-step-art', { 'aria-hidden': 'true' }, art),
    h('div.setup-step-text', h('strong', `${n}. ${title}`), h('span', text)));
  const copyRow = (label, fn, id) => h('button.btn.secondary', { type: 'button', id, onclick: fn }, icon('copy', { size: 16 }), label);
  let title, text, steps, kind;
  if (c.inAppBrowser) {
    kind = 'inapp';
    const target = c.os === 'ios' ? 'Safari' : 'your browser (Chrome or your default browser)';
    title = 'Open in your browser';
    text = `Apps like Instagram, Facebook or Mail open links in a small built-in browser that can’t install Daily Tracker or send reminders. Open it in ${target} instead.`;
    steps = [
      step(1, '📋', 'Copy the link', 'Tap Copy link below (or the ⋯ menu of this page).'),
      step(2, '🌐', `Open ${c.os === 'ios' ? 'Safari' : 'your browser'}`, 'Paste the link in its address bar.'),
    ];
  } else if (c.browser !== 'safari') {
    kind = 'ios-other';
    title = 'Open this link in Safari';
    text = 'On iPhone and iPad, Daily Tracker installs from Safari. Open this link there first.';
    steps = [
      step(1, '📋', 'Copy the link', 'Tap Copy link below.'),
      step(2, '🧭', 'Open Safari', 'Paste the link in Safari’s address bar, then follow the install steps shown there.'),
    ];
  } else {
    kind = 'ios-safari';
    title = 'Install it first';
    text = 'On iPhone and iPad, reminders and sync work from the Home Screen app. It takes a few seconds.';
    steps = [
      step(1, icon('share', { size: 24 }), 'Tap Share', 'The square with an arrow, at the bottom (or top) of Safari.'),
      step(2, '➕', 'Add to Home Screen', 'Scroll down in the list, then tap Add.'),
      step(3, '📲', 'Open it from the icon', code ? 'Tap “I have an invite” and paste your code.' : 'Open Daily Tracker from the new icon on your Home Screen.'),
    ];
  }
  const codeBox = code ? h('div.setup-code-box',
    h('span.setup-code-label', 'Your invite code'),
    h('p.setup-code', { 'aria-label': 'Invite code' }, formatCode(code)),
    copyRow('Copy code', () => copyText(formatCode(code), 'Code copied'), 'setup-copy'),
    h('p.setup-hint', kind === 'ios-safari' ? 'Safari and the Home Screen app don’t share anything, so the app will ask for this code. Copy it now, then paste it there.' : 'Keep it handy: you’ll need it again if the link doesn’t carry over.')) : null;
  let unmount = () => {};
  const root = h(`div.onboarding.ob-setup.ob-install.gate-${kind}`, { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div.ob-panel',
      h('div.ob-top', h('span.ob-brand', icon('check', { size: 16 }), 'Daily Tracker')),
      h('div.setup-body',
        h('h2.ob-title', title),
        h('p.ob-text', text),
        codeBox,
        kind !== 'ios-safari' ? copyRow('Copy link', () => copyText(link, 'Link copied'), 'setup-copy-link') : null,
        h('ol.setup-steps', steps)),
      h('div.ob-first-actions',
        h('button.btn.ghost.ob-choice', { type: 'button', id: 'setup-continue-browser', onclick: async () => {
          // iPhone/iPad Safari: this tab's storage isn't the Home Screen app's, so a code spent here is gone there.
          if (kind === 'ios-safari' && code && !(await confirmDialog('Use the invite here?', 'The invite code is used up as soon as you create your account here, and the Home Screen app doesn’t share this browser’s data. Later, in the Home Screen app, choose “Sign in to your account” (not “I have an invite”) and use the username and password you pick now.', { ok: 'Continue here' }))) return;
          unmount(); onContinue?.();
        } }, kind === 'inapp' ? 'Continue here anyway' : 'Continue in this browser anyway'))));
  unmount = mount(root, code ? '#setup-copy' : kind === 'ios-safari' ? '#setup-continue-browser' : '#setup-copy-link');
}

// ---------- The wizard ----------
const DONE = 'done';

/**
 * Open the wizard. code: an invite code to start with (from the link). start: 'code' | 'account' | 'notify'.
 * onDone({ offerPicker }) runs once it is closed (finished or skipped).
 */
export function openSetupWizard({ code = '', start = null, onDone = null } = {}) {
  if (document.querySelector('.ob-wizard')) return;
  const pc = platformContext();
  const STEPS = ['code', 'account', 'notify', ...(offersInstall(pc) ? ['install'] : [])];
  const afterNotify = () => go(STEPS.includes('install') ? 'install' : DONE);
  let step = start || (S.hasAccount() ? 'notify' : 'code');
  let current = normalizeCode(code);
  let codeOk = false;
  let deferPicker = false;
  let notifOn = pushEnabled();
  const note = { text: '', kind: '' };

  const body = h('div.setup-body');
  const foot = h('div.ob-first-actions');
  const dots = h('div.ob-dots', { role: 'list', 'aria-label': 'Setup steps' });
  const skipAll = h('button.btn.ghost.ob-skip', { type: 'button', id: 'setup-skip-all', onclick: () => finish() }, 'Close');
  const root = h('div.onboarding.ob-setup.ob-wizard', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Get set up' },
    h('div.ob-panel', h('div.ob-top', h('span.ob-brand', icon('check', { size: 16 }), 'Daily Tracker'), skipAll), body, h('div.setup-dots', dots), foot));
  let unmount = () => {};
  let closed = false;

  function finish() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    offSync();
    clearPendingInvite();
    unmount();
    onDone?.({ offerPicker: deferPicker });
  }
  const onKey = (e) => { if (e.key === 'Escape' && !isSheetOpen()) finish(); };
  document.addEventListener('keydown', onKey);
  // Signing in elsewhere in the app (the "I already have an account" link) moves the wizard along.
  const offSync = S.onSyncChange(() => { if (!closed && step === 'account' && S.hasAccount()) go('notify'); });

  const err = h('p.form-error', { role: 'alert' });
  const setErr = (m) => { err.textContent = m || ''; };
  const go = (s) => { step = s; note.text = ''; note.kind = ''; setErr(''); render(); };

  const primary = (label, onclick, id) => h('button.btn.primary.ob-choice', { type: 'button', id, onclick }, label);
  const secondary = (label, onclick, id) => h('button.btn.secondary.ob-choice', { type: 'button', id, onclick }, label);
  const skip = (label, to, id = 'setup-skip') => h('button.btn.ghost.ob-choice', { type: 'button', id, onclick: () => go(to) }, label);
  const busyBtn = async (btn, label, fn) => {
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = label;
    try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
  };

  function codeStep() {
    const input = h('input.input.mono.setup-code-input', { type: 'text', id: 'setup-code', autocomplete: 'off', autocapitalize: 'characters', spellcheck: false, maxlength: 80, 'aria-label': 'Invite code', placeholder: 'XXXX-XXXX', value: current ? formatCode(current) : '' });
    const submit = async (btn) => {
      setErr('');
      const n = extractCode(input.value);
      if (!n) { setErr('That doesn’t look like an invite code. It has 8 letters and digits, like 7K3Q-X9PM.'); return; }
      input.value = formatCode(n);
      await busyBtn(btn, 'Checking…', async () => {
        try {
          if (!(await checkInvite(n))) { setErr('That code doesn’t work. Check it for typos – it may also have been used, revoked or expired. Ask for a new one.'); return; }
        } catch (e) { setErr(S.plainError(e)); return; }
        current = n; codeOk = true;
        go('account');
      });
    };
    const next = primary('Continue', (e) => submit(e.currentTarget), 'setup-code-next');
    const paste = navigator.clipboard?.readText ? secondary('Paste from clipboard', async () => {
      setErr('');
      let t = '';
      try { t = await navigator.clipboard.readText(); } catch { setErr('Couldn’t read the clipboard – paste into the box instead.'); return; }
      const n = extractCode(t);
      if (!n) { setErr('There’s no invite code on the clipboard.'); return; }
      input.value = formatCode(n);
    }, 'setup-paste') : null;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); next.click(); } });
    return {
      art: '🎟️', title: 'Your invite code',
      text: current ? 'We found the code from your link. Tap Continue.' : 'Type or paste the code you were sent. It looks like 7K3Q-X9PM.',
      content: [h('label.field.acct-field', h('span.field-label', 'Invite code'), input), err],
      actions: [next, paste, skip('Skip this step', 'account', 'setup-skip-code')], focus: '#setup-code',
    };
  }

  function accountStep() {
    if (S.hasAccount()) {
      return { art: '✅', title: 'You’re signed in', text: `Signed in as ${S.syncState().username || 'your account'}. Your data is encrypted on this device before it syncs.`, content: [], actions: [primary('Continue', () => go('notify'), 'setup-account-next')] };
    }
    const create = primary('Create my account', () => {
      setErr('');
      openCreateWithInvite({
        code: codeOk ? current : '',
        onDone: ({ offerPicker }) => { if (offerPicker) deferPicker = true; go('notify'); },
        onCancel: () => {},
      });
    }, 'setup-create');
    return {
      art: '🔐', title: 'Create your account',
      text: codeOk ? 'Choose a username and password. Everything is encrypted on this device, so nobody else can read it. You’ll get a recovery key to save.' : 'Choose a username and password. Without an invite code you’ll also need the server’s register key.',
      content: [err],
      actions: [create, secondary('I already have an account', () => {
        // A brand-new install replaces its untouched placeholder profile, like the first screen's sign-in.
        if (isFreshInstall()) openFirstSignIn({ onDone: ({ offerPicker }) => { if (offerPicker) deferPicker = true; if (!closed && step === 'account') go('notify'); } });
        else openSignInSheet();
      }, 'setup-signin'), skip('Skip this step', 'notify', 'setup-skip-account')], focus: '#setup-create',
    };
  }

  const REALLOW = {
    ios: 'To allow them again: iPhone Settings › Notifications › Daily Tracker.',
    android: 'To allow them again: open the site settings in your browser (the ⋮ menu › Settings › Site settings › Notifications).',
    default: 'To allow them again: click the lock icon in the address bar and set Notifications to Allow.',
  };
  const NOTE_DESKTOP = 'On a computer, reminders arrive while your browser is running, even with this tab closed.';
  function notifyStep() {
    const hasRoute = S.hasAccount() || !!registerKeyMeta().key;
    const desktop = !['ios', 'android'].includes(pc.os);
    const test = h('button.btn.secondary.ob-choice', { type: 'button', id: 'setup-test', onclick: async (e) => {
      const ok = await busyBtn(e.currentTarget, 'Sending…', () => showNotification('Daily Tracker', 'Notifications are working. Your reminders will show up like this.', 'setup-test'));
      note.text = ok ? 'Sent – look for it at the top of your screen.' : 'Couldn’t show a notification. Check that notifications are allowed for Daily Tracker.';
      note.kind = ok ? 'ok' : 'bad';
      render();
    } }, 'Send a test notification');
    const noteEl = note.text ? h(`p.setup-note.${note.kind}`, { role: 'status' }, note.text) : null;
    const deskNote = desktop ? h('p.setup-note', NOTE_DESKTOP) : null;
    const cont = (label = 'Continue') => primary(label, afterNotify, 'setup-notify-next');
    const plain = (text) => ({ art: '🔔', title: 'Notifications', text, content: [], actions: [cont()] });
    if (notifOn) return { art: '🔔', title: 'Notifications are on', text: desktop ? '' : 'Your reminders arrive even when the app is closed.', content: [deskNote, noteEl], actions: [test, cont()], focus: '#setup-test' };
    if (pc.oldIos) return plain('This iPhone or iPad can’t get reminders while the app is closed. They show only while the app is open. Update iOS to 16.4 or later to get them with the app closed.');
    if (!pushConfigured()) return plain('Closed-app reminders aren’t available here: no reminder server is set up. Reminders show only while the app is open.');
    if (!pc.canPush) return plain('This browser can’t receive reminders while it’s closed. They show only while the app is open or was recently used.');
    if (pc.needsInstallForPush) return plain('Add Daily Tracker to your Home Screen first (Share › Add to Home Screen), then open the app from there to turn on reminders.');
    if (pc.permission === 'denied') return { ...plain(`Notifications are blocked for Daily Tracker, so reminders can’t appear. ${REALLOW[pc.os] || REALLOW.default}`), content: [deskNote] };
    if (!hasRoute) return { art: '🔔', title: 'Notifications', text: 'Notifications are set up through your account, so create it first.', content: [], actions: [primary('Back to the account step', () => go('account'), 'setup-back-account'), cont('Skip for now')] };
    const turnOn = primary('Turn on notifications', async (e) => {
      note.text = '';
      const r = await busyBtn(e.currentTarget, 'Turning on…', () => enablePush());
      if (!r.ok) { note.text = r.message; note.kind = 'bad'; render(); return; }
      notifOn = true;
      if (r.warning) { note.text = r.warning; note.kind = 'bad'; }
      render();
    }, 'setup-notify-on');
    return {
      art: '🔔', title: 'Get reminders', text: 'One tap: your device asks to allow notifications, then it’s signed up for reminders that arrive even when the app is closed.',
      content: [deskNote, noteEl], actions: [turnOn, cont('Skip for now')], focus: '#setup-notify-on',
    };
  }

  function installStep() {
    const can = platformContext().canInstallPrompt;
    const how = pc.os === 'android' ? 'Open your browser’s menu (⋮) and tap Install app or Add to Home screen.' : 'Use the install icon in the address bar, or the browser menu › Install Daily Tracker.';
    const next = skip('Continue', DONE, 'setup-install-next');
    if (can) {
      return { art: '📲', title: 'Add to your home screen', text: 'Optional: one tap puts Daily Tracker on your home screen like an app.', content: [noteInstall()], actions: [primary('Install', async () => {
        const r = await promptInstall();
        if (r === 'accepted') go(DONE); else { note.text = 'Not installed. You can do it any time from the browser menu.'; note.kind = ''; render(); }
      }, 'setup-install'), skip('Skip this step', DONE, 'setup-skip-install')], focus: '#setup-install' };
    }
    return { art: '📲', title: 'Add to your home screen', text: `Optional. ${how}`, content: [], actions: [next] };
  }
  const noteInstall = () => (note.text ? h('p.setup-note', { role: 'status' }, note.text) : null);

  function doneStep() {
    const line = (ok, label, text) => h('li.setup-sum', h('span.setup-sum-icon' + (ok ? '.ok' : ''), { 'aria-hidden': 'true' }, icon(ok ? 'check' : 'x', { size: 16 })), h('span', h('strong', label), ' ', text));
    const acct = S.hasAccount();
    // iPhone/iPad browser tab: the Home Screen app keeps its own data, and an invite code works only once.
    const tabNote = acct && pc.needsInstallForPush ? h('p.setup-note', { id: 'setup-tab-note' }, 'This account lives in this browser tab. In the Home Screen app, choose “Sign in to your account” (not “I have an invite”: the code is used up) with your username and password.') : null;
    return {
      art: '🎉', title: 'You’re all set',
      text: '',
      content: [tabNote, h('ul.setup-sums',
        line(acct, 'Account', acct ? `Signed in as ${S.syncState().username}.` : 'Not set up. You can do it later in Settings › Account.'),
        line(notifOn, 'Notifications', notifOn ? 'On – reminders arrive even when the app is closed.' : 'Off. Reminders only fire while the app is open or was recently used. Turn them on in Settings › Account.'))],
      actions: [primary('Start using Daily Tracker', () => finish(), 'setup-finish')], focus: '#setup-finish',
    };
  }

  function render() {
    const v = step === 'code' ? codeStep() : step === 'account' ? accountStep() : step === 'notify' ? notifyStep() : step === 'install' ? installStep() : doneStep();
    body.replaceChildren(
      h('div.ob-art', { 'aria-hidden': 'true' }, v.art),
      h('p.setup-count', step === DONE ? 'Done' : `Step ${STEPS.indexOf(step) + 1} of ${STEPS.length}`),
      h('h2.ob-title', v.title),
      v.text ? h('p.ob-text', v.text) : null,
      ...v.content.filter(Boolean));
    foot.replaceChildren(...v.actions.filter(Boolean));
    dots.replaceChildren(...[...STEPS, DONE].map((s) => h('span.ob-dot', { role: 'listitem', 'aria-current': s === step ? 'step' : null, 'aria-selected': String(s === step) })));
    skipAll.textContent = step === DONE ? 'Close' : 'Skip setup';
    if (root.isConnected) (root.querySelector(v.focus || '.btn.primary'))?.focus({ preventScroll: true });
  }
  render();
  unmount = mount(root, step === 'code' ? '#setup-code' : '.ob-foot .btn.primary, .ob-first-actions .btn.primary');
}
