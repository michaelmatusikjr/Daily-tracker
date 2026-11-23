// v1.14: #27 notification title = profile · timing, body = name – detail (local + push rules);
// #28 opening a task/habit from a notification shows big Complete / Missed (or a banner with Undo).
const { chromium } = require('playwright');
const URL = 'http://127.0.0.1:8080/';
const SHOTS = process.env.SHOTS || '';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const NOW = new Date(2026, 10, 18, 10, 0); // Wed Nov 18 2026, 10:00 local
const TODAY = '2026-11-18';
const task = (id, title, o = {}) => ({ id, title, notes: '', date: TODAY, time: null, duration: null, priority: 0, category: null, reminder: null, reminderAt: null, recur: { type: 'none', days: [], interval: 2 }, done: false, doneDates: {}, exceptions: [], order: Number(id.replace(/\D/g, '')) || 1, createdAt: NOW.getTime(), ...o });
const habit = (id, name, o = {}) => ({ id, name, emoji: '💧', color: '#0ea5e9', goal: { type: 'check', target: 1, unit: '' }, schedule: { type: 'daily', days: [] }, reminder: null, target: null, archived: false, order: 1, createdAt: '2026-01-01', ...o });
const base = (o = {}) => ({ version: 6, settings: { onboarded: true, theme: 'light', accent: 'indigo', weekStart: 1, timeFormat: '12', notifications: true }, categories: [], tasks: [], habits: [], logs: {}, journal: {}, exercises: [], workouts: [], ...o });

async function open(browser, { data = base(), second = null, hash = '', scheme = 'light' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', colorScheme: scheme, deviceScaleFactor: 1 });
  await ctx.addInitScript(([d, q]) => {
    window.__n = [];
    window.Notification = class { constructor(t, o) { window.__n.push({ title: t, body: o?.body }); } static get permission() { return 'granted'; } static requestPermission() { return Promise.resolve('granted'); } };
    if (localStorage.getItem('dailyTracker:profiles')) return;
    const profiles = [{ id: 'p', name: 'Mick', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }];
    if (q) { profiles.push({ id: 'q', name: 'Sam', avatar: { type: 'emoji', emoji: '', color: '#10b981' } }); localStorage.setItem('dailyTracker:data:q', q); }
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles }));
    localStorage.setItem('dailyTracker:data:p', d);
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
  }, [JSON.stringify(data), second && JSON.stringify(second)]);
  const p = await ctx.newPage();
  await p.clock.install({ time: NOW });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push(m.text()); });
  await p.goto(URL + hash); await p.waitForTimeout(600);
  return { ctx, p };
}
const stored = (p, id = 'p') => p.evaluate((i) => JSON.parse(localStorage.getItem('dailyTracker:data:' + i)), id);
const idx = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('dailyTracker:profiles')));
const go = (p, hash) => p.evaluate((x) => { location.hash = x; }, hash).then(() => p.waitForTimeout(800));
const rules = (p, hideText = false) => p.evaluate(async (hideText) => (await import('./js/push.js')).buildRules({ hideText, today: '2026-11-18' }).rules, hideText);
const occ = (p) => p.evaluate(async () => (await import('./js/notify.js')).reminderOccurrences(new Date(2026, 10, 18, 0, 0).getTime(), new Date(2026, 10, 18, 23, 59).getTime()).map((o) => ({ key: o.key.split(':').slice(1).join(':'), title: o.title, body: o.body })));

