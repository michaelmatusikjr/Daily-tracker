import { h, iconBtn, onSwipe, makeSortable, emptyState, sectionHead, toast, isSheetOpen } from '../ui.js';
import { icon } from '../icons.js';
import { getState, getActiveProfile } from '../store.js';
import { appHeader } from '../header.js';
import { ctx } from '../ctx.js';
import { dayProgress, tasksOn, splitTasks, sortAnytime, overdueTasks, activeHabits, isDueOn, habitStart, streaks, habitVal, habitTarget, weekCount, isTaskMissed, isTaskDone, habitWarnAt, isHabitMissed, missedDaysRun, futureTasks, isWeekly, weekStatus, habitWeekStart, habitDone, habitShownTime } from '../logic.js';
import { fmt as fmtDate, addDays, todayKey, startOfWeek, fromKey, fmtDateLong, fmtDateShort, nowMin, timeToMin, fmtTime, weekdayNarrow, weekdayLabels } from '../dates.js';
import { taskRow, habitControl, streakBadge, timeRange, reminderWarnBadge } from './widgets.js';
import { canFire } from '../reminders.js';
import { moveToToday, reorderToday, bumpHabit, completeTaskEarly } from '../actions.js';
import { openQuickAdd } from '../forms.js';
import { attachMenu, habitMenu, taskMenu, showMenu, journalMenu } from '../itemMenu.js';
import { openJournalForm, entryBody } from '../journalForm.js';
import { weatherSlot } from '../weatherUi.js';
import { habitIcon } from '../habitIcon.js';
import { openTaskView } from '../taskView.js';
import { attachRowSwipe } from '../rowSwipe.js';
import { monthGrid, monthNav, addMonths, monthStart } from '../monthGrid.js';

/** One habit row (check/count control, long-press menu). `timed`: shows its "by" time in a rail like timed tasks. */
function habitRow(st, hb, k, today, { timed = false, draggable = false } = {}) {
  const fmt = st.settings.timeFormat;
  const weekMet = isWeekly(hb) && weekStatus(st, hb, habitWeekStart(st, k), today).met && !habitDone(st, hb, k);
  const s = streaks(st, hb, today);
  const v = habitVal(st, hb, k);
  // Most useful info first, since the line is truncated with an ellipsis.
  const sub = [];
  if (isWeekly(hb)) {
    const ws = weekStatus(st, hb, habitWeekStart(st, k), today);
    sub.push(ws.met ? 'Done for this week ✓' : `${ws.left} left this week`);
  }
  if (hb.goal.type === 'count') sub.push(`${v}/${habitTarget(hb)}${hb.goal.unit ? ' ' + hb.goal.unit : ''}`);
  const shown = habitShownTime(hb, v, k === today ? nowMin() : k < today ? 1440 : null);
  if (hb.target) sub.push(`by ${fmtTime(shown, fmt)}`);
  const warnBadge = habitWarnAt(st, hb) !== null && !canFire();
  // A daily habit missed 2+ days in a row (ending yesterday): warning text + colour until it's done.
  const missRun = k === today ? missedDaysRun(st, hb, today) : 0;
  const missWarn = missRun >= 2;
  const li = h(`li.habit-row${missWarn ? '.miss-warn' : ''}${timed ? '.timed' : ''}${isWeekly(hb) ? '.weekly' : ''}${weekMet ? '.week-done' : ''}`, { dataset: { id: hb.id, kind: 'habit' }, style: { '--c': hb.color } },
    timed ? h('span.task-time', h('small', 'by'), h('span', fmtTime(shown, fmt))) : null,
    h('button.habit-row-main', { type: 'button', onclick: () => ctx.go('habit/' + hb.id), 'aria-label': `${hb.name} details` },
      h('span.emoji-bubble', { 'aria-hidden': 'true' }, habitIcon(hb)),
      h('span.habit-row-text', h('span.habit-name', hb.name), sub.length || s.current || warnBadge || missWarn ? h('span.habit-sub', missWarn ? h('span.miss-text', `Missed ${missRun} days`) : null, streakBadge(s, hb.id), warnBadge ? reminderWarnBadge() : null, h('span.sub-text', sub.join(' · '))) : null)),
    hb.goal.type === 'count' && v > 0 && k <= today ? iconBtn('minus', `Remove one from ${hb.name}`, () => bumpHabit(hb.id, k, -1), 'minus-btn') : null,
    habitControl(hb, k),
    draggable ? h('button.drag-handle', { type: 'button', 'data-fk': 'dh-' + hb.id, 'aria-label': `Reorder ${hb.name} (use arrow keys)` }, icon('grip', { size: 18 })) : null);
  return attachRowSwipe(typeBar(attachLi(li, () => habitMenu(hb.id, k)), 'Habit'), 'habit', hb.id, k);
}

