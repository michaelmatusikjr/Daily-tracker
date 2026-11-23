// Pure domain logic: recurrence, completion, streaks, stats.
import { addDays, diffDays, dow, daysInMonth, startOfWeek, todayKey, timeToMin, fmtSpan, fmtTime } from './dates.js';

// ---------- Tasks ----------
export const isRecurring = (t) => (t.recur?.type || 'none') !== 'none';

export function occursOn(t, k) {
  if (k < t.date) return false;
  if (t.exceptions?.includes(k)) return false;
  const r = t.recur || { type: 'none' };
  switch (r.type) {
    case 'daily': return true;
    case 'weekdays': { const d = dow(k); return d > 0 && d < 6; }
    case 'weekly': {
      const days = r.days?.length ? r.days : [dow(t.date)];
      return days.includes(dow(k));
    }
    case 'monthly': {
      const startDay = Number(t.date.slice(8, 10));
      const [y, m, d] = k.split('-').map(Number);
      return d === Math.min(startDay, daysInMonth(y, m - 1));
    }
    case 'interval': {
      const n = Math.max(1, r.interval || 1);
      return diffDays(t.date, k) % n === 0;
    }
    default: return k === t.date;
  }
}

export const isTaskDone = (t, k) => (isRecurring(t) ? !!t.doneDates?.[k] : !!t.done);
/** Marked "missed" for day k (and not done: done always wins). Only hides it from Today's lists. */
export const isTaskMissed = (t, k) => !!t.missedDates?.[k] && !isTaskDone(t, k);

export const tasksOn = (state, k) => state.tasks.filter((t) => occursOn(t, k));

export function splitTasks(tasks) {
  const timed = tasks.filter((t) => t.time).sort((a, b) => a.time.localeCompare(b.time) || a.order - b.order);
  const anytime = tasks.filter((t) => !t.time).sort((a, b) => a.order - b.order);
  return { timed, anytime };
}

/**
 * Today's Anytime list holds tasks and habits together. Items the user has dragged there carry a
 * `todayOrder` (separate from `order`, which the Habits tab and old task ordering keep using);
 * items without one follow after them: tasks by `order`, then habits by `order`.
 * `items` are { kind: 'task'|'habit', item }.
 */
export function sortAnytime(items) {
  const rank = (x) => (Number.isFinite(x.item.todayOrder) ? 0 : x.kind === 'task' ? 1 : 2);
  return [...items].sort((a, b) => rank(a) - rank(b)
    || (rank(a) === 0 ? a.item.todayOrder - b.item.todayOrder : 0)
    || (a.item.order || 0) - (b.item.order || 0));
}

/** "30 minutes left to floss" (first letter lowercased unless the name starts like an acronym). */
export function warnTitle(hb, left) {
  const n = hb.name;
  const lower = n.length > 1 && n[1] === n[1].toUpperCase() && n[1] !== n[1].toLowerCase() ? n : n.charAt(0).toLowerCase() + n.slice(1);
  return `${fmtSpan(left)} left to ${lower}`;
}

/** Short span for notification titles: "15 min", "1 hr", "1 hr 30 min", "2 days". */
export function shortSpan(min) {
  if (min >= 1440 && min % 1440 === 0) { const d = min / 1440; return `${d} day${d === 1 ? '' : 's'}`; }
  const h = Math.floor(min / 60), m = min % 60;
  return [h ? `${h} hr` : '', m || !h ? `${m} min` : ''].filter(Boolean).join(' ');
}

