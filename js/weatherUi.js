// The weather line under Today's week strip and its location pill (the only interactive part).
// All text from outside (city names) goes in as text nodes.
import { h, openSheet, closeAllSheets, iconBtn, toast } from './ui.js';
import { icon } from './icons.js';
import { getState } from './store.js';
import { ctx } from './ctx.js';
import { fmtTime } from './dates.js';
import { weatherFor, ensureFresh, onWeatherChange, searchPlaces, resetRetries } from './weather.js';
import { selectWeatherLocation, addWeatherLocation, deleteWeatherLocation } from './actions.js';

/** An empty container Today always renders; fillWeather() puts the line in it (or leaves it empty). */
export function weatherSlot(dateKey) {
  const slot = h('div.weather-slot', { dataset: { date: dateKey } });
  fillWeather(slot);
  return slot;
}

function fillWeather(slot) {
  const st = getState();
  const w = st.settings.weather;
  const k = slot.dataset.date;
  const info = weatherFor(w, k);
  if (!info) { slot.replaceChildren(); return; }
  ensureFresh(w); // async; fires the listener (below) when something new arrived
  const f = info.forecast;
  const pill = h('button.wx-pill', {
    type: 'button', 'aria-haspopup': 'dialog', 'aria-label': info.needCity ? 'Add a city for the weather' : `Weather location: ${info.pill}. Change`,
    // "Add a city" goes straight to the picker, unless saved cities exist (then the menu lets you pick one or add).
    onclick: () => (info.needCity && !w.locations.length ? openAddLocation() : openLocationMenu()),
  }, icon('pin', { size: 14 }), h('span.wx-name', info.pill), icon('chevronsUpDown', { size: 14, cls: 'wx-chev' }));
  const kids = [pill];
  if (f) {
    const upd = info.stale && info.updatedAt ? ` · updated ${fmtTime(new Date(info.updatedAt).toTimeString().slice(0, 5), st.settings.timeFormat)}` : '';
    const pop = f.pop === null ? '' : ` · 💧 ${f.pop}%`;
    kids.push(h('span.wx-text', { title: f.label }, `${f.emoji} ${f.hi}° / ${f.lo}°${pop}`, upd ? h('span.wx-stale', upd) : null));
  }
  slot.replaceChildren(h(`div.weather-line${info.stale ? '.stale' : ''}`, ...kids));
}

// Late results update only the weather line (no full re-render), and only if Today is still showing that date.
onWeatherChange(() => {
  const slot = document.querySelector('.weather-slot');
  if (slot && slot.dataset.date === ctx.ui.date) fillWeather(slot);
});

// ---------- location menu ----------
function openLocationMenu() {
  const w = getState().settings.weather;
  const choose = (id) => { closeAllSheets(); resetRetries(); selectWeatherLocation(id); };
  const row = (label, id, sub = null, deletable = false) => {
    const on = w.selected === id;
    return h('div.wx-loc-row',
      h('button.menu-item.wx-loc', { type: 'button', role: 'menuitemradio', 'aria-checked': String(on), onclick: () => choose(id) },
        icon('pin', { size: 20 }), h('span', label, sub ? h('small', sub) : null), on ? icon('check', { size: 18, cls: 'wx-check' }) : null),
      deletable ? iconBtn('trash', `Remove ${label}`, () => { closeAllSheets(); deleteWeatherLocation(id); }, 'wx-del') : null);
  };
  const list = h('div.menu-list', { role: 'menu', 'aria-label': 'Weather location' },
    row('Current location', 'current'),
    ...w.locations.map((l) => row(l.name, l.id, null, true)),
    h('button.menu-item', { type: 'button', role: 'menuitem', onclick: () => { closeAllSheets(); openAddLocation(); } },
      icon('plus', { size: 20 }), h('span', 'Add location')));
  openSheet({ title: 'Weather location', content: list, cls: 'action-menu' });
}

// ---------- add location ----------
export function openAddLocation() {
  const input = h('input.input', { type: 'search', placeholder: 'City name (or ZIP)', 'aria-label': 'Search for a city', autofocus: true, autocomplete: 'off', maxlength: 80, enterkeyhint: 'search' });
  const results = h('ul.wx-results', { 'aria-live': 'polite' });
  const note = h('p.hint-line.wx-note');
  let seq = 0, timer;
  const say = (t) => { note.textContent = t; };
  async function search() {
    const q = input.value.trim();
    const mine = ++seq;
    results.replaceChildren();
    if (q.length < 2) { say(''); return; }
    say('Searching…');
    try {
      const found = await searchPlaces(q);
      if (mine !== seq) return;
      if (!found.length) { say('No matches. Try a city name, since ZIP codes may not be found.'); return; }
      say('');
      results.replaceChildren(...found.map((p) => h('li', h('button.menu-item.wx-result', { type: 'button', onclick: () => pick(p) },
        icon('pin', { size: 20 }), h('span', p.name, p.detail ? h('small', p.detail) : null)))));
    } catch {
      if (mine === seq) say('Couldn’t search right now. Check your connection and try again.');
    }
  }
  function pick(p) {
    if (!addWeatherLocation(p)) { toast('You can save up to 10 locations. Remove one first.', { force: true }); return; }
    resetRetries();
    sheet.close();
  }
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 350); });
  const sheet = openSheet({
    title: 'Add location', cls: 'dialog',
    content: h('form.form', { onsubmit: (e) => { e.preventDefault(); clearTimeout(timer); search(); }, novalidate: true },
      h('div.field', h('label.field-label', 'Search'), input), note, results),
    footer: [h('button.btn.ghost', { type: 'button', onclick: () => sheet.close() }, 'Cancel'), h('button.btn.primary', { type: 'button', onclick: () => { clearTimeout(timer); search(); } }, 'Search')],
  });
  return sheet;
}
