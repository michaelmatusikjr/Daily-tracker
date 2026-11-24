// Read-only "View task" sheet: what a tap on a task (or a task reminder) opens.
// Edit, the long-press actions and done/not done are one tap away. Updates live while open.
import { h, openSheet, toast } from './ui.js';
import { icon } from './icons.js';
import { getState, subscribe, getActiveProfile } from './store.js';
import { clockText, isTaskDone, isTaskMissed, isRecurring, recurrenceLabel, PRIORITIES, occursOn } from './logic.js';
import { todayKey, relativeLabel, fmtDateShort, fmtDateLong, weekdayLabels, fmtTime } from './dates.js';
import { toggleTask, setMissed } from './actions.js';
import { openTaskForm } from './forms.js';
import { taskMenu, showMenu } from './itemMenu.js';
import { timeRange, reminderWarnBadge } from './views/widgets.js';
import { canFire } from './reminders.js';
import { fileUrl } from './attachments.js';
import { photoStatus, onPhotosChange } from './fileSync.js';
import { resetZoom } from './noZoom.js';

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

/** Words for a photo that isn't on this device (see fileSync.photoStatus). */
const MISSING_TEXT = { downloading: 'Downloading…', full: 'Not enough space on this device', elsewhere: 'Photo on another device' };
const missingText = (pid, id) => MISSING_TEXT[photoStatus(pid, id)] || MISSING_TEXT.elsewhere;

/** Thumbnail grid; tapping one opens the full-screen viewer. */
function photoSection(t) {
  const list = t.attachments;
  const pid = getActiveProfile()?.id;
  const items = list.map((a, i) => {
    const img = h('img', { alt: `${t.title} – photo ${i + 1} of ${list.length}`, width: 96, height: 96 });
    const li = h('li.photo-item', h('button.photo-open', { type: 'button', 'aria-label': `Open photo ${i + 1} of ${list.length}`, onclick: () => openPhotoViewer(t.title, list, i) }, img));
    return { a, img, li, shown: false };
  });
  // Not on this device (synced from another one): "Downloading…" while it's on its way, else a
  // placeholder. Shown as soon as it arrives.
  const load = (it) => fileUrl(it.a.id).then((u) => {
    if (it.shown) { if (u) URL.revokeObjectURL(u); return; }
    if (u) {
      it.shown = true;
      it.img.src = u; it.img.addEventListener('load', () => URL.revokeObjectURL(u), { once: true });
      it.li.classList.remove('missing'); it.li.querySelector('.photo-elsewhere')?.remove();
      return;
    }
    it.li.classList.add('missing');
    const text = missingText(pid, it.a.id);
    const el = it.li.querySelector('.photo-elsewhere');
    if (el) el.textContent = text; else it.li.querySelector('.photo-open')?.append(h('span.photo-elsewhere', text));
  });
  items.forEach(load);
  const grid = h('ul.photo-grid.tv-photos', items.map((it) => it.li));
  const off = onPhotosChange(() => {
    if (!grid.isConnected) { if (grid.dataset.mounted) off(); return; }
    grid.dataset.mounted = '1';
    items.filter((it) => !it.shown).forEach(load);
  });
  return h('section.tv-section', { 'aria-label': 'Photos' }, h('h3.tv-head', `Photos (${list.length})`), grid);
}

