// "Completed" history (#completed): every completed task occurrence, searchable and filterable.
import { h, iconBtn, openSheet, segmented } from '../ui.js';
import { icon } from '../icons.js';
import { getState, getActiveProfile } from '../store.js';
import { ctx } from '../ctx.js';
import { isRecurring, PRIORITIES } from '../logic.js';
import { todayKey, toKey, addDays, startOfWeek, fromKey, relativeLabel, fmtDateLong, fmtDateShort } from '../dates.js';
import { openTaskView } from '../taskView.js';

const PAGE = 150;
const RANGES = [['week', 'This week'], ['month', 'This month'], ['30', 'Last 30 days'], ['year', 'This year'], ['all', 'All'], ['custom', 'Custom']];
const fold = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Filters live for this session only, per profile. */
function filters() {
  const pid = getActiveProfile()?.id || '';
  ctx.ui.completed = ctx.ui.completed || {};
  if (!ctx.ui.completed[pid]) ctx.ui.completed[pid] = { q: '', cats: [], range: 'all', from: '', to: '', prios: [], type: 'all', photos: false, shown: PAGE };
  return ctx.ui.completed[pid];
}
const activeCount = (f) => (f.cats.length ? 1 : 0) + (f.range !== 'all' ? 1 : 0) + (f.prios.length ? 1 : 0) + (f.type !== 'all' ? 1 : 0) + (f.photos ? 1 : 0);

/** One entry per completed occurrence: { t, k (occurrence date), day (completion date), at }. */
export function completedEntries(state) {
  const out = [];
  const noon = (k) => fromKey(k).getTime();
  for (const t of state.tasks) {
    if (!isRecurring(t)) {
      if (!t.done) continue;
      const at = t.completedAt || noon(t.date);
      out.push({ t, k: t.date, day: t.completedAt ? toKey(new Date(at)) : t.date, at });
    } else {
      for (const k of Object.keys(t.doneDates || {})) {
        if (!t.doneDates[k]) continue;
        const ts = t.doneAt?.[k];
        out.push({ t, k, day: ts ? toKey(new Date(ts)) : k, at: ts || noon(k) });
      }
    }
  }
  return out.sort((a, b) => b.at - a.at || (a.t.title < b.t.title ? -1 : 1));
}

function rangeBounds(f, today, weekStart) {
  switch (f.range) {
    case 'week': return [startOfWeek(today, weekStart), today];
    case 'month': return [today.slice(0, 8) + '01', today];
    case '30': return [addDays(today, -29), today];
    case 'year': return [today.slice(0, 5) + '01-01', today];
    case 'custom': return [f.from || '0000-01-01', f.to || '9999-12-31'];
    default: return null;
  }
}

export function filterEntries(entries, f, state, today = todayKey()) {
  const q = fold(f.q.trim());
  const bounds = rangeBounds(f, today, state.settings.weekStart);
  const cats = new Set(f.cats), prios = new Set(f.prios);
  const known = new Set((state.categories || []).map((c) => c.id)); // a deleted category counts as "No category"
  return entries.filter(({ t, day }) => {
    if (bounds && (day < bounds[0] || day > bounds[1])) return false;
    if (cats.size && !cats.has(t.category && known.has(t.category) ? t.category : '__none')) return false;
    if (prios.size && !prios.has(t.priority || 0)) return false;
    if (f.type === 'one' && isRecurring(t)) return false;
    if (f.type === 'repeat' && !isRecurring(t)) return false;
    if (f.photos && !t.attachments?.length) return false;
    if (q && !fold(`${t.title}\n${t.notes || ''}`).includes(q)) return false;
    return true;
  });
}

// ---------- Filter sheets ----------
function checkList(options, selected, onChange, label) {
  const set = new Set(selected);
  return h('div.check-list', { role: 'group', 'aria-label': label }, options.map(([value, text, color]) => h('label.check-row',
    h('input', { type: 'checkbox', checked: set.has(value), onchange: (e) => { if (e.target.checked) set.add(value); else set.delete(value); onChange([...set]); } }),
    color ? h('span.cat-dot', { style: { background: color } }) : null, h('span', text))));
}
function filterSheet(title, content) {
  const sheet = openSheet({ title, content, footer: [h('span'), h('button.btn.primary', { type: 'button', onclick: () => sheet.close() }, 'Done')] });
  return sheet;
}

