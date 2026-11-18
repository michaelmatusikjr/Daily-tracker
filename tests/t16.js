// v1.5.0: long-press / right-click / keyboard item menus.
const { chromium } = require('playwright');
const URL = 'http://127.0.0.1:8080/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const NOW = new Date(2026, 10, 14, 10, 0); // Sat Nov 14 2026
const TODAY = '2026-11-14', TOMORROW = '2026-11-15';
const task = (id, title, o = {}) => ({ id, title, notes: '', date: TODAY, time: null, duration: null, priority: 0, category: null, reminder: null, recur: { type: 'none', days: [], interval: 2 }, done: false, doneDates: {}, exceptions: [], order: Number(id.slice(1)), createdAt: 1, ...o });
const habit = (id, name, o = {}) => ({ id, name, emoji: '💧', color: '#0ea5e9', goal: { type: 'check', target: 1, unit: '' }, schedule: { type: 'daily', days: [] }, timeOfDay: 'anytime', reminder: null, archived: false, order: Number(id.slice(1)), createdAt: '2026-11-01', ...o });
function seed(extra = {}) {
  return {
    version: 4,
    settings: { onboarded: true, theme: 'light', weekStart: 1, weightUnit: 'lb', distanceUnit: 'mi', workoutHabit: { habitId: 'h3', filter: 'any' } },
    tasks: [task('t1', 'Buy milk'), task('t2', 'Water plants', { recur: { type: 'daily', days: [], interval: 2 }, date: '2026-11-01' }), task('t3', 'Call mom'), task('t4', 'Read book')],
    habits: [habit('h1', 'Drink water', { goal: { type: 'count', target: 8, unit: 'glasses' } }), habit('h2', 'Stretch', { emoji: '🧘' }), habit('h3', 'Exercise', { emoji: '💪' })],
    logs: { h1: { [TODAY]: 3 } }, journal: {},
    exercises: [{ id: 'sq', name: 'Squat', type: 'strength' }, { id: 'run', name: 'Run', type: 'cardio' }],
    workouts: [{ id: 'w1', date: '2026-11-10', exerciseId: 'sq', lines: [{ weight: 185, sets: 3, reps: 5 }], weightUnit: 'lb', time: null, distance: null, distanceUnit: 'mi', note: '', createdAt: 1 }],
    ...extra,
  };
}
async function open(browser, { width = 390, dark = false, touch = true, tips = { settingsMoved: true, itemMenu: true }, data = seed(), second = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 820 }, serviceWorkers: 'block', colorScheme: dark ? 'dark' : 'light', hasTouch: touch });
  data.settings.theme = dark ? 'dark' : 'light';
  await ctx.addInitScript(([d, t, q]) => {
    if (localStorage.getItem('dailyTracker:profiles')) return;
    const profiles = [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }];
    if (q) { profiles.push({ id: 'q', name: 'Sam', avatar: { type: 'emoji', emoji: '', color: '#10b981' } }); localStorage.setItem('dailyTracker:data:q', q); }
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles }));
    localStorage.setItem('dailyTracker:data:p', d);
    localStorage.setItem('dailyTracker:tips', t);
  }, [JSON.stringify(data), JSON.stringify(tips), second && JSON.stringify(second)]);
  const p = await ctx.newPage();
  await p.clock.install({ time: NOW });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Service ?Worker/i.test(m.text())) errs.push(m.text()); });
  await p.goto(URL); await p.waitForTimeout(400);
  const cdp = touch ? await ctx.newCDPSession(p) : null;
  return { ctx, p, cdp };
}
const go = (p, hash) => p.evaluate((x) => { location.hash = x; }, hash).then(() => p.waitForTimeout(300));
const stored = (p, id = 'p') => p.evaluate((i) => JSON.parse(localStorage.getItem('dailyTracker:data:' + i)), id);
const center = async (p, sel) => { await p.locator(sel).first().evaluate((e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(50); const b = await p.locator(sel).first().boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
/** Real touch long-press via CDP (gives pointerType "touch" pointer events). moveBy = [dx, dy] after 100 ms. */
async function hold(p, cdp, sel, { ms = 650, moveBy = null } = {}) {
  const { x, y } = await center(p, sel);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  if (moveBy) { await p.waitForTimeout(100); await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + moveBy[0], y: y + moveBy[1] }] }); }
  await p.waitForTimeout(ms);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await p.waitForTimeout(350);
}
const menuOpen = (p) => p.locator('.sheet.action-menu').count().then((n) => n > 0);
const menuItems = (p) => p.$$eval('.sheet.action-menu .menu-item', (e) => e.map((x) => x.textContent.trim()));
const pick = async (p, label) => { if (!(await menuOpen(p))) { await p.screenshot({ path: __dirname + "/fail16.png" }); console.log("NO MENU for", label, await p.evaluate(() => document.querySelector(".sheet")?.className)); } await p.click(`.sheet.action-menu .menu-item:has-text("${label}")`); await p.waitForTimeout(300); };
const undo = async (p) => { await p.click('#toasts .toast-action'); await p.waitForTimeout(250); };
const esc = async (p) => { await p.keyboard.press('Escape'); await p.waitForTimeout(350); };

