// Keeps the text box you're typing into above the on-screen keyboard, everywhere.
// iOS (Safari and the Home Screen app) keeps the layout viewport full-height and only shrinks the *visual*
// viewport, so fixed sheets stay behind the keyboard and the focused field can end up under it.
//  1. While a field has focus and the visual viewport is much shorter than the layout one, <html> gets
//     class "kb-open" and --vv-top / --vv-h (the visible area): fixed overlays (sheets, setup screens) are
//     sized to that area in CSS, so their footers and fields sit above the keyboard.
//  2. The focused field is scrolled (inside its own scroll container: sheet body, setup panel or the page)
//     until it is fully inside the visible area with a margin, again when the keyboard finishes animating.
//  3. When the keyboard closes the page goes back to where it was if we had scrolled it.
// With no visualViewport, no keyboard (desktop) or a zoomed page this does nothing.
const FIELD = 'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]):not([type=file]):not([type=color]):not([type=hidden]), textarea, select, [contenteditable=""], [contenteditable="true"]';
const KB_MIN = 120;   // px of lost height that counts as a keyboard (browser toolbars are smaller)
const MARGIN = 16;    // px kept clear around the field
const isField = (el) => !!(el && el.nodeType === 1 && el.matches?.(FIELD));

let installed = false;
export function initKeyboard() {
  if (installed) return;
  installed = true;
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  let open = false, savedY = null, raf = 0;

  const state = () => ({ lost: window.innerHeight - vv.height, field: isField(document.activeElement) ? document.activeElement : null });
  const apply = () => {
    const { lost, field } = state();
    const on = !!field && lost > KB_MIN && vv.scale <= 1.02;
    root.style.setProperty('--vv-top', vv.offsetTop + 'px');
    root.style.setProperty('--vv-h', vv.height + 'px');
    if (on !== open) {
      open = on;
      root.classList.toggle('kb-open', on);
      if (!on && savedY !== null) { const y = savedY; savedY = null; requestAnimationFrame(() => window.scrollTo(0, y)); }
    }
    return on;
  };

  /** The nearest ancestor that scrolls vertically (null = the page). */
  const scroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body && p !== root; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 1) return p;
    }
    return null;
  };

  const reveal = (el = document.activeElement) => {
    if (!isField(el) || !document.contains(el) || !apply()) return;
    const box = scroller(el);
    const r = el.getBoundingClientRect();
    let top = vv.offsetTop, bottom = vv.offsetTop + vv.height;
    if (box) { const b = box.getBoundingClientRect(); top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom); }
    else { const head = document.querySelector('.app-head'); if (head) top = Math.max(top, head.getBoundingClientRect().bottom); }
    // Down far enough for the bottom to clear the keyboard, but never so far that the top leaves the area.
    let delta = 0;
    if (r.bottom + MARGIN > bottom) delta = r.bottom + MARGIN - bottom;
    if (r.top - delta < top + MARGIN) delta = r.top - top - MARGIN;
    if (Math.abs(delta) < 1) return;
    if (box) box.scrollTop += delta;
    else { if (savedY === null) savedY = window.scrollY; window.scrollBy(0, delta); }
  };
  const later = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => reveal()); };

  document.addEventListener('focusin', (e) => {
    if (!isField(e.target)) return;
    apply();
    // Now, and again once iOS has finished showing the keyboard and resized the visual viewport.
    later(); setTimeout(() => reveal(e.target), 120); setTimeout(() => reveal(e.target), 420);
  });
  document.addEventListener('focusout', () => setTimeout(apply, 150));
  vv.addEventListener('resize', () => { apply(); later(); });
  vv.addEventListener('scroll', () => { apply(); });
  // Typing can grow a textarea or wrap lines: keep the caret line in view.
  document.addEventListener('input', (e) => { if (open && e.target === document.activeElement) later(); });
}
