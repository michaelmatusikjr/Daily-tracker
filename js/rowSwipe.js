// Swipe actions on task and habit rows (Today and Habits), like iOS Mail: swiping partway reveals the side's
// two actions (inner, outer) as buttons; swiping all the way through runs the outermost one.
// Which actions each side has is a profile setting (Settings › Swipe actions; settings.swipe).
import { h, haptic, claimSwipe } from './ui.js';
import { icon } from './icons.js';
import { getState } from './store.js';
import { ctx } from './ctx.js';
import { isTaskDone, habitDone } from './logic.js';
import { todayKey } from './dates.js';
import { toggleTask, toggleHabitDay, setMissed, deleteTask, deleteHabit } from './actions.js';
import { openTaskForm, openHabitForm } from './forms.js';
import { openTaskView } from './taskView.js';

export const SWIPE_LABELS = { details: 'View details', missed: 'Mark missed', complete: 'Complete', edit: 'Edit', delete: 'Delete', off: 'Off' };
const BTN_W = 76;       // one revealed button
const START = 8;        // px before a touch counts as a swipe (or a scroll)
const OPEN_AT = 40;     // px: letting go beyond this keeps the buttons open
let openRow = null;     // { li, close(animate) }

export const closeOpenRow = () => openRow?.close(true);

/** The button for one action on this item/day, or null when it doesn't apply (e.g. "missed" on a done item). */
function actionFor(kind, id, k, name) {
  const st = getState();
  const today = todayKey();
  const item = kind === 'task' ? st.tasks.find((x) => x.id === id) : st.habits.find((x) => x.id === id);
  if (!item) return null;
  const done = kind === 'task' ? isTaskDone(item, k) : habitDone(st, item, k);
  const canAct = kind === 'task' || (k <= today && !item.archived);
  switch (name) {
    case 'details': return { name, label: 'Details', icon: 'list', run: () => (kind === 'task' ? openTaskView(id, k) : ctx.go('habit/' + id)) };
    case 'missed': return canAct && k <= today && !done ? { name, label: 'Missed', icon: 'skip', run: () => setMissed(kind, id, k, true) } : null;
    case 'complete': return canAct ? { name, label: done ? 'Not done' : 'Complete', icon: done ? 'undo' : 'check', run: () => (kind === 'task' ? toggleTask(id, k) : toggleHabitDay(id, k)) } : null;
    case 'edit': return { name, label: 'Edit', icon: 'edit', run: () => (kind === 'task' ? openTaskForm(item) : openHabitForm(item)) };
    case 'delete': return { name, label: 'Delete', icon: 'trash', run: () => (kind === 'task' ? deleteTask(id, k) : deleteHabit(id)) };
    default: return null;
  }
}

/** [inner, outer] actions that apply for a side ('right' / 'left' swipe), without duplicates or "off". */
export function sideActions(kind, id, k, side) {
  const cfg = getState().settings.swipe?.[side];
  if (!cfg) return [];
  const out = [];
  for (const pos of ['inner', 'outer']) {
    const a = cfg[pos] && cfg[pos] !== 'off' ? actionFor(kind, id, k, cfg[pos]) : null;
    if (a && !out.some((x) => x.name === a.name)) out.push(a);
  }
  return out;
}

/**
 * Make a task/habit row swipeable. `k` is the day the actions apply to (the Habits tab passes today).
 * Touch only: the gesture locks to horizontal after a few pixels (vertical scrolling is left alone), and
 * a swipe toward a side with no actions does nothing here, so the day-swipe of the page still works.
 */
export function attachRowSwipe(li, kind, id, k) {
  return makeSwipeable(li, (side) => sideActions(kind, id, k, side));
}

/**
 * The swipe gesture itself, for any row: actionsFor(side) → [inner, outer] of { name, label, icon, run } for 'right' / 'left'
 * ([] = nothing that way). Also used by the invite list (Settings › Account).
 */