/** The coloured left-edge bar that tells habits from tasks (its text doubles as the row's type for screen readers). */
function typeBar(li, label) {
  li.classList.add('has-bar');
  li.prepend(h(`span.type-bar.${label === 'Habit' ? 'bar-habit' : 'bar-task'}`, h('span', label)));
  return li;
}

const TIPS_KEY = 'dailyTracker:tips';
function tipsSeen() { try { return JSON.parse(localStorage.getItem(TIPS_KEY) || '{}'); } catch { return {}; } }
export function markTipSeen() {
  try { localStorage.setItem(TIPS_KEY, JSON.stringify({ ...tipsSeen(), settingsMoved: true })); } catch { /* ignore */ }
  document.querySelector('.coach-tip')?.remove();
}
/**
 * While the month calendar is open: scrolling (the page, the wheel, or a finger dragging on the content) closes it.
 * Only one watch exists at a time (each render replaces the previous one); null stops watching.
 */
let stopWatch = null;
function watchCal(close) {
  stopWatch?.(); stopWatch = null;
  if (!close) return;
  const t0 = performance.now(), y0 = window.scrollY;
  const outside = (e) => !(e.target instanceof Node && e.target.closest?.('.app-head'));
  const onScroll = () => { if (performance.now() - t0 > 350 && Math.abs(window.scrollY - y0) > 6) close(); };
  const onWheel = (e) => { if (outside(e) && Math.abs(e.deltaY) > 2) close(); };
  let ty = null;
  const onTouchStart = (e) => { ty = outside(e) && e.touches.length === 1 ? e.touches[0].clientY : null; };
  const onTouchMove = (e) => { if (ty !== null && Math.abs(e.touches[0].clientY - ty) > 10) { ty = null; close(); } };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('wheel', onWheel, { passive: true });
  window.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
  window.addEventListener('touchmove', onTouchMove, { passive: true, capture: true });
  stopWatch = () => {
    window.removeEventListener('scroll', onScroll); window.removeEventListener('wheel', onWheel);
    window.removeEventListener('touchstart', onTouchStart, true); window.removeEventListener('touchmove', onTouchMove, true);
  };
}
/** Leaving Today closes the calendar and its watchers. */
export function resetCalendar() { stopWatch?.(); stopWatch = null; }

/** One-time hint for people upgrading from a version with a Settings tab. */
function settingsTip() {
  if (tipsSeen().settingsMoved || !getState().settings.onboarded) return null;
  return h('div.coach-tip', { role: 'note' },
    h('span', '⚙️ ', h('b', 'Settings moved here.'), ' Tap your picture for settings and profiles.'),
    h('button.link-btn', { type: 'button', onclick: () => markTipSeen() }, 'Got it'));
}

const attachLi = (li, build) => { attachMenu(li, build, li.querySelector('button')); return li; };

