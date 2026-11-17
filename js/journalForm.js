// Journal entry sheet (mood + note for one day) and the shared read-only entry body.
import { h, openSheet } from './ui.js';
import { getState } from './store.js';
import { MOODS } from './logic.js';
import { fmtDateLong } from './dates.js';
import { saveJournal, deleteJournal } from './actions.js';

/** Add or edit the journal entry for day k (an existing entry is edited). Saving an empty entry removes it. */
export function openJournalForm(k) {
  const existing = getState().journal[k] || null;
  let mood = existing?.mood || null;
  const buttons = MOODS.map((m) => h('button.mood', {
    type: 'button', role: 'radio', 'aria-checked': String(mood === m.v), 'aria-label': m.label, title: m.label,
    onclick: () => { mood = mood === m.v ? null : m.v; buttons.forEach((b, i) => b.setAttribute('aria-checked', String(mood === MOODS[i].v))); },
  }, h('span.mood-e', m.e), h('span.mood-l', m.label)));
  const note = h('textarea.input.journal-note', { rows: 5, maxlength: 1000, placeholder: 'A few words about the day…', 'aria-label': 'Journal note', autofocus: true }, existing?.note || '');
  const save = () => { sheet.close(); saveJournal(k, { mood, note: note.value }); };
  const sheet = openSheet({
    title: `Journal · ${fmtDateLong(k)}`, cls: 'journal-sheet',
    content: h('form.form', { onsubmit: (e) => { e.preventDefault(); save(); } },
      h('div.moods', { role: 'radiogroup', 'aria-label': 'Mood' }, buttons), note),
    footer: [
      existing ? h('button.btn.danger-ghost', { type: 'button', onclick: () => { sheet.close(); deleteJournal(k); } }, 'Delete') : h('button.btn.ghost', { type: 'button', onclick: () => sheet.close() }, 'Cancel'),
      h('button.btn.primary', { type: 'button', onclick: save }, 'Save'),
    ],
  });
  return sheet;
}

/** Mood emoji + note for an entry (text nodes only). */
export function entryBody(entry) {
  const m = MOODS.find((x) => x.v === entry.mood);
  return [
    h('span.journal-mood', { 'aria-hidden': m ? 'true' : null, title: m ? m.label : null }, m ? m.e : '📓'),
    h('span.journal-text',
      m ? h('span.sr-only', `Feeling ${m.label.toLowerCase()}. `) : null,
      entry.note ? h('span.journal-note-text', entry.note) : h('span.journal-note-text.muted', m ? `Feeling ${m.label.toLowerCase()}` : '')),
  ];
}