export function makeSwipeable(li, actionsFor) {
  li.classList.add('swipe-row');
  let sx = 0, sy = 0, base = 0, active = false, lock = null, dx = 0, side = null, acts = [], layer = null, dragged = false;

  const setDx = (v, animate = false) => {
    dx = v;
    li.style.transition = animate ? 'transform .24s cubic-bezier(.2,.8,.2,1)' : 'none';
    li.style.transform = v ? `translateX(${v}px)` : '';
    if (layer) { layer.style.transition = animate ? 'width .24s cubic-bezier(.2,.8,.2,1)' : 'none'; layer.style.width = Math.abs(v) + 'px'; }
  };
  const dropLayer = () => { layer?.remove(); layer = null; li.classList.remove('swiping'); };
  const buildLayer = (s) => {
    dropLayer();
    side = s; acts = actionsFor(s);
    if (!acts.length) return false;
    // The outermost action sits at the row's far edge: last in [inner, outer] order on the right side of the row.
    const order = s === 'left' ? acts : [...acts].reverse();
    layer = h(`div.swipe-under.side-${s}`, order.map((a) => h(`button.sw-btn.sw-${a.name}${a === acts[acts.length - 1] ? '.sw-outer' : ''}`, {
      type: 'button', 'aria-label': `${a.label}`,
      onclick: (e) => { e.stopPropagation(); finish(a); },
    }, icon(a.icon, { size: 22 }), h('span', a.label))));
    li.classList.add('swiping');
    li.append(layer);
    return true;
  };
  /** Run an action and put the row back. */
  const finish = (a) => {
    close(false);
    a.run();
  };
  function close(animate) {
    if (openRow?.li === li) openRow = null;
    document.removeEventListener('touchstart', outside, true);
    window.removeEventListener('scroll', onScroll);
    if (!li.isConnected || !animate) { setDx(0); dropLayer(); base = 0; return; }
    setDx(0, true); base = 0;
    setTimeout(() => { if (dx === 0) dropLayer(); }, 260);
  }
  const outside = (e) => { if (!li.contains(e.target)) close(true); };
  const onScroll = () => close(true);
  const settleOpen = () => {
    const w = acts.length * BTN_W * (dx < 0 ? -1 : 1);
    setDx(w, true); base = w;
    openRow = { li, close };
    document.addEventListener('touchstart', outside, { capture: true, passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
  };

  li.addEventListener('touchstart', (e) => {
    active = false; lock = null; dragged = false;
    if (e.touches.length !== 1 || (document.body.classList.contains('sheet-open') && !li.closest('.sheet'))) return;
    if (e.target.closest('.drag-handle, input, textarea, select, .swipe-under')) return;
    if (openRow && openRow.li !== li) openRow.close(true);
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; active = true;
    if (!(openRow?.li === li)) base = 0;
  }, { passive: true });

  li.addEventListener('touchmove', (e) => {
    if (!active) return;
    const t = e.touches[0];
    const mx = t.clientX - sx, my = t.clientY - sy;
    if (lock === null) {
      if (Math.abs(mx) < START && Math.abs(my) < START) return;
      if (Math.abs(mx) > Math.abs(my) * 1.3) lock = 'h'; else { lock = 'v'; active = false; return; }
    }
    const want = base + mx;
    const s = want > 0 ? 'right' : want < 0 ? 'left' : side;
    if (s !== side || !layer) {
      if (!s || !buildLayer(s)) { setDx(0); dropLayer(); side = null; return; } // no actions that way: leave the gesture to the page
    }
    claimSwipe();
    dragged = true;
    if (e.cancelable) e.preventDefault();
    const max = li.offsetWidth - 4;
    // Dragging back across the middle switches sides (or none).
    setDx(Math.max(-max, Math.min(max, want)));
  }, { passive: false });

  const end = () => {
    if (!active || lock !== 'h' || !dragged || !layer) { active = false; return; }
    active = false;
    const abs = Math.abs(dx);
    const w = li.offsetWidth;
    const full = abs >= Math.max(acts.length * BTN_W + 24, w * 0.5);
    if (full) {
      const a = acts[acts.length - 1]; // the outermost action
      haptic(12);
      setDx(dx < 0 ? -w : w, true);
      setTimeout(() => finish(a), 200);
    } else if (abs >= OPEN_AT) settleOpen();
    else close(true);
  };
  li.addEventListener('touchend', end);
  li.addEventListener('touchcancel', () => { if (active && lock === 'h') { active = false; close(true); } else active = false; });
  // The click that can follow a swipe must not open the row's item; while open, a tap on the row only closes it.
  let swipedAt = 0;
  li.addEventListener('touchend', () => { if (dragged) swipedAt = Date.now(); });
  li.addEventListener('click', (e) => {
    if (e.target.closest('.swipe-under')) return;
    if (Date.now() - swipedAt < 350) { e.preventDefault(); e.stopPropagation(); return; }
    if (openRow?.li === li) { e.preventDefault(); e.stopPropagation(); close(true); }
  }, true);
  return li;
}
