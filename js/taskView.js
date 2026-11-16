// Read-only "View task" sheet: what a tap on a task (or a task reminder) opens.
// Edit, the long-press actions and done/not done are one tap away. Updates live while open.
import { h, openSheet, toast } from './ui.js';
import { icon } from './icons.js';
import { getState, subscribe } from './store.js';
import { isTaskDone, isTaskMissed, isRecurring, recurrenceLabel, PRIORITIES, occursOn } from './logic.js';
import { todayKey, relativeLabel, fmtDateShort, fmtDateLong, weekdayLabels } from './dates.js';
import { toggleTask } from './actions.js';
import { openTaskForm } from './forms.js';
import { taskMenu, showMenu } from './itemMenu.js';
import { timeRange, reminderWarnBadge } from './views/widgets.js';
import { canFire } from './reminders.js';

/** Notes → text nodes and safe links (http/https only, opened in a new tab). Never innerHTML. */
export function linkify(text) {
  const out = [];
  String(text || '').split('\n').forEach((line, i) => {
    if (i) out.push(h('br'));
    const re = /\bhttps?:\/\/[^\s<>"']+/gi;
    let last = 0, m;
    while ((m = re.exec(line))) {
      let url = m[0];
      // Leave trailing punctuation as text, but keep a closing bracket that has its opener in the URL
      // (e.g. https://en.wikipedia.org/wiki/Foo_(bar)).
      for (;;) {
        const c = url.slice(-1);
        const count = (ch) => url.split(ch).length - 1;
        if ('.,;:!?'.includes(c) && c) url = url.slice(0, -1);
        else if (c === ')' && count(')') > count('(')) url = url.slice(0, -1);
        else if (c === ']' && count(']') > count('[')) url = url.slice(0, -1);
        else break;
      }
      let ok = false;
      try { ok = ['http:', 'https:'].includes(new URL(url).protocol); } catch { /* not a URL */ }
      if (!ok) continue;
      if (m.index > last) out.push(document.createTextNode(line.slice(last, m.index)));
      out.push(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url));
      last = m.index + url.length;
    }
    if (last < line.length) out.push(document.createTextNode(line.slice(last)));
  });
  return out;
}

const reminderText = (min) => {
  if (min === 0) return 'At the start time';
  if (min % 1440 === 0) return `${min / 1440} day${min === 1440 ? '' : 's'} before`;
  if (min % 60 === 0) return `${min / 60} hour${min === 60 ? '' : 's'} before`;
  return `${min} min before`;
};

