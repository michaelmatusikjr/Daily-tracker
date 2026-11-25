// State mutations used by views and forms (with undo where it matters).
import { update, getState, uid, getActiveProfile } from './store.js';
import { deleteFiles, copyFiles } from './attachments.js';
import { ctx } from './ctx.js';
import { toast, haptic, choose } from './ui.js';
import { takeover } from './takeover.js';
import { prepareGhost } from './motion.js';
import { isRecurring, isTaskDone, habitTarget, habitVal, dayProgress } from './logic.js';
import { todayKey, fmtDateShort, addDays } from './dates.js';
import { syncHabitLink, computeRecords, exerciseById, recordToast } from './workouts.js';

function celebrateIfDone(k, before, undo = null) {
  const after = dayProgress(getState(), k);
  if (before.pct < 1 && after.pct === 1 && after.total > 0) {
    const message = k === todayKey() ? 'Everything done for today. Nice work!' : 'Everything done for that day';
    // The takeover replaces any toast, so an Undo that toast offered moves onto it.
    setTimeout(() => takeover({ emoji: '🎉', message, confetti: true, ...(undo ? { action: 'Undo', onAction: undo } : {}) }), 50);
    haptic([20, 40, 20]);
    return true;
  }
  return false;
}

/** Explicitly set a task occurrence's completion (used by toggle and by undo). */
export function setTaskDone(id, k, value) {
  update((s) => {
    const x = s.tasks.find((y) => y.id === id);
    if (!x) return;
    // completedAt / doneAt record when it was completed (for the Completed history).
    if (isRecurring(x)) {
      if (value) { x.doneDates[k] = true; x.doneAt = { ...(x.doneAt || {}), [k]: Date.now() }; }
      else { delete x.doneDates[k]; if (x.doneAt) { delete x.doneAt[k]; if (!Object.keys(x.doneAt).length) delete x.doneAt; } }
    } else {
      x.done = !!value;
      if (value) x.completedAt = Date.now(); else delete x.completedAt;
    }
    if (value) clearFlag(x, 'missedDates', isRecurring(x) ? k : null); // done wins over "missed"
    x.updatedAt = Date.now();
  });
}

/** Remove date k (or every date when k is null) from a { date: true } map, dropping it when empty. */
function clearFlag(obj, field, k) {
  if (!obj?.[field]) return;
  if (k === null) delete obj[field];
  else { delete obj[field][k]; if (!Object.keys(obj[field]).length) delete obj[field]; }
}

// ---------- Missed ----------
/** Mark a task or habit as missed (or not) for day k, with Undo. Hides it from Today; it still counts as not done. */
export function setMissed(kind, id, k, on, { silent = false } = {}) {
  if (k > todayKey()) return;
  const field = kind === 'task' ? 'missedDates' : 'missed';
  const list = kind === 'task' ? 'tasks' : 'habits';
  const item = getState()[list].find((x) => x.id === id);
  if (!item) return;
  update((s) => {
    const x = s[list].find((y) => y.id === id);
    if (!x) return;
    if (on) x[field] = { ...(x[field] || {}), [k]: true };
    else clearFlag(x, field, k);
    x.updatedAt = Date.now();
  });
  if (silent) return;
  const name = kind === 'task' ? `“${item.title}”` : item.name;
  toast(on ? `Marked ${name} as missed` : `${name} is back on the list`, {
    action: 'Undo', onAction: () => setMissed(kind, id, k, !on, { silent: true }),
  });
}

// ---------- Tasks ----------
export function toggleTask(id, k) {
  const st = getState();
  const t = st.tasks.find((x) => x.id === id);
  if (!t) return;
  const was = isTaskDone(t, k);
  if (was && t.earlyOf && !isRecurring(t)) { giveBackEarly(t); return; }
  const before = dayProgress(st, k);
  if (!was) ctx.anim.add('t-' + id);
  setTaskDone(id, k, !was);
  haptic(was ? 5 : 12);
  if (was) return;
  celebrateIfDone(k, before);
}

/**
 * Complete a not-yet-due task ahead of time (Today's "Future tasks"): it counts as completed today.
 * One-off: marked done and moved to today (Undo restores its date and state exactly).
 * Repeating: the scheduled occurrence `k` is consumed with an exception (so it never shows on its day,
 * and the push server's rules skip it), and a completed one-off copy dated today carries the "done today".
 * Tasks have no streaks or stats, so nothing else is touched.
 */
