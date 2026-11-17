// v1.7.0: Mark as missed.
const { chromium } = require('playwright');
const path = require('path');
const URL = 'http://127.0.0.1:8080/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const NOW = new Date(2026, 10, 18, 10, 0); // Wed Nov 18 2026
const TODAY = '2026-11-18', YDAY = '2026-11-17', TOMORROW = '2026-11-19';
const task = (id, title, o = {}) => ({ id, title, notes: '', date: TODAY, time: null, duration: null, priority: 0, category: null, reminder: null, recur: { type: 'none', days: [], interval: 2 }, done: false, doneDates: {}, exceptions: [], order: Number(id.replace(/\D/g, '')) || 1, createdAt: 1, ...o });
const habit = (id, name, o = {}) => ({ id, name, emoji: '🙏', color: '#0ea5e9', goal: { type: 'check', target: 1, unit: '' }, schedule: { type: 'daily', days: [] }, timeOfDay: 'anytime', reminder: null, archived: false, order: Number(id.replace(/\D/g, '')) || 1, createdAt: '2026-11-01', ...o });
const logs = {};
for (let d = 1; d <= 16; d++) { const k = `2026-11-${String(d).padStart(2, '0')}`; logs[k] = 1; }
const seed = () => ({
  version: 4, settings: { onboarded: true, theme: 'light', weekStart: 1, notifications: true, timeFormat: '24' },
  tasks: [task('t1', 'Buy milk'), task('t2', 'Water plants', { date: '2026-11-01', time: '19:00', reminder: 0, recur: { type: 'daily', days: [], interval: 2 } }),
    task('t3', 'Old errand', { date: '2026-11-15' }), task('t4', 'Call bank', { date: TOMORROW })],
  habits: [habit('h1', 'Morning prayer', { timeOfDay: 'morning', target: '23:45', warn: 15 }), habit('h2', 'Water', { emoji: '💧', goal: { type: 'count', target: 8, unit: 'glasses' } }), habit('h3', 'Read', { emoji: '📚' })],
  logs: { h1: { ...logs }, h2: { [TODAY]: 3 } }, journal: {}, exercises: [], workouts: [],
});

async function open(browser, { width = 390, dark = false, data = seed(), second = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 820 }, serviceWorkers: 'block', colorScheme: dark ? 'dark' : 'light' });
  data.settings.theme = dark ? 'dark' : 'light';
  await ctx.addInitScript(([d, q]) => {
    if (localStorage.getItem('dailyTracker:profiles')) return;
    const profiles = [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }];
    if (q) { profiles.push({ id: 'q', name: 'Sam', avatar: { type: 'emoji', emoji: '', color: '#10b981' } }); localStorage.setItem('dailyTracker:data:q', q); }
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles }));
    localStorage.setItem('dailyTracker:data:p', d);
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
    // Headless reports notifications as denied: allow them so reminder planning runs.
    if (window.Notification) { Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'granted' }); }
  }, [JSON.stringify(data), second && JSON.stringify(second)]);
  const p = await ctx.newPage();
  await p.clock.install({ time: NOW });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(URL); await p.waitForTimeout(400);
  return { ctx, p };
}
const go = (p, hash) => p.evaluate((x) => { location.hash = x; }, hash).then(() => p.waitForTimeout(300));
const stored = (p, id = 'p') => p.evaluate((i) => JSON.parse(localStorage.getItem('dailyTracker:data:' + i)), id);
const menu = async (p, sel) => { await p.click(sel, { button: 'right' }); await p.waitForTimeout(300); return p.$$eval('.sheet.action-menu .menu-item', (e) => e.map((x) => x.textContent.trim())); };
const pick = async (p, label) => { await p.click(`.sheet.action-menu .menu-item:has-text("${label}")`); await p.waitForTimeout(300); };
const esc = async (p) => { await p.keyboard.press('Escape'); await p.waitForTimeout(300); };
const undo = async (p) => { await p.click('#toasts .toast-action'); await p.waitForTimeout(300); };
const openMissed = async (p) => { if ((await p.getAttribute('.missed-section .collapse-btn', 'aria-expanded')) !== 'true') { await p.click('.missed-section .collapse-btn'); await p.waitForTimeout(250); } };

