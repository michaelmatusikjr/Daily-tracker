// v1.13.0 #19: fewer toasts, top pill, full-screen takeover, subtle animations.
const { chromium, devices } = require('playwright');
const APP = 'http://127.0.0.1:8080/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const pad = (n) => String(n).padStart(2, '0');
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const TODAY = key(new Date());
const TOMORROW = key(new Date(Date.now() + 86400000));
const task = (id, title, o = {}) => ({ id, title, notes: '', date: TODAY, time: null, duration: null, priority: 0, category: null, reminder: null, reminderAt: null, recur: { type: 'none', days: [], interval: 2 }, done: false, doneDates: {}, exceptions: [], createdAt: 1, order: 1, ...o });
const base = (o = {}) => ({ version: 6, settings: { onboarded: true, theme: 'light', weekStart: 1 }, categories: [], tasks: [], habits: [], logs: {}, journal: {}, exercises: [], workouts: [], ...o });
const WO = { exercises: [{ id: 'sq', name: 'Squat', type: 'strength' }], workouts: [{ id: 'w1', date: '2026-11-10', exerciseId: 'sq', lines: [{ weight: 185, sets: 3, reps: 5 }], weightUnit: 'lb', time: null, distance: null, distanceUnit: 'mi', note: '', createdAt: 1 }] };

async function open(browser, data, { reduced = false } = {}) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block', reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await ctx.addInitScript((d) => {
    if (localStorage.getItem('dailyTracker:profiles')) return;
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles: [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }] }));
    localStorage.setItem('dailyTracker:data:p', d);
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
  }, JSON.stringify(data));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push(m.text()); });
  await p.goto(APP); await p.waitForTimeout(700);
  return { ctx, p };
}
const stored = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('dailyTracker:data:p')));
const toastCount = (p) => p.locator('#toasts .toast').count();