/** One-time hint about item menus, the first time Today shows items. */
function menuHint(hasItems) {
  if (!hasItems || tipsSeen().itemMenu || !getState().settings.onboarded) return;
  setTimeout(() => {
    // Never replace a toast that is showing (it may carry an Undo); try again on a later render.
    if (document.querySelector('#toasts .toast') || isSheetOpen() || tipsSeen().itemMenu) return;
    try { localStorage.setItem(TIPS_KEY, JSON.stringify({ ...tipsSeen(), itemMenu: true })); } catch { return; }
    toast('Tip: press and hold any item for more options.', { duration: 6000, force: true });
  }, 600);
}

export function renderToday() {
  const st = getState();
  const k = ctx.ui.date;
  const today = todayKey();
  const isToday = k === today;
  const fmt = st.settings.timeFormat;
  const root = h('div.view.view-today');

  // ---- Header (v1.14: fixed; week strip pinned under the title row) ----
  const ws = startOfWeek(k, st.settings.weekStart);
  const strip = h('div.week-strip.no-swipe', { role: 'group', 'aria-label': 'Week' });
  const longNames = weekdayLabels('long');
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i);
    const p = dayProgress(st, d);
    strip.append(h(`button.ws-day${d === k ? '.selected' : ''}${d === today ? '.is-today' : ''}`, {
      type: 'button', 'aria-current': d === k ? 'date' : null,
      'aria-label': `${longNames[fromKey(d).getDay()]} ${fmtDateShort(d)}${p.total ? `, ${p.done} of ${p.total} done` : ''}`,
      onclick: () => ctx.setDate(d),
    },
    h('span.ws-letter', weekdayNarrow(d)),
    h('span.ws-num', String(fromKey(d).getDate())),
    h('span.ws-bar', { style: { '--p': p.total ? p.pct : 0 }, 'data-empty': p.total ? null : '' })));
  }
  onSwipe(strip, { left: () => ctx.setDate(addDays(k, 7)), right: () => ctx.setDate(addDays(k, -7)) });

  // ---- Pull-down month calendar (v1.18): the strip opens into the full month; scrolling or tapping a day closes it ----
  const calPanel = h('div.cal-panel', { id: 'cal-panel' });
  const grab = h('button.cal-grab', { type: 'button', 'aria-controls': 'cal-panel', onclick: () => setCal(!ctx.ui.calOpen) }, h('span.cal-grab-bar'));
  const fillCal = () => {
    const m = ctx.ui.calMonth || monthStart(k);
    const shift = (n) => { ctx.ui.calMonth = addMonths(m, n); fillCal(); };
    calPanel.replaceChildren(
      monthNav(m, { onMonth: shift, onToday: () => { ctx.ui.calMonth = monthStart(today); fillCal(); } }),
      // A tapped day closes the calendar; the strip then shows that day's week with the day selected.
      monthGrid(st, m, { selected: k, onPick: (d) => { ctx.ui.calOpen = false; ctx.setDate(d); }, onMonth: shift }));
  };
  const applyCal = () => {
    const open = !!ctx.ui.calOpen;
    head.classList.toggle('cal-open', open);
    grab.setAttribute('aria-expanded', String(open));
    grab.setAttribute('aria-label', open ? 'Hide month calendar' : 'Show month calendar');
    watchCal(open ? () => setCal(false) : null);
  };
  const setCal = (open) => {
    if (!!ctx.ui.calOpen === open) return;
    ctx.ui.calOpen = open;
    if (open) { ctx.ui.calMonth = monthStart(k); fillCal(); }
    applyCal();
  };
  // Pull down on the strip (or its handle) to open; pull up on the calendar to close.
  const pull = (el, onPull) => {
    let y0 = null, x0 = 0;
    el.addEventListener('touchstart', (e) => { if (e.touches.length === 1) { y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; } else y0 = null; }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (y0 === null) return;
      const t = e.touches[0], dy = t.clientY - y0, dx = t.clientX - x0;
      if (Math.abs(dy) > 24 && Math.abs(dy) > Math.abs(dx) * 1.2) { const down = dy > 0; y0 = null; onPull(down); }
    }, { passive: true });
  };
  pull(strip, (down) => { if (down) setCal(true); });
  pull(grab, (down) => { if (down) setCal(true); });
  pull(calPanel, (down) => { if (!down) setCal(false); });
  const head = appHeader({
    cls: 'today-head', onAvatar: () => markTipSeen(),
    // With the "Today" chip showing, narrow screens get a short date (swapped in CSS).
    title: [h('span.title-long', fmtDateLong(k)), !isToday ? h('span.title-short', fmtDate(k, { weekday: 'short', month: 'short', day: 'numeric' })) : null],
    actions: [
      !isToday ? h('button.chip-btn', { type: 'button', onclick: () => ctx.setDate(today) }, 'Today') : null,
      iconBtn('chevronLeft', 'Previous day', () => ctx.setDate(addDays(k, -1))),
      iconBtn('chevronRight', 'Next day', () => ctx.setDate(addDays(k, 1))),
    ],
    below: [strip, calPanel, grab],
  });
  root.append(head);
  if (ctx.ui.calOpen) fillCal();
  applyCal();
  const tip = settingsTip();
  if (tip) root.append(tip);
  root.append(weatherSlot(k));

  // ---- Overdue (rollover) ----
  if (isToday) {
    const overdue = overdueTasks(st, today);
    if (overdue.length) {
      const list = h('ul.tasks.compact');
      for (const t of overdue) {
        const row = attachRowSwipe(typeBar(taskRow(t, t.date, { showDate: true }), 'Task'), 'task', t.id, t.date);
        row.querySelector('.check').before(h('button.btn.small.secondary.move-btn', { type: 'button', onclick: () => moveToToday([t.id]), 'aria-label': `Move “${t.title}” to today` }, icon('arrowRight', { size: 16 }), h('span.hide-xs', 'Today')));
        list.append(row);
      }
      root.append(h('section.card.overdue-card', { 'aria-label': 'Unfinished from earlier days' },
        sectionHead(`Unfinished from earlier · ${overdue.length}`,
          overdue.length > 1 ? h('button.link-btn', { type: 'button', onclick: () => moveToToday(overdue.map((t) => t.id)) }, 'Move all to today') : null, 'alert'),
        list));
    }
  }

  // ---- Habits due ----
  // Weekly (X per week) habits show all week: "2 left this week", then "Done for this week ✓",
  // sitting after the others once met. They never count toward the day's ring.
  const weekMet = (hb) => isWeekly(hb) && weekStatus(st, hb, habitWeekStart(st, k), today).met && !habitDone(st, hb, k);
  const dueHabits = activeHabits(st)
    .filter((hb) => habitStart(st, hb) <= k || k >= hb.createdAt)
    .filter((hb) => isWeekly(hb) || isDueOn(st, hb, k));
  // "Mark as missed" only hides an item from these lists (it still counts as not done).
  const habits = dueHabits.filter((hb) => !isHabitMissed(st, hb, k));
  const missedHabits = dueHabits.filter((hb) => isHabitMissed(st, hb, k));

  // ---- Tasks and habits: the Schedule (timed) and the Anytime list ----
  const dayTasks = tasksOn(st, k);
  const missedTasks = dayTasks.filter((t) => isTaskMissed(t, k));
  const { timed, anytime } = splitTasks(dayTasks.filter((t) => !isTaskMissed(t, k)));
  if (!dayTasks.length && !dueHabits.length) {
    root.append(h('section.card', emptyState(isToday ? '🌤️' : '🗓️', 'Nothing scheduled',
      'Tap + and type something like “Gym 6pm” or “Call mom tomorrow 14:30”.',
      h('button.btn.primary', { type: 'button', onclick: () => openQuickAdd() }, icon('plus', { size: 18 }), 'Add a task'))));
  }
  // Schedule: timed tasks and habits with a "complete by" time, in time order (tasks before habits at the same time).
  const entries = [
    ...timed.map((t) => ({ kind: 'task', t, min: timeToMin(t.time) })),
    ...habits.filter((hb) => hb.target).sort((a, b) => a.order - b.order).map((hb) => ({ kind: 'habit', hb, min: timeToMin(habitShownTime(hb, habitVal(st, hb, k), isToday ? nowMin() : k < today ? 1440 : null)) })),
  ].sort((a, b) => a.min - b.min || (a.kind === b.kind ? 0 : a.kind === 'task' ? -1 : 1));
  if (entries.length) {
    const now = isToday ? nowMin() : null;
    const list = h('ol.timeline');
    let nowPlaced = !isToday;
    const nowLine = () => h('li.now-line', { 'aria-label': `Now, ${fmtTime(`${String(Math.floor(now / 60)).padStart(2, '0')}:${String(now % 60).padStart(2, '0')}`, fmt)}` },
      h('span.now-dot'), h('span.now-label', 'Now'));
    for (const e of entries) {
      if (!nowPlaced && e.min > now) { list.append(nowLine()); nowPlaced = true; }
      if (e.kind === 'habit') { list.append(habitRow(st, e.hb, k, today, { timed: true })); continue; }
      const t = e.t;
      const row = attachRowSwipe(typeBar(taskRow(t, k, { nowMin: now }), 'Task'), 'task', t.id, k);
      row.classList.add('timed');
      row.querySelector('.type-bar').after(h('span.task-time', h('span', fmtTime(t.time, fmt)), t.duration ? h('small', timeRange(t, fmt).split(' – ')[1] || '') : null));
      list.append(row);
    }
    if (!nowPlaced) list.append(nowLine());
    root.append(h('section.section', sectionHead('Schedule', null, 'clock'), list));
  }
  // Anytime: untimed tasks and habits without a target, draggable together (shared `todayOrder`).
  const anyItems = sortAnytime([
    ...anytime.map((t) => ({ kind: 'task', item: t })),
    ...habits.filter((hb) => !hb.target).map((hb) => ({ kind: 'habit', item: hb })),
  ]);
  // Met weekly habits sit last.
  anyItems.sort((a, b) => (a.kind === 'habit' && weekMet(a.item) ? 1 : 0) - (b.kind === 'habit' && weekMet(b.item) ? 1 : 0));
  if (anyItems.length) {
    const list = h('ul.tasks');
    const drag = anyItems.length > 1;
    for (const x of anyItems) list.append(x.kind === 'task' ? attachRowSwipe(typeBar(taskRow(x.item, k, { draggable: drag }), 'Task'), 'task', x.item.id, k) : habitRow(st, x.item, k, today, { draggable: drag }));
    makeSortable(list, { onReorder: (ids) => reorderToday(ids) });
    const doneCount = anyItems.filter((x) => (x.kind === 'task' ? isTaskDone(x.item, k) : habitDone(st, x.item, k))).length;
    root.append(h('section.section', sectionHead('Anytime', h('span.muted.small', `${doneCount}/${anyItems.length}`), 'list'), list));
  }

  menuHint(habits.length + timed.length + anytime.length > 0);

  // ---- Missed (collapsed) ----
  if (missedHabits.length || missedTasks.length) root.append(missedSection(k, missedHabits, missedTasks));

  // ---- Future tasks (today's view only) ----
  if (isToday) { const fut = futureSection(st, today); if (fut) root.append(fut); }

  // ---- Journal entry (added from +; read-only here) ----
  const jc = journalEntryCard(k);
  if (jc) root.append(jc);

  onSwipe(root, { left: () => ctx.setDate(addDays(k, 1)), right: () => ctx.setDate(addDays(k, -1)) });
  return root;
}