export function completeTaskEarly(id, k) {
  const st = getState();
  const t = st.tasks.find((x) => x.id === id);
  const today = todayKey();
  if (!t || k <= today) return;
  const before = dayProgress(st, today);
  ctx.anim.add('t-' + id);
  let undo;
  if (isRecurring(t)) {
    const copyId = uid();
    const copy = JSON.parse(JSON.stringify(t));
    // Photos stay with the series; the copy is just the record of today's completion.
    for (const f of ['attachments', 'doneAt', 'missedDates', 'fixedDay', 'todayOrder', 'reminderAt']) delete copy[f];
    Object.assign(copy, { id: copyId, reminder: null, earlyOf: { id, date: k }, date: today, recur: { type: 'none', days: [], interval: 2 }, exceptions: [], doneDates: {}, done: true, completedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(), order: (t.order || 0) + 0.5 });
    update((s) => {
      const x = s.tasks.find((y) => y.id === id);
      if (!x) return;
      if (!x.exceptions.includes(k)) x.exceptions.push(k);
      x.updatedAt = Date.now();
      s.tasks.push(copy);
    });
    undo = () => update((s) => {
      s.tasks = s.tasks.filter((y) => y.id !== copyId);
      const x = s.tasks.find((y) => y.id === id);
      if (x) { x.exceptions = x.exceptions.filter((d) => d !== k); x.updatedAt = Date.now(); }
    });
  } else {
    const prev = { date: t.date, done: t.done, completedAt: t.completedAt };
    update((s) => {
      const x = s.tasks.find((y) => y.id === id);
      if (!x) return;
      x.date = today; x.done = true; x.completedAt = Date.now(); x.updatedAt = Date.now();
    });
    undo = () => update((s) => {
      const x = s.tasks.find((y) => y.id === id);
      if (!x) return;
      x.date = prev.date; x.done = prev.done; x.updatedAt = Date.now();
      if (prev.completedAt) x.completedAt = prev.completedAt; else delete x.completedAt;
    });
  }
  haptic(12);
  if (!celebrateIfDone(today, before, undo)) toast(`Done early: “${t.title}” counts as completed today`, { action: 'Undo', onAction: undo });
}

/** Un-checking a repeating task's "done early" copy: remove the copy and put the occurrence back on its day. */
function giveBackEarly(copy) {
  const snap = JSON.parse(JSON.stringify(copy));
  const { id: seriesId, date } = copy.earlyOf;
  update((s) => {
    s.tasks = s.tasks.filter((y) => y.id !== copy.id);
    const x = s.tasks.find((y) => y.id === seriesId);
    if (x) { x.exceptions = x.exceptions.filter((d) => d !== date); x.updatedAt = Date.now(); }
  });
  haptic(5);
  toast(`“${copy.title}” is back on ${fmtDateShort(date)}`, { action: 'Undo', onAction: () => update((s) => {
    if (!s.tasks.some((y) => y.id === snap.id)) s.tasks.push(snap);
    const x = s.tasks.find((y) => y.id === seriesId);
    if (x && !x.exceptions.includes(date)) { x.exceptions.push(date); x.updatedAt = Date.now(); }
  }) });
}

export function moveToToday(ids) {
  const today = todayKey();
  const prev = new Map();
  update((s) => {
    for (const t of s.tasks) if (ids.includes(t.id)) { prev.set(t.id, t.date); t.date = today; t.updatedAt = Date.now(); }
  });
  toast(ids.length === 1 ? 'Moved to today' : `Moved ${ids.length} tasks to today`, {
    action: 'Undo',
    onAction: () => update((s) => { for (const t of s.tasks) if (prev.has(t.id)) t.date = prev.get(t.id); }),
  });
}