(async () => {
  const browser = await chromium.launch();

  // ===== #27 wording, single profile (no profile prefix) =====
  const tasks = [
    task('t1', 'Dentist', { time: '18:00', reminder: 0 }),
    task('t2', 'Call mom', { time: '14:30', reminder: 15 }),
    task('t3', 'Report', { time: '09:00', reminder: 90 }),
    task('t4', 'Water plants', { reminderAt: '16:00' }),
  ];
  const habits = [habit('h1', 'Read Bible', { target: '12:00', warn: 30 })];
  {
    const { ctx, p } = await open(browser, { data: base({ tasks, habits }) });
    const R = Object.fromEntries((await rules(p)).map((r) => [r.id.split(':').slice(1).join(':'), r]));
    const t = (id) => [R[id].title, R[id].body];
    assert(JSON.stringify(t('t:t1')) === '["Now","Dentist – 6:00 PM"]', 'W1 task at its time: ' + t('t:t1'));
    assert(JSON.stringify(t('t:t2')) === '["in 15 min","Call mom – 2:30 PM"]', 'W2 task with lead: ' + t('t:t2'));
    assert(JSON.stringify(t('t:t3')) === '["in 1 hr 30 min","Report – 9:00 AM"]', 'W3 long lead: ' + t('t:t3'));
    assert(JSON.stringify(t('t:t4')) === '["Today","Water plants – due today"]', 'W4 anytime task: ' + t('t:t4'));
    assert(JSON.stringify(t('hw:h1')) === '["30 min left","Read Bible – complete by 12:00 PM"]', 'W5 habit warning: ' + t('hw:h1'));
    const o = Object.fromEntries((await occ(p)).map((x) => [x.key, x]));
    assert(o['t:t1:2026-11-18'].title === 'Now' && o['t:t1:2026-11-18'].body === 'Dentist – 6:00 PM' && o['t:t2:2026-11-18'].title === 'in 15 min' && o['t:t4:2026-11-18'].title === 'Today' && o['hw:h1:2026-11-18'].title === '30 min left' && o['hw:h1:2026-11-18'].body === 'Read Bible – complete by 12:00 PM', 'W6 local occurrences use the same wording');
    const hr = await rules(p, true);
    assert(hr.length === 5 && hr.every((r) => r.title === 'Daily Tracker' && r.body === 'You have a reminder – tap to open' && !/Dentist|Bible|Mick/.test(JSON.stringify(r))), 'W7 hide text: generic title/body, no names');
    // a local notification actually fires with the new text (push off → local timers)
    await p.clock.runFor(2 * 3600000 + 5000); await p.waitForTimeout(300);
    const n = await p.evaluate(() => window.__n);
    assert(n.some((x) => x.title === 'in 15 min') === false && n.some((x) => x.title === '30 min left' && x.body === 'Read Bible – complete by 12:00 PM'), 'W8 local notification shown with title/body: ' + JSON.stringify(n));
    await ctx.close();
  }
  // 24-hour setting, two profiles (prefix)
  {
    const me = base({ settings: { onboarded: true, theme: 'light', weekStart: 1, timeFormat: '24', notifications: true }, tasks: [task('t1', 'Dentist', { time: '18:00', reminder: 0 })], habits });
    const sam = base({ tasks: [task('s1', 'Sam task', { time: '09:00', reminder: 30 })] });
    const { ctx, p } = await open(browser, { data: me, second: sam });
    const r = await rules(p);
    const by = (s) => r.find((x) => x.id.endsWith(s));
    assert(by(':t:t1').title === 'Mick · Now' && by(':t:t1').body === 'Dentist – 18:00', 'W9 multi-profile prefix + 24h clock: ' + by(':t:t1').title + ' / ' + by(':t:t1').body);
    assert(by(':hw:h1').title === 'Mick · 30 min left' && by(':hw:h1').body === 'Read Bible – complete by 12:00', 'W10 habit 24h: ' + by(':hw:h1').body);
    assert(by(':t:s1').title === 'Sam · in 30 min' && by(':t:s1').body === 'Sam task – 9:00 AM', 'W11 other profile: ' + by(':t:s1').title);
    const hr = await rules(p, true);
    assert(hr.every((x) => x.title === 'Daily Tracker' && !/Mick|Sam/.test(JSON.stringify(x))), 'W12 hide text hides profile names too');
    await ctx.close();
  }

  // ===== #28 opened from a notification =====
  const sheet = '.task-view-sheet';
  {
    const data = base({
      tasks: [task('t1', 'Dentist', { time: '10:30', reminder: 0, notes: 'Bring forms' }), task('t2', 'Done already', { done: true, completedAt: new Date(2026, 10, 18, 9, 5).getTime() }), task('t3', 'Skipped one'),
        task('t4', 'Daily stretch', { recur: { type: 'daily', days: [], interval: 2 }, date: '2026-11-10' })],
      habits: [habit('h1', 'Read Bible', { target: '12:00', warn: 30 }), habit('h2', 'Water', { goal: { type: 'count', target: 8, unit: 'glasses' } }), habit('h3', 'Floss')],
      logs: { h2: { [TODAY]: 3 } },
    });
    data.tasks[2].missedDates = { [TODAY]: true };
    const sam = base({ settings: { onboarded: true, theme: 'dark', weekStart: 1, timeFormat: '12', notifications: true }, tasks: [task('s1', 'Sam’s dentist')] });
    const { ctx, p } = await open(browser, { data, second: sam });
    const q = (s) => p.locator(`${sheet} ${s}`);

    // Normal open (tap on the row): unchanged, no quick actions
    await p.locator('.task[data-id="t1"] .task-main').first().click(); await p.waitForTimeout(500);
    assert(await q('.task-view').count() === 1 && await q('.tv-quick').count() === 0 && await q('.tv-banner').count() === 0 && await q('.tv-done').count() === 1, 'N1 normal open unchanged: no Complete/Missed block');
    await p.keyboard.press('Escape'); await p.waitForTimeout(400);

    // From a notification
    await go(p, '#open/task/p/t1/2026-11-18');
    assert(await q('.tv-quick .tv-complete').count() === 1 && await q('.tv-quick .tv-missed').count() === 1, 'N2 notification open shows Complete + Missed');
    const first = await q('.task-view > *').first().evaluate((e) => e.className);
    assert(first.includes('tv-quick'), 'N3 they are the first thing in the sheet');
    const bb = await q('.tv-complete').boundingBox();
    assert(bb.height >= 56 && bb.width >= 150, `N4 large tap targets (${Math.round(bb.width)}x${Math.round(bb.height)})`);
    await q('.tv-complete').click(); await p.waitForTimeout(400);
    const banner = (await q('.tv-banner').textContent()).replace(/\s+/g, ' ').trim();
    assert(/^Completed at \d{1,2}:\d{2} (AM|PM)/.test(banner) && await q('.tv-quick').count() === 0, 'N5 Complete → banner with time: ' + banner);
    const st = await stored(p);
    assert(st.tasks[0].done === true && st.tasks[0].completedAt > 0, 'N6 task is done with completedAt stored');
    await q('.tv-undo').click(); await p.waitForTimeout(400);
    assert((await stored(p)).tasks[0].done === false && await q('.tv-quick .tv-complete').count() === 1, 'N7 Undo restores (buttons back)');
    await q('.tv-missed').click(); await p.waitForTimeout(400);
    assert((await q('.tv-banner').textContent()).includes('Marked missed') && (await stored(p)).tasks[0].missedDates?.[TODAY], 'N8 Missed → "Marked missed" banner');
    await q('.tv-undo').click(); await p.waitForTimeout(400);
    assert(!(await stored(p)).tasks[0].missedDates && await q('.tv-quick').count() === 1, 'N9 Undo missed');
    await p.keyboard.press('Escape'); await p.waitForTimeout(400);

    // Already completed (with a stored time) / without a time / already missed
    await go(p, '#open/task/p/t2/2026-11-18');
    assert((await q('.tv-banner').textContent()).includes('Completed at 9:05 AM') && await q('.tv-quick').count() === 0, 'N10 already done shows "Completed at 9:05 AM" banner');
    await p.keyboard.press('Escape'); await p.waitForTimeout(400);
    await p.evaluate(async () => { const S = await import('./js/store.js'); S.update((s) => { delete s.tasks.find((x) => x.id === 't2').completedAt; }); });
    await go(p, '#open/task/p/t2/2026-11-18');
    assert((await q('.tv-banner-text').textContent()) === 'Completed', 'N11 no stored time → "Completed"');
    await p.keyboard.press('Escape'); await p.waitForTimeout(400);
    await go(p, '#open/task/p/t3/2026-11-18');
    assert((await q('.tv-banner-text').textContent()) === 'Marked missed' && await q('.tv-undo').count() === 1, 'N12 already missed shows "Marked missed" + Undo');
    await q('.tv-undo').click(); await p.waitForTimeout(300);
    assert(await q('.tv-quick').count() === 1, 'N13 Undo → Complete/Missed offered');
    await p.keyboard.press('Escape'); await p.waitForTimeout(400);

    // Recurring: per-date completion + doneAt
    await go(p, '#open/task/p/t4/2026-11-18');
    await q('.tv-complete').click(); await p.waitForTimeout(300);
    const t4 = (await stored(p)).tasks.find((x) => x.id === 't4');
    assert(t4.doneDates[TODAY] && t4.doneAt[TODAY] > 0 && !t4.doneDates['2026-11-17'], 'N14 recurring: only that date completed, doneAt stored');
    assert((await q('.tv-banner-text').textContent()).startsWith('Completed at'), 'N15 recurring banner');
    await p.keyboard.press('Escape'); await p.waitForTimeout(400);

    // Habits
    await go(p, '#open/habit/p/h1/2026-11-18');
    assert(await q('.tv-quick .tv-complete').count() === 1 && (await p.locator(`${sheet} .sheet-title`).textContent()).includes('Read Bible'), 'H1 habit notification open: Complete/Missed first');
    await q('.tv-complete').click(); await p.waitForTimeout(400);
    assert(/^Completed at \d{1,2}:\d{2} (AM|PM)/.test(await q('.tv-banner-text').textContent()) && (await stored(p)).logs.h1[TODAY] === 1 && (await stored(p)).habits[0].doneAt[TODAY] > 0, 'H2 habit Complete → logged + banner with time');
    await q('.tv-undo').click(); await p.waitForTimeout(400);
    const s2 = await stored(p);
    assert(!s2.logs.h1?.[TODAY] && !s2.habits[0].doneAt && await q('.tv-quick').count() === 1, 'H3 Undo clears the log and doneAt');
    await q('.tv-missed').click(); await p.waitForTimeout(400);
    assert((await q('.tv-banner-text').textContent()) === 'Marked missed' && (await stored(p)).habits[0].missed[TODAY], 'H4 habit Missed');
    await q('.tv-undo').click(); await p.waitForTimeout(300);
    await p.keyboard.press('Escape'); await p.waitForTimeout(400);
    // count habit: Complete logs up to the target; Undo restores the earlier count (3)
    await go(p, '#open/habit/p/h2/2026-11-18');
    await q('.tv-complete').click(); await p.waitForTimeout(400);
    assert((await stored(p)).logs.h2[TODAY] === 8, 'H5 count habit: Complete logs the full target');
    await q('.tv-undo').click(); await p.waitForTimeout(400);
    assert((await stored(p)).logs.h2[TODAY] === 3, 'H6 Undo restores the previous count');
    await p.keyboard.press('Escape'); await p.waitForTimeout(400);
    // a habit done before (no stored time): banner without a time
    await p.evaluate(async () => { const S = await import('./js/store.js'); S.update((s) => { s.logs.h3 = { '2026-11-18': 1 }; }); });
    await go(p, '#open/habit/p/h3/2026-11-18');
    assert((await q('.tv-banner-text').textContent()) === 'Completed', 'H7 legacy done habit → "Completed"');
    await p.keyboard.press('Escape'); await p.waitForTimeout(400);

    // Another profile's notification still switches profile (and opens its sheet with actions)
    await go(p, '#open/task/q/s1/2026-11-18');
    assert((await idx(p)).activeId === 'q' && (await p.locator(`${sheet} .sheet-title`).textContent()) === 'Sam’s dentist' && await q('.tv-quick').count() === 1, 'P1 other profile: switches and shows Complete/Missed');
    await q('.tv-complete').click(); await p.waitForTimeout(300);
    assert((await stored(p, 'q')).tasks[0].done === true && !(await stored(p, 'p')).tasks.find((x) => x.id === 't1').done, 'P2 completes in that profile only');
    await p.keyboard.press('Escape'); await p.waitForTimeout(400);
    await ctx.close();
  }
  // normalize keeps valid habit doneAt, drops junk
  {
    const { ctx, p } = await open(browser, { data: base({ habits: [habit('h1', 'X', { doneAt: { '2026-11-18': 1700000000000, bad: 5, '2026-11-19': -1 } })] }) });
    const hb = (await p.evaluate(async () => (await import('./js/store.js')).getState())).habits[0];
    assert(JSON.stringify(hb.doneAt) === '{"2026-11-18":1700000000000}', 'D1 habit doneAt validated by normalize: ' + JSON.stringify(hb.doneAt));
    await ctx.close();
  }
  // screenshots (SHOTS=/dir): task + habit sheets, light and dark
  if (SHOTS) {
    for (const scheme of ['light', 'dark']) {
      const d = base({ settings: { onboarded: true, theme: scheme, weekStart: 1, timeFormat: '12', notifications: true }, tasks: [task('t1', 'Dentist', { time: '10:30', reminder: 0, notes: 'Bring forms', duration: 45 })], habits: [habit('h1', 'Read Bible', { target: '12:00', warn: 30 })] });
      const { ctx, p } = await open(browser, { data: d, scheme, hash: '#open/task/p/t1/2026-11-18' });
      await p.waitForTimeout(500);
      await p.screenshot({ path: `${SHOTS}/task-${scheme}.png` });
      await p.locator(`${sheet} .tv-complete`).click(); await p.waitForTimeout(400);
      await p.screenshot({ path: `${SHOTS}/task-done-${scheme}.png` });
      await p.keyboard.press('Escape'); await p.waitForTimeout(400);
      await go(p, '#open/habit/p/h1/2026-11-18');
      await p.screenshot({ path: `${SHOTS}/habit-${scheme}.png` });
      await ctx.close();
    }
  }
  await browser.close();
  assert(errs.length === 0, 'no console errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
})();