/** "Future tasks": tasks scheduled after today; the next 14 days listed, the rest behind "More future tasks". Check = done early. */
function futureSection(st, today) {
  const { soon, later } = futureTasks(st, today);
  if (!soon.length && !later.length) return null;
  const row = ({ t, date }) => {
    const li = typeBar(taskRow(t, date, { dateLabel: fmtDate(date, { weekday: 'short', month: 'short', day: 'numeric' }), onCheck: () => completeTaskEarly(t.id, date) }), 'Task');
    li.classList.add('future-row');
    return li;
  };
  const sec = h('section.section.future-section', { 'aria-label': 'Future tasks' }, sectionHead('Future tasks', h('span.muted.small', String(soon.length + later.length)), 'calendar'));
  if (soon.length) sec.append(h('ul.tasks', soon.map(row)));
  else sec.append(h('p.hint-line', 'Nothing in the next 2 weeks.'));
  if (later.length) {
    const open = !!ctx.ui.futureOpen;
    sec.append(h('button.collapse-btn.future-more', { type: 'button', 'aria-expanded': String(open), onclick: () => { ctx.ui.futureOpen = !open; ctx.rerender(); } },
      'More future tasks', h('span.muted.small', ` (${later.length})`), h('span.chev', icon('chevronDown', { size: 16 }))));
    if (open) sec.append(h('ul.tasks', later.map(row)));
  }
  return sec;
}