/** Save a task (new or edited). Returns its id. */
export function saveTask(data) {
  let id = data.id;
  update((s) => {
    const existing = data.id && s.tasks.find((t) => t.id === data.id);
    if (existing) {
      Object.assign(existing, data, { updatedAt: Date.now() });
      if ('attachments' in data && !data.attachments?.length) delete existing.attachments;
    } else {
      const maxOrder = s.tasks.reduce((m, t) => Math.max(m, t.order || 0), 0);
      id = uid();
      ctx.anim.add('new-' + id);
      s.tasks.push({
        notes: '', time: null, duration: null, priority: 0, category: null, reminder: null, reminderAt: null,
        recur: { type: 'none', days: [], interval: 2 }, done: false, doneDates: {}, exceptions: [],
        createdAt: Date.now(), ...data, id, order: maxOrder + 1,
      });
      if (!data.attachments?.length) delete s.tasks[s.tasks.length - 1].attachments;
    }
  });
  return id;
}

/** Photos of a deleted task are removed once Undo is no longer possible (unless it came back). */
function deleteFilesLater(taskId, ids) {
  if (!ids.length) return;
  setTimeout(() => {
    if (getState().tasks.some((x) => x.id === taskId)) return; // restored with Undo
    deleteFiles(ids).catch(() => { /* startup clean-up will catch it */ });
  }, 8000);
}

/** Delete a task. For recurring tasks ask: this day only vs the whole series. Returns true if deleted. */
export async function deleteTask(id, k) {
  const st = getState();
  const t = st.tasks.find((x) => x.id === id);
  if (!t) return false;
  if (isRecurring(t)) {
    const choice = await choose('Delete repeating task', `“${t.title}” repeats. What would you like to delete?`, [
      { value: 'one', label: 'This day only', style: 'secondary' },
      { value: 'all', label: 'Whole series', style: 'danger' },
      { value: null, label: 'Cancel', style: 'ghost' },
    ]);
    if (!choice) return false;
    if (choice === 'one') { skipTaskDay(id, k, 'Removed from this day'); return true; }
  }
  const snapshot = JSON.parse(JSON.stringify(t));
  const index = st.tasks.indexOf(t);
  const ghost = prepareGhost(document.querySelector(`li.task[data-id="${CSS.escape(id)}"]`));
  // Deleting a "done early" copy gives the occurrence back to its series (Undo consumes it again).
  const early = !isRecurring(t) && t.earlyOf ? t.earlyOf : null;
  const setException = (s, on) => {
    const x = early && s.tasks.find((y) => y.id === early.id);
    if (!x) return;
    x.exceptions = x.exceptions.filter((d) => d !== early.date);
    if (on) x.exceptions.push(early.date);
    x.updatedAt = Date.now();
  };
  update((s) => { s.tasks = s.tasks.filter((x) => x.id !== id); setException(s, false); });
  ghost.play();
  deleteFilesLater(id, (t.attachments || []).map((a) => a.id));
  toast(`Deleted “${t.title}”`, {
    action: 'Undo',
    // Re-insert only this task (never a whole old state: remote edits may have arrived meanwhile).
    onAction: () => update((s) => { if (!s.tasks.some((x) => x.id === snapshot.id)) s.tasks.splice(Math.min(index, s.tasks.length), 0, snapshot); setException(s, true); }),
  });
  return true;
}

/** Skip one occurrence of a repeating task (an exception), with Undo. */
export function skipTaskDay(id, k, msg = `Skipped ${fmtDateShort(k)}`) {
  const t = getState().tasks.find((x) => x.id === id);
  if (!t) return;
  const wasDone = !!t.doneDates?.[k];
  update((s) => {
    const x = s.tasks.find((y) => y.id === id);
    if (!x.exceptions.includes(k)) x.exceptions.push(k);
    x.updatedAt = Date.now();
    delete x.doneDates[k];
  });
  toast(msg, {
    action: 'Undo',
    onAction: () => update((s) => {
      const x = s.tasks.find((y) => y.id === id);
      if (!x) return;
      x.exceptions = x.exceptions.filter((d) => d !== k);
      if (wasDone) x.doneDates[k] = true;
    }),
  });
}

