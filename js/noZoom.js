// No pinch / double-tap zoom anywhere except inside the full-screen photo viewer.
// iPhone Safari ignores the viewport's "no zoom" settings, so this is done with touch handling:
// CSS `touch-action: manipulation` (see styles.css) removes the double-tap zoom, and the guards
// below stop pinch gestures (iOS gesture events, two-finger touchmove, trackpad ctrl+wheel).
// The photo viewer (.photo-viewer) keeps normal browser zoom so photos can be inspected.

/** Elements where a quick second tap is a normal action, never a zoom. */
const INTERACTIVE = 'button, a, input, textarea, select, label, summary, [role="button"], [contenteditable], .has-menu, li, .task, .habit-row';
const inViewer = (t) => !!(t && t.closest && t.closest('.photo-viewer'));
const targetOf = (e) => (e.target && e.target.nodeType === 1 ? e.target : e.target?.parentElement);

let installed = false;
export function initNoZoom() {
  if (installed) return;
  installed = true;
  const block = (e) => { if (!inViewer(targetOf(e))) e.preventDefault(); };
  // iOS Safari pinch (non-standard gesture events).
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((n) => document.addEventListener(n, block, { passive: false }));
  // Two or more fingers moving: pinch (Android Chrome, other browsers).
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) block(e); }, { passive: false });
  // Trackpad pinch / ctrl + wheel on desktop browsers.
  document.addEventListener('wheel', (e) => { if (e.ctrlKey) block(e); }, { passive: false });
  // Safety net: if the page ever ends up zoomed in (e.g. after a pinch inside a sheet such as the photo
  // cropper), snap it back, unless the photo viewer is open (that one may zoom on purpose).
  const vv = window.visualViewport;
  if (vv) {
    let cooling = false;
    vv.addEventListener('resize', () => {
      if (cooling || vv.scale <= 1.02 || document.body.classList.contains('viewer-open') || document.querySelector('.photo-viewer')) return;
      cooling = true; resetZoom(); setTimeout(() => { cooling = false; }, 600);
    });
  }
  // Double-tap on blank, non-interactive areas. (Buttons and rows are excluded: swallowing their
  // second tap would drop a real action, and `touch-action: manipulation` already prevents the zoom there.)
  let lastEnd = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    const quick = now - lastEnd < 350;
    lastEnd = now;
    const t = targetOf(e);
    if (quick && e.touches.length === 0 && !inViewer(t) && !(t && t.closest && t.closest(INTERACTIVE))) e.preventDefault();
  }, { passive: false });
}

/** After the photo viewer closes, undo any zoom the viewer left behind (best effort; browsers differ). */
let origViewport = null;
export function resetZoom() {
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  if (origViewport === null) origViewport = meta.getAttribute('content'); // remembered once, even if called twice quickly
  const orig = origViewport;
  meta.setAttribute('content', orig + ', maximum-scale=1, minimum-scale=1');
  setTimeout(() => meta.setAttribute('content', orig), 250);
}