/** Collapsed "Missed (n)": items given up on for this day. Tap one for Unmark missed / Mark done. */
function missedSection(k, habits, tasks) {
  const n = habits.length + tasks.length;
  const open = !!ctx.ui.missedOpen;
  const head = h('button.collapse-btn', { type: 'button', 'aria-expanded': String(open), onclick: () => { ctx.ui.missedOpen = !open; ctx.rerender(); } },
    icon('skip', { size: 16 }), `Missed (${n})`, h('span.chev', icon('chevronDown', { size: 16 })));
  const sec = h('section.section.missed-section', head);
  if (open) {
    const rows = [
      ...habits.map((hb) => {
        const btn = h('button.missed-item', { type: 'button', style: { '--c': hb.color }, onclick: () => { const m = habitMenu(hb.id, k); if (m) showMenu(m.title, m.items, { mode: 'touch' }); } },
          h('span.emoji-bubble.small', { 'aria-hidden': 'true' }, habitIcon(hb)), h('span.missed-name', hb.name), h('span.muted.small', 'Habit'));
        const li = h('li', { dataset: { id: hb.id } }, btn);
        attachMenu(li, () => habitMenu(hb.id, k), btn);
        return li;
      }),
      ...tasks.map((t) => {
        const btn = h('button.missed-item', { type: 'button', onclick: () => openTaskView(t.id, k) },
          h('span.missed-dash', { 'aria-hidden': 'true' }, '–'), h('span.missed-name', t.title), h('span.muted.small', t.time ? fmtTime(t.time, getState().settings.timeFormat) : 'Task'));
        const li = h('li', { dataset: { id: t.id } }, btn);
        attachMenu(li, () => taskMenu(t.id, k), btn);
        return li;
      }),
    ];
    sec.append(h('ul.missed-list', rows), h('p.hint-line', 'Missed items still count as not done. Tap one to bring it back or mark it done.'));
  }
  return sec;
}

/** The day's journal entry, read-only. Tap opens it for editing (like tapping a task opens it); long-press: Edit / Delete. */
function journalEntryCard(k) {
  const entry = getState().journal[k];
  if (!entry) return null;
  const btn = h('button.journal-open', { type: 'button', onclick: () => openJournalForm(k), 'aria-label': 'Journal entry. Open to edit' }, ...entryBody(entry));
  const card = h('section.card.journal-entry', { 'aria-label': 'Journal' }, h('p.journal-label', icon('book', { size: 14 }), 'Journal'), btn);
  attachMenu(card, () => journalMenu(k), btn);
  return card;
}
