// Full-screen takeover for the few moments that deserve it: finishing the day, a new personal
// record, and "saved data couldn't be read". One at a time; a new one replaces the old.
import { h, clearToast } from './ui.js';
import { isStorageOk } from './store.js';

let current = null;

const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

function confetti(root) {
  const colors = ['#f97316', '#facc15', '#22c55e', '#38bdf8', '#a78bfa', '#f472b6'];
  const box = h('div.confetti', { 'aria-hidden': 'true' });
  for (let i = 0; i < 40; i++) {
    const p = h('i.confetto');
    p.style.setProperty('--x', (Math.random() * 100).toFixed(1) + '%');
    p.style.setProperty('--dx', ((Math.random() - 0.5) * 160).toFixed(0) + 'px');
    p.style.setProperty('--rot', (360 + Math.random() * 720).toFixed(0) + 'deg');
    p.style.setProperty('--c', colors[i % colors.length]);
    p.style.animationDelay = (Math.random() * 0.25).toFixed(2) + 's';
    p.style.animationDuration = (0.9 + Math.random() * 0.4).toFixed(2) + 's';
    box.append(p);
  }
  root.append(box);
  setTimeout(() => box.remove(), 1500);
}

/**
 * takeover({ emoji, message, action, onAction, kind, confetti, autoDismiss, force })
 * kind: 'celebrate' (default) or 'alert'. Auto-dismisses after 4 s (6 s with an action) unless
 * autoDismiss is false. Returns a dismiss function.
 */
export function takeover({ emoji = '🎉', message, action, onAction, kind = 'celebrate', confetti: withConfetti = false, autoDismiss = true, force = false } = {}) {
  if (!force && !isStorageOk()) return null;
  if (current) current.remove(true);
  clearToast();
  const prevFocus = document.activeElement;
  const msgId = 'takeover-msg-' + Math.random().toString(36).slice(2, 7);
  const openedAt = Date.now();
  let timer = null;
  let gone = false;

  const btn = action ? h('button.takeover-action.btn.primary', {
    type: 'button',
    onclick: (e) => { e.stopPropagation(); remove(); onAction?.(); },
  }, action) : null;
  const card = h('div.takeover-card', { tabindex: '-1' },
    h(`div.takeover-emoji${emoji === '🏆' ? '.shine' : ''}`, { 'aria-hidden': 'true' }, emoji),
    h('p.takeover-msg', { id: msgId }, message),
    btn);
  const root = h('div.takeover', {
    id: 'takeover', role: action || kind === 'alert' ? 'alertdialog' : 'status', 'aria-labelledby': msgId,
    'aria-live': kind === 'alert' ? 'assertive' : 'polite',
    onclick: (e) => {
      if (e.target.closest('.takeover-action')) return;
      if (Date.now() - openedAt > 250) remove(); // ignore the tail of the tap that triggered it
    },
  }, card);

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); remove(); }
    else if (e.key === 'Tab') { e.preventDefault(); (btn || card).focus(); }
  }
  function remove(immediate = false) {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    document.removeEventListener('keydown', onKey, true);
    if (current === api) current = null;
    if (prevFocus?.isConnected && prevFocus !== document.body) { try { prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ } }
    if (immediate) { root.remove(); return; }
    root.classList.add('leaving');
    setTimeout(() => root.remove(), 200);
  }
  const api = { remove };
  current = api;
  document.addEventListener('keydown', onKey, true);
  document.body.append(root);
  requestAnimationFrame(() => root.classList.add('show'));
  (btn || card).focus({ preventScroll: true });
  if (withConfetti && !reduced()) confetti(root);
  if (autoDismiss) timer = setTimeout(() => remove(), action ? 6000 : 4000);
  return () => remove();
}

export const celebrate = takeover;