/** Move a one-off task to another day, with Undo. */
export function moveTask(id, date) {
  const t = getState().tasks.find((x) => x.id === id);
  if (!t || !date || t.date === date) return;
  const prev = t.date;
  update((s) => { const x = s.tasks.find((y) => y.id === id); if (x) { x.date = date; x.updatedAt = Date.now(); } });
  const label = date === todayKey() ? 'today' : date === addDays(todayKey(), 1) ? 'tomorrow' : fmtDateShort(date);
  toast(`Moved “${t.title}” to ${label}`, {
    action: 'Undo',
    onAction: () => update((s) => { const x = s.tasks.find((y) => y.id === id); if (x) x.date = prev; }),
  });
}

/** Copy a task (not its completion), placed right after the original, with Undo. */
export function duplicateTask(id) {
  const t = getState().tasks.find((x) => x.id === id);
  if (!t) return;
  const copy = { ...JSON.parse(JSON.stringify(t)), id: uid(), done: false, doneDates: {}, createdAt: Date.now(), updatedAt: Date.now(), order: (t.order || 0) + 0.5 };
  delete copy.missedDates; // a copy starts clean, not missed
  delete copy.completedAt; delete copy.doneAt;
  delete copy.attachments; // photos are copied under new ids below
  update((s) => { s.tasks.push(copy); });
  if (t.attachments?.length) {
    const pid = getActiveProfile()?.id;
    copyFiles(t.attachments, copy.id, pid).then((list) => {
      if (list.length) update((s) => { const x = s.tasks.find((y) => y.id === copy.id); if (x) x.attachments = list; });
    }).catch(() => toast('The copy was made, but its photos couldn’t be copied.', { force: true }));
  }
}

export function reorderTasks(ids) {
  update((s) => {
    ids.forEach((id, i) => { const t = s.tasks.find((x) => x.id === id); if (t) t.order = i; });
  });
}

/**
 * Reorder Today's Anytime list, which mixes tasks and habits. Writes `todayOrder` on every item in
 * the new order, in one update; `order` (used by the Habits tab) is left alone.
 */
export function reorderToday(ids) {
  const write = (map) => update((s) => {
    for (const x of [...s.tasks, ...s.habits]) {
      if (!(x.id in map)) continue;
      if (map[x.id] === null) delete x.todayOrder; else x.todayOrder = map[x.id];
    }
  });
  const st = getState();
  const all = [...st.tasks, ...st.habits];
  const known = new Set(all.map((x) => x.id));
  const visible = ids.filter((id, i) => known.has(id) && ids.indexOf(id) === i);
  const vis = new Set(visible);
  // `todayOrder` is one global number per item, but each day shows a different subset. So merge the
  // dragged day's order into the existing global sequence instead of renumbering only the visible
  // items (which would make other days' orders collide). Visible items that already had a rank
  // reuse their slots in that sequence, in their new order; any others follow the last slot.
  const seq = all.filter((x) => Number.isFinite(x.todayOrder))
    .sort((a, b) => a.todayOrder - b.todayOrder || (a.order || 0) - (b.order || 0)).map((x) => x.id);
  const slots = seq.map((id, i) => (vis.has(id) ? i : -1)).filter((i) => i >= 0);
  const out = seq.filter((id) => !vis.has(id));
  const placed = [];
  slots.forEach((slot, n) => { if (n < visible.length) placed.push([slot, visible[n]]); });
  const rest = visible.slice(slots.length);
  const merged = [];
  let o = 0;
  for (let i = 0; i < seq.length; i++) {
    const hit = placed.find(([slot]) => slot === i);
    if (hit) merged.push(hit[1]);
    else if (!vis.has(seq[i])) merged.push(out[o++]);
    if (i === (slots.length ? slots[slots.length - 1] : -1)) merged.push(...rest);
  }
  if (!slots.length) merged.push(...rest);
  const next = {};
  merged.forEach((id, i) => { next[id] = i; });
  write(next);
}

