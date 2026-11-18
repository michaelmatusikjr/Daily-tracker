// Small motion helpers. Nothing here delays saving: callers change the data first.

/**
 * Collapse-out for a deleted list row. Call prepareGhost(row) BEFORE the data change, then play()
 * after it (the list has re-rendered without the row): a copy of the row is put back in its place
 * and shrinks away. Does nothing when the row isn't on screen or motion is reduced.
 */
export function prepareGhost(row) {
  const none = { play() {} };
  try {
    if (!row || matchMedia('(prefers-reduced-motion: reduce)').matches) return none;
    const height = row.getBoundingClientRect().height;
    if (!height) return none;
    const sameKind = (n) => n && n.tagName === row.tagName && n.dataset.id;
    const nextId = sameKind(row.nextElementSibling) ? row.nextElementSibling.dataset.id : null;
    const prevId = sameKind(row.previousElementSibling) ? row.previousElementSibling.dataset.id : null;
    const tag = row.tagName.toLowerCase();
    const find = (id) => (id ? document.querySelector(`${tag}[data-id="${CSS.escape(id)}"]`) : null);
    const clone = row.cloneNode(true);
    clone.removeAttribute('data-id');
    clone.querySelectorAll('[data-fk]').forEach((n) => n.removeAttribute('data-fk'));
    clone.querySelectorAll('button, a, input').forEach((n) => { n.tabIndex = -1; });
    clone.classList.remove('slide-in', 'pop', 'pulse');
    clone.classList.add('ghost-out');
    clone.setAttribute('aria-hidden', 'true');
    clone.style.height = height + 'px';
    return {
      play() {
        const next = find(nextId), prev = find(prevId);
        if (next) next.before(clone); else if (prev) prev.after(clone); else return;
        requestAnimationFrame(() => requestAnimationFrame(() => clone.classList.add('collapsing')));
        setTimeout(() => clone.remove(), 320);
      },
    };
  } catch { return none; }
}