/** Full-screen photo viewer: arrows / swipe to move, Esc or × to close, pinch-zoom on touch. */
export function openPhotoViewer(title, list, start = 0) {
  let i = start;
  const prevFocus = document.activeElement;
  const img = h('img.pv-img', { alt: '' });
  const counter = h('p.pv-count', { 'aria-live': 'polite' });
  let url = null, token = 0, closed = false;
  const show = async () => {
    const my = ++token;
    const n = list.length;
    img.alt = `${title} – photo ${i + 1} of ${n}`;
    counter.textContent = `${i + 1} / ${n}`;
    prevBtn.disabled = i === 0; nextBtn.disabled = i === n - 1;
    const u = await fileUrl(list[i].id, 'full');
    // A newer show() (fast navigation) or a close happened meanwhile: drop this result.
    if (my !== token || closed) { if (u) URL.revokeObjectURL(u); return; }
    if (url) URL.revokeObjectURL(url);
    url = u;
    if (u) { img.src = u; img.hidden = false; missing.hidden = true; } else {
      img.removeAttribute('src'); img.hidden = true; missing.hidden = false;
      const st = photoStatus(getActiveProfile()?.id, list[i].id);
      missing.textContent = st === 'downloading' ? 'Downloading…' : st === 'full' ? 'Not enough space on this device to download this photo.' : 'Photo on another device – it isn’t available here.';
    }
  };
  // A photo that arrives (or whose status changes) while it's shown.
  const offPhotos = onPhotosChange(() => { if (closed) { offPhotos(); return; } if (!url) show(); });
  const go = (d) => { const j = i + d; if (j >= 0 && j < list.length) { i = j; show(); } };
  const close = () => { closed = true; document.removeEventListener('keydown', onKey, true); root.remove(); if (url) URL.revokeObjectURL(url); url = null; document.body.classList.remove('viewer-open'); resetZoom(); prevFocus?.focus?.({ preventScroll: true }); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'Tab') { const f = [...root.querySelectorAll('button:not([disabled])')]; const k = f.indexOf(document.activeElement); e.preventDefault(); f[(k + (e.shiftKey ? -1 : 1) + f.length) % f.length]?.focus(); }
  };
  const prevBtn = h('button.pv-nav.pv-prev', { type: 'button', 'aria-label': 'Previous photo', onclick: () => go(-1) }, icon('chevronLeft', { size: 28 }));
  const nextBtn = h('button.pv-nav.pv-next', { type: 'button', 'aria-label': 'Next photo', onclick: () => go(1) }, icon('chevronRight', { size: 28 }));
  const closeBtn = h('button.pv-close', { type: 'button', 'aria-label': 'Close photo' }, icon('x', { size: 24 }));
  closeBtn.addEventListener('click', close);
  const missing = h('p.pv-missing', { hidden: true }, 'Photo on another device – it isn’t available here.');
  const stage = h('div.pv-stage', img, missing);
  // Swipe (one finger) to move; two fingers are left to the browser for pinch-zoom.
  let sx = null, sy = 0;
  stage.addEventListener('touchstart', (e) => { sx = e.touches.length === 1 ? e.touches[0].clientX : null; sy = e.touches[0]?.clientY || 0; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (sx === null) return;
    const t = e.changedTouches[0]; const dx = t.clientX - sx, dy = t.clientY - sy; sx = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  });
  const root = h('div.photo-viewer', { role: 'dialog', 'aria-modal': 'true', 'aria-label': `${title} photos` }, closeBtn, prevBtn, stage, nextBtn, counter);
  document.body.append(root);
  document.body.classList.add('viewer-open');
  document.addEventListener('keydown', onKey, true);
  show();
  closeBtn.focus();
  return { close, go, root };
}

/**
 * Top block of a View sheet opened from a notification: big Complete / Missed buttons, or – when
 * already done or marked missed – a banner with Undo. state: 'open' | 'done' | 'missed'.
 * `at` is the completion time (ms) when known.
 */
export function notifyActions({ state, at = null, fmt = '12', canMiss = true, onDone, onMissed, onUndo }) {
  if (state === 'open') {
    return h('div.tv-quick', { role: 'group', 'aria-label': 'Quick actions' },
      h('button.btn.primary.tv-big.tv-complete', { type: 'button', onclick: onDone }, icon('check', { size: 22 }), 'Complete'),
      canMiss ? h('button.btn.secondary.tv-big.tv-missed', { type: 'button', onclick: onMissed }, icon('skip', { size: 22 }), 'Missed') : null);
  }
  const text = state === 'missed' ? 'Marked missed'
    : at ? `Completed at ${(() => { const d = new Date(at); return clockText(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, fmt); })()}` : 'Completed';
  return h(`div.tv-banner.${state}`, { role: 'status' },
    icon(state === 'missed' ? 'skip' : 'check', { size: 20 }), h('span.tv-banner-text', text),
    h('button.btn.secondary.tv-undo', { type: 'button', onclick: onUndo }, icon('undo', { size: 16 }), 'Undo'));
}

/** Open the View sheet for task `id` on day `k` (the occurrence for repeating tasks).
 *  { fromNotification: true } puts Complete / Missed (or a Completed / Missed banner) first. */