// ---------- Habits ----------
export function setHabitValue(id, k, v, { silentUndo = false } = {}) {
  if (k > todayKey()) return; // can't complete habits in the future
  const st = getState();
  const before = dayProgress(st, k);
  const h = st.habits.find((x) => x.id === id);
  if (!h) return;
  const prev = habitVal(st, h, k);
  const wasDone = prev >= habitTarget(h);
  const value = Math.max(0, Math.min(9999, v));
  update((s) => {
    s.logs[id] = s.logs[id] || {};
    if (value > 0) s.logs[id][k] = value; else delete s.logs[id][k];
    // A manual change takes over from the workout link for that day.
    if (s.autoHabit[id]) { delete s.autoHabit[id][k]; if (!Object.keys(s.autoHabit[id]).length) delete s.autoHabit[id]; }
    const hx = s.habits.find((x) => x.id === id);
    if (value >= habitTarget(h)) clearFlag(hx, 'missed', k); // done wins over "missed"
    // When the day was completed (optional, shown in the notification View sheet; since 1.14).
    if (hx) {
      if (value >= habitTarget(h)) { if (!wasDone || !hx.doneAt?.[k]) hx.doneAt = { ...(hx.doneAt || {}), [k]: Date.now() }; }
      else if (hx.doneAt?.[k]) { delete hx.doneAt[k]; if (!Object.keys(hx.doneAt).length) delete hx.doneAt; }
    }
  });
  const nowDone = value >= habitTarget(h);
  if (nowDone && !wasDone) {
    ctx.anim.add('h-' + id); haptic(15);
    if (!silentUndo) celebrateIfDone(k, before);
  }
  else haptic(6);
}

export function bumpHabit(id, k, delta) {
  const st = getState();
  const h = st.habits.find((x) => x.id === id);
  if (!h) return;
  const cur = habitVal(st, h, k);
  if (h.goal.type !== 'count') {
    setHabitValue(id, k, cur >= 1 ? 0 : 1);
  } else {
    if (delta < 0 && cur === 0) return;
    setHabitValue(id, k, cur + delta);
  }
}

/** Clear a habit's value for one day, with Undo. */
export function resetHabitDay(id, k) {
  const st = getState();
  const hb = st.habits.find((x) => x.id === id);
  if (!hb) return;
  const prev = habitVal(st, hb, k);
  if (!prev) return;
  setHabitValue(id, k, 0);
  toast(`Reset ${hb.name} for ${k === todayKey() ? 'today' : fmtDateShort(k)}`, { action: 'Undo', onAction: () => setHabitValue(id, k, prev, { silentUndo: true }) });
}

/** Toggle a day fully done / not done (used by the week dots and calendars). */
export function toggleHabitDay(id, k) {
  const st = getState();
  const h = st.habits.find((x) => x.id === id);
  if (!h) return;
  setHabitValue(id, k, habitVal(st, h, k) >= habitTarget(h) ? 0 : habitTarget(h));
}

export function saveHabit(data) {
  let id = data.id;
  update((s) => {
    const existing = id && s.habits.find((x) => x.id === id);
    if (existing) {
      Object.assign(existing, data, { updatedAt: Date.now() });
      if (data.warn === undefined) delete existing.warn; // "follow the default"
      if (data.targets === undefined) delete existing.targets; // one time for the whole habit
    } else {
      id = uid();
      if (data.warn === undefined) delete data.warn;
      if (data.targets === undefined) delete data.targets;
      const maxOrder = s.habits.reduce((m, x) => Math.max(m, x.order || 0), 0);
      s.habits.push({ archived: false, createdAt: todayKey(), ...data, id, order: maxOrder + 1 });
    }
  });
  // The workout link only works with check-off habits.
  const st = getState();
  const hb = st.habits.find((x) => x.id === id);
  if (st.settings.workoutHabit?.habitId === id && hb?.goal.type !== 'check') {
    update((s) => { clearAutoChecks(s, id); s.settings.workoutHabit = { habitId: null, filter: 'any' }; });
    setTimeout(() => toast(`Workout link removed: “${hb.name}” is now a count habit`, { duration: 6000 }), 60);
  }
  return id;
}

/** Remove the checks the workout link made for a habit (manual checks stay). */
function clearAutoChecks(s, hid) {
  const auto = s.autoHabit[hid];
  if (!auto) return;
  const hb = s.habits.find((x) => x.id === hid);
  for (const d of Object.keys(auto)) {
    if (s.logs[hid]) delete s.logs[hid][d];
    if (hb?.doneAt) delete hb.doneAt[d]; // no stale "Completed at" time once the check is gone
  }
  if (hb?.doneAt && !Object.keys(hb.doneAt).length) delete hb.doneAt;
  delete s.autoHabit[hid];
}

