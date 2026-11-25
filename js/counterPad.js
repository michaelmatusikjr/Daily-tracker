// Long-press on a count habit's counter: a small − / + / Done pad (Today rows and Habits-tab dots, any past day).
import { h, haptic } from './ui.js';
import { icon } from './icons.js';
import { getState, subscribe } from './store.js';
import { bumpHabit } from './actions.js';
import { habitVal, habitTarget } from './logic.js';

let open = null; // { el, close }

export function closeCounterPad() { open?.close(); }

/**
 * Show the pad next to `anchor` for habit `id` on day `k`. + / − change that day's count by one; Done closes it.
 * It lives outside the view (which re-renders after every change), so it keeps its place and just updates its number.
 */
export function openCounterPad(id, k, anchor) {
  closeCounterPad();
  const hb = getState().habits.find((x) => x.id === id);
  if (!hb) return;
  const target = habitTarget(hb);
  const value = h('span.cp-value', { 'aria-live': 'polite' });
  const minus = h('button.cp-btn.cp-minus', { type: 'button', 'aria-label': `Remove one from ${hb.name}`, onclick: () => bumpHabit(id, k, -1) }, icon('minus', { size: 20 }));
  const plus = h('button.cp-btn.cp-plus', { type: 'button', 'aria-label': `Add one to ${hb.name}`, onclick: () => bumpHabit(id, k, 1) }, icon('plus', { size: 20 }));
  const done = h('button.cp-done', { type: 'button', onclick: () => close() }, 'Done');
  const el = h('div.counter-pad', { role: 'group', 'aria-label': `${hb.name}: quick count`, style: { '--c': hb.color } }, minus, value, plus, done);
  const refresh = () => {
    const cur = getState().habits.find((x) => x.id === id);
    if (!cur) { close(); return; }
    const v = habitVal(getState(), cur, k);
    value.textContent = `${v}/${target}`;
    minus.disabled = v <= 0;
  };
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth || 220;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    const below = r.bottom + 8 + 52 < window.innerHeight;
    el.style.left = left + 'px';
    el.style.top = (below ? r.bottom + 8 : Math.max(8, r.top - 8 - 52)) + 'px';
  };
  const away = (e) => { if (!el.contains(e.target)) close(); };
  const key = (e) => { if (e.key === 'Escape') close(); };
  const unsub = subscribe(refresh);
  function close() {
    unsub();
    document.removeEventListener('pointerdown', away, true);
    document.removeEventListener('keydown', key, true);
    window.removeEventListener('scroll', close);
    el.remove();
    if (open?.el === el) open = null;
  }
  refresh();
  document.body.append(el);
  place();
  open = { el, close };
  haptic(8);
  // Taps outside close it (not the one that just opened it: that finger is still down).
  setTimeout(() => { if (open?.el === el) { document.addEventListener('pointerdown', away, true); window.addEventListener('scroll', close, { passive: true }); } }, 350);
  document.addEventListener('keydown', key, true);
  plus.focus({ preventScroll: true });
}

/**
 * Wire a counter button: a long-press (touch/pen ~500 ms, or right-click / ContextMenu key) opens the pad
 * instead of the row's item menu. The tap that ends the long-press is swallowed. `data-lp-own` keeps
 * onItemMenu() (which listens on the whole row) out of it.
 */
export function onCounterHold(btn, id, k, { delay = 500 } = {}) {
  btn.dataset.lpOwn = '1';
  let timer = null, sx = 0, sy = 0, swallow = false;
  const cancel = () => { clearTimeout(timer); timer = null; };
  const fire = () => { swallow = true; setTimeout(() => { swallow = false; }, 700); openCounterPad(id, k, btn); };
  btn.addEventListener('pointerdown', (e) => {
    swallow = false;
    if (e.pointerType === 'mouse' || !e.isPrimary || btn.disabled) return;
    sx = e.clientX; sy = e.clientY; cancel();
    timer = setTimeout(() => { timer = null; fire(); }, delay);
  });
  btn.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel(); });
  btn.addEventListener('pointerup', cancel);
  btn.addEventListener('pointercancel', cancel);
  btn.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); cancel(); if (!btn.disabled && !swallow) fire(); });
  // The click that follows a long-press must not also add one.
  btn.addEventListener('click', (e) => { if (swallow) { swallow = false; e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  btn.addEventListener('touchend', (e) => { if (swallow && e.cancelable) e.preventDefault(); });
}
