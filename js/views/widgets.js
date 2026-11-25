// Small components shared by several views.
import { h, ring } from '../ui.js';
import { attachMenu, taskMenu } from '../itemMenu.js';
import { icon } from '../icons.js';
import { getState } from '../store.js';
import { ctx } from '../ctx.js';
import { bumpHabit, toggleHabitDay, toggleTask } from '../actions.js';
import { onCounterHold } from '../counterPad.js';
import { habitVal, habitTarget, isScheduled, habitStart, isTaskDone, isRecurring, PRIORITIES, weekCount, recurrenceLabel } from '../logic.js';
import { addDays, fmtTime, fmtDuration, weekdayNarrow, weekdayLabels, fmtDateShort, todayKey, timeToMin, minToTime } from '../dates.js';
import { openTaskView } from '../taskView.js';
import { canFire, reminderProblem } from '../reminders.js';

/** Small bell-off badge for a reminder that can't fire right now. */
export function reminderWarnBadge() {
  const why = reminderProblem() || 'Notifications are off';
  return h('span.meta.warn-badge', { title: `Reminder won’t appear: ${why}` }, icon('bellOff', { size: 13 }), h('span.sr-only', `Reminder won’t appear: ${why}`));
}

/** One-tap habit control: check button, or count button (tap +1; Down/− key −1; long-press opens the − / + pad). */
export function habitControl(hb, k, { big = false } = {}) {
  const st = getState();
  const v = habitVal(st, hb, k);
  const target = habitTarget(hb);
  const done = v >= target;
  const anim = ctx.anim.has('h-' + hb.id);
  const style = { '--c': hb.color };
  const future = k > todayKey();
  if (hb.goal.type !== 'count') {
    return h(`button.habit-check${done ? '.done' : ''}${anim ? '.pop' : ''}${big ? '.big' : ''}`, {
      type: 'button', style, 'aria-pressed': String(done), 'data-fk': 'hc-' + hb.id, disabled: future,
      title: future ? 'You can check this off on the day' : null,
      'aria-label': future ? `${hb.name}: upcoming` : done ? `${hb.name}: done. Tap to undo` : `Mark ${hb.name} done`,
      onclick: () => bumpHabit(hb.id, k, 1),
    }, icon('check', { size: big ? 28 : 22 }));
  }
  const size = big ? 72 : 46;
  const btn = h(`button.habit-count${done ? '.done' : ''}${anim ? '.pop' : ''}${big ? '.big' : ''}`, {
    type: 'button', style, 'data-fk': 'hc-' + hb.id, disabled: future,
    title: future ? 'You can log this on the day' : null,
    'aria-label': future ? `${hb.name}: upcoming, target ${target}` : `${hb.name}: ${v} of ${target}${hb.goal.unit ? ' ' + hb.goal.unit : ''}. Tap or press Up to add one; Down or minus to remove one.`,
    onclick: () => bumpHabit(hb.id, k, 1),
    onkeydown: (e) => {
      if (['ArrowDown', '-', 'Subtract'].includes(e.key)) { e.preventDefault(); bumpHabit(hb.id, k, -1); }
      else if (['ArrowUp', '+', '=', 'Add'].includes(e.key)) { e.preventDefault(); bumpHabit(hb.id, k, 1); }
    },
  },
  ring(v / target, { size, stroke: big ? 7 : 4, color: hb.color }),
  h('span.count-label', done ? icon('check', { size: big ? 26 : 18 }) : h('span', h('b', String(v)), h('small', `/${target}`))),
  // Above the goal the dot stays filled with its check; a small "+N" says how far over.
  v > target ? h('span.over-badge', { title: `${v - target} over the goal` }, `+${v - target}`) : null);
  if (!future) onCounterHold(btn, hb.id, k);
  return btn;
}

/** Last 7 days ending at `end`, each tappable to toggle that day. */
export function weekDots(hb, end = todayKey()) {
  const st = getState();
  const start = habitStart(st, hb);
  const target = habitTarget(hb);
  const today = todayKey();
  const wrap = h('div.week-dots', { role: 'group', 'aria-label': `${hb.name}, last 7 days` });
  for (let i = 6; i >= 0; i--) {
    const k = addDays(end, -i);
    const v = habitVal(st, hb, k);
    const done = v >= target;
    const partial = !done && v > 0;
    const sched = hb.schedule.type === 'perWeek' || isScheduled(hb, k);
    const future = k > today;
    const cls = ['wd', done && 'done', partial && 'partial', !sched && 'off', k === today && 'today', k < start && !v && 'pre'].filter(Boolean).join('.');
    const count = hb.goal.type === 'count';
    const dot = h(`button.${cls}`, {
      type: 'button', style: { '--c': hb.color, '--p': partial ? v / target : 0 }, disabled: future,
      'aria-pressed': String(done),
      'aria-label': `${fmtDateShort(k)}: ${done ? (v > target ? `${v} of ${target}, ${v - target} over` : 'done') : partial ? `${v} of ${target}` : sched ? 'not done' : 'not scheduled'}${count ? '. Tap to add one; press and hold for − / +.' : ''}`,
      // A count habit's dot adds one per tap (past days too, and past the target); a check habit's toggles the day.
      onclick: () => (count ? bumpHabit(hb.id, k, 1) : toggleHabitDay(hb.id, k)),
    }, h('span.wd-letter', weekdayNarrow(k)), h('span.wd-dot', done ? icon('check', { size: 12 }) : null, v > target ? h('span.over-badge.tiny', `+${v - target}`) : null));
    if (count && !future) onCounterHold(dot, hb.id, k);
    wrap.append(dot);
  }
  return wrap;
}