/** Change the workout → habit link. Switching to another habit removes the old one's auto-only checks. */
export function setWorkoutHabit(habitId, filter) {
  update((s) => {
    const old = s.settings.workoutHabit?.habitId || null;
    if (old && old !== habitId) clearAutoChecks(s, old);
    s.settings.workoutHabit = { habitId: habitId || null, filter: filter || s.settings.workoutHabit?.filter || 'any' };
  });
}

/** After an exercise's type changes, a type-filtered habit link may need re-checking on its dates. */
export function resyncExerciseDates(s, exerciseId) {
  const dates = [...new Set(s.workouts.filter((w) => w.exerciseId === exerciseId).map((w) => w.date))];
  dates.forEach((d) => syncHabitLink(s, d));
}

function unlinkWorkoutHabit(s, id) {
  if (s.settings.workoutHabit?.habitId === id) s.settings.workoutHabit = { habitId: null, filter: 'any' };
}

export function setArchived(id, archived) {
  update((s) => { const x = s.habits.find((y) => y.id === id); if (x) { x.archived = archived; x.updatedAt = Date.now(); } if (archived) unlinkWorkoutHabit(s, id); });
  toast(archived ? 'Habit archived' : 'Habit restored', {
    action: 'Undo',
    onAction: () => update((s) => { const x = s.habits.find((y) => y.id === id); if (x) x.archived = !archived; }),
  });
}

export function deleteHabit(id) {
  const st = getState();
  const habit = st.habits.find((x) => x.id === id);
  if (!habit) return;
  const snap = JSON.parse(JSON.stringify(habit));
  const logs = st.logs[id] ? { ...st.logs[id] } : null;
  const auto = st.autoHabit[id] ? { ...st.autoHabit[id] } : null;
  const ghost = prepareGhost(document.querySelector(`li[data-id="${CSS.escape(id)}"]`));
  update((s) => { s.habits = s.habits.filter((x) => x.id !== id); delete s.logs[id]; delete s.autoHabit[id]; unlinkWorkoutHabit(s, id); });
  ghost.play();
  toast(`Deleted “${habit.name}”`, {
    action: 'Undo',
    // Per item: keep any days logged meanwhile (e.g. synced from another device).
    onAction: () => update((s) => {
      if (!s.habits.some((x) => x.id === id)) s.habits.push(snap);
      if (logs) s.logs[id] = { ...logs, ...(s.logs[id] || {}) };
      if (auto) s.autoHabit[id] = { ...auto, ...(s.autoHabit[id] || {}) };
    }),
  });
}

export function reorderHabits(ids) {
  update((s) => { ids.forEach((id, i) => { const x = s.habits.find((y) => y.id === id); if (x) x.order = i; }); });
}

// ---------- Journal ----------
/** The entry for day k ({mood, note, updatedAt}) or null. */
const journalEntry = (k) => getState().journal[k] || null;
function putJournal(k, entry) {
  update((s) => { if (entry) s.journal[k] = entry; else delete s.journal[k]; });
}

/** Save the journal entry for day k. An empty entry (no mood and no note) removes it (with Undo if one existed). */
export function saveJournal(k, { mood, note }) {
  const prev = journalEntry(k) ? { ...journalEntry(k) } : null;
  const n = String(note || '').slice(0, 1000);
  const m = [1, 2, 3, 4, 5].includes(mood) ? mood : null;
  const empty = !m && !n.trim();
  if (empty && !prev) return;
  const next = empty ? null : { mood: m, note: n, updatedAt: Date.now() };
  putJournal(k, next);
  if (empty) toast('Journal entry deleted', { action: 'Undo', onAction: () => putJournal(k, prev) });
}

/** Delete the entry for day k, with Undo. */
export function deleteJournal(k) {
  const prev = journalEntry(k) ? { ...journalEntry(k) } : null;
  if (!prev) return;
  putJournal(k, null);
  toast(`Deleted journal entry for ${fmtDateShort(k)}`, { action: 'Undo', onAction: () => putJournal(k, prev) });
}

