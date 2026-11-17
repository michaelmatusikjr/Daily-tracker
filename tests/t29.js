// v1.11.0 #18: habits in Today's Schedule (timed) and Anytime lists, shared Anytime ordering.
const { chromium } = require('playwright');
const URL = 'http://127.0.0.1:8080/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const NOW = new Date(2026, 10, 18, 10, 0); // Wed Nov 18 2026
const TODAY = '2026-11-18';
const task = (id, title, o = {}) => ({ id, title, notes: '', date: TODAY, time: null, duration: null, priority: 0, category: null, reminder: null, recur: { type: 'none', days: [], interval: 2 }, done: false, doneDates: {}, exceptions: [], order: Number(id.replace(/\D/g, '')) || 1, createdAt: 1, ...o });
const habit = (id, name, o = {}) => ({ id, name, emoji: '✅', color: '#6366f1', schedule: { type: 'daily', days: [], times: 3 }, goal: { type: 'check', target: 1, unit: '' }, reminder: null, target: null, archived: false, order: Number(id.replace(/\D/g, '')) || 1, createdAt: '2026-11-01', ...o });
const base = (o = {}) => ({ version: 5, settings: { onboarded: true, theme: 'light', weekStart: 1 }, categories: [], tasks: [], habits: [], logs: {}, journal: {}, exercises: [], workouts: [], ...o });

async function open(browser, data, { width = 390 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
  await ctx.addInitScript((d) => {
    if (localStorage.getItem('dailyTracker:profiles')) return;
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles: [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }] }));
    localStorage.setItem('dailyTracker:data:p', d);
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
  }, JSON.stringify(data));
  const p = await ctx.newPage();
  await p.clock.install({ time: NOW });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(URL); await p.waitForTimeout(400);
  return { ctx, p };
}
const go = (p, hash) => p.evaluate((x) => { location.hash = x; }, hash).then(() => p.waitForTimeout(350));
const stored = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('dailyTracker:data:p')));
const names = (p, sel) => p.locator(sel).evaluateAll((els) => els.map((e) => (e.querySelector('.task-title, .habit-name') || e).textContent.trim()));

