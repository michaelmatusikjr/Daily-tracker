// v1.12.0 #4: weather line on Today (Open-Meteo forecast, geolocation / saved locations, units, cache, per-profile, v6 schema).
const { chromium } = require('playwright');
const fs = require('fs');
const APP = 'http://127.0.0.1:8080/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const NOW = new Date(2026, 10, 18, 10, 0); // Wed Nov 18 2026
const TODAY = '2026-11-18';
const DAYS = Array.from({ length: 8 }, (_, i) => `2026-11-${18 + i}`);
const CORS = { 'access-control-allow-origin': '*' };
const base = (settings = {}) => ({ version: 6, settings: { onboarded: true, theme: 'light', weekStart: 1, ...settings }, categories: [], tasks: [], habits: [], logs: {}, journal: {}, exercises: [], workouts: [] });
// Day 0: 22.2C/10.6C = 72F/51F, code 2 (partly cloudy), 20%. Day i: hi 20+i, code 61 (rain) from day 3.
const forecastJson = () => ({
  timezone: 'America/Chicago',
  daily: {
    time: DAYS,
    temperature_2m_max: DAYS.map((_, i) => (i === 0 ? 22.2 : 20 + i)),
    temperature_2m_min: DAYS.map((_, i) => (i === 0 ? 10.6 : 5 + i)),
    precipitation_probability_max: DAYS.map((_, i) => (i === 0 ? 20 : 10 * i)),
    weather_code: DAYS.map((_, i) => (i === 0 ? 2 : i >= 3 ? 61 : 0)),
  },
});
const places = [
  { name: 'Springfield', admin1: 'Illinois', country_code: 'US', latitude: 39.78173, longitude: -89.65015 },
  { name: 'Springfield', admin1: 'Missouri', country_code: 'US', latitude: 37.21533, longitude: -93.29824 },
];

/** Mocks the three weather hosts. `net` records every request URL. */
async function mock(ctx, net, { forecast = 'ok', search = places, reverse = { city: 'Springfield', locality: 'Downtown' } } = {}) {
  await ctx.route(/api\.open-meteo\.com\/v1\/forecast/, (r) => {
    net.forecast.push(r.request().url());
    if (forecast === 'fail') return r.fulfill({ status: 500, headers: CORS, body: 'oops' });
    if (forecast === 'abort') return r.abort();
    if (forecast === 'hang') return undefined;
    return r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(forecastJson()) });
  });
  await ctx.route(/geocoding-api\.open-meteo\.com\/v1\/search/, (r) => {
    net.search.push(r.request().url());
    const q = new URL(r.request().url()).searchParams.get('name');
    return r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(q === 'zzz' || q === '62704' ? { generationtime_ms: 1 } : { results: search }) });
  });
  await ctx.route(/api\.bigdatacloud\.net/, (r) => {
    net.reverse.push(r.request().url());
    if (reverse === 'fail') return r.abort();
    return r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(reverse) });
  });
}