// ---------- Weather settings ----------
export function setWeatherUnits(units) {
  update((s) => { s.settings.weather.units = units === 'C' ? 'C' : 'F'; });
}
export function selectWeatherLocation(id) {
  update((s) => {
    const w = s.settings.weather;
    w.selected = id !== 'current' && w.locations.some((l) => l.id === id) ? id : 'current';
  });
}
/** Save a location ({name, lat, lon}) and select it. Coordinates are rounded to 2 decimals (~1 km). Returns false when full. */
export function addWeatherLocation({ name, lat, lon }) {
  const r = (n) => Math.round(n * 100) / 100;
  let ok = true;
  update((s) => {
    const w = s.settings.weather;
    const same = w.locations.find((l) => l.lat === r(lat) && l.lon === r(lon));
    if (same) { w.selected = same.id; return; }
    if (w.locations.length >= 10) { ok = false; return; }
    const loc = { id: uid(), name: String(name || '').trim().slice(0, 80) || 'Saved location', lat: r(lat), lon: r(lon) };
    w.locations.push(loc);
    w.selected = loc.id;
  });
  return ok;
}
export function deleteWeatherLocation(id) {
  const w0 = getState().settings.weather;
  const idx = w0.locations.findIndex((l) => l.id === id);
  if (idx < 0) return;
  const loc = { ...w0.locations[idx] };
  const wasSelected = w0.selected === id;
  update((s) => {
    const w = s.settings.weather;
    w.locations = w.locations.filter((l) => l.id !== id);
    if (w.selected === id) w.selected = 'current';
  });
  toast(`Removed ${loc.name}`, {
    action: 'Undo',
    onAction: () => update((s) => {
      const w = s.settings.weather;
      if (w.locations.some((l) => l.id === id) || w.locations.length >= 10) return;
      w.locations.splice(Math.min(idx, w.locations.length), 0, loc);
      if (wasSelected) w.selected = id;
    }),
  });
}

// ---------- Examples ----------
export function seedExamples() {
  const today = todayKey();
  const examples = [
    { name: 'Drink water', emoji: '💧', color: '#0ea5e9', goal: { type: 'count', target: 8, unit: 'glasses' }, target: null, schedule: { type: 'daily', days: [], times: 3 } },
    { name: 'Morning stretch', emoji: '🧘', color: '#8b5cf6', goal: { type: 'check', target: 1, unit: '' }, target: '12:00', schedule: { type: 'daily', days: [], times: 3 } },
    { name: 'Read 20 minutes', emoji: '📚', color: '#f59e0b', goal: { type: 'check', target: 1, unit: '' }, target: '21:00', schedule: { type: 'daily', days: [], times: 3 } },
    { name: 'Workout', emoji: '🏃', color: '#ef4444', goal: { type: 'check', target: 1, unit: '' }, target: null, schedule: { type: 'perWeek', days: [], times: 3 } },
  ];
  update((s) => {
    let order = s.habits.reduce((m, x) => Math.max(m, x.order || 0), 0);
    for (const e of examples) {
      if (s.habits.some((x) => x.name === e.name)) continue;
      s.habits.push({ id: uid(), reminder: null, archived: false, createdAt: today, order: ++order, ...e });
    }
  });
}

// ---------- Workouts ----------
/**
 * What a workout/exercise delete removes, for Undo: the deleted items themselves and the linked
 * habit's days they touched. Undo puts back only those (re-found by id), never a whole old list, so
 * edits that arrived meanwhile (another device via sync) are kept.
 */
function workoutSnapshot(s, { workoutIds = [], exerciseId = null } = {}) {
  const hid = s.settings.workoutHabit?.habitId;
  const workouts = s.workouts.filter((w) => workoutIds.includes(w.id));
  const dates = [...new Set(workouts.map((w) => w.date))];
  return JSON.parse(JSON.stringify({
    workouts, exercise: exerciseId ? s.exercises.find((e) => e.id === exerciseId) || null : null, hid,
    days: hid ? dates.map((d) => ({ d, log: s.logs[hid]?.[d] ?? null, auto: !!s.autoHabit[hid]?.[d] })) : [],
  }));
}
function restoreSnapshot(snap) {
  update((s) => {
    if (snap.exercise && !s.exercises.some((e) => e.id === snap.exercise.id)) s.exercises.push(snap.exercise);
    for (const w of snap.workouts) if (!s.workouts.some((x) => x.id === w.id)) s.workouts.push(w);
    if (snap.hid && s.habits.some((x) => x.id === snap.hid)) {
      for (const { d, log, auto } of snap.days) {
        s.logs[snap.hid] = s.logs[snap.hid] || {};
        if (log !== null) s.logs[snap.hid][d] = log;
        if (auto) s.autoHabit[snap.hid] = { ...(s.autoHabit[snap.hid] || {}), [d]: true };
      }
    }
  });
}