(async () => {
  const browser = await chromium.launch();

  // ===== Touch on Today: tasks =====
  {
    const { ctx, p, cdp } = await open(browser);
    await hold(p, cdp, '.task:has-text("Buy milk") .task-main');
    assert(await menuOpen(p), 'T1 touch long-press opens the task menu (bottom sheet)');
    const items = await menuItems(p);
    assert(JSON.stringify(items) === JSON.stringify(['Edit', 'Mark done', 'Move to tomorrow', 'Move to…', 'Mark as missed', 'Duplicate', 'Delete']), 'T1 task actions in order, Delete last: ' + items.join(' | '));
    assert(await p.$eval('.sheet.action-menu .sheet-title', (e) => e.textContent) === 'Buy milk', 'T1 title is the item');
    assert(await p.$eval('.sheet.action-menu .menu-item:last-child', (e) => getComputedStyle(e).color) === await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--danger').trim()).then((c) => p.evaluate((cc) => { const d = document.createElement('div'); d.style.color = cc; document.body.append(d); const r = getComputedStyle(d).color; d.remove(); return r; }, c)), 'T1 Delete is red');
    assert(await p.evaluate(() => !!document.activeElement?.closest('.sheet.action-menu')), 'T1 focus moves into the menu: ' + await p.evaluate(() => document.activeElement?.outerHTML.slice(0, 80)));
    await esc(p);
    assert(!(await menuOpen(p)) && await p.locator('.sheet').count() === 0, 'T2 Esc closes; the tap after the long-press did not open Edit');
    assert(await p.evaluate(() => document.activeElement?.classList.contains('task-main') && document.activeElement.textContent.includes('Buy milk')), 'T2 focus returns to the item');
    // no tap-after-long-press on the check button either
    await hold(p, cdp, '.task:has-text("Call mom") .check');
    await esc(p);
    assert(!(await stored(p)).tasks.find((t) => t.id === 't3').done, 'T3 long-press on the check button does not toggle it');
    // moving cancels
    await hold(p, cdp, '.task:has-text("Buy milk") .task-main', { moveBy: [0, 30] });
    assert(!(await menuOpen(p)), 'T4 moving > 10 px cancels the long-press');
    await hold(p, cdp, '.task:has-text("Buy milk") .task-main', { moveBy: [4, 3] });
    assert(await menuOpen(p), 'T4 a small wobble (< 10 px) still opens it');
    // Move to tomorrow + Undo
    await pick(p, 'Move to tomorrow');
    let st = await stored(p);
    assert(st.tasks.find((t) => t.id === 't1').date === TOMORROW && (await p.textContent('#toasts')).includes('Moved “Buy milk” to tomorrow'), 'T5 Move to tomorrow');
    await undo(p);
    assert((await stored(p)).tasks.find((t) => t.id === 't1').date === TODAY, 'T5 Undo moves it back');
    // Duplicate + Undo
    await hold(p, cdp, '.task:has-text("Buy milk") .task-main'); await pick(p, 'Duplicate');
    assert((await stored(p)).tasks.filter((t) => t.title === 'Buy milk').length === 2, 'T6 Duplicate');
    assert(await p.locator('#toasts .toast').count() === 0 || !(await p.textContent('#toasts')).includes('Duplicated'), 'T6 no Duplicated toast');
    await p.evaluate(async () => { const S = await import('./js/store.js'); S.update((x) => { const c = x.tasks.filter((t) => t.title === 'Buy milk'); x.tasks = x.tasks.filter((t) => t !== c[c.length - 1]); }); }); await p.waitForTimeout(200);
    assert((await stored(p)).tasks.filter((t) => t.title === 'Buy milk').length === 1, 'T6 copy removed (test cleanup)');
    // Mark done
    await hold(p, cdp, '.task:has-text("Call mom") .task-main'); await pick(p, 'Mark done');
    assert((await stored(p)).tasks.find((t) => t.id === 't3').done === true, 'T7 Mark done');
    await hold(p, cdp, '.task:has-text("Call mom") .task-main');
    assert((await menuItems(p))[1] === 'Mark not done', 'T7 menu offers Mark not done');
    await pick(p, 'Mark not done');
    assert((await stored(p)).tasks.find((t) => t.id === 't3').done === false, 'T7 Mark not done');
    // Move to… date picker
    await hold(p, cdp, '.task:has-text("Read book") .task-main'); await pick(p, 'Move to…');
    await p.fill('.sheet input[type=date]', '2026-11-20'); await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(300);
    assert((await stored(p)).tasks.find((t) => t.id === 't4').date === '2026-11-20', 'T8 Move to… a picked date');
    await undo(p);
    // Delete + Undo
    await hold(p, cdp, '.task:has-text("Buy milk") .task-main'); await pick(p, 'Delete');
    assert(!(await stored(p)).tasks.some((t) => t.id === 't1'), 'T9 Delete');
    await undo(p);
    assert((await stored(p)).tasks.some((t) => t.id === 't1'), 'T9 Undo restores');
    // Recurring
    await hold(p, cdp, '.task:has-text("Water plants") .task-main');
    const ri = await menuItems(p);
    assert(ri.includes('Skip this day') && !ri.some((x) => x.startsWith('Move')) && ri.at(-1) === 'Delete…', 'T10 recurring: Skip this day instead of Move');
    await pick(p, 'Skip this day');
    assert((await stored(p)).tasks.find((t) => t.id === 't2').exceptions.includes(TODAY), 'T10 Skip adds an exception');
    await undo(p);
    assert(!(await stored(p)).tasks.find((t) => t.id === 't2').exceptions.includes(TODAY), 'T10 Undo removes it');
    await hold(p, cdp, '.task:has-text("Water plants") .task-main'); await pick(p, 'Delete…');
    assert((await p.textContent('.sheet.dialog')).includes('This day only') && (await p.textContent('.sheet.dialog')).includes('Whole series'), 'T11 recurring delete asks this day / whole series');
    await esc(p);
    // drag handle: long-press doesn't open the menu
    await hold(p, cdp, '.task:has-text("Buy milk") .drag-handle');
    assert(!(await menuOpen(p)), 'T12 long-press on a drag handle does not open the menu');
    // normal tap still edits
    await p.tap('.task:has-text("Buy milk") .task-main'); await p.waitForTimeout(300);
    assert((await p.textContent('.task-view-sheet .sheet-title')) === 'Buy milk', 'T13 a normal tap still works (opens View task since 1.7.2)');
    await esc(p);
    // swipe still changes day
    {
      const { x, y } = await center(p, '.progress-card');
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x + 80, y }] });
      for (let i = 1; i <= 4; i++) { await p.waitForTimeout(20); await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 80 - i * 40, y }] }); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await p.waitForTimeout(400);
      assert((await p.textContent('.page-title')).includes('15') && !(await menuOpen(p)), 'T14 swipe-to-change-day still works');
    }
    await ctx.close();
  }

  // ===== Habits (Today + Habits page), touch =====
  {
    const { ctx, p, cdp } = await open(browser);
    await hold(p, cdp, '.habit-row:has-text("Drink water") .habit-row-main');
    let items = await menuItems(p);
    assert(JSON.stringify(items) === JSON.stringify(['Edit', 'View details', 'Add one', 'Remove one', 'Mark done today', 'Reset today', 'Mark as missed', 'Archive', 'Delete']), 'H1 count habit menu: ' + items.join(' | '));
    await pick(p, 'Add one');
    assert((await stored(p)).logs.h1[TODAY] === 4, 'H2 +1');
    await hold(p, cdp, '.habit-row:has-text("Drink water") .habit-count'); await pick(p, 'Remove one');
    assert((await stored(p)).logs.h1[TODAY] === 3, 'H2 −1 (long-press on the counter opens the menu instead of decrementing)');
    await hold(p, cdp, '.habit-row:has-text("Drink water") .habit-row-main'); await pick(p, 'Reset today');
    assert(!(await stored(p)).logs.h1?.[TODAY], 'H3 Reset today');
    await undo(p);
    assert((await stored(p)).logs.h1[TODAY] === 3, 'H3 Undo restores the count');
    await p.tap('.habit-row:has-text("Drink water") .habit-count'); await p.waitForTimeout(200);
    await p.tap('.habit-row:has-text("Drink water") .minus-btn'); await p.waitForTimeout(200);
    assert((await stored(p)).logs.h1[TODAY] === 3, 'H4 tap +1 and the visible − button still work');
    await hold(p, cdp, '.habit-row:has-text("Stretch") .habit-row-main');
    items = await menuItems(p);
    assert(!items.includes('Add one') && items.includes('Mark done today'), 'H5 check habit: Mark done, no ±1');
    await pick(p, 'Mark done today');
    assert((await stored(p)).logs.h2?.[TODAY] === 1, 'H5 Mark done');
    await go(p, '#habits');
    await hold(p, cdp, '.habit-card:has-text("Stretch") .habit-open'); await pick(p, 'Archive');
    assert((await stored(p)).habits.find((x) => x.id === 'h2').archived, 'H6 Archive (Habits page)');
    await undo(p);
    assert(!(await stored(p)).habits.find((x) => x.id === 'h2').archived, 'H6 Undo unarchives');
    // week dots still toggle with a tap; long-press there doesn't toggle
    const dots = '.habit-card:has-text("Stretch") .week-dots .wd';
    await p.tap(`${dots} >> nth=5`); await p.waitForTimeout(200);
    assert((await stored(p)).logs.h2?.['2026-11-13'] === 1, 'H7 tapping a week dot still toggles it');
    await hold(p, cdp, `${dots} >> nth=4`); await esc(p);
    assert(!(await stored(p)).logs.h2?.['2026-11-12'], 'H7 long-press on a week dot does not toggle it');
    await hold(p, cdp, '.habit-card:has-text("Stretch") .habit-open'); await pick(p, 'Delete');
    assert((await p.textContent('.sheet.dialog')).includes('Delete habit?'), 'H8 Delete keeps its confirm');
    await p.click('.sheet.dialog .btn.danger'); await p.waitForTimeout(300);
    assert(!(await stored(p)).habits.some((x) => x.id === 'h2'), 'H8 deleted after confirming');
    await undo(p);
    assert((await stored(p)).habits.some((x) => x.id === 'h2') && (await stored(p)).logs.h2?.[TODAY] === 1, 'H8 Undo restores habit and history');
    await hold(p, cdp, '.habit-card:has-text("Stretch") .habit-open'); await pick(p, 'View details');
    assert(await p.evaluate(() => location.hash) === '#habit/h2', 'H9 View details');
    await ctx.close();
  }

  // ===== Workouts, exercises, calendar (touch) + habit link =====
  {
    const { ctx, p, cdp } = await open(browser);
    await go(p, '#workouts');
    await hold(p, cdp, '.wo-entry .wo-main');
    assert(JSON.stringify(await menuItems(p)) === JSON.stringify(['Edit', 'Log again today', 'View exercise', 'Delete']), 'W1 workout menu');
    await pick(p, 'Log again today');
    const vals = await p.$$eval('.wo-line input', (e) => e.map((x) => x.value));
    assert(await p.inputValue('.sheet input[type=date]') === TODAY && vals.join(',') === '185,3,5' && (await p.textContent('.last-time')).startsWith('Copied from'), 'W2 Log again today: prefilled, dated today');
    await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(300);
    let st = await stored(p);
    assert(st.workouts.filter((w) => w.date === TODAY && w.exerciseId === 'sq').length === 1 && st.logs.h3?.[TODAY] === 1, 'W2 saved, and the workout→habit link checks the habit');
    await hold(p, cdp, '.wo-entry:has-text("Squat") .wo-main'); await pick(p, 'Delete');
    st = await stored(p);
    assert(st.workouts.length === 1 && !st.logs.h3?.[TODAY], 'W3 Delete (habit link un-checks)');
    await undo(p);
    st = await stored(p);
    assert(st.workouts.length === 2 && st.logs.h3?.[TODAY] === 1, 'W3 Undo restores workout and habit check');
    // Exercise chip
    await hold(p, cdp, '.filter-chip:has-text("Squat")');
    assert(JSON.stringify(await menuItems(p)) === JSON.stringify(['Edit', 'View history', 'Archive', 'Delete']), 'E1 exercise chip menu');
    await pick(p, 'Archive');
    assert((await stored(p)).exercises.find((e) => e.id === 'sq').archived, 'E2 Archive');
    await undo(p);
    assert(!(await stored(p)).exercises.find((e) => e.id === 'sq').archived, 'E2 Undo');
    // Manage list
    await p.click('[aria-label="Manage exercises"]'); await p.waitForTimeout(300);
    await hold(p, cdp, '.ex-manage li:has-text("Squat") button');
    await pick(p, 'Delete');
    assert((await p.textContent('.sheet.dialog')).includes('Archive instead'), 'E3 Delete offers Archive instead (manage list)');
    await p.click('.sheet.dialog .btn.danger'); await p.waitForTimeout(300);
    assert(!(await stored(p)).exercises.some((e) => e.id === 'sq'), 'E3 deleted with its workouts');
    await undo(p);
    assert((await stored(p)).workouts.length === 2, 'E3 Undo restores');
    await hold(p, cdp, '.filter-chip:has-text("Squat")'); await pick(p, 'View history');
    assert(await p.evaluate(() => location.hash) === '#exercise/sq', 'E4 View history');
    // Calendar
    await go(p, '#calendar');
    const day = (n) => `.cal-day:not(.outside) >> nth=${n - 1}`;
    await hold(p, cdp, day(20));
    let items = await menuItems(p);
    assert(JSON.stringify(items) === JSON.stringify(['Open day', 'Add task on this day']), 'C1 future day: no workout logging');
    await pick(p, 'Add task on this day');
    assert(await p.inputValue('.sheet input[type=date]') === '2026-11-20', 'C2 Add task on this day prefills the date');
    await esc(p);
    await hold(p, cdp, day(12));
    assert((await menuItems(p)).includes('Log workout on this day'), 'C3 past day offers Log workout');
    await pick(p, 'Log workout on this day');
    assert(await p.inputValue('.sheet input[type=date]') === '2026-11-12', 'C3 workout form dated that day');
    await esc(p);
    await hold(p, cdp, day(12)); await pick(p, 'Open day');
    assert(await p.evaluate(() => location.hash) === '#today' && (await p.textContent('.page-title')).includes('12'), 'C4 Open day');
    await ctx.close();
  }

  // ===== Mouse (right-click) + keyboard, desktop popover =====
  {
    const { ctx, p } = await open(browser, { width: 1280, touch: false });
    await p.click('.task:has-text("Buy milk") .task-main', { button: 'right' }); await p.waitForTimeout(300);
    assert(await p.locator('.sheet-root.pop .sheet.action-menu').count() === 1, 'K1 right-click opens a popover on desktop');
    const box = await p.locator('.sheet-root.pop .sheet').boundingBox();
    const row = await p.locator('.task:has-text("Buy milk")').boundingBox();
    const cb = await p.locator('.task:has-text("Buy milk") .task-main').boundingBox(); const cy = cb.y + cb.height / 2;
    assert(box.width <= 262 && (Math.abs(box.y - cy) < 6 || Math.abs(box.y + box.height - cy) < 6) && box.y >= 0 && box.y + box.height <= 820, 'K1 popover is small, anchored at the pointer and inside the viewport');
    await p.keyboard.press('ArrowDown'); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
    assert((await stored(p)).tasks.find((t) => t.id === 't1').done, 'K2 arrow keys + Enter pick an item');
    await p.locator('.task:has-text("Call mom") .task-main').focus();
    await p.keyboard.press('Shift+F10'); await p.waitForTimeout(300);
    assert(await menuOpen(p) && await p.evaluate(() => document.activeElement.classList.contains('menu-item')), 'K3 Shift+F10 opens the menu and focuses it');
    await esc(p);
    assert(await p.evaluate(() => document.activeElement.textContent.includes('Call mom')), 'K3 focus returns to the item');
    await p.locator('.habit-row:has-text("Drink water") .habit-row-main').focus();
    await p.keyboard.press('ContextMenu'); await p.waitForTimeout(300);
    assert((await menuItems(p)).includes('Add one'), 'K4 ContextMenu key opens the habit menu');
    await esc(p);
    await p.click('.habit-row:has-text("Drink water") .habit-count', { button: 'right' }); await p.waitForTimeout(300);
    assert(await menuOpen(p) && (await stored(p)).logs.h1[TODAY] === 3, 'K5 ' + (await menuOpen(p)) + ' ' + (await stored(p)).logs.h1[TODAY] + '  right-click on a counter opens the menu (no decrement)');
    await esc(p);
    await go(p, '#workouts');
    await p.click('.wo-entry .wo-main', { button: 'right' }); await p.waitForTimeout(300);
    assert((await menuItems(p)).includes('Log again today'), 'K6 right-click: workout');
    await esc(p);
    await p.locator('.filter-chip:has-text("Squat")').focus(); await p.keyboard.press('Shift+F10'); await p.waitForTimeout(300);
    assert((await menuItems(p)).includes('View history'), 'K7 keyboard: exercise chip');
    await esc(p);
    await go(p, '#calendar');
    await p.locator('.cal-day.today').focus(); await p.keyboard.press('Shift+F10'); await p.waitForTimeout(300);
    assert((await menuItems(p)).includes('Log workout on this day'), 'K8 keyboard: calendar day');
    await esc(p);
    await go(p, '#habits');
    await p.click('.habit-card:has-text("Stretch") .habit-open', { button: 'right' }); await p.waitForTimeout(300);
    assert((await menuItems(p)).includes('Archive'), 'K9 right-click: habit card');
    await esc(p);
    await p.click('.habit-card:has-text("Stretch") .habit-open'); await p.waitForTimeout(300);
    assert(await p.evaluate(() => location.hash) === '#habit/h2', 'K10 a normal click after a right-click still works');
    await ctx.close();
  }

  // ===== Multi-profile =====
  {
    const other = seed({ tasks: [task('t9', 'Sam task')], habits: [], workouts: [], exercises: [] });
    const { ctx, p, cdp } = await open(browser, { second: other });
    await p.evaluate(async () => { const S = await import('./js/store.js'); S.switchProfile('q'); }); await p.waitForTimeout(400);
    await hold(p, cdp, '.task:has-text("Sam task") .task-main'); await pick(p, 'Delete');
    assert((await stored(p, 'q')).tasks.length === 0 && (await stored(p, 'p')).tasks.length === 4, 'M1 menus act on the active profile only');
    await undo(p);
    assert((await stored(p, 'q')).tasks.length === 1, 'M1 Undo in the other profile');
    await ctx.close();
  }

  // ===== Hint toast =====
  {
    const { ctx, p } = await open(browser, { tips: { settingsMoved: true } });
    await p.waitForTimeout(900);
    assert((await p.textContent('#toasts')).includes('Tip: press and hold any item for more options.'), 'N1 one-time hint on Today');
    assert(JSON.parse(await p.evaluate(() => localStorage.getItem('dailyTracker:tips'))).itemMenu === true, 'N1 remembered');
    await p.reload(); await p.waitForTimeout(1000);
    assert(!(await p.textContent('#toasts')).includes('Tip:'), 'N2 not shown again');
    await ctx.close();
    const empty = seed({ tasks: [], habits: [] });
    const c2 = await open(browser, { tips: { settingsMoved: true }, data: empty });
    await c2.p.waitForTimeout(900);
    assert(!(await c2.p.textContent('#toasts')).includes('Tip:'), 'N3 not shown when Today has no items');
    await c2.ctx.close();
  }

  // ===== Layout at 320 light/dark =====
  for (const dark of [false, true]) {
    const { ctx, p, cdp } = await open(browser, { width: 320, dark });
    await hold(p, cdp, '.task:has-text("Buy milk") .task-main');
    const b = await p.locator('.sheet.action-menu').boundingBox();
    const fit = await p.evaluate(() => [...document.querySelectorAll('.sheet.action-menu .menu-item')].every((x) => x.scrollWidth <= x.clientWidth && x.getBoundingClientRect().height >= 44));
    assert(b.width <= 320 && b.y >= 0 && fit, `L 320 ${dark ? 'dark' : 'light'}: sheet fits, rows ≥ 44 px`);
    assert(await p.evaluate(() => getComputedStyle(document.querySelector('.task')).userSelect === 'none'), 'L rows suppress callout/selection');
    await p.screenshot({ path: `${__dirname}/l16-task-${dark ? 'dark' : 'light'}.png` });
    await esc(p);
    await hold(p, cdp, '.habit-row:has-text("Drink water") .habit-row-main');
    await p.screenshot({ path: `${__dirname}/l16-habit-${dark ? 'dark' : 'light'}.png` });
    await esc(p);
    assert(await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'L no horizontal overflow');
    await ctx.close();
  }
  {
    const { ctx, p } = await open(browser, { width: 1280, touch: false, dark: true });
    await p.click('.task:has-text("Buy milk") .task-main', { button: 'right' }); await p.waitForTimeout(300);
    await p.screenshot({ path: `${__dirname}/l16-pop-dark.png` });
    await ctx.close();
  }

  console.log(errs.join('\n') || 'no console errors');
  await browser.close();
})();
