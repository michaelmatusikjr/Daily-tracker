// Settings › Storage and "Clear completed tasks": bulk-delete old completed tasks (and their photos)
// to free space. Active profile only; habits, workouts and the journal are never touched.
import { h, openSheet, toast, confirmDialog, segmented } from './ui.js';
import { icon } from './icons.js';
import { getState, update, getActiveProfile, getProfiles, readProfileState, mutateProfileData } from './store.js';
import { isRecurring, occursOn } from './logic.js';
import { todayKey, toKey, addMonths, addDays, fmtDateShort, isValidKey } from './dates.js';
import { getFile, deleteFiles, profileUsage, fmtBytes } from './attachments.js';
import { isSynced } from './sync.js';
import { ctx } from './ctx.js';

const UNDO_MS = 10000;      // how long the Undo toast stays
const PHOTO_DELAY_MS = 15000; // photos are removed only after that, and only if the tasks didn't come back
const HORIZON = 800;        // days looked ahead to decide whether a repeating series is still running
const big = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : fmtBytes(b));
const bytesOf = (v) => JSON.stringify(v).length * 2; // localStorage is UTF-16 (2 bytes per character)

/** The day a one-off task was completed (what the Completed screen groups by). */
const completedDay = (t) => (t.completedAt ? toKey(new Date(t.completedAt)) : t.date);

/**
 * Which tasks "completed before `cutoff`" clears: done one-offs (including early-completed copies)
 * completed before it, and finished repeating series (completions all before the cutoff and no
 * occurrence left from it on: rare, there are no end dates). Returns { tasks, partial }: `tasks` are
 * deleted; `partial` are running repeating tasks that keep going but lose their completions before
 * the cutoff (see clearHistory: they get `clearedBefore`, so those days stop existing).
 */
export function planClear(state, cutoff) {
  const tasks = [];
  const partial = []; // running repeating tasks: { t, n } n = completions before the cutoff to clear
  for (const t of state.tasks) {
    if (!isRecurring(t)) {
      if (t.done && completedDay(t) < cutoff) tasks.push(t);
      continue;
    }
    const done = Object.keys(t.doneDates || {}).filter((k) => t.doneDates[k] && k < cutoff);
    if (!done.length) continue;
    let running = false;
    const later = Object.keys(t.doneDates).some((k) => t.doneDates[k] && k >= cutoff);
    for (let i = 0, k = cutoff; i < HORIZON && !running && !later; i++, k = addDays(k, 1)) running = occursOn(t, k);
    if (!running && !later) tasks.push(t); // finished series: cleared like a one-off
    else partial.push({ t, n: done.length }); // still running: only its old history goes
  }
  return { tasks, partial };
}

/** Clear a running task's history before `cutoff`: returns what was removed (for Undo) or null. */
function clearHistory(t, cutoff) {
  const gone = { id: t.id, set: null, prevBefore: t.clearedBefore, done: {}, doneAt: {}, exceptions: [] };
  const before = (k) => k < cutoff;
  for (const k of Object.keys(t.doneDates || {})) if (before(k)) { gone.done[k] = t.doneDates[k]; delete t.doneDates[k]; }
  for (const k of Object.keys(t.doneAt || {})) if (before(k)) { gone.doneAt[k] = t.doneAt[k]; delete t.doneAt[k]; }
  if (t.doneAt && !Object.keys(t.doneAt).length) delete t.doneAt;
  gone.exceptions = (t.exceptions || []).filter(before);
  t.exceptions = (t.exceptions || []).filter((k) => !before(k));
  if (!t.clearedBefore || t.clearedBefore < cutoff) t.clearedBefore = cutoff;
  gone.set = t.clearedBefore;
  t.updatedAt = Date.now();
  return gone;
}

/** Undo of clearHistory for one task: put back only what was removed, keep everything changed since. */
function restoreHistory(t, g) {
  if (t.clearedBefore === g.set) { if (g.prevBefore) t.clearedBefore = g.prevBefore; else delete t.clearedBefore; }
  else if (t.clearedBefore && t.clearedBefore > g.set) return; // cleared further since: leave it
  t.doneDates = t.doneDates || {};
  for (const [k, v] of Object.entries(g.done)) if (!(k in t.doneDates)) t.doneDates[k] = v;
  if (Object.keys(g.doneAt).length) { t.doneAt = t.doneAt || {}; for (const [k, v] of Object.entries(g.doneAt)) if (!(k in t.doneAt)) t.doneAt[k] = v; }
  t.exceptions = [...new Set([...(t.exceptions || []), ...g.exceptions])];
  t.updatedAt = Date.now();
}

/** Photo ids of `tasks` that no other task (any profile) still refers to. */
function clearablePhotoIds(tasks, pid) {
  const gone = new Set(tasks.map((t) => t.id));
  const keep = new Set();
  for (const p of getProfiles()) {
    const st = readProfileState(p.id);
    for (const t of st?.tasks || []) if (p.id !== pid || !gone.has(t.id)) for (const a of t.attachments || []) keep.add(a.id);
  }
  const ids = new Set();
  for (const t of tasks) for (const a of t.attachments || []) if (!keep.has(a.id)) ids.add(a.id);
  return [...ids];
}