(async () => {
  const browser = await chromium.launch();
  const { ctx, p } = await open(browser);

  // ===== Habit =====
  let items = await menu(p, '.habit-row[data-id="h1"] .habit-row-main');
  assert(items.includes('Mark as missed'), 'M1 habit menu offers Mark as missed');
  await pick(p, 'Mark as missed');
  assert(await p.locator('.habit-row[data-id="h1"]').count() === 0 && (await p.textContent('.missed-section .collapse-btn')).includes('Missed (1)'), 'M2 habit hidden from Today, Missed (1) shown');
  assert((await stored(p)).habits.find((x) => x.id === 'h1').missed[TODAY] === true, 'M2 stored as habit.missed[date]');
  await undo(p);
  assert(await p.locator('.habit-row[data-id="h1"]').count() === 1 && await p.locator('.missed-section').count() === 0 && !(await stored(p)).habits.find((x) => x.id === 'h1').missed, 'M3 Undo brings it back');
  // Count habit
  await menu(p, '.habit-row[data-id="h2"] .habit-row-main'); await pick(p, 'Mark as missed');
  assert(await p.locator('.habit-row[data-id="h2"]').count() === 0, 'M4 count habit hidden');
  // ===== One-off task + recurring task =====
  await menu(p, '.task:has-text("Buy milk") .task-main'); await pick(p, 'Mark as missed');
  await menu(p, '.task:has-text("Water plants") .task-main'); await pick(p, 'Mark as missed');
  let st = await stored(p);
  assert(st.tasks.find((x) => x.id === 't1').missedDates[TODAY] && st.tasks.find((x) => x.id === 't2').missedDates[TODAY], 'M5 tasks store missedDates[date] (one-off and recurring)');
  assert(await p.locator('.task:has-text("Buy milk")').count() === 0 && await p.locator('.task:has-text("Water plants")').count() === 0 && (await p.textContent('.missed-section .collapse-btn')).includes('Missed (3)'), 'M6 both tasks hidden; Missed (3)');
  await openMissed(p);
  const listed = await p.$$eval('.missed-list .missed-name', (e) => e.map((x) => x.textContent));
  assert(JSON.stringify(listed) === JSON.stringify(['Water', 'Buy milk', 'Water plants']), 'M7 Missed list: ' + listed.join(', '));
  // Tap → Unmark missed
  // 1.7.2: tapping a missed task opens View task (Mark done + More › Unmark missed)
  await p.click('.missed-item:has-text("Water plants")'); await p.waitForTimeout(400);
  await p.click('.tv-actions button:has-text("More")'); await p.waitForTimeout(300);
  let mi = await p.$$eval('.sheet.action-menu .menu-item', (e) => e.map((x) => x.textContent.trim()));
  assert(mi.includes('Unmark missed') && (await p.textContent('.task-view-sheet')).includes('Mark done'), 'M8 tapping a missed task opens View task: Mark done, and More › Unmark missed');
  await pick(p, 'Unmark missed');
  await p.keyboard.press('Escape'); await p.waitForTimeout(350);
  assert(await p.locator('.task:has-text("Water plants")').count() === 1 && !(await stored(p)).tasks.find((x) => x.id === 't2').missedDates, 'M9 Unmark missed puts it back');
  // Mark done from the Missed list clears missed (done wins)
  await openMissed(p);
  await p.click('.missed-item:has-text("Buy milk")'); await p.waitForTimeout(400);
  await p.click('.tv-done'); await p.waitForTimeout(300);
  await p.keyboard.press('Escape'); await p.waitForTimeout(350);
  st = await stored(p);
  assert(st.tasks.find((x) => x.id === 't1').done && !st.tasks.find((x) => x.id === 't1').missedDates && await p.locator('.task.done:has-text("Buy milk")').count() === 1, 'D1 Mark done clears missed; task shows done on Today');
  await openMissed(p);
  await p.click('.missed-item:has-text("Water")'); await p.waitForTimeout(300);
  mi = await p.$$eval('.sheet.action-menu .menu-item', (e) => e.map((x) => x.textContent.trim()));
  await pick(p, 'Mark done today');
  st = await stored(p);
  assert(st.logs.h2[TODAY] === 8 && !st.habits.find((x) => x.id === 'h2').missed && await p.locator('.missed-section').count() === 0, 'D2 count habit marked done → missed cleared, section gone');
  // Not offered: done item, future date
  items = await menu(p, '.task:has-text("Buy milk") .task-main'); await esc(p);
  assert(!items.includes('Mark as missed') && !items.includes('Unmark missed'), 'N1 not offered on a done item');
  await go(p, '#today'); await p.click('[aria-label="Next day"]'); await p.waitForTimeout(300);
  items = await menu(p, '.task:has-text("Call bank") .task-main'); await esc(p);
  const hItems = await menu(p, '.habit-row[data-id="h3"] .habit-row-main'); await esc(p);
  assert(!items.includes('Mark as missed') && !hItems.includes('Mark as missed'), 'N2 not offered on a future date');
  assert(!(await p.evaluate(async () => { const A = await import('./js/actions.js'); A.setMissed('task', 't4', '2026-11-19', true, { silent: true }); const S = await import('./js/store.js'); return !!S.getState().tasks.find((x) => x.id === 't4').missedDates; })), 'N3 setMissed refuses future dates');
  await p.click('[aria-label="Previous day"]'); await p.waitForTimeout(300);

  // ===== Rollover list =====
  assert((await p.textContent('.overdue-card')).includes('Old errand'), 'O1 overdue one-off shows in rollover');
  await p.evaluate(async (k) => { const A = await import('./js/actions.js'); A.setMissed('task', 't3', k, true, { silent: true }); }, '2026-11-15');
  await p.waitForTimeout(300);
  assert(await p.locator('.overdue-card').count() === 0, 'O2 missed one-off is gone from the rollover list');
  await p.evaluate(() => { location.hash = '#today'; }); await p.evaluate(async () => { const { ctx } = await import('./js/ctx.js'); ctx.setDate('2026-11-15'); }); await p.waitForTimeout(300);
  await openMissed(p);
  assert((await p.textContent('.missed-list')).includes('Old errand'), 'O3 still found under its own day (Missed)');
  await p.evaluate(async () => { const { ctx } = await import('./js/ctx.js'); ctx.setDate('2026-11-18'); }); await p.waitForTimeout(300);

  // ===== Reminders =====
  await p.evaluate(async (k) => { const A = await import('./js/actions.js'); A.setMissed('habit', 'h1', k, true, { silent: true }); A.setMissed('task', 't2', k, true, { silent: true }); }, TODAY);
  const rem = await p.evaluate(async () => {
    const N = await import('./js/notify.js'); const P = await import('./js/push.js');
    const occ = N.reminderOccurrences(Date.now() - 3600000, Date.now() + 3 * 86400000).map((o) => o.key);
    const { rules } = P.buildRules({ hideText: false });
    return { occ, h1: rules.find((r) => r.id === 'p:hw:h1')?.skipDates, t2: rules.find((r) => r.id === 'p:t:t2')?.skipDates };
  });
  assert(!rem.occ.includes(`p:hw:h1:${TODAY}`) && !rem.occ.includes(`p:t:t2:${TODAY}`) && rem.occ.includes(`p:hw:h1:${TOMORROW}`) && rem.occ.includes(`p:t:t2:${TOMORROW}`), 'R1 local timers skip the missed day only');
  assert(rem.h1.includes(TODAY) && rem.t2.includes(TODAY) && !rem.h1.includes(TOMORROW), 'R2 push rules: missed day in skipDates');
  await ctx.close();

  // ===== Honest numbers: missed == simply unfinished =====
  {
    const plain = seed();
    const marked = seed();
    marked.habits[0].missed = { [TODAY]: true, '2026-11-12': true }; // a past day too
    marked.tasks[0].missedDates = { [TODAY]: true };
    marked.tasks[1].missedDates = { [TODAY]: true };
    // h1 not done on 11-12 in both, so streak math must agree
    delete plain.logs.h1['2026-11-12']; delete marked.logs.h1['2026-11-12'];
    const snap = async (data) => {
      const { ctx: c, p: q } = await open(browser, { data });
      const out = {};
      out.ring = await q.textContent('.progress-card');
      out.numbers = await q.evaluate(async () => {
        const L = await import('./js/logic.js'); const S = await import('./js/store.js'); const st = S.getState();
        return JSON.stringify(['2026-11-18', '2026-11-12', '2026-11-15'].map((k) => L.dayProgress(st, k)).concat(st.habits.map((h) => [L.streaks(st, h), L.completionRate(st, h, 30), L.completionRate(st, h)])));
      });
      await go(q, '#calendar'); out.cal = await q.$$eval('.cal-day', (e) => e.map((x) => x.getAttribute('aria-label') + '|' + x.className + '|' + x.getAttribute('style')).join('\n'));
      await go(q, '#habits'); await q.click('[role=tab]:has-text("Stats")'); await q.waitForTimeout(250); out.stats = await q.textContent('.view');
      await go(q, '#habit/h1'); out.detail = await q.textContent('.stat-grid');
      await c.close();
      return out;
    };
    const a = await snap(plain), b = await snap(marked);
    for (const k of ['ring', 'numbers', 'cal', 'stats', 'detail']) assert(a[k] === b[k], `E ${k}: identical to simply leaving the items unfinished`);
  }

  // ===== Habit detail calendar marker; import validation; profile isolation =====
  {
    const d = seed(); d.habits[0].missed = { '2026-11-12': true }; delete d.logs.h1['2026-11-12'];
    const other = seed();
    const { ctx: c, p: q } = await open(browser, { data: d, second: other });
    await go(q, '#habit/h1');
    assert((await q.getAttribute('.mc-day.missed', 'aria-label')).includes('missed'), 'C1 habit month calendar marks the missed day subtly');
    const imp = await q.evaluate(async () => {
      const S = await import('./js/store.js');
      const r = S.validateImport({ version: 4, tasks: [{ id: 'a', title: 'A', date: '2026-11-18', missedDates: { '2026-11-18': true, '2026-02-31': true, bad: true, '2026-11-17': 'yes' } }, { id: 'b', title: 'B', date: '2026-11-18', missedDates: 'nope' }],
        habits: [{ id: 'x', name: 'X', missed: { '2026-11-18': true, '2026-11-19': 1 } }, { id: 'y', name: 'Y', missed: ['2026-11-18'] }] });
      return { t: r.data.tasks.map((t) => t.missedDates || null), h: r.data.habits.map((x) => x.missed || null) };
    });
    assert(JSON.stringify(imp) === JSON.stringify({ t: [{ '2026-11-18': true }, null], h: [{ '2026-11-18': true }, null] }), 'I1 import keeps valid date keys with true only: ' + JSON.stringify(imp));
    const exp = await q.evaluate(async () => JSON.stringify((await import('./js/store.js')).exportPayload()));
    assert(exp.includes('"missed":{"2026-11-12":true}'), 'I2 export includes missed');
    await go(q, '#today');
    await menu(q, '.habit-row[data-id="h3"] .habit-row-main'); await pick(q, 'Mark as missed');
    const sam = await stored(q, 'q');
    assert(!sam.habits.find((x) => x.id === 'h3').missed && (await stored(q, 'p')).habits.find((x) => x.id === 'h3').missed[TODAY], 'P1 profile isolation: only the active profile changes');
    await q.evaluate(async () => { const S = await import('./js/store.js'); S.switchProfile('q'); }); await q.waitForTimeout(300);
    assert(await q.locator('.habit-row[data-id="h3"]').count() === 1 && await q.locator('.missed-section').count() === 0, 'P2 the other profile still lists it');
    await c.close();
  }

  // ===== Older data loads =====
  {
    const old = seed();
    const { ctx: c, p: q } = await open(browser, { data: old });
    assert(await q.locator('.missed-section').count() === 0 && await q.locator('.habit-row').count() === 3, 'V1 data without missed fields loads unchanged');
    await c.close();
  }

  // ===== QA wording: saving Advanced unchanged while push is on =====
  {
    const { ctx: c, p: q } = await open(browser);
    // Never contact the real (bundled) server from tests.
    await q.route(/workers\.dev|other\.example\.org/, (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"ok":true}' }));
    await q.evaluate(() => localStorage.setItem('dailyTracker:push', JSON.stringify({ on: true, deviceId: 'd'.repeat(22), token: 't'.repeat(43), lastOk: Date.now() })));
    await go(q, '#settings');
    await q.click('details.push-advanced summary');
    await q.click('.push-advanced .btn.secondary'); await q.waitForTimeout(400);
    const t = await q.textContent('#toasts');
    assert(t.includes('Saved') && !t.includes('again') && JSON.parse(await q.evaluate(() => localStorage.getItem('dailyTracker:push'))).on === true, 'W1 unchanged Advanced save keeps push on and just says Saved: ' + t.slice(0, 60));
    await q.fill('[aria-label="Push server URL"]', 'https://other.example.org');
    await q.click('.push-advanced .btn.secondary'); await q.waitForTimeout(600);
    assert((await q.textContent('#toasts')).includes('Turn closed-app reminders on again'), 'W2 a different server does turn it off, and says so');
    await c.close();
  }

  // ===== 320 light/dark =====
  for (const dark of [false, true]) {
    const d = seed(); d.habits[0].missed = { [TODAY]: true }; d.tasks[1].missedDates = { [TODAY]: true }; d.tasks[0].title = 'A rather long task title that should be truncated nicely in the missed list';
    d.tasks[0].missedDates = { [TODAY]: true };
    const { ctx: c, p: q } = await open(browser, { width: 320, dark, data: d });
    await openMissed(q);
    await q.locator('.missed-section').scrollIntoViewIfNeeded();
    assert(await q.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `L 320 ${dark ? 'dark' : 'light'}: no overflow`);
    await q.screenshot({ path: path.join(__dirname, `l20-missed-${dark ? 'dark' : 'light'}.png`) });
    await c.close();
  }

  console.log(errs.join('\n') || 'no console errors');
  await browser.close();
})();
