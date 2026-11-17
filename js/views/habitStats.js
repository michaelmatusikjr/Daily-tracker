// Habits tab › Stats: all-time check-ins, longest active streak and each habit's completion rate.
import { h, emptyState } from '../ui.js';
import { activeHabits, streaks, completionRate, totalCompletions, isWeekly, weeklyRate } from '../logic.js';
import { todayKey } from '../dates.js';
import { habitIcon, habitTitle } from '../habitIcon.js';

const pctStr = (x) => (x === null || Number.isNaN(x) ? '—' : Math.round(x * 100) + '%');

export function tile(value, label, sub) {
  return h('div.stat-card', h('span.stat-value', value), h('span.stat-label', label), sub ? h('span.stat-sub', sub) : null);
}

export function habitStatsPanel(st) {
  const today = todayKey();
  const habits = activeHabits(st);
  const root = h('div.habit-stats');
  if (!habits.length) {
    root.append(h('section.card', emptyState('📊', 'No habit stats yet', 'Create a habit and check it off to see your streaks and completion rates here.')));
    return root;
  }
  const totalDone = habits.reduce((n, hb) => n + totalCompletions(st, hb), 0);
  let longest = null;
  for (const hb of habits) {
    const sk = streaks(st, hb, today);
    if (!longest || sk.current > longest.s.current) longest = { hb, s: sk };
  }
  root.append(h('section.stat-grid',
    tile(String(totalDone), 'Habit check-ins', 'All time'),
    tile(longest && longest.s.current ? `🔥 ${longest.s.current}` : '—', 'Longest active streak',
      longest && longest.s.current ? habitTitle(longest.hb) : 'Start one today')));

  const list = h('ul.rate-list');
  for (const hb of habits) {
    const r30 = completionRate(st, hb, 30, today);
    const all = completionRate(st, hb, null, today);
    // Weekly habits: weeks hit / weeks counted (current week only once met).
    const wk = isWeekly(hb) ? { r: weeklyRate(st, hb, 30, today), a: weeklyRate(st, hb, null, today) } : null;
    const sub = wk ? `${wk.r.hit} of ${wk.r.counted} week${wk.r.counted === 1 ? '' : 's'} · all time ${wk.a.hit} of ${wk.a.counted}` : `All time ${pctStr(all)}`;
    list.append(h('li.rate-row', { style: { '--c': hb.color } },
      h('span.emoji-bubble.small', { 'aria-hidden': 'true' }, habitIcon(hb)),
      h('div.rate-main',
        h('div.rate-top', h('span.habit-name', hb.name), h('span.rate-val', pctStr(r30))),
        h('div.rate-bar', { role: 'img', 'aria-label': `${hb.name}: ${pctStr(r30)} over the last 30 days, ${pctStr(all)} all time` },
          h('span', { style: { width: `${Math.round((r30 || 0) * 100)}%` } })),
        h('span.muted.small', sub))));
  }
  root.append(h('section.card', h('div.section-head', h('h2.section-title', 'Habits · last 30 days')), list));
  return root;
}