/**
 * Save a workout (new or edited). `newExercise` = { name, type } creates the exercise first.
 * Shows a 🏆 takeover (no Undo) when it sets a personal record.
 */
export function saveWorkout(data, { newExercise = null } = {}) {
  let id = data.id;
  // Records this entry already held, so re-saving it (or changing only a note/date) doesn't celebrate again.
  const before = getState().workouts.find((w) => w.id === id);
  const had = before ? computeRecords(getState(), before.exerciseId).records.get(id) || [] : [];
  let exerciseId = data.exerciseId;
  let oldDate = null;
  update((s) => {
    if (newExercise) {
      exerciseId = uid();
      s.exercises.push({ id: exerciseId, name: newExercise.name.slice(0, 60), type: ['cardio', 'bodyweight'].includes(newExercise.type) ? newExercise.type : 'strength', archived: false, createdAt: Date.now() });
    }
    const entry = { ...data, exerciseId };
    const existing = id && s.workouts.find((w) => w.id === id);
    if (existing) { oldDate = existing.date; Object.assign(existing, entry); } else {
      id = uid();
      s.workouts.push({ ...entry, id, createdAt: Date.now() });
    }
    syncHabitLink(s, entry.date);
    if (oldDate && oldDate !== entry.date) syncHabitLink(s, oldDate);
  });
  const st = getState();
  const w = st.workouts.find((x) => x.id === id);
  const ex = exerciseById(st, exerciseId);
  const labels = (computeRecords(st, exerciseId).records.get(id) || [])
    .filter((r) => !had.some((o) => o.kind === r.kind && o.value === r.value));
  if (labels.length) {
    ctx.anim.add('w-' + id);
    haptic([20, 40, 20]);
    // e.g. '🏆 New 3×5 max: Squat 235 lbs' or '🏆 Fastest 5K: Run 24:50'
    takeover({ emoji: '🏆', message: recordToast(labels, ex.name).replace(/^🏆\s*/, '') });
  }
  return id;
}

export function deleteWorkout(id) {
  const st = getState();
  const w = st.workouts.find((x) => x.id === id);
  if (!w) return;
  const ex = exerciseById(st, w.exerciseId);
  const snap = workoutSnapshot(st, { workoutIds: [id] });
  update((s) => { s.workouts = s.workouts.filter((x) => x.id !== id); syncHabitLink(s, w.date); });
  toast(`Deleted ${ex?.name || 'workout'}`, { action: 'Undo', onAction: () => restoreSnapshot(snap) });
}

/** Archive / unarchive an exercise, with Undo. */
export function setExerciseArchived(id, archived) {
  const ex = exerciseById(getState(), id);
  if (!ex) return;
  update((s) => { const e = s.exercises.find((x) => x.id === id); if (e) e.archived = archived; });
  toast(`${ex.name} ${archived ? 'archived' : 'restored'}`, {
    action: 'Undo', onAction: () => update((s) => { const e = s.exercises.find((x) => x.id === id); if (e) e.archived = !archived; }),
  });
}

/** Delete an exercise and all of its workouts (Undo restores both). */
export function deleteExercise(id) {
  const st = getState();
  const ex = exerciseById(st, id);
  if (!ex) return;
  const snap = workoutSnapshot(st, { workoutIds: st.workouts.filter((w) => w.exerciseId === id).map((w) => w.id), exerciseId: id });
  const dates = [...new Set(st.workouts.filter((w) => w.exerciseId === id).map((w) => w.date))];
  update((s) => {
    s.exercises = s.exercises.filter((e) => e.id !== id);
    s.workouts = s.workouts.filter((w) => w.exerciseId !== id);
    dates.forEach((d) => syncHabitLink(s, d));
  });
  toast(`Deleted ${ex.name}`, { action: 'Undo', onAction: () => restoreSnapshot(snap) });
}