async function photoStats(ids) {
  let count = 0, bytes = 0;
  for (const id of ids) {
    try { const f = await getFile(id); if (f) { count++; bytes += (f.blob?.size || 0) + (f.thumbBlob?.size || 0); } } catch { /* unreadable: not counted */ }
  }
  return { count, bytes };
}

/** Remove the photos once nothing refers to them any more (after the Undo window). */
function deletePhotosLater(ids) {
  if (!ids.length) return;
  setTimeout(() => {
    const keep = new Set();
    for (const p of getProfiles()) {
      const st = readProfileState(p.id);
      if (!st) return; // an unreadable profile: don't guess what it refers to (start-up clean-up decides later)
      for (const t of st.tasks || []) for (const a of t.attachments || []) keep.add(a.id);
    }
    deleteFiles(ids.filter((id) => !keep.has(id))).catch(() => { /* start-up clean-up will catch it */ });
  }, PHOTO_DELAY_MS);
}

/** Delete the planned tasks and clear the history of running ones, with one Undo. Returns { tasks, completions }. */
export function clearTasks({ tasks, partial }, cutoff) {
  const pid = getActiveProfile().id;
  const snaps = tasks.map((t) => JSON.parse(JSON.stringify(t)));
  const idSet = new Set(snaps.map((t) => t.id));
  const photoIds = clearablePhotoIds(tasks, pid);
  const pids = new Set(partial.map((x) => x.t.id));
  const gone = [];
  update((s) => {
    s.tasks = s.tasks.filter((t) => !idSet.has(t.id));
    for (const t of s.tasks) if (pids.has(t.id)) gone.push(clearHistory(t, cutoff));
  });
  deletePhotosLater(photoIds);
  const n = gone.reduce((a, g) => a + Object.keys(g.done).length, 0);
  const parts = [];
  if (snaps.length) parts.push(`${snaps.length} completed task${snaps.length === 1 ? '' : 's'}`);
  if (n) parts.push(`${n} completion${n === 1 ? '' : 's'}`);
  toast(`Cleared ${parts.join(' and ')}`, {
    action: 'Undo', duration: UNDO_MS, force: true,
    // Put back only what was removed (re-found by id, merged into the current data), never an old snapshot.
    onAction: () => mutateProfileData(pid, (s) => {
      for (const t of snaps) if (!s.tasks.some((x) => x.id === t.id)) s.tasks.push(JSON.parse(JSON.stringify(t)));
      for (const g of gone) { const t = s.tasks.find((x) => x.id === g.id); if (t) restoreHistory(t, g); }
    }),
  });
  return { tasks: snaps.length, completions: n };
}

// ---------- The sheet ----------
const PICKS = [['1m', 'Older than 1 month'], ['3m', 'Older than 3 months'], ['1y', 'Older than 1 year'], ['custom', 'Custom date']];
const pickDate = (v, today) => (v === '1m' ? addMonths(today, -1) : v === '3m' ? addMonths(today, -3) : addMonths(today, -12));