const lastStreak = new Map(); // habit id -> streak last rendered (a rise makes the flame flicker once)
export function streakBadge(s, id = null) {
  const prev = id ? lastStreak.get(id) : undefined;
  if (id) lastStreak.set(id, s.current);
  if (!s.current) return null;
  const rose = prev !== undefined && s.current > prev;
  return h(`span.streak${rose ? '.flick' : ''}`, { title: `Current streak: ${s.current} ${s.unit}${s.current === 1 ? '' : 's'}` },
    h('span.flame', '🔥'), ' ', h('b', String(s.current)), s.unit === 'week' ? ' wk' : '');
}

/** Task row with one-tap completion. */
export function taskRow(t, k, { draggable = false, showDate = false, nowMin = null, dateLabel = null, onCheck = null } = {}) {
  const st = getState();
  const done = isTaskDone(t, k);
  const cat = t.category ? st.categories.find((c) => c.id === t.category) : null;
  const fmt = st.settings.timeFormat;
  const anim = ctx.anim.has('t-' + t.id);
  const meta = [];
  if (dateLabel) meta.unshift(h('span.meta.future-date', icon('calendar', { size: 13 }), dateLabel));
  if (showDate) meta.push(h('span.meta', icon('calendar', { size: 13 }), fmtDateShort(t.date)));
  if (t.time && !showDate) {
    // time shown in the rail; show duration only
    if (t.duration) meta.push(h('span.meta', icon('clock', { size: 13 }), fmtDuration(t.duration)));
  } else if (t.time) meta.push(h('span.meta', icon('clock', { size: 13 }), fmtTime(t.time, fmt)));
  else if (t.duration) meta.push(h('span.meta', { title: 'Estimated duration' }, icon('clock', { size: 13 }), fmtDuration(t.duration)));
  if (cat) meta.push(h('span.cat', { style: { '--c': cat.color } }, cat.name));
  if (isRecurring(t)) meta.push(h('span.meta', { title: 'Repeats' }, icon('repeat', { size: 13 }), recurrenceLabel(t, weekdayLabels('short'))));
  if ((t.reminder !== null && t.time) || (!t.time && t.reminderAt)) {
    meta.push(canFire() ? h('span.meta', { title: 'Reminder set' }, icon('bell', { size: 13 }), h('span.sr-only', 'Reminder set')) : reminderWarnBadge());
  }
  if (t.notes) meta.push(h('span.meta', { title: 'Has notes' }, icon('note', { size: 13 }), h('span.sr-only', 'Has notes')));
  if (t.attachments?.length) meta.push(h('span.meta.clip', { title: `${t.attachments.length} photo${t.attachments.length === 1 ? '' : 's'}` }, '📎', String(t.attachments.length), h('span.sr-only', ` photo${t.attachments.length === 1 ? '' : 's'}`)));

  let isNow = false;
  if (nowMin !== null && t.time && !done) {
    const s = timeToMin(t.time);
    isNow = nowMin >= s && nowMin < s + (t.duration || 30);
  }

  const row = h(`li.task${done ? '.done' : ''}${anim ? '.pop' : ''}${ctx.anim.has('new-' + t.id) ? '.slide-in' : ''}${isNow ? '.is-now' : ''}`, {
    dataset: { id: t.id }, style: { '--prio': PRIORITIES[t.priority || 0].color },
  },
  h('button.task-main', { type: 'button', onclick: () => openTaskView(t.id, k), 'aria-label': `Open “${t.title}”` },
    h('span.task-title-row',
      h('span.task-title', t.title),
      t.priority ? h('span.prio-flag', { title: PRIORITIES[t.priority].label + ' priority' }, icon('flag', { size: 14 }), h('span.sr-only', PRIORITIES[t.priority].label + ' priority')) : null),
    meta.length ? h('span.task-meta', meta) : null),
  // Same round check button as a habit's (on the right); `.check` stays as a stable hook for tests.
  h(`button.habit-check.check${done ? '.done' : ''}`, {
    type: 'button', style: { '--c': 'var(--accent)' }, 'aria-pressed': String(done), 'data-fk': 'tc-' + t.id,
    'aria-label': done ? `Mark “${t.title}” as not done` : `Complete “${t.title}”`,
    onclick: () => (onCheck ? onCheck() : toggleTask(t.id, k)),
  }, icon('check', { size: 22 })),
  draggable ? h('button.drag-handle', { type: 'button', 'data-fk': 'dh-' + t.id, 'aria-label': `Reorder “${t.title}” (use arrow keys)` }, icon('grip', { size: 18 })) : null);
  attachMenu(row, () => taskMenu(t.id, k), row.querySelector('.task-main'));
  return row;
}

export function timeRange(t, fmt) {
  if (!t.time) return '';
  if (!t.duration) return fmtTime(t.time, fmt);
  return `${fmtTime(t.time, fmt)} – ${fmtTime(minToTime((timeToMin(t.time) + t.duration) % 1440), fmt)}`;
}

export { weekCount };
