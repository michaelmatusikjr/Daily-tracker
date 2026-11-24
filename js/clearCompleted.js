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
 * completed before it, and finished repeating series. A series is finished when it has completions,
 * all of them before the cutoff, and no occurrence left from the cutoff on (there are no series end
 * dates, so this is rare: e.g. every remaining day was skipped). A running series is never touched.
 */
export function planClear(state, cutoff) {
  const tasks = [];
  for (const t of state.tasks) {
    if (!isRecurring(t)) {
      if (t.done && completedDay(t) < cutoff) tasks.push(t);
      continue;
    }
    const done = Object.keys(t.doneDates || {}).filter((k) => t.doneDates[k]);
    if (!done.length || done.some((k) => k >= cutoff)) continue;
    let running = false;
    for (let i = 0, k = cutoff; i < HORIZON && !running; i++, k = addDays(k, 1)) running = occursOn(t, k);
    if (!running) tasks.push(t);
  }
  return tasks;
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

/** Delete the planned tasks with one Undo. Returns the number deleted. */
export function clearTasks(tasks) {
  const pid = getActiveProfile().id;
  const snaps = tasks.map((t) => JSON.parse(JSON.stringify(t)));
  const idSet = new Set(snaps.map((t) => t.id));
  const photoIds = clearablePhotoIds(tasks, pid);
  update((s) => { s.tasks = s.tasks.filter((t) => !idSet.has(t.id)); });
  deletePhotosLater(photoIds);
  toast(`Cleared ${snaps.length} completed task${snaps.length === 1 ? '' : 's'}`, {
    action: 'Undo', duration: UNDO_MS, force: true,
    // Put back only these tasks (re-found by id, merged into the current data), never an old snapshot.
    onAction: () => mutateProfileData(pid, (s) => { for (const t of snaps) if (!s.tasks.some((x) => x.id === t.id)) s.tasks.push(JSON.parse(JSON.stringify(t))); }),
  });
  return snaps.length;
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
    const tasks = planClear(getState(), c);
    const ids = clearablePhotoIds(tasks, pid);
    const ph = await photoStats(ids);
    if (mine !== seq) return;
    const taskBytes = tasks.reduce((n, t) => n + bytesOf(t), 0);
    plan = { c, tasks };
    if (!tasks.length) { preview.replaceChildren(h('p.muted', `No completed tasks before ${fmtDateShort(c)}, ${c.slice(0, 4)}.`)); return; }
    preview.replaceChildren(
      h('p.clear-line', h('strong', String(tasks.length)), ` completed task${tasks.length === 1 ? '' : 's'} before ${fmtDateShort(c)}, ${c.slice(0, 4)}`),
      h('p.clear-line', h('strong', String(ph.count)), ` photo${ph.count === 1 ? '' : 's'}`),
      h('p.clear-line', 'Frees about ', h('strong', fmtBytes(taskBytes + ph.bytes))));
    go.disabled = false;
  }

  async function run() {
    if (!plan) return;
    const fresh = planClear(getState(), plan.c); // what's eligible right now
    if (!fresh.length) { refresh(); return; }
    const synced = isSynced(pid);
    const where = synced ? ' They are also deleted from your account and from your other devices.' : ' This only affects this device.';
    const ok = await confirmDialog('Clear completed tasks?',
      `Delete ${fresh.length} completed task${fresh.length === 1 ? '' : 's'} (and their photos) from ${getActiveProfile().name}.${where} You can undo right after.`,
      { ok: 'Clear', danger: true });
    if (!ok) return;
    sheet.close();
    clearTasks(planClear(getState(), plan.c));
    ctx.rerender?.();
  }

  const seg = segmented(PICKS.map(([value, label]) => ({ value, label: label.replace('Older than ', '') })), pick, (v) => { pick = v; refresh(); }, { label: 'Completed before' });
  const sheet = openSheet({
    title: 'Clear completed tasks', cls: 'clear-sheet',
    content: h('div.form',
      h('p.muted', 'Deletes tasks completed before the date you pick. Repeating tasks that are still running, habits, workouts and the journal are never touched.'),
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