export function openClearSheet() {
  const today = todayKey();
  const pid = getActiveProfile().id;
  let pick = '3m';
  let custom = addMonths(today, -6);
  const preview = h('div.clear-preview', { role: 'status', 'aria-live': 'polite' });
  const dateIn = h('input.input', { type: 'date', value: custom, max: today, 'aria-label': 'Completed before', onchange: (e) => { custom = e.target.value; refresh(); } });
  const customRow = h('div.field', { hidden: true }, h('label.field-label', 'Completed before'), dateIn);
  const go = h('button.btn.danger', { type: 'button', disabled: true, onclick: () => run() }, 'Clear…');
  let plan = null, seq = 0;
  const cutoff = () => (pick === 'custom' ? (isValidKey(custom) ? custom : null) : pickDate(pick, today));

  async function refresh() {
    const mine = ++seq;
    customRow.hidden = pick !== 'custom';
    const c = cutoff();
    go.disabled = true; plan = null;
    if (!c) { preview.replaceChildren(h('p.muted', 'Choose a date.')); return; }
    const { tasks, partial } = planClear(getState(), c);
    const ids = clearablePhotoIds(tasks, pid);
    const ph = await photoStats(ids);
    if (mine !== seq) return;
    const comps = partial.reduce((n, x) => n + x.n, 0);
    const taskBytes = tasks.reduce((n, t) => n + bytesOf(t), 0) + comps * 100; // a completion: its date key (+ time) in the task
    plan = { c, tasks, comps };
    if (!tasks.length && !comps) { preview.replaceChildren(h('p.muted', `No completed tasks before ${fmtDateShort(c)}, ${c.slice(0, 4)}.`)); return; }
    const when = `${fmtDateShort(c)}, ${c.slice(0, 4)}`;
    preview.replaceChildren(
      h('p.clear-line', h('strong', String(tasks.length)), ` completed task${tasks.length === 1 ? '' : 's'} before ${when}`),
      h('p.clear-line', h('strong', String(ph.count)), ` photo${ph.count === 1 ? '' : 's'}`),
      comps ? h('p.clear-line', `Also clears ${comps} completion${comps === 1 ? '' : 's'} of ${partial.length} repeating task${partial.length === 1 ? '' : 's'} before ${when}. The task${partial.length === 1 ? ' keeps' : 's keep'} repeating.`) : null,
      h('p.clear-line', 'Frees about ', h('strong', fmtBytes(taskBytes + ph.bytes))));
    go.disabled = false;
  }

  async function run() {
    if (!plan) return;
    const fresh = planClear(getState(), plan.c); // what's eligible right now
    const nc = fresh.partial.reduce((n, x) => n + x.n, 0);
    if (!fresh.tasks.length && !nc) { refresh(); return; }
    const synced = isSynced(pid);
    const where = synced ? ' They are also deleted from your account and from your other devices.' : ' This only affects this device.';
    const ok = await confirmDialog('Clear completed tasks?',
      `Delete ${[fresh.tasks.length ? `${fresh.tasks.length} completed task${fresh.tasks.length === 1 ? '' : 's'} (and their photos)` : '', nc ? `${nc} old completion${nc === 1 ? '' : 's'} of repeating tasks (the tasks stay)` : ''].filter(Boolean).join(' and ')} from ${getActiveProfile().name}.${where} You can undo right after.`,
      { ok: 'Clear', danger: true });
    if (!ok) return;
    sheet.close();
    clearTasks(planClear(getState(), plan.c), plan.c);
    ctx.rerender?.();
  }

  const seg = segmented(PICKS.map(([value, label]) => ({ value, label: label.replace('Older than ', '') })), pick, (v) => { pick = v; refresh(); }, { label: 'Completed before' });
  const sheet = openSheet({
    title: 'Clear completed tasks', cls: 'clear-sheet',
    content: h('div.form',
      h('p.muted', 'Deletes tasks completed before the date you pick. Repeating tasks keep repeating, but their old completions go. Habits, workouts and the journal are never touched.'),
      h('div.field', h('label.field-label', 'Completed before'), seg), customRow, preview),
    footer: [h('button.btn.ghost', { type: 'button', onclick: () => sheet.close() }, 'Cancel'), go],
  });
  refresh();
  return sheet;
}

// ---------- Settings › Storage ----------
const lsBytes = () => {
  let n = 0;
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('dailyTracker:')) n += (k.length + (localStorage.getItem(k) || '').length) * 2; } } catch { /* unavailable */ }
  return n;
};
const profileBytes = (id) => { try { return ((localStorage.getItem('dailyTracker:data:' + id) || '').length) * 2; } catch { return 0; } };

/** The Storage card for Settings (rows fill in as the browser answers). */
export function storageSection(wrapGroup) {
  const profile = getActiveProfile();
  const dataEl = h('span.set-desc', `${fmtBytes(lsBytes())} in all profiles · ${fmtBytes(profileBytes(profile.id))} in ${profile.name}`);
  const photoEl = h('span.set-desc', 'Checking…');
  const deviceEl = h('span.set-desc', '');
  profileUsage(profile.id).then((u) => { photoEl.textContent = u.count ? `${u.count} photo${u.count === 1 ? '' : 's'} · ${fmtBytes(u.bytes)} in ${profile.name}` : `No photos in ${profile.name}`; }).catch(() => { photoEl.textContent = 'Photos can’t be read right now'; });
  if (navigator.storage?.estimate) navigator.storage.estimate().then((e) => { if (e?.usage != null) deviceEl.textContent = `The app uses about ${big(e.usage)} here (photos, saved files)${e.quota ? `; the browser allows up to ${big(e.quota)}` : ''}`; }).catch(() => {});
  const line = (label, el) => h('div.set-row.col', h('div.set-text', h('span.set-label', label), el));
  const sec = wrapGroup('Storage',
    line('App data', dataEl),
    line('Photos', photoEl),
    line('This device', deviceEl),
    h('div.set-row.col',
      h('div.set-text', h('span.set-label', 'Clear completed tasks'), h('span.set-desc', 'Free space by deleting old completed tasks and their photos. You can undo right after.')),
      h('div.set-actions', h('button.btn.secondary.small', { type: 'button', onclick: () => openClearSheet() }, icon('trash', { size: 16 }), 'Clear completed tasks…'))));
  sec.id = 'set-storage';
  return sec;
}

/** Take the user to Settings › Storage (used by the "storage full" messages). */
export function goToStorage() {
  ctx.ui.scrollTo = 'set-storage';
  ctx.go('settings');
}
