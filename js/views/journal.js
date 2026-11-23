// Journal tab: every entry, newest first, searchable by note text. Tap an entry to edit it; long-press for Edit / Delete.
import { h, emptyState } from '../ui.js';
import { appHeader } from '../header.js';
import { getState } from '../store.js';
import { ctx } from '../ctx.js';
import { todayKey, fmt } from '../dates.js';
import { attachMenu, journalMenu } from '../itemMenu.js';
import { openJournalForm, entryBody } from '../journalForm.js';

const fold = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** "Fri, Nov 14" (plus the year for other years). */
function dateLabel(k) {
  const sameYear = k.slice(0, 4) === todayKey().slice(0, 4);
  return fmt(k, { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** [{ k, mood, note }] newest first, optionally only entries whose note contains q. */
export function journalEntries(state, q = '') {
  const needle = fold(q.trim());
  return Object.entries(state.journal)
    .filter(([, e]) => !needle || fold(e.note).includes(needle))
    .map(([k, e]) => ({ k, ...e }))
    .sort((a, b) => (a.k < b.k ? 1 : -1));
}

export function renderJournal() {
  const st = getState();
  const total = Object.keys(st.journal).length;
  const root = h('div.view.view-journal');
  if (!total) {
    root.append(appHeader({ title: 'Journal' }));
    root.append(h('section.card', emptyState('📓', 'No journal entries yet', 'Tap + and choose Journal to write about your day.')));
    return root;
  }
  const results = h('ul.journal-list', { 'aria-label': 'Journal entries' });
  const countEl = h('p.completed-count', { role: 'status', 'aria-live': 'polite' });
  const empty = h('p.hint-line', 'No entries match your search.');
  let timer;
  const draw = () => {
    const list = journalEntries(getState(), ctx.ui.journalQuery);
    countEl.textContent = ctx.ui.journalQuery.trim() ? `${list.length} match${list.length === 1 ? '' : 'es'}` : '';
    empty.hidden = list.length > 0;
    results.replaceChildren(...list.map((e) => {
      const btn = h('button.journal-open', { type: 'button', onclick: () => openJournalForm(e.k), 'aria-label': `${dateLabel(e.k)}. Open to edit` },
        h('span.journal-date', dateLabel(e.k)), h('span.journal-row', ...entryBody(e)));
      const li = h('li.journal-item', { dataset: { date: e.k } }, btn);
      attachMenu(li, () => journalMenu(e.k), btn);
      return li;
    }));
  };
  const search = h('input.input.completed-search.journal-search', {
    type: 'search', value: ctx.ui.journalQuery, placeholder: 'Search your notes', 'aria-label': 'Search journal notes', 'data-fk': 'journal-search', autocomplete: 'off',
    oninput: (e) => { clearTimeout(timer); timer = setTimeout(() => { ctx.ui.journalQuery = e.target.value; draw(); }, 200); },
  });
  root.append(appHeader({ title: 'Journal', below: [search] }), h('div.completed-tools', countEl), results, empty);
  draw();
  return root;
}
