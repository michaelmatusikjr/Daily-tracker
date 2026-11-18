// v1.13.4: no weather "updated" note / no pull-to-refresh; takeovers without Undo; "by" above the time; task check on the right like habits.
const { chromium, devices } = require('playwright');
const fs = require('fs');
const APP = 'http://127.0.0.1:8080/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const pad = (n) => String(n).padStart(2, '0');
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const TODAY = key(new Date());
const task = (id, title, o = {}) => ({ id, title, notes: '', date: TODAY, time: null, duration: null, priority: 0, category: null, reminder: null, reminderAt: null, recur: { type: 'none', days: [], interval: 2 }, done: false, doneDates: {}, exceptions: [], createdAt: 1, order: 1, ...o });
const habit = (id, name, o = {}) => ({ id, name, emoji: '📚', color: '#22c55e', schedule: { type: 'daily', days: [] }, goal: { type: 'check', target: 1, unit: '' }, reminder: null, target: null, createdAt: 1, order: 1, archived: false, ...o });
const base = (o = {}) => ({ version: 6, settings: { onboarded: true, theme: 'light', weekStart: 1 }, categories: [{ id: 'c1', name: 'Home', color: '#0ea5e9' }], tasks: [], habits: [], logs: {}, journal: {}, exercises: [], workouts: [], ...o });
const WO = { exercises: [{ id: 'sq', name: 'Squat', type: 'strength' }], workouts: [] };

async function open(browser, data, { init = null, clock = null } = {}) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  for (const re of [/open-meteo\.com/, /nominatim/, /bigdatacloud/, /zippopotam/]) await ctx.route(re, (r) => r.abort());
  await ctx.addInitScript(([d, extra]) => {
    if (localStorage.getItem('dailyTracker:profiles')) return;
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles: [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }] }));
    localStorage.setItem('dailyTracker:data:p', d);
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
    if (extra) for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
  }, [JSON.stringify(data), init]);
  const p = await ctx.newPage();
  if (clock) await p.clock.install({ time: clock });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push(m.text()); });
  await p.goto(APP); await p.waitForTimeout(700);
  return { ctx, p };
}
const stored = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('dailyTracker:data:p')));
const box = (p, sel) => p.locator(sel).first().boundingBox();

