const { chromium } = require('./testprep');
const SP = __dirname;
const URL = 'http://127.0.0.1:8080/';
const KEY = 'dailyTracker:data';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };

async function swipe(p, sel, dx) {
  await p.evaluate(({ sel, dx }) => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + Math.min(20, r.height / 2);
    const mk = (cx) => new Touch({ identifier: 1, target: el, clientX: cx, clientY: y });
    el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [mk(x)], changedTouches: [mk(x)] }));
    el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [mk(x + dx)] }));
  }, { sel, dx });
  await p.waitForTimeout(250);
}

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 320, height: 700 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, acceptDownloads: true });
  const p = await ctx.newPage(); await p.clock.install({ time: new Date(2026, 10, 10, 15, 0) }); // tests assume "today" is Tue 2026-11-10
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  const seed = (data) => p.evaluate(([k, d]) => { const idx = JSON.parse(localStorage.getItem('dailyTracker:profiles') || 'null'); localStorage.setItem(idx ? 'dailyTracker:data:' + idx.activeId : k, typeof d === 'string' ? d : JSON.stringify(d)); }, [KEY, data]);
  const stored = () => p.evaluate((k) => localStorage.getItem(localStorage.getItem('dailyTracker:profiles') ? 'dailyTracker:data:' + JSON.parse(localStorage.getItem('dailyTracker:profiles')).activeId : k), KEY);

  // 1. corrupted data is preserved
  await p.goto(URL);
  await seed('{"version":1, "tasks": [ broken');
  await p.reload(); await p.waitForTimeout(500);
  assert(await p.locator('.load-fail').count() === 1, '1 warning card shown');
  assert(await p.evaluate(() => Object.keys(localStorage).some((k) => k.includes(':backup-'))), '1 backup key written');
  await p.keyboard.press('Escape'); await p.waitForTimeout(300); // dismiss the unreadable-data takeover
  await p.click('.fab'); await p.fill('.qa-input', 'Should not save'); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
  assert((await stored()) === '{"version":1, "tasks": [ broken', '1 raw data not overwritten');
  await p.screenshot({ path: SP + '/q-loadfail.png' });
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('text=Export raw data')]);
  assert(!!dl, '1 export raw works');
  await p.click('.load-fail .danger-ghost'); await p.waitForTimeout(300);
  await p.click('.sheet .btn.danger'); await p.waitForTimeout(400);
  assert(await p.locator('.load-fail').count() === 0 && (await stored()).startsWith('{'), '1 reset resumes saving');

  // 3. week start for perWeek habits
  const r3 = await p.evaluate(async () => {
    const L = await import('./js/logic.js');
    const h = { id: 'h', schedule: { type: 'perWeek', times: 2 }, goal: { type: 'check' }, createdAt: '2026-11-01' };
    const mk = (ws) => ({ settings: { weekStart: ws }, logs: { h: { '2026-11-08': 1, '2026-11-09': 1 } } });
    return [L.weekCount(mk(0), h, '2026-11-10'), L.weekCount(mk(1), h, '2026-11-10')];
  });
  assert(r3[0] === 2 && r3[1] === 1, '3 weekCount respects week start ' + JSON.stringify(r3));

  // seed realistic data
  await seed({ version: 1, settings: { onboarded: true, weekStart: 1 }, tasks: [
    { id: 'r1', title: 'Daily standup', date: '2026-11-01', time: '09:00', duration: 15, recur: { type: 'weekly', days: [1, 2, 3, 4, 5] }, doneDates: { '2026-11-11': true }, category: 'work' },
    { id: 't1', title: 'Pick up the very long named dry-cleaning order', date: '2026-11-10', category: 'xlong' },
  ], categories: [{ id: 'work', name: 'Work', color: '#3b82f6' }, { id: 'xlong', name: 'Extremely long category name here', color: '#f59e0b' }],
  habits: [
    { id: 'w', name: 'Water', emoji: '💧', color: '#0ea5e9', goal: { type: 'count', target: 3, unit: 'glasses of sparkling mineral water' }, schedule: { type: 'daily' }, createdAt: '2026-11-01' },
    { id: 'p', name: 'Gym', emoji: '🏃', color: '#ef4444', goal: { type: 'check' }, schedule: { type: 'perWeek', times: 3 }, createdAt: '2026-11-10' },
  ], logs: { w: { '2026-11-10': 1 } }, journal: {} });
  await p.reload(); await p.waitForTimeout(500);

  // 4. swipes
  const title0 = await p.locator('.page-title').textContent();
  await swipe(p, '.week-strip', -120);
  assert((await p.locator('.page-title').textContent()).includes('17'), '4 week strip swipe → next week');
  await swipe(p, '.view-today', 120);
  assert((await p.locator('.page-title').textContent()).includes('16'), '4 day swipe on page');
  // 19. leave and return via Today tab resets the date
  await p.click('a[data-tab="habits"]'); await p.waitForTimeout(200);
  await p.click('a[data-tab="today"]'); await p.waitForTimeout(300);
  assert((await p.locator('.page-title').textContent()) === title0, '19 Today tab resets to today');
  await p.click('a[data-tab="calendar"]'); await p.waitForTimeout(300);
  const m0 = await p.locator('.page-title').textContent();
  await swipe(p, '.cal-card', -120);
  assert((await p.locator('.page-title').textContent()) !== m0, '4 calendar swipe changes month');
  await p.click('a[data-tab="today"]'); await p.waitForTimeout(300);

  // 20. minus button on today
  assert(await p.locator('.habit-row .minus-btn').count() === 1, '20 minus button shown for count habit');
  await p.click('.habit-row .minus-btn'); await p.waitForTimeout(200);
  assert(JSON.parse(await stored()).logs.w['2026-11-10'] === undefined, '20 minus decrements');
  await p.locator('.habit-count').focus(); await p.keyboard.press('ArrowUp'); await p.keyboard.press('ArrowUp'); await p.keyboard.press('ArrowDown');
  assert(JSON.parse(await stored()).logs.w['2026-11-10'] === 1, '20 keyboard up/down on count');
  // 27. new perWeek habit rate is null (—)
  const r27 = await p.evaluate(async () => { const L = await import('./js/logic.js'); const S = await import('./js/store.js'); const st = S.getState(); return L.completionRate(st, st.habits.find((h) => h.id === 'p'), 30); });
  assert(r27 === null, '27 new perWeek habit rate is null');
  await p.screenshot({ path: SP + '/q-today-320.png', fullPage: true });

  // 5. future day: habit controls disabled
  await p.click('[aria-label="Next day"]'); await p.waitForTimeout(200);
  assert(await p.locator('.habit-row .habit-check:disabled, .habit-row .habit-count:disabled').count() >= 1, '5 future habit controls disabled');
  const r5 = await p.evaluate(async () => { const A = await import('./js/actions.js'); A.setHabitValue('p', '2026-11-11', 1); const S = await import('./js/store.js'); return S.getState().logs.p?.['2026-11-11']; });
  assert(r5 === undefined, '5 setHabitValue rejects future dates');
  // 10. delete this day only + undo restores done
  await p.locator('.task', { hasText: 'Daily standup' }).locator('.task-main').click(); await p.waitForTimeout(300); await p.click('.tv-actions button:has-text("Edit")'); await p.waitForTimeout(300); // 1.7.2: tap opens View task; Edit from there
  await p.click('.sheet-foot .danger-ghost'); await p.waitForTimeout(300);
  await p.click('text=This day only'); await p.waitForTimeout(400);
  await p.click('.toast-action'); await p.waitForTimeout(300);
  const r1 = JSON.parse(await stored()).tasks.find((t) => t.id === 'r1');
  assert(!r1.exceptions.includes('2026-11-11') && r1.doneDates['2026-11-11'] === true, '10 undo restores occurrence and its done state');
  // 30. recurrence label visible
  assert((await p.locator('.task', { hasText: 'Daily standup' }).textContent()).includes('Weekly'), '30 recurrence label shown');
  await p.click('.chip-btn:has-text("Today")'); await p.waitForTimeout(200);

  // 11. duration without time
  await p.click('.fab'); await p.waitForTimeout(300);
  await p.fill('.qa-input', 'Study for 3 hours tomorrow');
  assert((await p.locator('.qa-preview').textContent()).includes('3h'), '11 preview shows 3h');
  await p.keyboard.press('Enter'); await p.waitForTimeout(300);
  assert(JSON.parse(await stored()).tasks.find((t) => t.title === 'Study').duration === 180, '11 saved duration 180');
  // 15. More options with #newtag then cancel
  await p.click('.fab'); await p.waitForTimeout(300);
  await p.fill('.qa-input', 'Thing #garden');
  await p.click('text=More options'); await p.waitForTimeout(300);
  assert((await p.locator('.sheet .chip[aria-checked="true"]').textContent()).includes('Garden'), '15 pending category preselected');
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  assert(!JSON.parse(await stored()).categories.some((c) => c.name === 'Garden'), '15 cancel does not create category');
  // 18. double tap FAB
  await p.dblclick('.fab'); await p.waitForTimeout(500);
  assert(await p.locator('.sheet-root.open').count() === 1, '18 double-tap keeps sheet open');
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  // 16. celebration toast has undo — complete all items today
  await p.evaluate(async () => {
    const S = await import('./js/store.js');
    S.update((s) => { s.tasks = s.tasks.filter((t) => t.id === 't1'); s.habits = s.habits.filter((h) => h.id === 'w'); s.logs.w['2026-11-10'] = 3; });
  });
  await p.waitForTimeout(200);
  await p.locator('.task .check').first().click(); await p.waitForTimeout(400);
  const tmsg = await p.locator('.takeover').textContent();
  assert(tmsg.includes('Everything done') && tmsg.includes('Undo'), '16 celebration takeover with Undo');
  await p.click('.takeover-action'); await p.waitForTimeout(300);
  assert(JSON.parse(await stored()).tasks.find((t) => t.id === 't1').done === false, '17 undo restores not-done');
  // 28. a journal entry added from + shows on Today
  await p.click('.fab'); await p.waitForTimeout(300);
  await p.click('.sheet .segmented button:has-text("Journal")'); await p.waitForTimeout(300);
  await p.fill('.sheet .journal-note', 'hello'); await p.click('.sheet .btn.primary:has-text("Save")'); await p.waitForTimeout(500);
  assert((await p.locator('.journal-entry').textContent()).includes('hello'), '28 journal entry shows on Today');

  // 21. ZWJ emoji
  await p.click('a[data-tab="habits"]'); await p.waitForTimeout(200);
  await p.click('.fab'); await p.waitForTimeout(300);
  await p.fill('.sheet .habit-name-row input', 'Code');
  await p.fill('.sheet input[aria-label="Custom emoji"]', '👩‍💻x');
  await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(300);
  assert(JSON.parse(await stored()).habits.find((h) => h.name === 'Code').emoji === '👩‍💻', '21 ZWJ emoji kept intact');
  // detail at 320
  await p.click('.habit-open >> nth=0'); await p.waitForTimeout(400);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert(!overflow, '8/9 no horizontal overflow on detail at 320px');
  await p.screenshot({ path: SP + '/q-detail-320.png', fullPage: true });
  await p.click('a[data-tab="habits"]'); await p.waitForTimeout(300);
  await p.screenshot({ path: SP + '/q-habits-320.png', fullPage: true });

  // 23. weekly default follows date
  await p.click('a[data-tab="today"]'); await p.waitForTimeout(200);
  await p.click('.fab'); await p.click('text=More options'); await p.waitForTimeout(300);
  await p.selectOption('.sheet select >> nth=2', 'weekly');
  await p.fill('.sheet input[type=date]', '2026-11-13'); await p.locator('.sheet input[type=date]').dispatchEvent('change');
  const pressed = await p.locator('.sheet .day-chip[aria-pressed="true"]').getAttribute('aria-label');
  assert(pressed === 'Friday', '23 weekly days follow date (' + pressed + ')');
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);

  // 22. import normalization
  const r22 = await p.evaluate(async () => {
    const S = await import('./js/store.js');
    const st = S.validateImport({ settings: { accent: 'pink' }, tasks: [{ id: 'a', title: 'x' }, { id: 'a', title: 'y' }], habits: [{ id: 'h', name: 'n', schedule: { type: 'days', days: [] } }] }).data;
    return [st.settings.accent, new Set(st.tasks.map((t) => t.id)).size, st.habits[0].schedule.type];
  });
  assert(r22[0] === 'indigo' && r22[1] === 2 && r22[2] === 'daily', '22 import normalized ' + JSON.stringify(r22));

  // 25/26 journal tab
  await p.click('a[data-tab="journal"]'); await p.waitForTimeout(300);
  assert((await p.locator('.journal-item').first().textContent()).includes('hello'), '25 journal tab lists the entry');

  // 31 + 7 onboarding replay
  await p.evaluate(() => { location.hash = '#settings'; }); await p.waitForTimeout(300);
  await p.click('text=Show welcome tour'); await p.waitForTimeout(400);
  assert(await p.evaluate(() => document.querySelector('.app').hasAttribute('inert')), '7 background inert during onboarding');
  for (let i = 0; i < 6; i++) await p.keyboard.press('Tab');
  assert(await p.evaluate(() => document.querySelector('.onboarding').contains(document.activeElement)), '7 focus stays in onboarding');
  assert(!(await p.locator('.ob-check input').isChecked()), '31 example checkbox unchecked on replay');
  await p.click('.ob-skip'); await p.waitForTimeout(300);
  assert(!(await p.evaluate(() => document.querySelector('.app').hasAttribute('inert'))), '7 inert removed');

  console.log(errs.join('\n') || 'no console errors');
  await b.close();
})();
