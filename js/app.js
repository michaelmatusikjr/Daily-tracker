// App bootstrap: routing, rendering, timers, PWA wiring.
import { load, subscribe, getState, getLoadFailure, resolveLoadFailure, onSaveError, onSaveOk, getActiveProfile, handleStorageEvent, pendingLegacy, resolveLegacy, legacyTargetProfile, isStorageOk } from './store.js';
import { ctx } from './ctx.js';
import { h, closeAllSheets, isSheetOpen, confirmDialog, toast, choose } from './ui.js';
import { takeover } from './takeover.js';
import { icon } from './icons.js';
import { applyTheme } from './theme.js';
import { todayKey, monthStart, isValidKey } from './dates.js';
import { renderToday, resetCalendar } from './views/today.js';
import { renderHabits } from './views/habits.js';
import { renderHabitDetail } from './views/habitDetail.js';
import { renderStats } from './views/allStats.js';
import { renderJournal } from './views/journal.js';
import { renderSettings } from './views/settings.js';
import { openQuickAdd, openHabitForm } from './forms.js';
import { showOnboarding, startFirstRun, startInviteFlow } from './onboarding.js';
import { captureInviteFromUrl, clearPendingInvite } from './invites.js';
import { captureSignInFromUrl, householdAvailable } from './household.js';
import { resumeGoogleRedirect } from './account.js';
import { registerSW, onInstallChange, safeReload } from './pwa.js';
import { reschedule } from './notify.js';
import { initPush, scheduleSync, onPushChange } from './push.js';
import { renderWorkouts, renderExercise } from './views/workouts.js';
import { openWorkoutForm } from './workoutForm.js';
import { openJournalForm } from './journalForm.js';
import { openProfileEditor } from './profiles.js';
import { APP_VERSION as APP_VERSION_STR, storedDataProfileIds, getProfiles, readProfileState, switchProfile } from './store.js';
import { openTaskView } from './taskView.js';
import { openHabitView } from './habitSheet.js';
import { renderCompleted } from './views/completed.js';
import { collectGarbage } from './attachments.js';
import { goToStorage } from './clearCompleted.js';
import { initNoZoom } from './noZoom.js';
import { initKeyboard } from './keyboard.js';
import { initSync, onSyncChange, profileReset, syncState, forgetKept, hasAccount, accountsAvailable } from './sync.js';
import { refreshWeather } from './weather.js';

const TABS = [
  { id: 'today', label: 'Today', icon: 'today' },
  { id: 'habits', label: 'Habits', icon: 'habits' },
  { id: 'workouts', label: 'Workouts', icon: 'dumbbell' },
  { id: 'journal', label: 'Journal', icon: 'book' },
  { id: 'settings', label: 'Settings', icon: 'settings', desktopOnly: true },
];
// On phones Settings has no tab: it opens from the profile menu (avatar on Today) or #settings.
// The wide-screen side nav also lists it.
const TITLES = { completed: 'Completed', today: 'Today', habits: 'Habits', habit: 'Habit', workouts: 'Workouts', exercise: 'Exercise', stats: 'Stats', journal: 'Journal', settings: 'Settings' };

const main = document.getElementById('main');
const nav = document.getElementById('nav');
let lastRoute = null;
let lastTabIdx = -1;
const tabIdxOf = (name) => TABS.findIndex((t) => t.id === (name === 'habit' ? 'habits' : name === 'exercise' ? 'workouts' : name));
let lastToday = todayKey();

function parseRoute() {
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  // The Calendar tab is gone: an old "#calendar" link opens Today with the month calendar pulled down.
  if (name === 'calendar') return { name: 'today', arg: null, legacyCalendar: true };
  return { name: TITLES[name] ? name : 'today', arg: arg ? decodeURIComponent(arg) : null };
}