(async () => {
  const browser = await chromium.launch();

  // ===== 1. weather: no "updated" note, no pull-to-refresh =====
  {
    const NOW = new Date(2026, 10, 18, 10, 0);
    const days = Array.from({ length: 8 }, (_, i) => `2026-11-${18 + i}`);
    const cache = { '39.78,-89.65': { fetchedAt: NOW.getTime() - 3 * 3600 * 1000, tz: 'America/Chicago', days: Object.fromEntries(days.map((k) => [k, { hi: 22.2, lo: 10.6, pop: 20, code: 2 }])) } };
    const init = { 'dailyTracker:weatherCache': JSON.stringify(cache), 'dailyTracker:weatherPos': JSON.stringify({ lat: 39.78, lon: -89.65, name: 'Springfield', at: NOW.getTime() }) };
    const { ctx, p } = await open(browser, base(), { init, clock: NOW });
    await p.waitForTimeout(2500);
    const t = await p.locator('.weather-slot').innerText();
    assert(t.includes('72° / 51°'), 'A1 old cached forecast still shown: ' + t.replace(/\n/g, ' '));
    assert(await p.locator('.wx-stale-note').count() === 0 && !/updated/i.test(t), 'A2 no "updated …" note');
    assert(await p.locator('.weather-line.stale').count() === 1, 'A3 stale dimming kept');
    const cdp = await ctx.newCDPSession(p);
    const tt = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    await tt('touchStart', 200, 200); await tt('touchMove', 205, 230); await tt('touchMove', 205, 320); await p.waitForTimeout(100);
    assert(await p.locator('.ptr').count() === 0, 'A4 no pull-to-refresh indicator');
    await tt('touchEnd', 205, 320);
    assert(!fs.existsSync(__dirname + '/../js/pullRefresh.js'), 'A5 js/pullRefresh.js is gone');
    assert(!/pullRefresh/.test(fs.readFileSync(__dirname + '/../sw.js', 'utf8')) && !/pullRefresh/.test(fs.readFileSync(__dirname + '/../js/app.js', 'utf8')), 'A6 not in sw.js precache or app.js');
    await ctx.close();
  }

  // ===== 2. takeovers: no buttons, tap dismisses =====
  {
    const { ctx, p } = await open(browser, base({ tasks: [task('a', 'Alpha')] }));
    await p.click('.task[data-id="a"] .check'); await p.waitForTimeout(900);
    const tk = p.locator('.takeover');
    assert(await tk.count() === 1 && /Everything done/.test(await tk.innerText()), 'B1 all-done takeover shows');
    assert(await tk.locator('button').count() === 0 && !/Undo/.test(await tk.innerText()), 'B2 all-done takeover has no button / Undo');
    await p.mouse.click(10, 300); await p.waitForTimeout(450);
    assert(await tk.count() === 0, 'B3 tap dismisses it');
    assert((await stored(p)).tasks[0].done === true, 'B4 task stays done');
    await ctx.close();
  }
  {
    const { ctx, p } = await open(browser, base(WO));
    await p.evaluate(async () => { const m = await import('/js/actions.js'); m.saveWorkout({ exerciseId: 'sq', date: (await import('/js/dates.js')).todayKey(), lines: [{ weight: 225, sets: 3, reps: 5 }], weightUnit: 'lb', time: null, distance: null, distanceUnit: 'mi', note: '' }); });
    await p.waitForTimeout(700);
    const tk = p.locator('.takeover');
    assert(await tk.count() === 1 && (await tk.locator('.takeover-emoji').innerText()) === '🏆', 'C1 PR takeover shows');
    assert(await tk.locator('button').count() === 0 && !/Undo/.test(await tk.innerText()), 'C2 PR takeover has no button / Undo');
    await p.mouse.click(10, 300); await p.waitForTimeout(450);
    assert(await tk.count() === 0, 'C3 tap dismisses it');
    assert((await stored(p)).workouts.length === 1, 'C4 workout stays saved');
    await ctx.close();
  }

  // ===== 3 + 4. Today rows =====
  {
    const data = base({
      tasks: [
        task('t1', 'Call mom', { time: '09:00' }),
        task('t2', 'Alpha', { order: 1 }),
        task('t3', 'Beta done', { order: 2, done: true, doneDates: { [TODAY]: true } }),
        task('t4', 'Gamma flagged', { order: 3, priority: 3, category: 'c1', reminderAt: Date.now() + 3600000 }),
      ],
      habits: [habit('h1', 'Read', { target: '12:00' }), habit('h2', 'Stretch', { order: 2 })],
    });
    const { ctx, p } = await open(browser, data);
    const by = await box(p, '.habit-row.timed .task-time small'), tm = await box(p, '.habit-row.timed .task-time > span');
    assert(by && tm && by.y + by.height <= tm.y + 1, `D1 "by" is above the time (by.y=${Math.round(by.y)}, time.y=${Math.round(tm.y)})`);
    assert(Math.abs(by.x - tm.x) < 2, 'D2 "by" aligned with the time');
    assert((await p.locator('.task.timed .task-time').innerText()).trim().startsWith('9:00') || /9:00/.test(await p.locator('.task.timed .task-time').innerText()), 'D3 timed task rail unchanged');
    const hb = await box(p, '.habit-row .habit-check');
    const vw = 390;
    for (const id of ['t1', 't2', 't3', 't4']) {
      const cb = await box(p, `.task[data-id="${id}"] .check`), main = await box(p, `.task[data-id="${id}"] .task-main`), row = await box(p, `.task[data-id="${id}"]`);
      assert(cb.x > main.x + main.width - 2, `E1 ${id} check is right of the task body`);
      assert(Math.abs(cb.width - hb.width) <= 1 && Math.abs(cb.height - hb.height) <= 1, `E2 ${id} check size ${cb.width}x${cb.height} matches habit ${hb.width}x${hb.height}`);
      assert(cb.x + cb.width <= row.x + row.width + 0.5 && cb.x > vw / 2, `E3 ${id} check inside the row on the right`);
    }
    assert(await p.locator('.task[data-id="t2"] .check').evaluate((e) => e.classList.contains('habit-check') && getComputedStyle(e).borderRadius.startsWith('50%') || parseFloat(getComputedStyle(e).borderRadius) >= 20), 'E4 task check uses the habit-check style (round)');
    const hbDone = await p.locator('.task[data-id="t3"] .check').evaluate((e) => getComputedStyle(e).backgroundColor);
    assert(hbDone !== 'rgba(0, 0, 0, 0)' && await p.locator('.task[data-id="t3"] .task-title').evaluate((e) => getComputedStyle(e).textDecorationLine === 'line-through'), 'E5 done task: filled check and strike-through title');
    const flag = await box(p, '.task[data-id="t4"] .prio-flag'), ck = await box(p, '.task[data-id="t4"] .check');
    assert(flag && flag.x + flag.width <= ck.x && await p.locator('.task[data-id="t4"] .cat').count() === 1 && await p.locator('.task[data-id="t4"] .task-meta svg').count() >= 1, 'E6 flag, category chip and bell visible; flag clear of the check');
    // drag handle in Anytime: right of the check
    const dh = await box(p, '.tasks:not(.compact) .task[data-id="t2"] .drag-handle'), c2 = await box(p, '.task[data-id="t2"] .check');
    assert(dh && dh.x >= c2.x + c2.width - 1, 'E7 drag handle is to the right of the check, not overlapping');
    // aligned with habit check in the same list
    const hc2 = await box(p, '.habit-row[data-id="h2"] .habit-check');
    assert(Math.abs(hc2.x - c2.x) <= 1, `E8 task and habit checks align (${Math.round(c2.x)} vs ${Math.round(hc2.x)})`);
    // toggling
    await p.click('.task[data-id="t2"] .check'); await p.waitForTimeout(300);
    assert((await stored(p)).tasks.find((t) => t.id === 't2').done === true && await p.locator('.task[data-id="t2"].done').count() === 1, 'F1 tapping the check completes the task');
    assert(await p.locator('.task[data-id="t2"] .check').getAttribute('aria-pressed') === 'true' && /not done/.test(await p.locator('.task[data-id="t2"] .check').getAttribute('aria-label')), 'F2 aria-label/pressed updated');
    await p.click('.task[data-id="t2"] .check'); await p.waitForTimeout(300);
    assert((await stored(p)).tasks.find((t) => t.id === 't2').done === false, 'F3 tapping again un-completes');
    await p.click('.task[data-id="t2"] .task-main'); await p.waitForTimeout(400);
    assert(await p.locator('.sheet').count() >= 1, 'F4 tapping the body opens the task');
    await p.keyboard.press('Escape'); await p.waitForTimeout(400);
    // FAB doesn't cover the last row's check once scrolled to the bottom
    await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await p.waitForTimeout(300);
    const fab = await box(p, '.fab'), last = await p.locator('.task .check, .habit-check').last().boundingBox();
    assert(last.y + last.height <= fab.y + 1 || last.x + last.width <= fab.x || last.x >= fab.x + fab.width, 'G1 FAB does not cover the last check at the bottom of the page');
    await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(200);
    if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/v1134-today.png` });
    await ctx.close();
  }

  console.log(errs.length ? 'ERRORS: ' + errs.join(' | ') : 'ok: no page errors');
  if (errs.length) process.exitCode = 1;
  await browser.close();
})();