/** Clock text with minutes always shown in 12-hour mode: "6:00 PM" (24-hour: "18:00"). */
export function clockText(time, fmt) {
  if (!time) return '';
  if (fmt === '24') return fmtTime(time, fmt);
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * Notification wording (shared by local reminders and the push rules).
 * Title = [profile · ]timing; body = name + detail. Single-profile setups leave the profile off.
 *   task at its time      "Now"            body "Dentist – 6:00 PM"
 *   task with a lead      "in 15 min"      body "Dentist – 6:00 PM"
 *   anytime task          "Today"          body "Dentist – due today"
 *   habit running out     "30 min left"    body "Read Bible – complete by 12:00 PM"
 */
export function reminderText({ kind, name, profile = '', lead = 0, left = 0, time = '', fmt }) {
  const pre = profile ? `${profile} · ` : '';
  const at = clockText(time, fmt);
  if (kind === 'habit') return { title: `${pre}${shortSpan(left)} left`, body: `${name} – complete by ${at}` };
  if (kind === 'anytime') return { title: `${pre}Today`, body: `${name} – due today` };
  return { title: `${pre}${lead ? `in ${shortSpan(lead)}` : 'Now'}`, body: `${name} – ${at}` };
}

/** Reminder fields a NEW task gets from the profile's defaults (settings.taskDefaults). */
export function taskDefaultReminder(state, time) {
  const td = state.settings?.taskDefaults;
  if (!td?.on) return { reminder: null, reminderAt: null };
  return time ? { reminder: 0, reminderAt: null } : { reminder: null, reminderAt: td.anytimeReminderTime || '06:00' };
}

/** Minutes before the target to warn about a habit (0 = no warning): its own setting, else the profile default. */
export function habitWarnMinutes(state, h) {
  if (!h.target) return 0;
  const w = Number.isInteger(h.warn) ? h.warn : (state.settings?.habitWarnDefault ?? 30);
  return w > 0 ? w : 0;
}
/** When the warning fires, as minutes after midnight; null when none or it would fall before 00:00. */
export function habitWarnAt(state, h) {
  const w = habitWarnMinutes(state, h);
  if (!w) return null;
  const at = timeToMin(h.target) - w;
  return at >= 0 ? at : null;
}

export function overdueTasks(state, today = todayKey()) {
  return state.tasks
    .filter((t) => !isRecurring(t) && !t.done && t.date < today && !t.missedDates?.[t.date])
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function recurrenceLabel(t, dayNames) {
  const r = t.recur || {};
  switch (r.type) {
    case 'daily': return 'Every day';
    case 'weekdays': return 'Weekdays';
    case 'weekly': {
      const days = r.days?.length ? r.days : [dow(t.date)];
      return 'Weekly · ' + [...days].sort().map((d) => dayNames[d]).join(', ');
    }
    case 'monthly': return `Monthly on day ${Number(t.date.slice(8))}`;
    case 'interval': return `Every ${r.interval} days`;
    default: return '';
  }
}

export function taskEndTime(t) {
  if (!t.time) return null;
  return timeToMin(t.time) + (t.duration || 0);
}

// ---------- Habits ----------
export const activeHabits = (state) => state.habits.filter((h) => !h.archived).sort((a, b) => a.order - b.order);

export const habitTarget = (h) => (h.goal?.type === 'count' ? Math.max(1, h.goal.target || 1) : 1);
export const habitVal = (state, h, k) => state.logs[h.id]?.[k] || 0;
export const habitDone = (state, h, k) => habitVal(state, h, k) >= habitTarget(h);
export const isHabitMissed = (state, h, k) => !!h.missed?.[k] && !habitDone(state, h, k);

/** Is the habit expected on that weekday (for day-based schedules)? perWeek: any day counts. */
export function isScheduled(h, k) {
  if (h.schedule?.type === 'days') return (h.schedule.days || []).includes(dow(k));
  return true;
}

/** Habit weeks follow the user's "week starts on" setting. */
export const habitWeekStart = (state, k) => startOfWeek(k, state.settings?.weekStart ?? 1);

export function weekCount(state, h, k) {
  const ws = habitWeekStart(state, k);
  let c = 0;
  for (let i = 0; i < 7; i++) if (habitDone(state, h, addDays(ws, i))) c++;
  return c;
}

/** First day the habit "exists": creation date or earliest log, whichever is earlier. */
export function habitStart(state, h) {
  let s = h.createdAt || todayKey();
  const logs = state.logs[h.id];
  if (logs) for (const k in logs) if (logs[k] > 0 && k < s) s = k;
  return s;
}

/** Should this habit appear as something to do on day k? */
export function isDueOn(state, h, k) {
  if (h.schedule?.type === 'perWeek') {
    return habitDone(state, h, k) || weekCount(state, h, k) < (h.schedule.times || 1);
  }
  return isScheduled(h, k);
}

/**
 * Streaks respect schedules: days the habit isn't scheduled never break a streak,
 * and today (still in progress) never breaks it either. perWeek habits count
 * consecutive weeks (per the week-start setting) where the weekly target was met.
 */
export function streaks(state, h, today = todayKey()) {
  const start = habitStart(state, h);
  if (start > today) return { current: 0, best: 0, unit: h.schedule?.type === 'perWeek' ? 'week' : 'day' };
  if (h.schedule?.type === 'perWeek') {
    const times = h.schedule.times || 1;
    const thisWeek = habitWeekStart(state, today);
    let run = 0, best = 0;
    for (let w = habitWeekStart(state, start); w <= thisWeek; w = addDays(w, 7)) {
      const met = weekCount(state, h, w) >= times;
      if (met) { run++; best = Math.max(best, run); }
      else if (w !== thisWeek) run = 0;
    }
    return { current: run, best, unit: 'week' };
  }
  let run = 0, best = 0;
  for (let k = start; k <= today; k = addDays(k, 1)) {
    if (!isScheduled(h, k)) continue;
    if (habitDone(state, h, k)) { run++; if (run > best) best = run; }
    else if (k !== today) run = 0;
  }
  return { current: run, best, unit: 'day' };
}

// ---------- Weekly (X per week) habits: judged by their own weekly target ----------
export const isWeekly = (h) => h?.schedule?.type === 'perWeek';

/**
 * One week of an X-per-week habit (ws = week start, per the week-start setting).
 * done is capped at the target (extra sessions add nothing). A week is "counted" once it has
 * ended, or as soon as its target is met; the current, unmet week isn't held against you.
 */
export function weekStatus(state, h, ws, today = todayKey()) {
  const target = Math.max(1, h.schedule?.times || 1);
  const count = weekCount(state, h, ws);
  const met = count >= target;
  return { ws, target, done: Math.min(count, target), left: Math.max(0, target - count), met, counted: met || addDays(ws, 6) < today };
}

/** Weeks hit / weeks counted for an X-per-week habit, over weeks overlapping [from, today]. */
export function weeklyRate(state, h, days = null, today = todayKey()) {
  const start = habitStart(state, h);
  if (start > today) return { hit: 0, counted: 0, rate: null };
  const from = days ? (addDays(today, -(days - 1)) > start ? addDays(today, -(days - 1)) : start) : start;
  let hit = 0, counted = 0;
  for (let w = habitWeekStart(state, from); w <= today; w = addDays(w, 7)) {
    const s = weekStatus(state, h, w, today);
    if (!s.counted) continue;
    counted++;
    if (s.met) hit++;
  }
  return { hit, counted, rate: counted ? hit / counted : null };
}

/** Completion rate over the last `days` days (or all time when null). Returns 0..1 or null. */
export function completionRate(state, h, days = null, today = todayKey()) {
  const start = habitStart(state, h);
  if (start > today) return null;
  const from = days ? (addDays(today, -(days - 1)) > start ? addDays(today, -(days - 1)) : start) : start;
  // Weekly habits: weeks hit / weeks counted (see weekStatus), never per day.
  if (isWeekly(h)) return weeklyRate(state, h, days, today).rate;
  let sched = 0, done = 0;
  for (let k = from; k <= today; k = addDays(k, 1)) {
    if (!isScheduled(h, k)) continue;
    const d = habitDone(state, h, k);
    if (k === today && !d) continue; // today still in progress
    sched++;
    if (d) done++;
  }
  return sched ? done / sched : null;
}

export function totalCompletions(state, h) {
  const logs = state.logs[h.id] || {};
  let n = 0;
  for (const k in logs) if (logs[k] >= habitTarget(h)) n++;
  return n;
}

export function scheduleLabel(h, dayNames) {
  const s = h.schedule || {};
  if (s.type === 'days') {
    const d = [...(s.days || [])].sort();
    if (d.length === 7) return 'Every day';
    if (d.join() === '1,2,3,4,5') return 'Weekdays';
    if (d.join() === '0,6') return 'Weekends';
    return d.map((i) => dayNames[i]).join(' ');
  }
  if (s.type === 'perWeek') return `${s.times}× per week`;
  return 'Every day';
}

// ---------- Day-level aggregates ----------
export function dayProgress(state, k) {
  const tasks = tasksOn(state, k);
  const tDone = tasks.filter((t) => isTaskDone(t, k)).length;
  // Weekly (X per week) habits are judged by their weekly target, never per day: not in the day's numbers.
  const habits = activeHabits(state).filter((h) => !isWeekly(h) && habitStart(state, h) <= k && isDueOn(state, h, k));
  const hDone = habits.filter((h) => habitDone(state, h, k)).length;
  const total = tasks.length + habits.length;
  const done = tDone + hDone;
  return {
    total, done, pct: total ? done / total : 0,
    tasks: { total: tasks.length, done: tDone },
    habits: { total: habits.length, done: hDone, pct: habits.length ? hDone / habits.length : 0 },
  };
}

export function moodEmoji(m) {
  return ['', '😞', '😕', '😐', '🙂', '😄'][m] || '';
}
export const MOODS = [
  { v: 1, e: '😞', label: 'Awful' },
  { v: 2, e: '😕', label: 'Bad' },
  { v: 3, e: '😐', label: 'Okay' },
  { v: 4, e: '🙂', label: 'Good' },
  { v: 5, e: '😄', label: 'Great' },
];

export const PRIORITIES = [
  { v: 0, label: 'None', color: 'var(--text-3)' },
  { v: 1, label: 'Low', color: 'var(--prio-low)' },
  { v: 2, label: 'Medium', color: 'var(--prio-med)' },
  { v: 3, label: 'High', color: 'var(--prio-high)' },
];