function buildNav() {
  nav.replaceChildren(
    h('div.nav-brand', h('span.brand-mark', { 'aria-hidden': 'true' }, icon('check', { size: 16 })), h('span', 'Daily Tracker')),
    ...TABS.map((t) => h(`a.nav-item${t.desktopOnly ? '.desktop-only' : ''}`, {
      href: '#' + t.id, dataset: { tab: t.id },
      // Tapping the Today tab always means "today" (calendar day taps set a date explicitly).
      onclick: t.id === 'today' ? () => { ctx.ui.date = todayKey(); if (parseRoute().name === 'today') render(); } : null,
    },
      h('span.nav-icon', icon(t.icon, { size: 22 })), h('span.nav-label', t.label))));
}

/**
 * "#open/task|habit/<profileId>/<id>/<date>" (a tapped reminder): switch profile if needed, show
 * Today on that date, highlight the item and open its action menu. The hash is replaced with
 * "#today" first, so back/reload don't trigger it again.
 */
function openDeepLink(hash = location.hash) {
  const m = /^#open\/(task|habit)\/([^/]+)\/([^/]+)\/(\d{4}-\d{2}-\d{2})$/.exec(hash);
  try { history.replaceState(null, '', '#today'); } catch { /* ignore */ }
  closeAllSheets();
  let kind, pid, id, date;
  try { [, kind, pid, id, date] = m.map((x) => decodeURIComponent(x)); } catch { m && (m.length = 0); }
  const profile = m && getProfiles().find((p) => p.id === pid);
  const data = profile && readProfileState(pid);
  const exists = data && (kind === 'task' ? data.tasks.some((t) => t.id === id) : data.habits.some((x) => x.id === id));
  if (!exists) {
    ctx.ui.date = todayKey();
    render();
    toast('That reminder’s item was deleted.', { force: true });
    return;
  }
  if (!isValidKey(date)) {
    ctx.ui.date = todayKey();
    render();
    toast('That reminder’s date isn’t valid – showing today.', { force: true });
    return;
  }
  if (getActiveProfile()?.id !== pid) {
    switchProfile(pid); // re-renders with fresh view state
    syncTheme(); // always that profile's theme + accent (also on a cold launch, before subscribe() runs)
    toast(`Switched to ${profile.name}`, { force: true });
  }
  ctx.ui.date = date;
  render();
  cancelRestore();
  // Highlight the row (if it shows on that day) and open the item's menu.
  const sel = kind === 'task' ? `.task[data-id="${CSS.escape(id)}"]` : `.habit-row[data-id="${CSS.escape(id)}"]`;
  const row = document.querySelector(sel);
  if (row) {
    row.scrollIntoView({ block: 'center' });
    cancelRestore();
    row.classList.add('pulse');
    setTimeout(() => row.classList.remove('pulse'), 2400);
    (row.querySelector('.task-main, .habit-row-main') || row.querySelector('button'))?.focus({ preventScroll: true });
  }
  // A task opens its View sheet (the row stays highlighted behind it); a habit opens its menu.
  if (kind === 'task') { setTimeout(() => openTaskView(id, date, { fromNotification: true }), row ? 350 : 0); return; }
  setTimeout(() => openHabitView(id, date, { fromNotification: true }), row ? 350 : 0);
}

/** Apply the active profile's theme + accent (no-op when unchanged). */
let lastSettingsSig = null;
function syncTheme() {
  const st = getState();
  applyTheme(st.settings);
  lastSettingsSig = JSON.stringify(st.settings);
}

/** Keeps --head-h (used for scroll padding/margins) equal to the fixed header's height. */
let headObserver = null;
function trackHeaderHeight(head) {
  headObserver?.disconnect();
  const set = () => document.documentElement.style.setProperty('--head-h', (head ? head.offsetHeight + 8 : 0) + 'px');
  set();
  if (head && 'ResizeObserver' in window) { headObserver = new ResizeObserver(set); headObserver.observe(head); }
}