async function open(browser, { data = base(), second = null, geo = true, forecast, reverse, search, init = null, width = 390 } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height: 844 }, serviceWorkers: 'block',
    ...(geo ? { geolocation: { latitude: 39.78123, longitude: -89.65456 }, permissions: ['geolocation'] } : {}),
  });
  const net = { forecast: [], search: [], reverse: [] };
  await mock(ctx, net, { forecast, reverse, search });
  await ctx.addInitScript(([d, q, extra]) => {
    if (localStorage.getItem('dailyTracker:profiles')) return;
    const profiles = [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }];
    if (q) { profiles.push({ id: 'q', name: 'Sam', avatar: { type: 'emoji', emoji: '', color: '#10b981' } }); localStorage.setItem('dailyTracker:data:q', q); }
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles }));
    localStorage.setItem('dailyTracker:data:p', d);
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
    if (extra) for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
  }, [JSON.stringify(data), second && JSON.stringify(second), init]);
  const p = await ctx.newPage();
  await p.clock.install({ time: NOW });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push(m.text()); });
  await p.goto(APP); await p.waitForTimeout(700);
  return { ctx, p, net };
}
const go = (p, hash) => p.evaluate((x) => { location.hash = x; }, hash).then(() => p.waitForTimeout(350));
const stored = (p, id = 'p') => p.evaluate((i) => JSON.parse(localStorage.getItem('dailyTracker:data:' + i)), id);
const line = (p) => p.locator('.weather-line').first().textContent().catch(() => null);
const next = async (p, n) => { for (let i = 0; i < n; i++) await p.click('button[aria-label="Next day"]'); await p.waitForTimeout(350); };
const prev = async (p, n) => { for (let i = 0; i < n; i++) await p.click('button[aria-label="Previous day"]'); await p.waitForTimeout(350); };
const undo = async (p) => { await p.click('#toasts .toast-action'); await p.waitForTimeout(250); };
const saved = (id, name, lat, lon) => ({ id, name, lat, lon });

