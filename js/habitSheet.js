// "View habit" sheet shown when a habit reminder is tapped (js/app.js #open/habit/... links):
// big Complete / Missed buttons first, or a Completed / Missed banner with Undo.
// Complete = the habit's normal "done" action: a check habit gets checked; a count habit is logged
// up to its target (Undo goes back to the count it had before). Updates live while open.
import { h, openSheet } from './ui.js';
import { icon } from './icons.js';
import { getState, subscribe } from './store.js';
import { habitVal, habitTarget, isHabitMissed, scheduleLabel } from './logic.js';
import { todayKey, relativeLabel, fmtDateLong, weekdayLabels, fmtTime } from './dates.js';
import { setHabitValue, setMissed } from './actions.js';
import { habitMenu, showMenu } from './itemMenu.js';
import { habitTitle } from './habitIcon.js';
import { notifyActions } from './taskView.js';
import { ctx } from './ctx.js';

export function openHabitView(id, k = todayKey(), { fromNotification = true } = {}) {
  if (!getState().habits.some((x) => x.id === id)) return null;
  const body = h('div.task-view.habit-view');
  let before = 0; // the count before Complete was tapped (Undo restores it)
  const render = () => {
    const st = getState();
    const hb = st.habits.find((x) => x.id === id);
    if (!hb) return false;
    const today = todayKey();
    const target = habitTarget(hb), v = habitVal(st, hb, k);
    const done = v >= target;
    const missed = isHabitMissed(st, hb, k);
    const can = k <= today && !hb.archived;
    const count = hb.goal.type === 'count';
    const unit = hb.goal.unit ? ` ${hb.goal.unit}` : '';
    const quick = fromNotification && can ? notifyActions({
      state: done ? 'done' : missed ? 'missed' : 'open', at: hb.doneAt?.[k], fmt: st.settings.timeFormat,
      onDone: () => { before = v; setHabitValue(id, k, target); },
      onMissed: () => setMissed('habit', id, k, true),
      onUndo: () => (done ? setHabitValue(id, k, before < target ? before : 0) : setMissed('habit', id, k, false)),
    }) : null;
    body.replaceChildren(...[
      quick,
      h(`div.tv-state${done ? '.done' : ''}`, done ? icon('check', { size: 14 }) : null, done ? 'Done' : 'Not done', count ? ` · ${Math.min(v, 9999)} of ${target}${unit}` : ''),
      h('section.tv-section', { 'aria-label': 'When' }, h('h3.tv-head', 'When'),
        h('div.tv-line', icon('calendar', { size: 16 }), h('span', `${relativeLabel(k, today)} · ${fmtDateLong(k)}`)),
        h('div.tv-line', icon('repeat', { size: 16 }), h('span', scheduleLabel(hb, weekdayLabels('short')))),
        hb.target ? h('div.tv-line', icon('clock', { size: 16 }), h('span', `Complete by ${fmtTime(hb.target, st.settings.timeFormat)}`)) : null),
      h('div.tv-actions',
        h('button.btn.secondary', { type: 'button', onclick: () => { sheet.close(); ctx.go('habit/' + id); } }, icon('stats', { size: 16 }), 'Details'),
        h('button.btn.secondary', {
          type: 'button', 'aria-label': 'More actions', 'aria-haspopup': 'menu',
          onclick: (e) => { const m = habitMenu(id, k); if (m) showMenu(m.title, m.items, { mode: 'touch', anchor: e.currentTarget, keepOthers: true }); },
        }, icon('list', { size: 16 }), 'More')),
    ].filter(Boolean));
    titleEl.replaceChildren(habitTitle(hb));
    return true;
  };
  const sheet = openSheet({ title: '', content: body, cls: 'task-view-sheet', onClose: () => unsub() });
  const titleEl = sheet.panel.querySelector('.sheet-title');
  titleEl.setAttribute('tabindex', '-1');
  render();
  const unsub = subscribe(() => { if (!render()) sheet.close(); });
  setTimeout(() => titleEl.focus({ preventScroll: true }), 60);
  return sheet;
}
