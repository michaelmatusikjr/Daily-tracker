// First-run welcome tour: swipeable cards (scroll-snap), skippable.
import { h } from './ui.js';
import { icon } from './icons.js';
import { update, getState, getActiveProfile, updateProfile, isFreshInstall } from './store.js';
import { seedExamples } from './actions.js';
import { accountsAvailable, hasAccount } from './sync.js';
import { openFirstSignIn, cancelFirstSignIn, resumeFirstSignIn, offerSyncPicker, resumeGoogleRedirect } from './account.js';
import { ctx } from './ctx.js';
import { openSetupWizard, showInstallFirst, needsInstallFirst } from './setup.js';

/**
 * App start with nothing onboarded: a brand-new install (only the untouched placeholder profile) first
 * asks whether to sign in to an account; everything else goes straight to the tour.
 */
export function startFirstRun({ google = null } = {}) {
  if (!(isFreshInstall() && accountsAvailable())) { showOnboarding(); if (google) resumeGoogleRedirect(google); return; }
  if (document.querySelector('.onboarding')) return;
  const finish = ({ offerPicker }) => {
    document.querySelector('.ob-first')?.remove();
    document.querySelectorAll('body > .app, body > .fab, body > .skip-link, body > #toasts').forEach((el) => el.removeAttribute('inert'));
    ctx.rerender?.();
    if (!getState().settings.onboarded) showOnboarding({ onFinish: offerPicker ? offerSyncPicker : null });
  };
  // Signed in already (a postponed download): never ask again, continue the signed-in flow.
  if (hasAccount()) { resumeFirstSignIn({ onDone: finish }); return; }
  const behind = [...document.querySelectorAll('body > .app, body > .fab, body > .skip-link, body > #toasts')];
  // Removed at once: the tour (or the next sheet) takes over and showOnboarding() refuses to open beside another .onboarding.
  const close = () => { behind.forEach((el) => el.removeAttribute('inert')); root.remove(); };
  const signIn = h('button.btn.primary.ob-choice', { type: 'button', onclick: () => {
    const onDone = ({ offerPicker }) => { close(); finish({ offerPicker }); };
    if (hasAccount()) resumeFirstSignIn({ onDone }); else openFirstSignIn({ onDone });
  } }, 'Sign in to your account');
  const invite = h('button.btn.secondary.ob-choice', { type: 'button', id: 'ob-invite', onclick: () => { cancelFirstSignIn(); close(); startInviteFlow({}); } }, 'I have an invite');
  const start = h('button.btn.ghost.ob-choice', { type: 'button', onclick: () => { cancelFirstSignIn(); close(); showOnboarding(); } }, 'Get started on this device');
  const root = h('div.onboarding.ob-first', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Welcome to Daily Tracker' },
    h('div.ob-panel',
      h('div.ob-top', h('span.ob-brand', icon('check', { size: 16 }), 'Daily Tracker')),
      h('div.ob-first-body',
        h('div.ob-art', { 'aria-hidden': 'true' }, '👋'),
        h('h2.ob-title', 'Welcome'),
        h('p.ob-text', 'Already use Daily Tracker on another device? Sign in to bring your profiles here. Got an invite from a friend? Use it to get set up. Or start fresh on this device.')),
      h('div.ob-first-actions', signIn, invite, start)));
  behind.forEach((el) => el.setAttribute('inert', ''));
  document.body.append(root);
  requestAnimationFrame(() => { root.classList.add('show'); signIn.focus(); });
  // Came back from Google's redirect sign-in (installed iPhone app): carry on as if "Sign in" was used.
  if (google) resumeGoogleRedirect(google, { onFirstDone: ({ offerPicker }) => { close(); finish({ offerPicker }); } });
}

/**
 * An invite (the link's #invite=CODE, the first screen's "I have an invite", or Settings): on an iPhone/iPad
 * browser tab the "Install first" screen comes before the wizard. When it ends, a device that hasn't had
 * the welcome tour yet gets it (and then the profile picker for a new account).
 */
export function startInviteFlow({ code = '', start = null } = {}) {
  if (!accountsAvailable() || document.querySelector('.ob-setup')) return;
  const after = ({ offerPicker = false } = {}) => {
    ctx.rerender?.();
    if (!getState().settings.onboarded) showOnboarding({ onFinish: offerPicker ? offerSyncPicker : null });
    else if (offerPicker) offerSyncPicker();
  };
  const go = () => openSetupWizard({ code, start, onDone: after });
  if (needsInstallFirst() && !start) showInstallFirst({ code, onContinue: go }); else go();
}
ctx.startInviteFlow = startInviteFlow;