// Pending post-render scroll restore: cancelled by user input or an explicit scroll (deep link), but
// not by generic scroll events (iOS focus scroll, scroll anchoring are what the restore undoes).
let restoreGen = 0;
let ownY = null;
function ownScrollTo(y) { ownY = y; window.scrollTo(0, y); }
const cancelRestore = () => { restoreGen++; };
for (const ev of ['touchstart', 'touchmove', 'wheel', 'keydown', 'pointerdown']) window.addEventListener(ev, cancelRestore, { passive: true, capture: true });
// A render counts as user-caused only shortly after real input inside main (focus is no signal: iOS
// doesn't focus tapped buttons, and main itself has focus after every tab change).
let lastMainInput = -Infinity;
const markMainInput = (e) => { if (e.target instanceof Node && main.contains(e.target)) lastMainInput = performance.now(); };
for (const ev of ['pointerup', 'click', 'change', 'input', 'keydown']) window.addEventListener(ev, markMainInput, { passive: true, capture: true });

/** Identity of a focused control: tag + role + aria-label (or text) and its ordinal among identical ones. */
function focusIdentity(el, sel) {
  const key = (e) => [e.tagName, e.getAttribute('role') || '', e.getAttribute('aria-label') || (e.textContent || '').trim().slice(0, 80)].join('|');
  const k = key(el);
  const same = [...main.querySelectorAll(sel)].filter((e) => key(e) === k);
  return { k, n: same.indexOf(el), key };
}
function findByIdentity(id, sel) {
  return [...main.querySelectorAll(sel)].filter((e) => id.key(e) === id.k)[id.n] || null;
}

