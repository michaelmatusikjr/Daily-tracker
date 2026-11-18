// v1.12.1: Settings Defaults layout, habit reminder removed, weather ZIP + forced refresh + pull-to-refresh, 3-item weather line.
const { chromium } = require('playwright');
const APP = 'http://127.0.0.1:8080/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const NOW = new Date(2026, 10, 18, 10, 0);
const DAYS = Array.from({ length: 8 }, (_, i) => `2026-11-${18 + i}`);
const CORS = { 'access-control-allow-origin': '*' };
const habit = (id, name, o = {}) => ({ id, name, emoji: '✅', color: '#6366f1', schedule: { type: 'daily', days: [] }, goal: { type: 'check', target: 1, unit: '' }, reminder: null, target: null, archived: false, order: 1, createdAt: '2026-11-01', ...o });
const base = (o = {}) => ({ version: 6, settings: { onboarded: true, theme: 'light', weekStart: 1, notifications: true, ...(o.settings || {}) }, categories: [], tasks: [], habits: [], logs: {}, journal: {}, exercises: [], workouts: [], ...o, ...(o.settings ? { settings: { onboarded: true, theme: 'light', weekStart: 1, notifications: true, ...o.settings } } : {}) });
const forecastJson = () => ({ timezone: 'America/Chicago', daily: { time: DAYS, temperature_2m_max: DAYS.map(() => 22.2), temperature_2m_min: DAYS.map(() => 10.6), precipitation_probability_max: DAYS.map(() => 10), weather_code: DAYS.map(() => 0) } });

async function open(browser, { data = base(), geo = true, zip = 'ok', width = 390 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: 'block', hasTouch: true, ...(geo ? { geolocation: { latitude: 33.19721, longitude: -96.61543 }, permissions: ['geolocation', 'notifications'] } : {}) });
  const net = { forecast: [], zip: [], reverse: [], search: [] };
  await ctx.route(/api\.open-meteo\.com\/v1\/forecast/, (r) => { net.forecast.push(r.request().url()); r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(forecastJson()) }); });
  await ctx.route(/geocoding-api\.open-meteo\.com/, (r) => { net.search.push(r.request().url()); r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: '{}' }); });
  await ctx.route(/api\.bigdatacloud\.net/, (r) => { net.reverse.push(r.request().url()); r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ city: 'McKinney', locality: 'Downtown' }) }); });
  await ctx.route(/api\.zippopotam\.us/, (r) => {
    net.zip.push(r.request().url());
    if (r.request().url().endsWith('/75070')) return r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ 'post code': '75070', country: 'United States', places: [{ 'place name': 'McKinney', longitude: '-96.6', latitude: '33.2', state: 'Texas', 'state abbreviation': 'TX' }] }) });
    return r.fulfill({ status: 404, headers: CORS, contentType: 'application/json', body: '{}' });
  });
  await ctx.addInitScript((d) => {
    if (localStorage.getItem('dailyTracker:profiles')) return;
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles: [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }] }));
    localStorage.setItem('dailyTracker:data:p', d);
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
    window.__geo = 0;
    const g = navigator.geolocation, orig = g.getCurrentPosition.bind(g);
    g.getCurrentPosition = (ok, err, opts) => { window.__geo++; window.__geoOpts = opts; return orig(ok, err, opts); };
  }, JSON.stringify(data));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push(m.text()); });
  await p.goto(APP); await p.waitForTimeout(900);
  return { ctx, p, net };
}
const go = (p, hash) => p.evaluate((x) => { location.hash = x; }, hash).then(() => p.waitForTimeout(350));
const stored = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('dailyTracker:data:p')));
const touch = async (cdp, type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });

