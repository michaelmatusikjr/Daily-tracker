// The month calendar (habit shading, task dots, mood, workout, starred days, legend). It opens from Today's
// week strip when you pull it down (js/views/today.js).
import { h, iconBtn, onSwipe } from './ui.js';
import { hasWorkoutOn } from './workouts.js';
import { attachMenu, dayMenu } from './itemMenu.js';
import { dayProgress, tasksOn, isTaskDone, moodEmoji, PRIORITIES } from './logic.js';
import { todayKey, addDays, addMonths, startOfWeek, monthStart, daysInMonth, fmtMonthYear, fmtDateLong, weekdayLabels } from './dates.js';

const MOOD_WORDS = ['awful', 'bad', 'okay', 'good', 'great'];

/**
 * One month as a card: grid + legend. `m` = first day of the month ('YYYY-MM-01'), `selected` = highlighted day.
 * onPick(dateKey) runs when a day is tapped; onMonth(delta) when the grid is swiped sideways.
 */
export function monthGrid(st, m, { selected, onPick, onMonth }) {
  const today = todayKey();
  const ws = st.settings.weekStart;
  const [y, mo] = m.split('-').map(Number);
  const dim = daysInMonth(y, mo - 1);
  const first = startOfWeek(m, ws);
  const last = addDays(startOfWeek(addDays(m, dim - 1), ws), 6);
  const names = weekdayLabels('short');
  const grid = h('div.cal-grid', { role: 'grid', 'aria-label': fmtMonthYear(m) });
  for (let i = 0; i < 7; i++) grid.append(h('span.cal-head', { 'aria-hidden': 'true' }, names[(ws + i) % 7].slice(0, 2)));
  for (let k = first; k <= last; k = addDays(k, 1)) {
    const inMonth = k.slice(0, 7) === m.slice(0, 7);
    const p = dayProgress(st, k);
    const tasks = tasksOn(st, k);
    const mood = st.journal[k]?.mood;
    const worked = hasWorkoutOn(st, k);
    const intensity = k <= today && p.habits.total ? p.habits.pct : 0;
    const dots = tasks.slice(0, 3).map((t) => {
      const cat = t.category && st.categories.find((c) => c.id === t.category);
      return h(`span.cal-dot${isTaskDone(t, k) ? '.done' : ''}`, { style: { background: cat ? cat.color : t.priority ? PRIORITIES[t.priority].color : 'var(--accent)' } });
    });
    const label = `${fmtDateLong(k)}. ${tasks.length} task${tasks.length === 1 ? '' : 's'}${p.habits.total ? `, ${p.habits.done} of ${p.habits.total} habits done` : ''}${mood ? ', mood ' + MOOD_WORDS[mood - 1] : ''}${worked ? ', workout logged' : ''}`;
    const cell = h(`button.cal-day${inMonth ? '' : '.outside'}${k === today ? '.today' : ''}${k === selected ? '.selected' : ''}${p.total && p.pct === 1 && k <= today ? '.perfect' : ''}`, {
      type: 'button', 'aria-label': label, style: { '--i': intensity.toFixed(2) }, dataset: { date: k },
      onclick: () => onPick(k),
    },
    h('span.cal-num', String(Number(k.slice(8)))),
    mood ? h('span.cal-mood', { 'aria-hidden': 'true' }, moodEmoji(mood)) : null,
    worked ? h('span.cal-workout', { 'aria-hidden': 'true' }, '💪') : null,
    tasks.length ? h('span.cal-dots', { 'aria-hidden': 'true' }, dots, tasks.length > 3 ? h('span.cal-more', '+') : null) : null);
    const day = k;
    attachMenu(cell, () => dayMenu(day), cell);
    grid.append(cell);
  }
  const card = h('div.cal-card.no-swipe', grid);
  if (onMonth) onSwipe(card, { left: () => onMonth(1), right: () => onMonth(-1) });
  return h('div.cal-body',
    card,
    h('div.cal-legend', { 'aria-hidden': 'true' },
      h('span', h('i.lg-swatch'), 'Habit completion'),
      h('span', h('i.lg-dot'), 'Task'),
      h('span', '🙂 Mood'),
      h('span', '💪 Workout')));
}

/** The panel's month heading with previous/next buttons (and a "Today" chip away from the current month). */
export function monthNav(m, { onMonth, onToday }) {
  const today = todayKey();
  return h('div.cal-nav',
    iconBtn('chevronLeft', 'Previous month', () => onMonth(-1)),
    h('span.cal-nav-title', { 'aria-live': 'polite' }, fmtMonthYear(m)),
    m !== monthStart(today) ? h('button.chip-btn', { type: 'button', onclick: onToday }, 'Today') : null,
    iconBtn('chevronRight', 'Next month', () => onMonth(1)));
}

export { addMonths, monthStart };
