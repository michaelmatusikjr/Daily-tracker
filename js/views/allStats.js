// Stats (opened from the profile menu): the summary that used to sit under the Calendar tab, for a month
// or for all time: items completed, completion rate and days journaled.
import { h, iconBtn, segmented } from '../ui.js';
import { appHeader } from '../header.js';
import { getState } from '../store.js';
import { ctx } from '../ctx.js';
import { dayProgress } from '../logic.js';
import { todayKey, addDays, addMonths, monthStart, daysInMonth, fmtMonthYear } from '../dates.js';

/** Totals over the days from..to (inclusive, never past today). */
export function summary(st, from, to) {
  const today = todayKey();
  if (to > today) to = today;
  let total = 0, done = 0, journaled = 0;
  for (let k = from; k <= to; k = addDays(k, 1)) {
    const p = dayProgress(st, k);
    total += p.total; done += p.done;
    if (st.journal[k]) journaled++;
  }
  return { total, done, journaled };
}

/** The earliest day anything exists for (a task, a habit, a journal entry), or today. */
function firstDay(st) {
  const keys = [todayKey(), ...st.tasks.map((t) => t.date), ...st.habits.map((x) => x.createdAt), ...Object.keys(st.journal)].filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k));
  return keys.sort()[0];
}

export function renderStats() {
  const st = getState();
  const today = todayKey();
  const ui = ctx.ui;
  const range = ui.statsRange === 'all' ? 'all' : 'month';
  const m = ui.statsMonth || monthStart(today);
  const root = h('div.view.view-stats');
  const setM = (n) => { ui.statsMonth = addMonths(m, n); ctx.rerender(); };
  root.append(appHeader({
    cls: 'detail', back: { label: 'Back', onclick: () => (history.length > 1 ? history.back() : ctx.go('today')) },
    title: 'Stats',
    below: [h('div.stats-range', segmented([{ value: 'month', label: 'Month' }, { value: 'all', label: 'All time' }], range, (v) => { ui.statsRange = v; ctx.rerender(); }, { label: 'Period' }))],
  }));
  let s, title;
  if (range === 'all') { s = summary(st, firstDay(st), today); title = 'All time'; }
  else {
    const [y, mo] = m.split('-').map(Number);
    s = summary(st, m, addDays(m, daysInMonth(y, mo - 1) - 1)); title = fmtMonthYear(m);
    root.append(h('div.cal-nav',
      iconBtn('chevronLeft', 'Previous month', () => setM(-1)),
      h('span.cal-nav-title', title),
      m !== monthStart(today) ? h('button.chip-btn', { type: 'button', onclick: () => { ui.statsMonth = monthStart(today); ctx.rerender(); } }, 'This month') : null,
      iconBtn('chevronRight', 'Next month', () => setM(1))));
  }
  root.append(h('section.stat-grid.three', { 'aria-label': `Summary: ${title}` },
    h('div.stat-card', h('span.stat-value', String(s.done)), h('span.stat-label', 'Items completed')),
    h('div.stat-card', h('span.stat-value', s.total ? Math.round((s.done / s.total) * 100) + '%' : '—'), h('span.stat-label', 'Completion')),
    h('div.stat-card', h('span.stat-value', String(s.journaled)), h('span.stat-label', 'Days journaled'))));
  root.append(h('p.hint-line', 'Counts tasks and daily habits (weekly habits are judged by their weekly goal). Days after today aren’t counted.'));
  return root;
}
