// v1.8.1: the "only while the app is open" caveat follows the closed-app push state.
const { chromium } = require('playwright');
const APP = 'http://127.0.0.1:8080/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const data = { version: 4, settings: { onboarded: true, theme: 'light', weekStart: 1, notifications: true }, tasks: [{ id: 't1', title: 'Dentist', date: today, time: '23:59', reminder: 0, recur: { type: 'none' } }],
  habits: [{ id: 'h1', name: 'Read', emoji: '📚', color: '#0ea5e9', goal: { type: 'check', target: 1 }, schedule: { type: 'daily', days: [] }, reminder: '21:00', createdAt: '2026-11-01' }], logs: {}, journal: {}, exercises: [], workouts: [] };
let healthy = true;

async function open(browser, push) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 820 }, serviceWorkers: 'block' });
  // Never touch the real server: answer health/schedule locally.
  await ctx.route(/workers\.dev/, (r) => {
    const u = new URL(r.request().url());
    const now = Date.now();
    const body = u.pathname.endsWith('/api/health')
      ? { ok: healthy, time: now, vapidPublic: true, vapidPublicKey: null, vapidPrivate: true, registerKey: true, db: true, lastCronAt: healthy ? now - 30000 : now - 3600000, lastCronError: null }
      : { ok: true };
    return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
  });
  await ctx.addInitScript(([d, push]) => {
    if (window.Notification) { Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'granted' }); }
    if (localStorage.getItem('dailyTracker:profiles')) return;
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles: [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }] }));
    localStorage.setItem('dailyTracker:data:p', d);
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
    if (push) localStorage.setItem('dailyTracker:push', JSON.stringify({ on: true, deviceId: 'd'.repeat(22), token: 't'.repeat(43), lastOk: Date.now() }));
  }, [JSON.stringify(data), push]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(APP); await p.waitForTimeout(1200);
  return { ctx, p };
}
const go = (p, hash) => p.evaluate((x) => { location.hash = x; }, hash).then(() => p.waitForTimeout(300));
const CAVEAT = /open or was recently used/;

(async () => {
  const browser = await chromium.launch();
  // ===== Push off: caveat shown =====
  {
    const { ctx, p } = await open(browser, false);
    await go(p, '#settings');
    const s = await p.textContent('.set-group:has-text("Reminders")');
    assert(CAVEAT.test(s) && !s.includes('Reminders arrive even when the app is closed.') && !s.includes('They arrive even when the app is closed.'), 'A1 push off: Settings keeps the caveat: ' + s.slice(0, 200));
    await p.evaluate(async () => { const S = await import('./js/store.js'); const F = await import('./js/forms.js'); F.openHabitForm(S.getState().habits[0]); }); await p.waitForTimeout(300);
    const hs = await p.textContent('.sheet');
    assert(CAVEAT.test(hs) && (hs.match(/open or was recently used/g) || []).length === 1, 'A2 push off: habit form shows the caveat exactly once');
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    await p.evaluate(async () => { const S = await import('./js/store.js'); const F = await import('./js/forms.js'); F.openTaskForm(S.getState().tasks[0]); }); await p.waitForTimeout(300);
    assert(CAVEAT.test(await p.textContent('.sheet .reminder-note')), 'A3 push off: task reminder note keeps the caveat');
    await ctx.close();
  }
  // ===== Push on and healthy: caveat replaced =====
  {
    healthy = true;
    const { ctx, p } = await open(browser, true);
    // (Opening waits for the service worker, which tests block: sync + health check directly.)
    await p.evaluate(async () => { const P = await import('./js/push.js'); await Promise.all([P.syncNow({ force: true }), P.checkHealth()]); });
    assert(await p.evaluate(async () => (await import('./js/push.js')).pushCoversReminders()), 'B0 push on and healthy');
    await go(p, '#settings');
    const s = await p.textContent('.set-group:has-text("Reminders")');
    assert(!CAVEAT.test(s) && !/Reminders arrive even when the app is closed\.|They arrive even when the app is closed\./.test(s), 'B1 healthy push: Settings shows no caveat and no positive message (1.9.0)');
    await p.evaluate(async () => { const S = await import('./js/store.js'); const F = await import('./js/forms.js'); F.openHabitForm(S.getState().habits[0]); }); await p.waitForTimeout(300);
    let t = await p.textContent('.sheet');
    assert(!CAVEAT.test(t) && !/Reminders arrive even when the app is closed/.test(t) && await p.locator('.sheet .reminder-note:not([hidden])').count() === 0, 'B2 healthy push: habit form shows no note at all (1.9.0)');
    // Server becomes unhealthy while the form is open → hint switches back live
    healthy = false;
    await p.evaluate(async () => (await import('./js/push.js')).checkHealth()); await p.waitForTimeout(300);
    t = await p.textContent('.sheet');
    assert(CAVEAT.test(t), 'B3 server unhealthy → the open form switches back to the caveat');
    healthy = true;
    await p.evaluate(async () => (await import('./js/push.js')).checkHealth()); await p.waitForTimeout(300);
    assert(!CAVEAT.test(await p.textContent('.sheet')), 'B4 healthy again → caveat gone again');
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    await p.evaluate(async () => { const S = await import('./js/store.js'); const F = await import('./js/forms.js'); F.openTaskForm(S.getState().tasks[0]); }); await p.waitForTimeout(300);
    const note = await p.textContent('.sheet .reminder-note');
    assert(!CAVEAT.test(note) && !/arrive even when/.test(note) && await p.locator('.sheet .reminder-note:not([hidden])').count() === 0, 'B5 healthy push: no task reminder note');
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    // Unhealthy: Settings shows the caveat again with the reason
    healthy = false;
    await p.evaluate(async () => (await import('./js/push.js')).checkHealth()); await p.waitForTimeout(300);
    await go(p, '#calendar'); await go(p, '#settings');
    const s2 = await p.textContent('.set-group:has-text("Reminders")');
    assert(CAVEAT.test(s2) && s2.includes('timer isn’t running'), 'B6 unhealthy: caveat back in Settings, with the reason');
    // Notifications denied: coverage needs permission; one note only, the blocked one
    healthy = true;
    await p.evaluate(async () => (await import('./js/push.js')).checkHealth());
    await p.evaluate(() => { Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'denied' }); });
    assert(!(await p.evaluate(async () => (await import('./js/push.js')).pushCoversReminders())), 'C1 denied permission → not covered even with a healthy server');
    await p.evaluate(async () => { const S = await import('./js/store.js'); const F = await import('./js/forms.js'); F.openHabitForm(S.getState().habits[0]); }); await p.waitForTimeout(300);
    const notes = await p.$$eval('.sheet .reminder-note:not([hidden]), .sheet .field-hint', (e) => e.map((x) => x.textContent).filter((x) => /notification|Reminder|blocked/i.test(x)));
    assert(notes.length === 1 && /blocked/i.test(notes[0]), 'C2 denied: the habit form shows exactly one note, the blocked one: ' + JSON.stringify(notes));
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    await ctx.close();
  }
  console.log(errs.join('\n') || 'no console errors');
  await browser.close();
})();