export function showOnboarding({ onFinish = null } = {}) {
  if (document.querySelector('.onboarding')) return;
  const prevFocus = document.activeElement;
  // On a replay of the tour, don't add examples again unless asked.
  const firstRun = !getState().settings.onboarded;
  let seed = firstRun;
  // New users name their profile right here (optional; defaults to "Me").
  const nameInput = firstRun ? h('input.input.ob-name', { type: 'text', maxlength: 40, placeholder: 'Your name (optional)', autocomplete: 'given-name', 'aria-label': 'Your name' }) : null;
  const slides = [
    { art: '🗓️', title: 'Plan your day in seconds', text: 'Tap + and just type. “Gym 6pm” or “Call mom tomorrow 14:30” lands at the right time automatically.' },
    { art: '🔥', title: 'Build habits that stick', text: 'One tap to check off. Count goals like 8 glasses of water. Streaks respect your schedule, so rest days never break them.' },
    { art: '🌱', title: 'Everything stays on your device', text: 'Works offline, no account needed. Install it to your home screen for a native-app feel.', last: true },
  ];
  const track = h('div.ob-track', { tabindex: '-1' });
  const dots = h('div.ob-dots', { role: 'tablist', 'aria-label': 'Tour steps' });
  slides.forEach((sl, i) => {
    track.append(h('section.ob-slide', { 'aria-roledescription': 'slide', 'aria-label': `${i + 1} of ${slides.length}` },
      h('div.ob-art', { 'aria-hidden': 'true' }, sl.art),
      h('h2.ob-title', sl.title),
      h('p.ob-text', sl.text),
      sl.last && nameInput ? h('label.ob-name-label', h('span', 'What should we call you?'), nameInput) : null,
      sl.last ? h('label.ob-check',
        h('input', { type: 'checkbox', checked: seed, onchange: (e) => { seed = e.target.checked; } }),
        h('span', 'Add a few example habits to start')) : null));
    dots.append(h('button.ob-dot', { type: 'button', role: 'tab', 'aria-label': `Go to step ${i + 1}`, onclick: () => goTo(i) }));
  });
  const next = h('button.btn.primary.ob-next', { type: 'button', onclick: () => (current() < slides.length - 1 ? goTo(current() + 1) : finish(true)) }, 'Next');
  const skip = h('button.btn.ghost.ob-skip', { type: 'button', onclick: () => finish(false) }, 'Skip');
  const root = h('div.onboarding', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Welcome to Daily Tracker' },
    h('div.ob-panel',
      h('div.ob-top', h('span.ob-brand', icon('check', { size: 16 }), 'Daily Tracker'), skip),
      track,
      h('div.ob-foot', dots, next)));

  const current = () => Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
  function goTo(i) {
    track.scrollTo({ left: i * track.clientWidth, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  function sync() {
    const c = current();
    [...dots.children].forEach((d, i) => d.setAttribute('aria-selected', String(i === c)));
    next.textContent = c === slides.length - 1 ? 'Get started' : 'Next';
  }
  track.addEventListener('scroll', () => requestAnimationFrame(sync), { passive: true });
  function onKey(e) {
    if (e.key === 'Tab') {
      const f = [...root.querySelectorAll('button, input')].filter((x) => x.offsetParent !== null);
      const first = f[0], last = f[f.length - 1];
      if (!root.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      return;
    }
    if (e.key === 'Escape') finish(false);
    if (e.key === 'ArrowRight') goTo(Math.min(slides.length - 1, current() + 1));
    if (e.key === 'ArrowLeft') goTo(Math.max(0, current() - 1));
  }
  document.addEventListener('keydown', onKey);
  // Make everything behind the dialog inert so focus stays inside it.
  const behind = [...document.querySelectorAll('body > .app, body > .fab, body > .skip-link, body > #toasts')];
  behind.forEach((el) => el.setAttribute('inert', ''));
  function finish(completed) {
    behind.forEach((el) => el.removeAttribute('inert'));
    document.removeEventListener('keydown', onKey);
    root.classList.remove('show');
    setTimeout(() => root.remove(), 250);
    const name = nameInput?.value.trim();
    if (name) updateProfile(getActiveProfile().id, { name });
    if (firstRun) { try { localStorage.setItem('dailyTracker:tips', JSON.stringify({ settingsMoved: true })); } catch { /* ignore */ } }
    update((s) => { s.settings.onboarded = true; });
    if (completed && seed) seedExamples();
    if (prevFocus && document.contains(prevFocus)) prevFocus.focus?.();
    onFinish?.();
  }
  document.body.append(root);
  requestAnimationFrame(() => { root.classList.add('show'); sync(); next.focus(); });
}