export function renderCompleted() {
  const st = getState();
  const f = filters();
  const today = todayKey();
  const root = h('div.view.view-completed');
  root.append(h('header.page-head.detail-head',
    iconBtn('arrowLeft', 'Back', () => (history.length > 1 ? history.back() : ctx.go('today'))),
    h('div.page-head-text', h('p.eyebrow', 'History'), h('h1.page-title', 'Completed'))));

  const all = completedEntries(st);
  const results = h('div.completed-results');
  const countEl = h('p.completed-count', { role: 'status', 'aria-live': 'polite' });
  const rerun = () => { f.shown = PAGE; draw(); };
  // Search (debounced; redraws only the results, so typing keeps focus)
  let timer;
  const search = h('input.input.completed-search', {
    type: 'search', value: f.q, placeholder: 'Search title and notes', 'aria-label': 'Search completed tasks', 'data-fk': 'completed-search', autocomplete: 'off',
    oninput: (e) => { clearTimeout(timer); timer = setTimeout(() => { f.q = e.target.value; rerun(); }, 200); },
  });
  const cats = st.categories || [];
  const chip = (label, on, onclick, extra = '') => h(`button.chip.filter-chip${extra}`, { type: 'button', 'aria-pressed': String(!!on), onclick }, label);
  const rerender = () => ctx.rerender();
  const chips = h('div.completed-filters', { role: 'group', 'aria-label': 'Filters' },
    chip(f.cats.length ? `Category · ${f.cats.length}` : 'Category', f.cats.length, () => filterSheet('Category', checkList(
      [...cats.map((c) => [c.id, c.name, c.color]), ['__none', 'No category', null]], f.cats, (v) => { f.cats = v; rerender(); }, 'Categories'))),
    chip(f.range === 'all' ? 'Date' : RANGES.find((r) => r[0] === f.range)[1], f.range !== 'all', () => {
      const from = h('input.input', { type: 'date', value: f.from, 'aria-label': 'From', onchange: (e) => { f.from = e.target.value; f.range = 'custom'; rerender(); } });
      const to = h('input.input', { type: 'date', value: f.to, 'aria-label': 'To', onchange: (e) => { f.to = e.target.value; f.range = 'custom'; rerender(); } });
      filterSheet('Date', h('div.form', h('div.range-list', { role: 'radiogroup', 'aria-label': 'Date range' }, RANGES.map(([v, l]) => h('label.check-row',
        h('input', { type: 'radio', name: 'c-range', checked: f.range === v, onchange: () => { f.range = v; rerender(); } }), h('span', l)))),
        h('div.grid-2', h('div.field', h('label.field-label', 'From'), from), h('div.field', h('label.field-label', 'To'), to))));
    }),
    chip(f.prios.length ? `Priority · ${f.prios.length}` : 'Priority', f.prios.length, () => filterSheet('Priority', checkList(
      PRIORITIES.map((p, i) => [i, i ? p.label : 'No priority', i ? p.color : null]), f.prios, (v) => { f.prios = v; rerender(); }, 'Priorities'))),
    chip(f.type === 'one' ? 'One-off' : f.type === 'repeat' ? 'Repeating' : 'Type', f.type !== 'all', () => filterSheet('Type',
      segmented([{ value: 'all', label: 'All' }, { value: 'one', label: 'One-off' }, { value: 'repeat', label: 'Repeating' }], f.type, (v) => { f.type = v; rerender(); }, { label: 'Task type' }))),
    chip('📎 Has photos', f.photos, () => { f.photos = !f.photos; rerender(); }));
  const n = activeCount(f);
  root.append(h('div.completed-tools', search, chips,
    n ? h('div.completed-active', h('span.muted.small', `${n} filter${n === 1 ? '' : 's'} on`),
      h('button.link-btn', { type: 'button', onclick: () => { Object.assign(f, { cats: [], range: 'all', from: '', to: '', prios: [], type: 'all', photos: false, q: f.q }); rerender(); } }, 'Clear filters')) : null),
    countEl, results);

  function draw() {
    const list = filterEntries(all, f, st, today);
    countEl.textContent = `${list.length} completed`;
    if (!all.length) { results.replaceChildren(h('div.card', h('p.empty-title', 'Nothing completed yet'), h('p.muted', 'Tasks you check off show up here.'))); return; }
    if (!list.length) { results.replaceChildren(h('p.hint-line', 'No completed tasks match. Try another search or clear the filters.')); return; }
    const shown = list.slice(0, f.shown);
    const groups = [];
    for (const e of shown) {
      if (!groups.length || groups[groups.length - 1].day !== e.day) groups.push({ day: e.day, items: [] });
      groups[groups.length - 1].items.push(e);
    }
    const catOf = (id) => cats.find((c) => c.id === id);
    results.replaceChildren(...groups.map((g) => h('section.completed-day',
      h('h2.completed-day-head', `${relativeLabel(g.day, today)}${['Today', 'Yesterday', 'Tomorrow'].includes(relativeLabel(g.day, today)) ? ` · ${fmtDateLong(g.day)}` : ''}`),
      h('ul.completed-list', { 'aria-label': `Completed ${fmtDateLong(g.day)}` }, g.items.map(({ t, k }) => {
        const c = catOf(t.category);
        const meta = [];
        if (isRecurring(t)) meta.push(h('span.meta', icon('repeat', { size: 13 }), k !== g.day ? fmtDateShort(k) : 'Repeats'));
        else if (t.date !== g.day) meta.push(h('span.meta', icon('calendar', { size: 13 }), `Due ${fmtDateShort(t.date)}`));
        if (c) meta.push(h('span.cat', { style: { '--c': c.color } }, c.name));
        if (t.priority) meta.push(h('span.meta', { style: { color: PRIORITIES[t.priority].color } }, icon('flag', { size: 13 }), PRIORITIES[t.priority].label));
        if (t.attachments?.length) meta.push(h('span.meta.clip', '📎', String(t.attachments.length)));
        return h('li', { dataset: { key: `${t.id}|${k}` } }, h('button.completed-row', { type: 'button', onclick: () => openTaskView(t.id, k), 'aria-label': `${t.title}, completed. Open` },
          h('span.completed-check', { 'aria-hidden': 'true' }, icon('check', { size: 14 })),
          h('span.completed-text', h('span.completed-title', t.title), meta.length ? h('span.task-meta', meta) : null)));
      })))));
    if (list.length > shown.length) {
      const more = h('button.btn.secondary.block.completed-more', { type: 'button', onclick: () => { f.shown += PAGE; draw(); } }, `Show more (${list.length - shown.length} left)`);
      results.append(more);
      // Load the next page automatically when the button scrolls into view.
      if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { io.disconnect(); f.shown += PAGE; draw(); } }, { rootMargin: '400px' });
        io.observe(more);
      }
    }
  }
  draw();
  return root;
}