(async () => {
  const browser = await chromium.launch();

  // ===== 1. Settings Defaults layout =====
  {
    const { ctx, p } = await open(browser);
    await go(p, '#settings');
    const r = await p.evaluate(() => {
      const out = {};
      for (const id of ['set-anytime-reminder', 'set-habit-warn']) {
        const el = document.getElementById(id), row = el.closest('.set-row'), text = row.querySelector('.set-text');
        const a = text.getBoundingClientRect(), b = el.getBoundingClientRect(), rr = row.getBoundingClientRect();
        out[id] = { textW: a.width, textRight: a.right, ctlLeft: b.left, ctlRight: b.right, rowRight: rr.right, ctlW: b.width };
      }
      return out;
    });
    for (const [id, v] of Object.entries(r)) {
      assert(v.textW > 150, `A1 ${id}: label column ${Math.round(v.textW)}px wide (>150)`);
      assert(v.ctlLeft >= v.textRight - 0.5 && v.ctlRight <= v.rowRight + 0.5, `A2 ${id}: control sits right of the text, inside the row`);
      assert(v.ctlW <= 0.46 * (v.rowRight - 0) + 1, `A3 ${id}: control is compact (${Math.round(v.ctlW)}px)`);
    }
    await ctx.close();
  }

  // ===== 2. Habit reminder removed =====
  {
    const data = base({ habits: [habit('h1', 'Read', { reminder: '21:00', target: '22:00', warn: 30 }), habit('h2', 'Stretch', { reminder: '07:00' })] });
    const { ctx, p } = await open(browser, { data });
    await go(p, '#habits');
    await p.click('.habit-open:has-text("Read")'); await p.waitForTimeout(300);
    assert(!/Reminder at/.test(await p.textContent('.detail-hero')), 'B1 habit detail has no "Reminder at" line for legacy data');
    await go(p, '#habits');
    await p.click('button[aria-label="Add habit"], .page-head button:has-text("Add")').catch(() => {});
    await p.evaluate(async () => { const F = await import('./js/forms.js'); const S = await import('./js/store.js'); F.openHabitForm(S.getState().habits.find((x) => x.id === 'h1')); });
    await p.waitForTimeout(400);
    const labels = await p.$$eval('.sheet .field-label, .sheet .group-label, .sheet label, .sheet legend', (e) => e.map((x) => x.textContent.trim()));
    assert(labels.length > 3 && !labels.some((t) => /^Reminder$/.test(t)), 'B2 habit form has no "Reminder" field: ' + labels.join('|'));
    assert(labels.some((t) => /Warn me before/.test(t)), 'B3 habit form still has "Warn me before"');
    await p.click('.sheet button:has-text("Save")'); await p.waitForTimeout(400);
    const s = await stored(p);
    assert(s.habits.find((x) => x.id === 'h1').reminder === null && s.habits.find((x) => x.id === 'h2').reminder === '07:00', 'B4 saving clears the old reminder on the edited habit only');
    const info = await p.evaluate(async () => {
      const N = await import('./js/notify.js'); const P = await import('./js/push.js');
      const occ = N.reminderOccurrences(new Date(2026, 10, 17, 0, 0).getTime(), new Date(2026, 10, 19, 23, 0).getTime()).map((o) => o.key);
      const rules = P.buildRules({ today: '2026-11-18' }).rules;
      return { occ, rules: rules.map((r) => r.id) };
    });
    assert(!info.occ.some((k) => /:h:h2:/.test(k)) && !info.occ.some((k) => /:h:h1:/.test(k)), 'B5 no local time-of-day habit timers: ' + info.occ.length);
    assert(!info.rules.some((id) => /:h:h[12]$/.test(id)), 'B6 no push rule for habit reminders');
    await ctx.close();
  }
  {
    // Warning still produces a rule/timer.
    const data = base({ settings: { habitWarnDefault: 0 }, habits: [habit('h1', 'Read', { reminder: '21:00', target: '22:00', warn: 30 })] });
    const { ctx, p } = await open(browser, { data });
    const info = await p.evaluate(async () => {
      const N = await import('./js/notify.js'); const P = await import('./js/push.js');
      return { occ: N.reminderOccurrences(new Date(2026, 10, 18, 0, 0).getTime(), new Date(2026, 10, 19, 23, 0).getTime()).map((o) => o.key), rules: P.buildRules({ today: '2026-11-18' }).rules.map((r) => r.id) };
    });
    assert(info.occ.some((k) => /:hw:h1:/.test(k)) && !info.occ.some((k) => /:h:h1:/.test(k)), 'B7 warning timer exists, reminder timer does not: ' + info.occ.join(','));
    assert(info.rules.some((id) => /:hw:h1$/.test(id)) && !info.rules.some((id) => /:h:h1$/.test(id)), 'B8 warning push rule exists, reminder rule does not: ' + info.rules.join(','));
    await ctx.close();
  }

  // ===== 3a. ZIP search =====
  {
    const { ctx, p, net } = await open(browser);
    await p.evaluate(async () => { const W = await import('./js/weatherUi.js'); W.openAddLocation(); });
    await p.waitForTimeout(300);
    assert(await p.getAttribute('.sheet input', 'placeholder') === 'City or ZIP code', 'C1 placeholder');
    await p.fill('.sheet input', '75070'); await p.press('.sheet input', 'Enter'); await p.waitForTimeout(600);
    const t = await p.textContent('.wx-results');
    assert(net.zip.length === 1 && net.zip[0].endsWith('/us/75070') && net.search.length === 0, 'C2 ZIP uses zippopotam only');
    assert(t.includes('McKinney') && t.includes('TX, US 75070'), 'C3 result shows McKinney: ' + t);
    await p.fill('.sheet input', '00000'); await p.press('.sheet input', 'Enter'); await p.waitForTimeout(600);
    assert(await p.textContent('.wx-note') === 'No matches. Check the spelling or ZIP code.' && net.search.length === 0, 'C4 404 → no-match note, no throw/fallback');
    await ctx.close();
  }

  // ===== 3b. Forced refresh, 3-decimal name lookup =====
  {
    const { ctx, p, net } = await open(browser);
    const f0 = net.forecast.length, g0 = await p.evaluate(() => window.__geo), r0 = net.reverse.length;
    assert(f0 >= 1 && g0 >= 1 && r0 >= 1, `D0 startup fetched (forecast ${f0}, geo ${g0}, reverse ${r0})`);
    assert(/latitude=33\.197&longitude=-96\.615/.test(net.reverse[0]), 'D1 reverse geocode uses 3 decimals: ' + net.reverse[0]);
    assert(/latitude=33\.2&longitude=-96\.62/.test(net.forecast[0]), 'D2 forecast keeps 2 decimals: ' + net.forecast[0]);
    await p.evaluate(async () => { const W = await import('./js/weather.js'); const S = await import('./js/store.js'); await Promise.all([W.refreshWeather(S.getState().settings.weather), W.refreshWeather(S.getState().settings.weather)]); });
    const opts = await p.evaluate(() => window.__geoOpts);
    assert(await p.evaluate(() => window.__geo) === g0 + 1, 'D3 forced refresh re-reads the position once (no stacking)');
    assert(opts && opts.maximumAge === 0 && opts.enableHighAccuracy === true, 'D4 fresh high-accuracy position: ' + JSON.stringify(opts));
    assert(net.forecast.length === f0 + 1, 'D5 forced refresh refetches despite fresh cache');
    assert(net.reverse.length === r0, 'D6 same 3-decimal key → name not looked up again');
    assert(/McKinney/.test(await p.textContent('.wx-pill')), 'D7 pill shows city');
    await ctx.close();
  }

  // ===== 3c. Pull to refresh + 4. weather line =====
  {
    const { ctx, p, net } = await open(browser);
    await p.waitForTimeout(500);
    const cdp = await ctx.newCDPSession(p);
    const f0 = net.forecast.length;
    await touch(cdp, 'touchStart', 200, 200); await touch(cdp, 'touchMove', 205, 230); await touch(cdp, 'touchMove', 205, 300);
    await p.waitForTimeout(100);
    assert(await p.locator('.ptr.show').count() === 1, 'E1 indicator shows while pulling');
    await touch(cdp, 'touchEnd', 205, 300); await p.waitForTimeout(1200);
    assert(net.forecast.length === f0 + 1, 'E2 pull-to-refresh refetched the forecast');
    assert(await p.locator('.ptr.show').count() === 0, 'E3 indicator hidden after refresh');
    const f1 = net.forecast.length;
    await touch(cdp, 'touchStart', 200, 200); await touch(cdp, 'touchMove', 205, 240); await touch(cdp, 'touchEnd', 205, 240); await p.waitForTimeout(600);
    assert(net.forecast.length === f1, 'E4 short pull does not refresh');
    await touch(cdp, 'touchStart', 300, 300); await touch(cdp, 'touchMove', 200, 330); await touch(cdp, 'touchMove', 100, 400); await touch(cdp, 'touchEnd', 100, 400); await p.waitForTimeout(600);
    assert(net.forecast.length === f1, 'E5 mostly-horizontal drag does not refresh');
    // weather line
    const b = await p.evaluate(() => { const r = (s) => document.querySelector(s)?.getBoundingClientRect(); const L = r('.weather-line'); const P = r('.wx-pill'), T = r('.wx-temps'), O = r('.wx-pop'); return { L, P, T, O, txt: document.querySelector('.wx-temps')?.textContent, pop: document.querySelector('.wx-pop')?.textContent }; });
    assert(b.P && b.T && b.O && b.P.right <= b.T.left && b.T.right <= b.O.left, 'F1 pill | temps | pop in order, no overlap');
    const cx = (r) => (r.left + r.right) / 2;
    assert(Math.abs(cx(b.T) - cx(b.L)) < 2, 'F2a temps centred on the line');
    assert(Math.abs(cx(b.P) - (b.L.left + b.T.left) / 2) < 12 && Math.abs(cx(b.O) - (b.T.right + b.L.right) / 2) < 12, 'F2b pill centred left of temps, pop centred right of temps');
    assert(/72° \/ 51°/.test(b.txt) && /10%/.test(b.pop) && b.P.height < 40, `F3 contents: ${b.txt} / ${b.pop}`);
    assert(!/null|undefined/.test(await p.textContent('.weather-slot')), 'F5 no stray null/undefined text in the slot');
    const mid = (b.T.left + b.T.right) / 2, lmid = (b.L.left + b.L.right) / 2;
    assert(Math.abs(mid - lmid) < 60, 'F4 temps roughly centred');
    await p.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/today.png' : '/tmp/t33-today.png' });
    await ctx.close();
  }

  assert(errs.length === 0, 'no page errors: ' + errs.join(' | '));
  await browser.close();
})();