function render() {
  if (location.hash.startsWith('#open/')) { openDeepLink(); return; }
  let { name, arg, legacyCalendar } = parseRoute();
  if (legacyCalendar) { ctx.ui.calOpen = true; ctx.ui.calMonth = monthStart(ctx.ui.date); try { history.replaceState(null, '', '#today'); } catch { /* ignore */ } }
  // "#today/2026-11-20" (from a reminder notification) opens that day, then the URL tidies up.
  if (name === 'today' && arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) {
    ctx.ui.date = arg;
    try { history.replaceState(null, '', '#today'); } catch { /* ignore */ }
    arg = null;
  }
  const routeKey = name + '/' + (arg || '');
  const changedRoute = routeKey !== lastRoute;
  // Remember which control had focus so keyboard users keep their place.
  const fk = document.activeElement?.closest?.('[data-fk]')?.dataset.fk;
  // A same-screen re-render caused by the user's own tap/keyboard in the view (focus is inside main)
  // keeps the exact scroll position and the focused control (iOS otherwise scrolls to wherever focus
  // lands once the tapped button is replaced). Background renders (tick, sync, storage) never scroll.
  const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';
  const ae = document.activeElement;
  const userRender = !changedRoute && performance.now() - lastMainInput < 1000;
  const scrollY = window.scrollY;
  const fid = !fk && !changedRoute && ae && ae !== document.body && ae !== main && main.contains(ae) ? focusIdentity(ae, FOCUSABLE) : null;
  let view;
  switch (name) {
    case 'habits': view = renderHabits(); break;
    case 'habit': view = renderHabitDetail(arg); break;
    case 'stats': view = renderStats(); break;
    case 'journal': view = renderJournal(); break;
    case 'completed': view = renderCompleted(); break;
    case 'settings': view = renderSettings(); break;
    case 'workouts': view = renderWorkouts(); break;
    case 'exercise': view = renderExercise(arg); break;
    default: view = renderToday();
  }
  // Slide in from the side of the tapped tab, but only when the tab/route really changed (re-renders
  // happen every minute and on every data change). Sub-tabs (Habits/Workouts) set ctx.slide.
  const tabIdx = tabIdxOf(name);
  let dir = null;
  if (changedRoute && lastRoute !== null && tabIdx >= 0 && lastTabIdx >= 0 && tabIdx !== lastTabIdx) dir = tabIdx > lastTabIdx ? 'r' : 'l';
  else if (!changedRoute && ctx.slide) dir = ctx.slide;
  ctx.slide = null;
  if (dir) view.classList.add('slide-' + dir);
  else if (changedRoute) view.classList.add('enter');
  lastTabIdx = tabIdx;
  const failure = getLoadFailure();
  if (failure) view.prepend(loadFailureCard(failure));
  main.replaceChildren(view);
  trackHeaderHeight(view.querySelector('.app-head'));
  ctx.anim.clear();
  const activeTab = name === 'habit' ? 'habits' : name === 'exercise' ? 'workouts' : name;
  nav.querySelectorAll('.nav-item').forEach((a) => {
    if (a.dataset.tab === activeTab) {
      if (changedRoute && lastRoute !== null && a.getAttribute('aria-current') !== 'page') {
        const ic = a.querySelector('.nav-icon');
        ic?.classList.add('bounce');
        setTimeout(() => ic?.classList.remove('bounce'), 400);
      }
      a.setAttribute('aria-current', 'page');
    } else a.removeAttribute('aria-current');
  });
  document.title = `${TITLES[name]} · Daily Tracker`;
  fab.hidden = name === 'settings' || name === 'stats';
  if (name !== 'today') { ctx.ui.calOpen = false; resetCalendar(); }
  fab.setAttribute('aria-label', name === 'habits' || name === 'habit' ? 'New habit' : name === 'workouts' || name === 'exercise' ? 'Log workout' : name === 'journal' ? 'New journal entry' : 'Quick add');
  if (changedRoute) {
    window.scrollTo(0, 0);
    if (lastRoute !== null) main.focus({ preventScroll: true });
  } else {
    if (fk) document.querySelector(`[data-fk="${CSS.escape(fk)}"]`)?.focus({ preventScroll: true });
    else if (fid) findByIdentity(fid, FOCUSABLE)?.focus({ preventScroll: true });
    if (userRender) {
      if (window.scrollY !== scrollY) ownScrollTo(scrollY);
      // Again after layout settles (fonts/images, iOS's own focus scroll) – unless the user scrolled
      // or something else (a deep link, a "Show" button) scrolled in the meantime.
      const gen = ++restoreGen;
      requestAnimationFrame(() => { if (gen === restoreGen && parseRoute().name === name && Math.abs(window.scrollY - scrollY) > 1) ownScrollTo(scrollY); ownY = null; });
    }
  }
  if (ctx.ui.scrollTo) { // e.g. the "storage full" banner: land on Settings › Storage
    const target = document.getElementById(ctx.ui.scrollTo);
    ctx.ui.scrollTo = null;
    if (target) requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
  }
  lastRoute = routeKey;
}