(async () => {
  const browser = await chromium.launch();

  // ===== Granted geolocation: forecast for today and +3, nothing for yesterday / +8 =====
  {
    const { ctx, p, net } = await open(browser);
    let t = await line(p);
    assert(t && t.includes('Springfield') && t.includes('⛅') && t.includes('72° / 51°') && t.includes('💧 20%'), 'A1 today: pill + "⛅ 72° / 51° · 💧 20%": ' + t);
    assert(await p.locator('.weather-slot + .progress-card, .week-strip + .weather-slot').count() >= 1, 'A2 the line sits directly under the week strip');
    assert(await p.locator('.weather-line button').count() === 1 && await p.locator('.wx-text button, .wx-text a').count() === 0, 'A3 only the location pill is interactive');
    assert(net.forecast.length === 1 && /latitude=39\.78&/.test(net.forecast[0]) && /longitude=-89\.65&/.test(net.forecast[0]), 'A4 forecast request uses coordinates rounded to 2 decimals: ' + net.forecast[0]);
    assert(/timezone=auto/.test(net.forecast[0]) && /forecast_days=8/.test(net.forecast[0]) && /precipitation_probability_max/.test(net.forecast[0]) && /weather_code/.test(net.forecast[0]), 'A5 request asks for daily max/min/precip/code, timezone=auto, 8 days');
    assert(net.reverse.length === 1 && /latitude=39\.78&/.test(net.reverse[0]) && /longitude=-89\.65(&|$)/.test(net.reverse[0]) && !/39\.781/.test(net.reverse[0]), 'A6 reverse geocoding also gets rounded coordinates: ' + net.reverse[0]);
    await next(p, 3);
    t = await line(p);
    assert(t && t.includes('🌧️') && t.includes('26° / ') === false && t.includes('💧 30%'), 'A7 +3 days shows that day (rain, 30%): ' + t);
    assert(t.includes('70° / 52°') || /\d+° \/ \d+°/.test(t), 'A8 temps shown');
    await next(p, 4); // +7
    assert(!!(await line(p)), 'A9 +7 days still shows a forecast');
    await next(p, 1); // +8
    assert(await p.locator('.weather-line, .weather-slot > *').count() === 0, 'A10 +8 days: nothing (no pill either)');
    await p.click('.head-actions .chip-btn:has-text("Today")'); await p.waitForTimeout(350);
    await prev(p, 1);
    assert(await p.locator('.weather-line').count() === 0, 'A11 yesterday: nothing');
    for (const route of ['#habits', '#workouts', '#calendar', '#journal', '#settings']) { await go(p, route); assert(await p.locator('.weather-line').count() === 0, `A12 no weather line on ${route}`); }
    await go(p, '#today'); await p.click('.head-actions .chip-btn:has-text("Today")'); await p.waitForTimeout(400);
    assert(await p.locator('.weather-line').count() === 1, 'A12b back on today the line is shown');
    assert(net.forecast.length === 1, 'A13 re-rendering Today reuses the cache (no refetch within 30 min): ' + net.forecast.length);
    const cache = await p.evaluate(() => JSON.parse(localStorage.getItem('dailyTracker:weatherCache')));
    assert(cache && Object.keys(cache).join() === '39.78,-89.65' && cache['39.78,-89.65'].fetchedAt > 0 && !('weatherCache' in (await stored(p)).settings), 'A14 cache is per device in localStorage, keyed by location, not in profile data');
    // Resume after >30 min refreshes
    await p.clock.fastForward(31 * 60 * 1000);
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await p.waitForTimeout(600);
    assert(net.forecast.length === 2, 'A15 resuming after 30+ minutes refetches: ' + net.forecast.length);
    await ctx.close();
  }

  // ===== Units =====
  {
    const { ctx, p } = await open(browser);
    assert((await line(p)).includes('72° / 51°'), 'B1 default °F');
    await go(p, '#settings');
    const sect = await p.locator('.set-group:has-text("Temperature")').textContent();
    assert(/Approximate location \(about 1 km\) is sent to the weather service\./.test(sect), 'B3 privacy note next to the units option');
    await p.click('.set-group:has-text("Temperature") [role=radio]:has-text("°C")'); await p.waitForTimeout(300);
    assert((await stored(p)).settings.weather.units === 'C', 'B4 °C saved per profile');
    await go(p, '#today');
    const t = await line(p);
    assert(t.includes('22° / 11°') && !t.includes('72°'), 'B5 line shows °C: ' + t);
    await ctx.close();
  }

  // ===== Denied permission → "Add a city" → search, save, select =====
  {
    const { ctx, p, net } = await open(browser, { geo: false });
    const pillText = await p.locator('.wx-pill').textContent();
    assert(pillText.trim() === 'Add a city' && await p.locator('.wx-text').count() === 0, 'C1 denied: pill says "Add a city": ' + pillText);
    assert(net.forecast.length === 0, 'C2 no forecast request without a location');
    await p.click('.wx-pill'); await p.waitForTimeout(350);
    assert((await p.textContent('.sheet-title')) === 'Add location', 'C3 the pill opens the picker');
    await p.fill('.sheet input[type=search]', 'zzz'); await p.click('.sheet .btn.primary:has-text("Search")'); await p.waitForTimeout(500);
    const empty = await p.textContent('.wx-note');
    assert(/ZIP/.test(empty) && /city name/i.test(empty), 'C4 empty results mention ZIP codes and suggest a city name: ' + empty);
    await p.fill('.sheet input[type=search]', 'Springfield'); await p.click('.sheet .btn.primary:has-text("Search")'); await p.waitForTimeout(500);
    const rs = await p.$$eval('.wx-result', (r) => r.map((x) => x.textContent.trim()));
    assert(rs.length === 2 && rs[0].includes('Springfield') && rs[0].includes('Illinois'), 'C5 results listed: ' + rs.join(' / '));
    assert(/name=Springfield/.test(net.search.at(-1)) && /count=5/.test(net.search.at(-1)) && /language=en/.test(net.search.at(-1)), 'C6 geocoding request: ' + net.search.at(-1));
    await p.click('.wx-result >> nth=1'); await p.waitForTimeout(700);
    const w = (await stored(p)).settings.weather;
    assert(w.locations.length === 1 && w.locations[0].name === 'Springfield' && w.locations[0].lat === 37.22 && w.locations[0].lon === -93.3 && w.selected === w.locations[0].id, 'C7 tapping a result saves (rounded) and selects it: ' + JSON.stringify(w));
    assert(await p.locator('.sheet').count() === 0, 'C8 picker closes');
    assert((await line(p)).includes('Springfield') && (await line(p)).includes('72° / 51°'), 'C9 forecast for the chosen city: ' + (await line(p)));
    assert(/latitude=37\.22&longitude=-93\.3&/.test(net.forecast.at(-1)), 'C10 forecast requested for the saved location: ' + net.forecast.at(-1));
    // Menu: current + saved + add
    await p.click('.wx-pill'); await p.waitForTimeout(350);
    const items = await p.$$eval('.sheet .menu-item', (e) => e.map((x) => x.textContent.trim()));
    assert(items.join('|') === 'Current location|Springfield|Add location', 'C11 menu lists Current location, saved, Add location: ' + items.join('|'));
    assert(await p.locator('.wx-loc[aria-checked="true"]').textContent() === 'Springfield', 'C12 selected location is marked');
    // Delete + Undo
    await p.click('.sheet .wx-del'); await p.waitForTimeout(350);
    let w2 = (await stored(p)).settings.weather;
    assert(w2.locations.length === 0 && w2.selected === 'current', 'C13 delete removes it and falls back to Current location');
    assert(/Undo/.test(await p.textContent('#toasts')), 'C14 delete shows an Undo toast');
    assert((await p.locator('.wx-pill').textContent()).trim() === 'Add a city', 'C15 denied + nothing saved: back to "Add a city"');
    await undo(p);
    w2 = (await stored(p)).settings.weather;
    assert(w2.locations.length === 1 && w2.locations[0].id === w.locations[0].id && w2.selected === w.selected, 'C16 Undo restores the location and selection');
    // Add a second via the menu, select Current location
    await p.click('.wx-pill'); await p.click('.sheet .menu-item:has-text("Add location")'); await p.waitForTimeout(350);
    await p.fill('.sheet input[type=search]', 'Springfield'); await p.waitForTimeout(700);
    await p.click('.wx-result >> nth=0'); await p.waitForTimeout(500);
    assert((await stored(p)).settings.weather.locations.length === 2, 'C17 second location saved');
    await p.click('.wx-pill'); await p.click('.sheet .wx-loc >> nth=0'); await p.waitForTimeout(600);
    assert((await stored(p)).settings.weather.selected === 'current' && (await p.locator('.wx-pill').textContent()).trim() === 'Add a city', 'C18 selecting Current location (still denied) shows "Add a city"');
    await p.click('.wx-pill'); await p.click('.sheet .wx-loc >> nth=2'); await p.waitForTimeout(500);
    assert((await stored(p)).settings.weather.selected === (await stored(p)).settings.weather.locations[1].id, 'C19 selecting a saved location');
    await ctx.close();
  }

  // ===== 10-location cap, text-only rendering of names =====
  {
    const locs = Array.from({ length: 10 }, (_, i) => saved('l' + i, i === 0 ? '<img src=x onerror=window.__xss=1>' : 'City ' + i, 30 + i, -90));
    const { ctx, p } = await open(browser, { geo: false, data: base({ weather: { units: 'F', selected: 'l0', locations: locs } }) });
    assert((await p.locator('.wx-name').textContent()) === '<img src=x onerror=window.__xss=1>' && await p.locator('.weather-line img').count() === 0 && !(await p.evaluate(() => window.__xss)), 'D1 location names are text only');
    await p.click('.wx-pill'); await p.click('.sheet .menu-item:has-text("Add location")'); await p.waitForTimeout(350);
    await p.fill('.sheet input[type=search]', 'Springfield'); await p.waitForTimeout(700);
    await p.click('.wx-result >> nth=0'); await p.waitForTimeout(400);
    assert((await stored(p)).settings.weather.locations.length === 10 && /up to 10/.test(await p.textContent('#toasts')), 'D2 cannot save an 11th location');
    await ctx.close();
  }

  // ===== Per-profile isolation =====
  {
    const a = base({ weather: { units: 'F', selected: 'a1', locations: [saved('a1', 'Austin', 30.27, -97.74)] } });
    const b = base({ weather: { units: 'C', selected: 'b1', locations: [saved('b1', 'Boston', 42.36, -71.06), saved('b2', 'Berlin', 52.52, 13.4)] } });
    const { ctx, p } = await open(browser, { data: a, second: b });
    assert((await p.locator('.wx-pill').textContent()).trim() === 'Austin' && (await line(p)).includes('72° / 51°'), 'E1 profile 1 shows its own city/units');
    await p.click('.avatar-btn'); await p.waitForTimeout(300);
    await p.click('.sheet [aria-label="Switch to Sam"]'); await p.waitForTimeout(700);
    assert((await p.locator('.wx-pill').textContent()).trim() === 'Boston' && (await line(p)).includes('22° / 11°'), 'E2 profile 2 shows its own city/units: ' + (await line(p)));
    await p.click('.wx-pill'); await p.waitForTimeout(300);
    const items = await p.$$eval('.sheet .menu-item', (e) => e.map((x) => x.textContent.trim()));
    assert(items.join('|') === 'Current location|Boston|Berlin|Add location', 'E3 saved locations are per profile: ' + items.join('|'));
    await p.keyboard.press('Escape'); await p.waitForTimeout(350);
    assert((await stored(p, 'p')).settings.weather.locations.length === 1 && (await stored(p, 'q')).settings.weather.locations.length === 2, 'E4 each profile keeps its own list');
    await ctx.close();
  }

  // ===== Stale offline cache =====
  {
    const old = NOW.getTime() - 3 * 3600 * 1000;
    const cache = { '39.78,-89.65': { fetchedAt: old, tz: 'America/Chicago', days: Object.fromEntries(DAYS.map((k, i) => [k, { hi: i === 0 ? 22.2 : 20, lo: 10.6, pop: 20, code: 2 }])) } };
    const init = { 'dailyTracker:weatherCache': JSON.stringify(cache), 'dailyTracker:weatherPos': JSON.stringify({ lat: 39.78, lon: -89.65, name: 'Springfield', at: NOW.getTime() }) };
    const { ctx, p } = await open(browser, { forecast: 'abort', init });
    await p.waitForTimeout(500);
    const t = await line(p);
    assert(t && t.includes('72° / 51°') && /updated \d{1,2}(:\d{2})?/.test(t), 'F1 offline: cached forecast shown with an "updated …" note: ' + t);
    assert(await p.locator('.weather-line.stale').count() === 1, 'F2 and marked stale (dimmed)');
    assert(await p.locator('.progress-card').count() === 1, 'F3 Today still renders');
    await ctx.close();
  }
  {
    // Offline with nothing cached: just the pill, nothing else
    const { ctx, p } = await open(browser, { forecast: 'abort' });
    await p.waitForTimeout(400);
    assert(await p.locator('.wx-pill').count() === 1 && await p.locator('.wx-text').count() === 0 && await p.locator('.progress-card').count() === 1, 'F4 no cache + offline: no forecast text, Today fine');
    await ctx.close();
  }

  // ===== Failures never break Today =====
  for (const mode of ['fail', 'hang']) {
    const { ctx, p } = await open(browser, { forecast: mode });
    if (mode === 'hang') { await p.clock.runFor(9000); await p.waitForTimeout(300); }
    assert(await p.locator('.progress-card').count() === 1 && await p.locator('.wx-text').count() === 0, `G1 forecast ${mode}: Today renders, no forecast text`);
    await p.click('button[aria-label="Next day"]'); await p.waitForTimeout(300);
    assert(await p.locator('.view-today').count() === 1, `G2 forecast ${mode}: navigating still works`);
    await ctx.close();
  }
  {
    // Garbage response is ignored
    const { ctx, p } = await open(browser, { forecast: 'ok' });
    await ctx.close();
    const c2 = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', geolocation: { latitude: 1, longitude: 2 }, permissions: ['geolocation'] });
    await c2.route(/open-meteo|bigdatacloud/, (r) => r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: '{"daily":{"time":["x"],"temperature_2m_max":["hot"]}}' }));
    await c2.addInitScript((d) => { if (!localStorage.getItem('dailyTracker:profiles')) { localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles: [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }] })); localStorage.setItem('dailyTracker:data:p', d); } }, JSON.stringify(base()));
    const p2 = await c2.newPage(); p2.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    await p2.clock.install({ time: NOW }); await p2.goto(APP); await p2.waitForTimeout(600);
    assert(await p2.locator('.progress-card').count() === 1 && await p2.locator('.wx-text').count() === 0, 'G3 malformed forecast JSON is ignored');
    await c2.close();
  }

  // ===== Schema v6: migration, import, sanitising =====
  {
    const { ctx, p } = await open(browser, { geo: false });
    const res = await p.evaluate(async () => {
      const m = await import('./js/store.js');
      const out = {};
      out.version = m.SCHEMA_VERSION;
      for (const v of [1, 2, 3, 4, 5]) {
        const d = m.validateImport({ version: v, settings: { onboarded: true }, tasks: [{ id: 't', title: 'Old', date: '2026-11-10' }], habits: [], logs: {}, journal: {} });
        out['v' + v] = { weather: d.data.settings.weather, version: d.data.version, task: d.data.tasks[0].title };
      }
      const multi = m.validateImport({ app: 'daily-tracker', format: 'profiles', activeId: 'a', profiles: [{ id: 'a', name: 'A', avatar: { type: 'emoji', emoji: '', color: '#6366f1' }, data: { version: 5, settings: { onboarded: true }, tasks: [], habits: [] } }] });
      out.multi = multi.profiles[0].data.settings.weather;
      try { m.validateImport({ version: 7, settings: {}, tasks: [], habits: [] }); out.newer = 'accepted'; } catch (e) { out.newer = e.message; }
      const locs = Array.from({ length: 14 }, (_, i) => ({ id: 'x' + i, name: 'N' + i, lat: 10 + i, lon: 20 }));
      const dirty = m.validateImport({ version: 6, settings: { weather: { units: 'K', selected: 'nope', locations: [
        ...locs,
      ] } }, tasks: [], habits: [] }).data.settings.weather;
      out.dirty = { units: dirty.units, selected: dirty.selected, n: dirty.locations.length };
      const bad = m.validateImport({ version: 6, settings: { weather: { units: 'C', selected: 'ok', locations: [
        { id: 'ok', name: 'N'.repeat(500), lat: 12.3, lon: 0 }, { id: 'bad1', name: 'Far', lat: 91, lon: 0 }, { id: 'bad2', name: 'Far', lat: 0, lon: -181 },
        { id: 'bad3', name: 5, lat: 1, lon: 1 }, { id: 'bad4', name: 'Str', lat: '12', lon: 1 }, { id: 'bad5', name: '  ', lat: 1, lon: 1 }, null, 'x', { id: 'ok', name: 'Dup id', lat: 12.3456, lon: 45.6789 },
        { id: 'current', name: 'Sneaky', lat: 1, lon: 1 }, { id: 7, name: 'Numeric id', lat: 1.234, lon: 2.345 },
      ] } }, tasks: [], habits: [] }).data.settings.weather;
      out.bad = bad;
      out.garbage = ['str', 5, null, [], { locations: 'x' }].map((g) => m.validateImport({ version: 6, settings: { weather: g }, tasks: [], habits: [] }).data.settings.weather);
      return out;
    });
    const def = { units: 'F', selected: 'current', locations: [] };
    assert(res.version === 6, 'H1 SCHEMA_VERSION is 6');
    for (const v of [1, 2, 3, 4, 5]) assert(JSON.stringify(res['v' + v].weather) === JSON.stringify(def) && res['v' + v].version === 6 && res['v' + v].task === 'Old', `H2 v${v} backup imports with default weather settings`);
    assert(JSON.stringify(res.multi) === JSON.stringify(def), 'H3 multi-profile backup of v5 data gets the default');
    assert(/newer version/.test(res.newer), 'H4 newer-than-supported backups are still rejected: ' + res.newer);
    assert(res.dirty.units === 'F' && res.dirty.selected === 'current' && res.dirty.n === 10, 'H5 bad units/selected sanitised, locations capped at 10: ' + JSON.stringify(res.dirty));
    const names = res.bad.locations.map((l) => `${l.name.length > 80 ? 'long' : l.name}@${l.lat},${l.lon}`);
    assert(res.bad.units === 'C' && res.bad.locations.length === 4, 'H6 invalid entries dropped (out of range, non-strings, blank, null): ' + names.join(' ; '));
    assert(res.bad.locations[0].name.length === 80 && res.bad.selected === 'ok', 'H7 name capped at 80 chars, valid selection kept');
    assert(new Set(res.bad.locations.map((l) => l.id)).size === 4 && !res.bad.locations.some((l) => l.id === 'current' || typeof l.id !== 'string'), 'H8 ids are unique strings and never "current"');
    assert(res.bad.locations.every((l) => Math.abs(l.lat * 100 - Math.round(l.lat * 100)) < 1e-6), 'H9 coordinates stored at 2 decimals');
    assert(res.garbage.every((g) => JSON.stringify(g) === JSON.stringify(def)), 'H10 garbage weather values fall back to the default');
    await ctx.close();
  }
  {
    // A v5 profile already on the device is upgraded in place on load
    const v5 = { version: 5, settings: { onboarded: true, theme: 'light' }, categories: [], tasks: [], habits: [], logs: {}, journal: {}, exercises: [], workouts: [] };
    const { ctx, p } = await open(browser, { data: v5, geo: false });
    const s = await stored(p);
    assert(s.version === 6 && JSON.stringify(s.settings.weather) === JSON.stringify({ units: 'F', selected: 'current', locations: [] }), 'H11 stored v5 profile migrates to v6 with default weather');
    await ctx.close();
  }

  // ===== QA fixes (v1.12.0): onboarding, very old cache, pruning, hung geolocation, long ids =====
  {
    // J1: nothing is requested (and no location prompt) while the welcome screen is up; weather starts after Skip
    const { ctx, p, net } = await open(browser, { data: base({ onboarded: false }) });
    await p.waitForTimeout(500);
    assert(await p.locator('.onboarding').count() === 1 && net.forecast.length === 0 && net.reverse.length === 0, 'J1 no weather requests behind the onboarding screen');
    await p.click('.ob-skip'); await p.waitForTimeout(700);
    assert(net.forecast.length === 1 && !!(await line(p)), 'J2 weather loads once onboarding is dismissed: ' + (await line(p)));
    await ctx.close();
  }
  {
    // J3: a forecast older than 24 h is not shown at all (the pill stays)
    const old = NOW.getTime() - 26 * 3600 * 1000;
    const cache = { '39.78,-89.65': { fetchedAt: old, tz: 'America/Chicago', days: Object.fromEntries(DAYS.map((k) => [k, { hi: 22.2, lo: 10.6, pop: 20, code: 2 }])) } };
    const init = { 'dailyTracker:weatherCache': JSON.stringify(cache), 'dailyTracker:weatherPos': JSON.stringify({ lat: 39.78, lon: -89.65, name: 'Springfield', at: NOW.getTime() }) };
    const { ctx, p } = await open(browser, { forecast: 'abort', init });
    await p.waitForTimeout(500);
    const t = await line(p);
    assert(t && t.includes('Springfield') && !t.includes('72°'), 'J3 26 h old forecast hidden, pill kept: ' + t);
    await ctx.close();
  }
  {
    // J4: pruning keeps the current position and remaining profiles' saved cities only
    const data = base({ weather: { units: 'F', selected: 'current', locations: [saved('a', 'Keep', 10, 20)] } });
    const day = { fetchedAt: NOW.getTime(), tz: '', days: { [TODAY]: { hi: 1, lo: 0, pop: 0, code: 0 } } };
    const init = {
      'dailyTracker:weatherCache': JSON.stringify({ '10.00,20.00': day, '39.78,-89.65': day, '1.00,2.00': day }),
      'dailyTracker:weatherPos': JSON.stringify({ lat: 39.78, lon: -89.65, name: 'Springfield', at: NOW.getTime() }),
    };
    const { ctx, p } = await open(browser, { data, init, forecast: 'hang' });
    const keys = await p.evaluate(async () => { const m = await import('./js/weather.js'); m.pruneWeatherCache(); return Object.keys(JSON.parse(localStorage.getItem('dailyTracker:weatherCache'))).sort(); });
    assert(keys.join('|') === '10.00,20.00|39.78,-89.65', 'J4 prune drops cached places nobody uses: ' + keys.join('|'));
    await ctx.close();
  }
  {
    // J5: a geolocation prompt nobody answers gives up after ~10 s and offers "Add a city"
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const net = { forecast: [], search: [], reverse: [] };
    await mock(ctx, net, {});
    await ctx.addInitScript(([d]) => {
      Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition() { /* never answers */ } }, configurable: true });
      if (localStorage.getItem('dailyTracker:profiles')) return;
      localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles: [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }] }));
      localStorage.setItem('dailyTracker:data:p', d);
      localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
    }, [JSON.stringify(base())]);
    const p = await ctx.newPage();
    await p.clock.install({ time: NOW });
    p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    await p.goto(APP); await p.waitForTimeout(500);
    assert(/Current location/.test((await line(p)) || ''), 'J5a while waiting for an answer the pill reads "Current location"');
    await p.clock.runFor(11000); await p.waitForTimeout(300);
    assert(/Add a city/.test((await line(p)) || ''), 'J5b after the guard timeout the pill offers "Add a city": ' + (await line(p)));
    await ctx.close();
  }
  {
    // J6: an over-long saved id keeps its selection after import normalisation
    const { ctx, p } = await open(browser, { geo: false });
    const sel = await p.evaluate(async () => {
      const m = await import('./js/store.js');
      const id = 'x'.repeat(60);
      return m.normWeather({ units: 'F', selected: id, locations: [{ id, name: 'Long', lat: 1, lon: 2 }] }).selected;
    });
    assert(sel === 'x'.repeat(40), 'J6 selected follows the truncated id instead of silently falling back');
    await ctx.close();
  }

  // ===== Service worker leaves the weather APIs alone; no CSP in the way =====
  {
    const sw = fs.readFileSync(__dirname + '/../sw.js', 'utf8');
    assert(/url\.origin !== self\.location\.origin\) return;/.test(sw) && !/open-meteo|bigdatacloud/.test(sw), 'I1 service worker ignores cross-origin requests (weather responses are never cached)');
    for (const f of ['js/weather.js', 'js/weatherUi.js', 'js/journalForm.js', 'js/views/journal.js', 'js/views/habitStats.js']) assert(sw.includes(`'./${f}'`), `I2 ${f} is precached`);
    assert(!/stats\.js/.test(sw), 'I3 removed stats.js is no longer precached');
    const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
    assert(!/Content-Security-Policy/i.test(html), 'I4 no CSP that would block the three API hosts');
    const ver = /VERSION = '([^']+)'/.exec(sw)[1], appv = /APP_VERSION = '([^']+)'/.exec(fs.readFileSync(__dirname + '/../js/store.js', 'utf8'))[1];
    assert(ver === '1.12.0' && appv === '1.12.0', 'I5 versions bumped together: ' + ver + ' / ' + appv);
  }

  await browser.close();
  assert(errs.length === 0, 'no page errors: ' + errs.slice(0, 3).join(' | '));
})();