(async () => {
  const browser = await chromium.launch();

  // ===== A. removed toasts =====
  {
    const { ctx, p } = await open(browser, base({ tasks: [task('a', 'Alpha'), task('b', 'Beta')] }));
    await p.click('.task[data-id="a"] .check'); await p.waitForTimeout(400);
    assert(await toastCount(p) === 0 && await p.locator('.takeover').count() === 0, 'A1 completing a task (not the last) shows no toast');
    assert((await stored(p)).tasks.find((t) => t.id === 'a').done === true, 'A1b the task is saved as done');
    await p.evaluate(async () => { const m = await import('/js/actions.js'); m.saveJournal(new Date().toISOString().slice(0, 0) || (await import('/js/dates.js')).todayKey(), { mood: 4, note: 'x' }); });
    await p.waitForTimeout(300);
    assert(await toastCount(p) === 0, 'A2 saving a journal entry shows no toast');
    await p.evaluate(async () => { const m = await import('/js/actions.js'); m.saveHabit({ name: 'Read', emoji: '📚', color: '#6366f1', schedule: { type: 'daily', days: [] }, goal: { type: 'check', target: 1, unit: '' }, reminder: null, target: null }); });
    await p.waitForTimeout(300);
    assert(await toastCount(p) === 0, 'A3 creating a habit shows no toast');
    await p.evaluate(async () => { const m = await import('/js/actions.js'); m.reorderToday(['b', 'a']); });
    await p.waitForTimeout(300);
    assert(await toastCount(p) === 0, 'A4 reordering shows no toast');
    await p.evaluate(async () => { const m = await import('/js/actions.js'); m.duplicateTask('b'); });
    await p.waitForTimeout(300);
    assert(await toastCount(p) === 0, 'A5 duplicating shows no toast');
    await ctx.close();
  }

  // ===== A. quick add: viewing day = no toast, other day = "Added to … · View" =====
  {
    const { ctx, p } = await open(browser, base());
    await p.click('.fab'); await p.waitForTimeout(400);
    await p.fill('.qa-form input', 'Buy milk'); await p.keyboard.press('Enter'); await p.waitForTimeout(500);
    assert((await stored(p)).tasks.length === 1, 'A6 quick add saved a task');
    assert(await toastCount(p) === 0, 'A6b adding for the viewed day shows no toast');
    await p.click('.fab'); await p.waitForTimeout(400);
    await p.fill('.qa-form input', 'Dentist tomorrow'); await p.keyboard.press('Enter'); await p.waitForTimeout(500);
    const t = p.locator('#toasts .toast');
    assert(await t.count() === 1 && /Added to/.test(await t.innerText()) && await t.locator('.toast-action').innerText() === 'View', 'A7 adding for another day shows "Added to … View"');
    await ctx.close();
  }

  // ===== C. pill: Undo-bearing toast at the top =====
  {
    const { ctx, p } = await open(browser, base({ tasks: [task('a', 'Alpha'), task('b', 'Beta')] }));
    await p.evaluate(async () => { const m = await import('/js/actions.js'); await m.deleteTask('a', (await import('/js/dates.js')).todayKey()); });
    await p.waitForTimeout(450);
    const pill = p.locator('#toasts .toast');
    assert(await pill.count() === 1 && /Deleted/.test(await pill.innerText()), 'C1 delete shows a pill');
    const box = await pill.boundingBox(), fab = await p.locator('.fab').boundingBox();
    assert(box.y < 120 && box.y >= 0, `C2 pill is at the top (y=${Math.round(box.y)})`);
    assert(box.y + box.height < fab.y, 'C3 pill does not overlap the + button');
    assert(await p.locator('.task[data-id="a"]').count() === 0, 'C4 task removed (ghost row is gone)');
    await p.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/pill-light.png` : '/dev/null' }).catch(() => {});
    await pill.locator('.toast-action').click(); await p.waitForTimeout(500);
    assert((await stored(p)).tasks.some((t) => t.id === 'a'), 'C5 Undo restores the task');
    assert(await toastCount(p) === 0, 'C6 pill is gone after Undo');
    // tap dismisses
    await p.evaluate(async () => { const m = await import('/js/actions.js'); await m.deleteTask('b', (await import('/js/dates.js')).todayKey()); });
    await p.waitForTimeout(450);
    await p.locator('#toasts .toast-msg').tap(); await p.waitForTimeout(500);
    assert(await toastCount(p) === 0, 'C7 tapping the pill dismisses it');
    // swipe up dismisses
    await p.evaluate(async () => { const m = await import('/js/actions.js'); await m.deleteTask('a', (await import('/js/dates.js')).todayKey()); });
    await p.waitForTimeout(450);
    const b2 = await p.locator('#toasts .toast').boundingBox();
    const x = b2.x + 40, y = b2.y + b2.height - 6;
    await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.move(x, y - 15, { steps: 3 }); await p.mouse.move(x, y - 45, { steps: 4 }); await p.mouse.up();
    await p.waitForTimeout(500);
    assert(await toastCount(p) === 0, 'C8 swiping the pill up dismisses it');
    await ctx.close();
  }

  // ===== B. all-done takeover =====
  {
    const { ctx, p } = await open(browser, base({ tasks: [task('a', 'Alpha')] }));
    await p.click('.task[data-id="a"] .check'); await p.waitForTimeout(900);
    const tk = p.locator('.takeover');
    assert(await tk.count() === 1 && /Everything done for today/.test(await tk.innerText()), 'B1 completing the last item shows the takeover');
    assert(await p.locator('.takeover .takeover-action').innerText() === 'Undo', 'B2 takeover has an Undo button');
    assert(await p.locator('.takeover .confetto').count() === 40, 'B3 confetti present (40 pieces)');
    const r = await tk.boundingBox();
    assert(r.x === 0 && r.y === 0 && r.width >= 380, 'B4 takeover covers the viewport');
    await p.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/takeover-light.png` : '/dev/null' }).catch(() => {});
    await p.waitForTimeout(1500);
    assert(await p.locator('.takeover .confetto').count() === 0, 'B5 confetti removed afterwards');
    await p.mouse.click(10, 300); await p.waitForTimeout(450);
    assert(await tk.count() === 0, 'B6 clicking the backdrop dismisses');
    assert((await stored(p)).tasks[0].done === true, 'B7 dismissing keeps the task done');
    // Undo
    await p.click('.task[data-id="a"] .check'); await p.waitForTimeout(300); // un-complete
    await p.click('.task[data-id="a"] .check'); await p.waitForTimeout(900);
    await p.click('.takeover .takeover-action'); await p.waitForTimeout(500);
    assert((await stored(p)).tasks[0].done === false && await p.locator('.takeover').count() === 0, 'B8 Undo restores and dismisses');
    // Escape
    await p.click('.task[data-id="a"] .check'); await p.waitForTimeout(900);
    await p.keyboard.press('Escape'); await p.waitForTimeout(450);
    assert(await p.locator('.takeover').count() === 0, 'B9 Escape dismisses');
    // auto-dismiss (6 s with action)
    await p.click('.task[data-id="a"] .check'); await p.waitForTimeout(300);
    await p.click('.task[data-id="a"] .check'); await p.waitForTimeout(900);
    await p.waitForTimeout(5400);
    assert(await p.locator('.takeover').count() === 0, 'B10 auto-dismisses after ~6 s');
    await ctx.close();
  }

  // ===== B. PR takeover =====
  {
    const { ctx, p } = await open(browser, base(WO));
    await p.evaluate(async () => { const m = await import('/js/actions.js'); m.saveWorkout({ exerciseId: 'sq', date: (await import('/js/dates.js')).todayKey(), lines: [{ weight: 225, sets: 3, reps: 5 }], weightUnit: 'lb', time: null, distance: null, distanceUnit: 'mi', note: '' }); });
    await p.waitForTimeout(700);
    const tk = p.locator('.takeover');
    assert(await tk.count() === 1 && (await tk.innerText()).includes('Squat') && (await tk.locator('.takeover-emoji').innerText()) === '🏆', 'B11 personal record shows the 🏆 takeover');
    assert(await toastCount(p) === 0, 'B12 takeover replaces pills');
    await p.click('.takeover .takeover-action'); await p.waitForTimeout(500);
    assert((await stored(p)).workouts.length === 1, 'B13 Undo removes the new workout');
    await ctx.close();
  }

  // ===== B. data-load warning takeover (no auto-dismiss) =====
  {
    const ctx = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
    await ctx.addInitScript(() => {
      if (localStorage.getItem('dailyTracker:profiles')) return;
      localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles: [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }] }));
      localStorage.setItem('dailyTracker:data:p', '{not json');
      localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
    });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    await p.goto(APP); await p.waitForTimeout(1000);
    const tk = p.locator('.takeover');
    assert(await tk.count() === 1 && /couldn’t be read/.test(await tk.innerText()), 'B14 unreadable-data takeover appears');
    await p.waitForTimeout(6500);
    assert(await tk.count() === 1, 'B15 it does not auto-dismiss');
    await p.keyboard.press('Escape'); await p.waitForTimeout(400);
    assert(await tk.count() === 0, 'B16 Escape dismisses it');
    await ctx.close();
  }

  // ===== reduced motion =====
  {
    const { ctx, p } = await open(browser, base({ tasks: [task('a', 'Alpha')] }), { reduced: true });
    await p.click('.task[data-id="a"] .check'); await p.waitForTimeout(900);
    assert(await p.locator('.takeover').count() === 1, 'R1 takeover still shows under reduced motion');
    assert(await p.locator('.takeover .confetto, .takeover .confetti').count() === 0, 'R2 no confetti under reduced motion');
    await ctx.close();
  }

  // ===== D. animations =====
  {
    const { ctx, p } = await open(browser, base({ tasks: [task('a', 'Alpha'), task('b', 'Beta')] }));
    const cls = () => p.evaluate(() => document.querySelector('#main .view')?.className || '');
    assert(!/slide-/.test(await cls()), 'D1 no slide on initial load');
    await p.evaluate(() => { location.hash = '#habits'; }); await p.waitForTimeout(60);
    assert(/slide-r/.test(await cls()), 'D2 Today → Habits slides in from the right');
    await p.evaluate(() => { location.hash = '#today'; }); await p.waitForTimeout(60);
    assert(/slide-l/.test(await cls()), 'D3 Habits → Today slides in from the left');
    await p.waitForTimeout(400);
    await p.evaluate(async () => { (await import('/js/ctx.js')).ctx.rerender(); }); await p.waitForTimeout(60);
    assert(!/slide-|enter/.test(await cls()), 'D4 same-tab re-render does not animate');
    await p.evaluate(() => { location.hash = '#habits'; }); await p.waitForTimeout(400);
    await p.evaluate(async () => { (await import('/js/ctx.js')).ctx.rerender(); }); await p.waitForTimeout(60);
    assert(!/slide-|enter/.test(await cls()), 'D5 re-render on Habits does not animate');
    await p.click('[role="tab"]:has-text("Stats")'); await p.waitForTimeout(60);
    assert(/slide-r/.test(await cls()), 'D6 Habits sub-tab switch slides');
    await p.evaluate(() => { location.hash = '#today'; }); await p.waitForTimeout(400);
    // add animation
    await p.evaluate(async () => { const m = await import('/js/actions.js'); m.saveTask({ title: 'Gamma', date: (await import('/js/dates.js')).todayKey() }); }); await p.waitForTimeout(40);
    assert(await p.locator('.task.slide-in').count() === 1, 'D7 a newly added task slides in (and only that one)');
    await ctx.close();
  }

  // ===== screenshots (dark) =====
  if (process.env.SHOTS) {
    const { ctx, p } = await open(browser, base({ settings: { onboarded: true, theme: 'dark', weekStart: 1 }, tasks: [task('a', 'Alpha'), task('b', 'Beta')] }));
    await p.evaluate(async () => { const m = await import('/js/actions.js'); await m.deleteTask('a', (await import('/js/dates.js')).todayKey()); });
    await p.waitForTimeout(450);
    await p.screenshot({ path: `${process.env.SHOTS}/pill-dark.png` });
    await ctx.close();
    const o = await open(browser, base({ settings: { onboarded: true, theme: 'dark', weekStart: 1 }, tasks: [task('a', 'Alpha')] }));
    await o.p.click('.task[data-id="a"] .check'); await o.p.waitForTimeout(1900);
    await o.p.screenshot({ path: `${process.env.SHOTS}/takeover-dark.png` });
    await o.ctx.close();
  }

  assert(errs.length === 0, 'no JS errors in the console' + (errs.length ? ': ' + errs.join(' | ') : ''));
  await browser.close();
})();
