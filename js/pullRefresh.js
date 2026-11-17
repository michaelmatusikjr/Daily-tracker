// Pull-to-refresh for the Today view (iOS Home Screen apps have none). Passive touch listeners only,
// so scrolling and horizontal swipes are untouched. Shows a small indicator while pulling/refreshing.
const THRESHOLD = 70;
const MAX_MS = 8000;

export function initPullRefresh({ isActive, onRefresh }) {
  let sx = 0, sy = 0, pulling = false, busy = false, ind = null;
  const reset = () => { pulling = false; };
  const indicator = () => {
    if (ind) return ind;
    ind = document.createElement('div');
    ind.className = 'ptr';
    ind.setAttribute('aria-hidden', 'true');
    ind.textContent = '↓';
    document.body.append(ind);
    return ind;
  };
  const hide = () => { if (ind) { ind.classList.remove('ready', 'busy'); ind.style.removeProperty('--pull'); ind.classList.remove('show'); } };
  document.addEventListener('touchstart', (e) => {
    pulling = false;
    if (busy || e.touches.length !== 1 || !isActive() || document.body.classList.contains('sheet-open')) return;
    if (e.target.closest && e.target.closest('input, textarea, select, .drag-handle')) return;
    if ((window.scrollY || 0) > 0) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; pulling = true;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    if (e.touches.length !== 1 || (window.scrollY || 0) > 0) { reset(); hide(); return; }
    const dy = e.touches[0].clientY - sy, dx = e.touches[0].clientX - sx;
    if (dy <= 8 || Math.abs(dx) > dy) { if (ind) hide(); return; }
    const el = indicator();
    el.style.setProperty('--pull', String(Math.min(1, dy / THRESHOLD)));
    el.classList.add('show');
    el.classList.toggle('ready', dy > THRESHOLD);
  }, { passive: true });
  const end = (e) => {
    if (!pulling) return;
    pulling = false;
    const t = e.changedTouches && e.changedTouches[0];
    const dy = t ? t.clientY - sy : 0, dx = t ? t.clientX - sx : 0;
    if (e.type !== 'touchend' || dy <= THRESHOLD || Math.abs(dx) > dy || document.body.classList.contains('sheet-open') || !isActive()) { hide(); return; }
    busy = true;
    const el = indicator();
    el.classList.add('show', 'busy');
    let done = false;
    const finish = () => { if (done) return; done = true; busy = false; hide(); };
    setTimeout(finish, MAX_MS);
    Promise.resolve().then(onRefresh).catch(() => {}).then(finish);
  };
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', end, { passive: true });
}