/** Open the View sheet for task `id` on day `k` (the occurrence for repeating tasks). */
export function openTaskView(id, k = null) {
  let t = getState().tasks.find((x) => x.id === id);
  if (!t) { toast('That task was deleted.'); return null; }
  k = k || t.date;
  // e.g. an old notification for a day that was skipped since: don't open an empty sheet.
  if (isRecurring(t) && !occursOn(t, k)) { toast('That occurrence was skipped or moved.'); return null; }
  const body = h('div.task-view');
  let deletingHere = false;
  const render = () => {
    const st = getState();
    t = st.tasks.find((x) => x.id === id);
    if (!t) return false;
    const today = todayKey();
    if (!isRecurring(t)) k = t.date; // a one-off task follows its date (e.g. after Move to tomorrow)
    if (isRecurring(t) && !occursOn(t, k)) return false; // this occurrence was skipped/deleted
    const done = isTaskDone(t, k);
    const fmt = st.settings.timeFormat;
    const rec = isRecurring(t);
    const prio = PRIORITIES[t.priority || 0];
    const cat = t.category ? st.categories.find((c) => c.id === t.category) : null;
    const when = [h('div.tv-line', icon('calendar', { size: 16 }), h('span', `${relativeLabel(k, today)} · ${fmtDateLong(k)}`))];
    if (t.time) when.push(h('div.tv-line', icon('clock', { size: 16 }), h('span', timeRange(t, fmt))));
    else if (t.duration) when.push(h('div.tv-line', icon('clock', { size: 16 }), h('span', `About ${t.duration} min`)));
    if (rec) when.push(h('div.tv-line', icon('repeat', { size: 16 }), h('span', `${recurrenceLabel(t, weekdayLabels('short'))} · showing ${fmtDateShort(k)}`)));
    const details = [];
    if (t.priority) details.push(h('div.tv-line', h('span.tv-prio', { style: { '--prio': prio.color } }, icon('flag', { size: 16 })), h('span', `${prio.label} priority`)));
    if (cat) details.push(h('div.tv-line', icon('tag', { size: 16 }), h('span.cat', { style: { '--c': cat.color } }, cat.name)));
    if (t.reminder !== null && t.reminder !== undefined && t.time) {
      details.push(h('div.tv-line', icon('bell', { size: 16 }), h('span', `Reminder: ${reminderText(t.reminder)}`), canFire() ? null : reminderWarnBadge()));
    }
    let status = null;
    if (isTaskMissed(t, k)) status = h('p.tv-status.missed', icon('skip', { size: 15 }), 'Marked as missed for this day – it still counts as not done.');
    else if (!done && !rec && t.date < today) status = h('p.tv-status.overdue', icon('alert', { size: 15 }), `Overdue – it was due ${relativeLabel(t.date, today).toLowerCase()}.`);
    body.replaceChildren(...[
      h(`div.tv-state${done ? '.done' : ''}`, done ? icon('check', { size: 14 }) : null, done ? 'Done' : 'Not done', rec ? ` · ${fmtDateShort(k)}` : ''),
      status,
      h('section.tv-section', { 'aria-label': 'When' }, h('h3.tv-head', 'When'), ...when),
      details.length ? h('section.tv-section', { 'aria-label': 'Details' }, h('h3.tv-head', 'Details'), ...details) : null,
      t.notes ? h('section.tv-section', { 'aria-label': 'Notes' }, h('h3.tv-head', 'Notes'), h('p.tv-notes', linkify(t.notes))) : null,
      h(`button.btn.block.tv-done${done ? '.secondary' : '.primary'}`, {
        type: 'button', onclick: () => toggleTask(id, k),
      }, icon(done ? 'undo' : 'check', { size: 18 }), done ? 'Mark not done' : 'Mark done'),
      h('div.tv-actions',
        h('button.btn.secondary.tv-edit', {
          type: 'button',
          // The view re-renders on save, so the Edit button that opened the form is gone by the time it
          // closes: hand focus back to the current Edit button (re-queried), or the title.
          onclick: () => openTaskForm(t, {}, { onClose: () => { if (!document.contains(sheet.panel)) return; (sheet.panel.querySelector('.tv-edit') || titleEl).focus({ preventScroll: true }); } }),
        }, icon('edit', { size: 16 }), 'Edit'),
        h('button.btn.secondary', {
          type: 'button', 'aria-label': 'More actions', 'aria-haspopup': 'menu',
          onclick: (e) => {
            const m = taskMenu(id, k);
            if (!m) return;
            // The menu's Delete shows its own Undo toast; don't add a second one.
            const items = m.items.map((it) => (it && it.danger ? { ...it, run: () => { deletingHere = true; it.run(); } } : it));
            showMenu(m.title, items, { mode: 'touch', anchor: e.currentTarget, keepOthers: true });
          },
        }, icon('list', { size: 16 }), 'More')),
    ].filter(Boolean)); // (null children would render as "null" text)
    titleEl.textContent = t.title;
    // Re-rendering replaces the buttons, so focus can drop to <body> (e.g. after Edit › Save): bring it back.
    setTimeout(() => { const a = document.activeElement; if ((!a || a === document.body) && document.contains(titleEl)) titleEl.focus({ preventScroll: true }); }, 0);
    return true;
  };
  const sheet = openSheet({ title: t.title, content: body, cls: 'task-view-sheet', onClose: () => unsub() });
  const titleEl = sheet.panel.querySelector('.sheet-title');
  titleEl.setAttribute('tabindex', '-1');
  render();
  // Re-render on any change (actions here, the edit form, another tab); close if the task is gone.
  const unsub = subscribe((st, info = {}) => {
    if (render()) return;
    const gone = !getState().tasks.some((x) => x.id === id);
    sheet.close();
    // Removed in another tab: say so. A delete made here already showed its own Undo toast.
    if (gone && !deletingHere && info.external) toast('That task was deleted.', { force: true });
  });
  setTimeout(() => titleEl.focus({ preventScroll: true }), 60); // after openSheet's own focus
  return sheet;
}