function loadFailureCard(failure) {
  const exportRaw = () => {
    const url = URL.createObjectURL(new Blob([failure.raw ?? ''], { type: 'application/json' }));
    const a = h('a', { href: url, download: `daily-tracker-unreadable-data-${todayKey()}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  const reset = async () => {
    if (!(await confirmDialog('Start fresh?', 'The unreadable data stays stored as a backup on this device, but the app will start empty and save new changes.', { ok: 'Start fresh', danger: true }))) return;
    // A synced profile is downloaded again from the account instead of uploading the empty data
    // (marked before the reset is saved, so a sync in another window never sees it as edits).
    const pid = getActiveProfile().id;
    const refetch = profileReset(pid);
    // Not synced (e.g. a copy kept from an account while signed out): the empty start must never be
    // resumed against the kept shadow (that would tombstone the account's copy). Forgotten first.
    if (!refetch) await forgetKept([pid]).catch(() => {});
    resolveLoadFailure();
    if (refetch) toast('Started fresh. Your old data is kept as a backup; the account’s copy is being downloaded.', { force: true });
    else toast('Started fresh. Your old data is still kept as a backup.');
  };
  return h('section.card.warn-card.load-fail', { role: 'alert' },
    h('div',
      h('p.load-fail-title', 'We couldn’t read your saved data'),
      h('p.set-desc', 'Nothing has been overwritten: a backup is stored on this device. Changes are not saved until you choose what to do.'),
      h('div.set-actions',
        h('button.btn.secondary.small', { type: 'button', onclick: exportRaw }, icon('download', { size: 16 }), 'Export raw data'),
        h('button.btn.danger-ghost.small', { type: 'button', onclick: reset }, icon('refresh', { size: 16 }), 'Reset'))));
}

let legacyOpen = false;
const LEGACY_TITLE = 'Changes from an older version';
/** An old (pre-1.3) tab kept writing after the upgrade: offer to bring those changes in. */
async function offerLegacyMerge() {
  if (legacyOpen || !pendingLegacy()) return;
  legacyOpen = true;
  const target = legacyTargetProfile();
  const name = target?.name || 'this profile';
  const choice = await choose(LEGACY_TITLE,
    'Changes made in an older version of the app were found (probably a tab that was still open during the update). What should happen to them?', [
      { value: 'merge', label: `Merge into ${name}`, style: 'primary' },
      { value: 'add', label: 'Add as new profile', style: 'secondary' },
      { value: 'discard', label: 'Discard', style: 'danger' },
    ]);
  legacyOpen = false;
  if (!choice) return; // closed: ask again next time
  if (choice === 'discard' && !(await confirmDialog('Discard those changes?', 'They can’t be recovered afterwards.', { ok: 'Discard', danger: true }))) { offerLegacyMerge(); return; }
  const res = resolveLegacy(choice, target?.id);
  const msg = { Merged: `Merged into ${name}`, Added: 'Added as profile “Older version”', Discarded: 'Older changes discarded', Unreadable: 'Those changes couldn’t be read', 'Storage full': 'Couldn’t save – storage is full' }[res] || res;
  toast(msg, res === 'Storage full' ? { force: true, action: 'Storage', onAction: goToStorage } : { force: true });
}

function rollover() {
  const t = todayKey();
  if (t === lastToday) return false;
  if (ctx.ui.date === lastToday) ctx.ui.date = t;
  if (ctx.ui.calMonth === monthStart(lastToday)) ctx.ui.calMonth = monthStart(t);
  lastToday = t;
  return true;
}

const fab = h('button.fab', { type: 'button', 'aria-label': 'Quick add', onclick: () => {
  if (isSheetOpen()) return; // ignore double-taps while a sheet is open
  const { name } = parseRoute();
  if (name === 'habits' || name === 'habit') openHabitForm(null);
  else if (name === 'workouts') openWorkoutForm(null);
  else if (name === 'exercise') openWorkoutForm(null, { exerciseId: parseRoute().arg });
  else if (name === 'journal') openJournalForm(todayKey());
  else openQuickAdd();
} }, icon('plus', { size: 28 }));

ctx.rerender = render;
ctx.setDate = (k) => { ctx.ui.date = k; if (parseRoute().name === 'today') render(); };
ctx.go = (route) => {
  if (location.hash === '#' + route) render(); else location.hash = '#' + route;
};

function init() {
  initNoZoom();
  initKeyboard();
  // The household (Google) redirect sign-in coming back: "#signin=CODE" is read and removed first, too.
  const googleReturn = householdAvailable() ? captureSignInFromUrl() : null;
  const invite = captureInviteFromUrl(); // "#invite=CODE" is read and removed from the address before anything else
  load();
  applyTheme(getState().settings);
  buildNav();
  document.body.append(fab);
  // Forced weather refresh (fresh position + forecast) when the selected location is "current".
  const forceWeather = (always = false) => {
    const w = getState().settings.weather;
    if (getState().settings.onboarded && w && (always || w.selected === 'current')) refreshWeather(w, { auto: true });
  };
  forceWeather(); // once per app launch, before the first render so its own refresh doesn't double up
  render();
  syncTheme(); // the first render may have switched profile (cold launch from a notification)
  let scheduleTimer;
  subscribe((st, info = {}) => {
    const sNow = JSON.stringify(st.settings);
    if (sNow !== lastSettingsSig) { applyTheme(st.settings); lastSettingsSig = sNow; }
    if (info.profileSwitched) {
      // Fresh view state for the other person.
      closeAllSheets();
      Object.assign(ctx.ui, { date: todayKey(), calMonth: monthStart(todayKey()), calOpen: false, statsMonth: null, statsRange: 'month', detailMonth: null, habitsReorder: false, showArchived: false, habitsTab: 'active', workoutsTab: 'workouts', journalQuery: '', workoutFilter: 'all', workoutDays: 30 });
      applyTheme(st.settings); lastSettingsSig = sNow;
    }
    render();
    clearTimeout(scheduleTimer);
    scheduleTimer = setTimeout(reschedule, 300);
    scheduleSync(); // push server copy (debounced; no-op unless push is on)
  });
  window.addEventListener('hashchange', () => {
    // An invite link opened while the app is running: take the code out of the address and open the wizard.
    if (/^#invite=/i.test(location.hash)) { const inv = captureInviteFromUrl(); if (inv.present) {
        if (accountsAvailable() && !hasAccount()) startInviteFlow({ code: inv.code }); else clearPendingInvite();
        return;
      } }
    closeAllSheets(); render();
  });
  // Keyboard shortcut: "n" opens quick add.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && !isSheetOpen() && !document.querySelector('.onboarding')) {
      e.preventDefault();
      fab.click();
    }
  });
  // Keep "now" line fresh and roll over at midnight.
  // Re-plan reminders when notification permission changes (e.g. allowed in browser settings).
  let lastPerm = 'Notification' in window ? Notification.permission : 'unsupported';
  setInterval(() => {
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    if (perm !== lastPerm) { lastPerm = perm; reschedule(); }
    if (rollover()) reschedule();
    if (parseRoute().name === 'today' && !document.body.classList.contains('sheet-open') && !document.activeElement?.matches?.('textarea, input')) render();
  }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    rollover();
    forceWeather(); // first, so the render below doesn't start a second forecast request
    if (!document.body.classList.contains('sheet-open')) render();
    reschedule();
  });
  onInstallChange(() => { if (parseRoute().name === 'settings') render(); });
  reschedule();
  if (getLoadFailure()) {
    // Make sure the warning is seen: no scroll restoration, start at the top, and a toast too.
    try { history.scrollRestoration = 'manual'; } catch { /* ignore */ }
    window.scrollTo(0, 0);
    // Some browsers still restore scroll after load; reset again while the warning is up.
    const toTop = () => { if (getLoadFailure()) window.scrollTo(0, 0); };
    window.addEventListener('load', () => { toTop(); requestAnimationFrame(toTop); });
    window.addEventListener('pageshow', toTop);
    setTimeout(() => takeover({
      emoji: '⚠️', kind: 'alert', autoDismiss: false, message: 'Saved data couldn’t be read. Changes are paused until you choose.',
      action: 'Show', onAction: () => window.scrollTo({ top: 0, behavior: 'smooth' }),
    }), 300);
  }
  // Alarms were removed in 1.2.0: drop their leftover runtime state.
  try { localStorage.removeItem('dailyTracker:alarmRuntime'); } catch { /* ignore */ }
  // Saving can fail when the device's storage is full (e.g. many profile photos).
  // A failed save shows a banner that stays until a save works again (success toasts are muted meanwhile).
  const banner = document.getElementById('save-banner');
  const showBanner = (on) => { banner.hidden = !on; };
  banner.querySelector('[data-action="storage"]')?.addEventListener('click', () => goToStorage());
  onSaveError(() => showBanner(true));
  onSaveOk(() => showBanner(false));
  if (!isStorageOk()) showBanner(true);
  // Changes from other tabs: the profile list, this profile's data, or an old-version tab.
  window.addEventListener('storage', (e) => {
    const r = handleStorageEvent(e);
    if (!r) return;
    if (r.deletedElsewhere) {
      toast(`That profile was deleted in another window. Switched to ${getActiveProfile()?.name || 'another profile'}.`, { force: true, duration: 6000 });
    }
    if (r.legacyChanged) offerLegacyMerge();
    if (r.legacyResolved && legacyOpen) {
      // Another window answered the same question: close ours.
      const t = [...document.querySelectorAll('.sheet-root .sheet-title')].find((x) => x.textContent === LEGACY_TITLE);
      t?.closest('.sheet')?.querySelector('.sheet-head .icon-btn')?.click();
      toast('Older-version changes were handled in another window', { force: true });
    }
    if (r.profileChanged || r.external) reschedule();
  });
  // When another tab activates a new version, reload so we never run old code against new data.
  navigator.serviceWorker?.addEventListener?.('message', (e) => {
    if (e.data?.type === 'APP_UPDATED' && e.data.version && e.data.version !== APP_VERSION_STR) safeReload(e.data.version);
    // A tapped reminder notification: show its day in this window.
    if (e.data?.type === 'OPEN_URL' && typeof e.data.url === 'string') {
      try { const u = new URL(e.data.url, location.href); if (u.origin === location.origin && u.hash) {
        closeAllSheets();
        // Handle a reminder link directly (a hashchange can be missed when the hash is unchanged).
        if (u.hash.startsWith('#open/')) { try { history.replaceState(null, '', u.hash); } catch { /* ignore */ } openDeepLink(u.hash); } else location.hash = u.hash;
      } } catch { /* ignore */ }
    }
  });
  onPushChange(() => { if (parseRoute().name === 'settings' && !isSheetOpen()) render(); });
  // Account changes (signed in/out, a profile now syncing) change the "On this device only" marks.
  let syncSig = null;
  onSyncChange(() => {
    const s = syncState();
    const sig = JSON.stringify([!!s.accountId, s.synced || []]);
    if (sig === syncSig) return;
    syncSig = sig;
    if (!isSheetOpen() && !document.activeElement?.matches?.('input, textarea')) render();
  });
  if (googleReturn && accountsAvailable()) { if (!getState().settings.onboarded) startFirstRun({ google: googleReturn }); else resumeGoogleRedirect(googleReturn); }
  else if ((invite.present || invite.code) && accountsAvailable() && !hasAccount()) startInviteFlow({ code: invite.code });
  else if (invite.present || invite.code) { clearPendingInvite(); if (!getState().settings.onboarded) startFirstRun(); }
  else if (!getState().settings.onboarded) startFirstRun();
  else if (getActiveProfile()?.introPending) setTimeout(() => openProfileEditor(getActiveProfile(), { intro: true, onDone: () => offerLegacyMerge() }), 400);
  else setTimeout(() => offerLegacyMerge(), 500);
  registerSW();
  initPush();
  initSync();
  // Photos no task refers to any more (in any profile), e.g. after a delete whose Undo window ended
  // while the app was closed: clean up a moment after start.
  setTimeout(() => {
    const ids = new Set();
    const states = getProfiles().map((p) => readProfileState(p.id));
    if (states.some((x) => !x)) return; // a profile can't be read: don't guess what it refers to
    for (const st of states) for (const t of st.tasks || []) for (const a of t.attachments || []) ids.add(a.id);
    // Profiles whose data is still stored but missing from the index (damaged index): keep their photos.
    const listed = new Set(getProfiles().map((x) => x.id));
    const orphanDataIds = new Set(storedDataProfileIds().filter((x) => !listed.has(x)));
    collectGarbage(ids, Date.now(), orphanDataIds).catch(() => { /* storage unavailable: nothing to clean */ });
  }, 3000);
}

init();