(async () => {
  const browser = await chromium.launch();
  const data = base({
    tasks: [
      task('t1', 'Standup', { time: '09:00' }), task('t2', 'Dentist', { time: '14:00' }),
      task('t3', 'Buy milk', { order: 1 }), task('t4', 'Call mom', { order: 2 }),
    ],
    habits: [
      habit('h1', 'Floss', { target: '08:00', order: 1 }), habit('h2', 'Run', { target: '14:00', order: 2 }), habit('h3', 'Lunch', { target: '12:00', order: 3 }),
      habit('h4', 'Water', { order: 4 }), habit('h5', 'Read', { order: 5 }),
      habit('h6', 'Gym', { order: 6, schedule: { type: 'perWeek', days: [], times: 3 } }),
      habit('h7', 'Swim', { order: 7, target: '18:00', schedule: { type: 'perWeek', days: [], times: 2 } }),
      habit('h8', 'Skipped', { order: 8, target: '11:00', missed: { [TODAY]: true } }),
    ],
  });
  {
    const { ctx, p } = await open(browser, data);
    const heads = await p.locator('.section-title, .section-head h2, .section > header').allTextContents().catch(() => []);
    assert(!(await p.locator('section.section:has(.habit-rows)').count()), 'S1 no separate Habits section on Today');
    const sched = await p.locator('ol.timeline > li').evaluateAll((els) => els.map((e) => e.classList.contains('now-line') ? 'NOW' : (e.querySelector('.task-title, .habit-name')?.textContent || '').trim()));
    assert(JSON.stringify(sched) === JSON.stringify(['Floss', 'Standup', 'NOW', 'Lunch', 'Dentist', 'Run', 'Swim']), 'S2 Schedule interleaves tasks+habits by time, tasks first on ties, Now line placed (' + sched.join(',') + ')');
    const floss = await p.textContent('ol.timeline .habit-row:has-text("Floss")');
    assert(/by 8 AM/.test(floss), 'S3 timed habit labelled "by 8 AM"');
    assert(await p.locator('ol.timeline .habit-row:has-text("Swim")').textContent().then((t) => /2 left this week/.test(t)), 'S4 weekly habit with a target sits in the timeline and keeps "N left this week"');
    const any = await names(p, 'section:has(h2:text("Anytime")) ul.tasks > li');
    assert(JSON.stringify(any) === JSON.stringify(['Buy milk', 'Call mom', 'Water', 'Read', 'Gym']), 'S5 Anytime: tasks, then habits by order (weekly last) (' + any.join(',') + ')');
    assert(/3 left this week/.test(await p.textContent('ul.tasks .habit-row:has-text("Gym")')), 'S6 weekly Anytime habit shows "3 left this week"');
    assert(!any.includes('Skipped') && !sched.includes('Skipped'), 'S7 missed habit is not in the lists');
    assert((await p.textContent('.progress-big')).includes('0 of 10 done'), 'S8 ring/progress unchanged: 4 tasks + 5 daily habits... (' + (await p.textContent('.progress-big')) + ')');
    // Complete from the timeline
    await p.click('ol.timeline .habit-row:has-text("Floss") .habit-check'); await p.waitForTimeout(400);
    assert((await p.textContent('.progress-big')).includes('1 of 10 done') && (await stored(p)).logs.h1?.[TODAY] === 1, 'S9 habit check in the timeline logs it and updates progress');
    // Tap opens detail
    await p.click('ol.timeline .habit-row:has-text("Lunch") .habit-row-main'); await p.waitForTimeout(350);
    assert((await p.evaluate(() => location.hash)) === '#habit/h3', 'S10 tapping a habit row opens its detail');
    await go(p, 'today');
    // Keyboard reorder: Water up above Call mom
    await p.focus('ul.tasks .habit-row:has-text("Water") .drag-handle');
    await p.keyboard.press('ArrowUp'); await p.waitForTimeout(400);
    let any2 = await names(p, 'section:has(h2:text("Anytime")) ul.tasks > li');
    assert(JSON.stringify(any2) === JSON.stringify(['Buy milk', 'Water', 'Call mom', 'Read', 'Gym']), 'R1 dragging a habit among tasks reorders the shared list (' + any2.join(',') + ')');
    let st = await stored(p);
    const to = Object.fromEntries([...st.tasks, ...st.habits].filter((x) => 'todayOrder' in x).map((x) => [x.id, x.todayOrder]));
    assert(to.t3 === 0 && to.h4 === 1 && to.t4 === 2 && to.h5 === 3 && to.h6 === 4, 'R2 todayOrder written to tasks and habits together (' + JSON.stringify(to) + ')');
    assert(st.habits.find((x) => x.id === 'h4').order === 4 && st.habits.find((x) => x.id === 'h5').order === 5 && st.tasks.find((x) => x.id === 't4').order === 2, 'R3 `order` left untouched (Habits tab not corrupted)');
    await go(p, 'habits');
    const tab = await p.locator('.habit-card .habit-name').allTextContents();
    assert(tab.indexOf('Water') < tab.indexOf('Read'), 'R4 Habits tab unaffected');
    await go(p, 'today');
    any2 = await names(p, 'section:has(h2:text("Anytime")) ul.tasks > li');
    assert(any2[1] === 'Water', 'R5 order persists after re-render');
    // Undo
    await p.focus('ul.tasks .habit-row:has-text("Read") .drag-handle');
    await p.keyboard.press('ArrowUp'); await p.waitForTimeout(400);
    assert((await names(p, 'section:has(h2:text("Anytime")) ul.tasks > li')).slice(0, 4).join() === 'Buy milk,Water,Read,Call mom', 'R6 second move applied');
    await p.click('#toasts .toast button:has-text("Undo")'); await p.waitForTimeout(400);
    assert((await names(p, 'section:has(h2:text("Anytime")) ul.tasks > li')).slice(0, 4).join() === 'Buy milk,Water,Call mom,Read', 'R7 Undo restores the previous order');
    // New task goes after the dragged ones
    await p.evaluate(async () => { const A = await import('./js/actions.js'); A.saveTask({ title: 'Fresh', date: '2026-11-18', time: null }); });
    await p.waitForTimeout(300);
    assert((await names(p, 'section:has(h2:text("Anytime")) ul.tasks > li')).includes('Fresh'), 'R8 newly added task appears in the list');
    // Missed section
    await p.click('.collapse-btn:has-text("Missed")'); await p.waitForTimeout(300);
    assert(await p.locator('.missed-list:has-text("Skipped")').count() === 1, 'R9 missed habit stays in the collapsed Missed section');
    await ctx.close();
  }
  // Now line after everything / before everything
  {
    const d2 = JSON.parse(JSON.stringify(data));
    const { ctx, p } = await open(browser, d2);
    await p.clock.setFixedTime(new Date(2026, 10, 18, 19, 0));
    await p.reload(); await p.waitForTimeout(500);
    const sched = await p.locator('ol.timeline > li').evaluateAll((els) => els.map((e) => e.classList.contains('now-line') ? 'NOW' : (e.querySelector('.task-title, .habit-name')?.textContent || '').trim()));
    assert(sched[sched.length - 1] === 'NOW', 'N1 Now line last when every entry is earlier (' + sched.join(',') + ')');
    await ctx.close();
  }
  // Only-habits day: no "Nothing scheduled" card
  {
    const { ctx, p } = await open(browser, base({ habits: [habit('h1', 'Floss', { target: '08:00' })] }));
    assert(await p.locator('ol.timeline .habit-row').count() === 1 && await p.locator(':text("Nothing scheduled")').count() === 0, 'E1 a day with only a habit shows it in Schedule, no empty state');
    await ctx.close();
  }
  assert(errs.length === 0, 'no console/page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await browser.close();
})();