export function openTaskView(id, k = null, { fromNotification = false } = {}) {
  let t = getState().tasks.find((x) => x.id === id);
  if (!t) { toast('That task was deleted.'); return null; }
  k = k || t.date;
  // e.g. an old notification for a day that was skipped since: don't open an empty sheet.
  if (isRecurring(t) && !occursOn(t, k)) { toast('That occurrence was skipped or moved.'); return null; }
  const body = h('div.task-view');
  // Rows on screen when the view opened (to move focus sensibly if this task disappears).
  // (Today's task rows, or the Completed list's rows keyed "id|date".)
  const rowOrder = [...document.querySelectorAll('.task[data-id], .completed-list li[data-key]')].map((e) => e.dataset.key || e.dataset.id);
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
    if (!t.time && t.reminderAt) {
      details.push(h('div.tv-line', icon('bell', { size: 16 }), h('span', `Reminder: at ${fmtTime(t.reminderAt, fmt)}`), canFire() ? null : reminderWarnBadge()));
    }
    if (t.reminder !== null && t.reminder !== undefined && t.time) {
      details.push(h('div.tv-line', icon('bell', { size: 16 }), h('span', `Reminder: ${reminderText(t.reminder)}`), canFire() ? null : reminderWarnBadge()));
    }
    let status = null;
    if (isTaskMissed(t, k)) status = h('p.tv-status.missed', icon('skip', { size: 15 }), 'Marked as missed for this day – it still counts as not done.');
    else if (!done && !rec && t.date < today) status = h('p.tv-status.overdue', icon('alert', { size: 15 }), `Overdue – it was due ${relativeLabel(t.date, today).toLowerCase()}.`);
    const doneAt = rec ? t.doneAt?.[k] : t.completedAt;
    const quick = fromNotification ? notifyActions({
      state: done ? 'done' : isTaskMissed(t, k) ? 'missed' : 'open', at: doneAt, fmt, canMiss: k <= today,
      onDone: () => toggleTask(id, k),
      onMissed: () => setMissed('task', id, k, true),
      onUndo: () => (done ? toggleTask(id, k) : setMissed('task', id, k, false)),
    }) : null;
    body.replaceChildren(...[
      quick,
      h(`div.tv-state${done ? '.done' : ''}`, done ? icon('check', { size: 14 }) : null, done ? 'Done' : 'Not done', rec ? ` · ${fmtDateShort(k)}` : ''),
      status,
      h('section.tv-section', { 'aria-label': 'When' }, h('h3.tv-head', 'When'), ...when),
      details.length ? h('section.tv-section', { 'aria-label': 'Details' }, h('h3.tv-head', 'Details'), ...details) : null,
      t.notes ? h('section.tv-section', { 'aria-label': 'Notes' }, h('h3.tv-head', 'Notes'), h('p.tv-notes', linkify(t.notes))) : null,
      t.attachments?.length ? photoSection(t) : null,
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
  const sheet = openSheet({
    title: t.title, content: body, cls: 'task-view-sheet',
    onClose: () => {
      unsub();
      // The row that opened the view may have been re-rendered (e.g. after an edit): focus its replacement.
      const a = document.activeElement;
      if (a && a !== document.body && !sheet.panel.contains(a)) return;
      const rowBtn = (key) => document.querySelector(`.task[data-id="${CSS.escape(key)}"] .task-main, .completed-list li[data-key="${CSS.escape(key)}"] .completed-row`);
      const selfKey = rowOrder.includes(`${id}|${k}`) ? `${id}|${k}` : id;
      let target = rowBtn(selfKey);
      if (!target) {
        // The task (or this occurrence) is gone, e.g. deleted from here: go to the next row, else the
        // previous one, else the list's heading, so keyboard focus never drops to <body>.
        const i = rowOrder.indexOf(selfKey);
        const next = rowOrder.slice(i + 1).map(rowBtn).find(Boolean) || rowOrder.slice(0, Math.max(0, i)).reverse().map(rowBtn).find(Boolean);
        target = next || document.querySelector('main .section-title, main h1');
        if (target && !next && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      }
      target?.focus({ preventScroll: true });
    },
  });
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
