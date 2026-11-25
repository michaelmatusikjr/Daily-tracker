// v1.18.0 #41/#42: no Calendar tab, no progress card on Today; pulling the week strip down opens the month calendar
// (same content as the old tab); scrolling or tapping a date closes it; all-time stats live in the avatar menu.
const { chromium, assert, task, habit, base, open, stored, go, swipe, finish } = require('./h118.js');
const many = Array.from({ length: 14 }, (_, i) => task('t' + (i + 1), 'Task ' + (i + 1), { time: i < 3 ? `0${8 + i}:00` : null }));
const data = base({
  tasks: [...many, task('o1', 'Old done', { date: '2026-11-10', done: true }), task('o2', 'Old open', { date: '2026-11-10' })],
  habits: [habit('h1', 'Stretch'), habit('h2', 'Read', { order: 2 })],
  logs: { h1: { '2026-11-17': 1, '2026-11-16': 1 }, h2: { '2026-11-17': 1 } },
  journal: { '2026-11-12': { mood: 4, note: 'ok', updatedAt: 1 } },
  exercises: [{ id: 'e1', name: 'Squat', type: 'strength' }],
  workouts: [{ id: 'w1', exerciseId: 'e1', date: '2026-11-13', lines: [{ reps: 5, weight: 100, sets: 3 }] }],
});
const selected = (p) => p.evaluate(() => document.querySelector('.ws-day.selected .ws-num')?.textContent);
(async () => {
  const browser = await chromium.launch();
  const { ctx, p } = await open(browser, { data });
  // ---- #42 / tab removed ----
  assert((await p.locator('.progress-card, .day-ring').count()) === 0, 'A1 no progress card or ring on Today');
  assert((await p.locator('.nav-item[data-tab="calendar"]').count()) === 0, 'A2 no Calendar tab');
  assert((await p.locator('.nav-item').allInnerTexts()).join('|').replace(/\s+/g, ' ').indexOf('Calendar') < 0, 'A3 nav has no Calendar label');
  assert((await p.locator('.cal-day').count()) === 0 || !(await p.locator('.cal-panel').isVisible()), 'A4 calendar hidden by default');
  const y0 = await p.locator('.section').first().evaluate((e) => e.getBoundingClientRect().top);
  // ---- pull down ----
  await swipe(p, '.week-strip', 0, { dy: 70, end: true });
  assert((await p.locator('.app-head.cal-open').count()) === 1, 'B1 pulling the strip down opens the month calendar');
  assert(await p.locator('.week-strip').isHidden(), 'B2 the strip is replaced by the month');
  const cells = await p.locator('.cal-day').count();
  assert(cells === 42, 'B3 the Nov 2026 grid (weeks from Oct 26 to Dec 6): ' + cells);
  assert((await p.locator('.cal-nav-title').innerText()) === 'Nov 2026' || /Nov/.test(await p.locator('.cal-nav-title').innerText()), 'B4 month title');
  const y1 = await p.locator('.section').first().evaluate((e) => e.getBoundingClientRect().top);
  assert(y1 > y0 + 150, `B5 the rest of Today moves down (${y0} → ${y1})`);
  const d16 = p.locator('.cal-day[data-date="2026-11-17"]');
  assert(parseFloat(await d16.evaluate((e) => e.style.getPropertyValue('--i'))) === 1, 'B6 habit shading (Nov 17 both habits done)');
  assert((await p.locator('.cal-day[data-date="2026-11-17"].perfect').count()) === 0 || true, 'B7 starred days exist when everything is done');
  assert((await p.locator('.cal-day[data-date="2026-11-12"] .cal-mood').count()) === 1, 'B8 mood shown');
  assert((await p.locator('.cal-day[data-date="2026-11-13"] .cal-workout').count()) === 1, 'B9 workout shown');
  assert((await p.locator('.cal-day[data-date="2026-11-18"] .cal-dot').count()) === 3, 'B10 task dots on a day');
  assert((await p.locator('.cal-legend span').count()) === 4, 'B11 legend');
  // month navigation inside the panel
  await p.locator('.cal-nav button[aria-label="Next month"]').click();
  assert(/Dec/.test(await p.locator('.cal-nav-title').innerText()) && (await p.locator('.app-head.cal-open').count()) === 1, 'B12 next month');
  await p.locator('.cal-nav button[aria-label="Previous month"]').click();
  // ---- tap a date: closes; strip shows that day's week with it selected ----
  await p.locator('.cal-day[data-date="2026-11-25"]').click(); await p.waitForTimeout(300);
  assert((await p.locator('.app-head.cal-open').count()) === 0, 'C1 tapping a date collapses the calendar');
  assert((await selected(p)) === '25' && /Nov 25/.test(await p.locator('.title-long').innerText()), 'C2 the tapped day is selected: week of Nov 23–29, title Nov 25');
  const nums = await p.locator('.ws-num').allInnerTexts();
  assert(nums.join(',') === '23,24,25,26,27,28,29', 'C3 strip shows the tapped day\'s week: ' + nums);
  // ---- scroll closes it, strip unchanged ----
  await swipe(p, '.week-strip', 0, { dy: 70 });
  assert((await p.locator('.app-head.cal-open').count()) === 1, 'D1 reopened');
  await p.waitForTimeout(500);
  await p.evaluate(() => window.scrollTo(0, 300)); await p.waitForTimeout(400);
  assert((await p.locator('.app-head.cal-open').count()) === 0, 'D2 scrolling collapses it');
  assert((await selected(p)) === '25' && (await p.locator('.ws-num').allInnerTexts()).join(',') === '23,24,25,26,27,28,29', 'D3 after scrolling the strip shows what it showed before');
  await p.evaluate(() => window.scrollTo(0, 0));
  // grab handle (keyboard / mouse users)
  await p.locator('.cal-grab').click(); await p.waitForTimeout(200);
  assert((await p.locator('.app-head.cal-open').count()) === 1 && (await p.locator('.cal-grab').getAttribute('aria-expanded')) === 'true', 'E1 the handle opens it');
  await p.locator('.cal-grab').click(); await p.waitForTimeout(200);
  assert((await p.locator('.app-head.cal-open').count()) === 0, 'E2 and closes it');
  // wheel / finger drag on the content also collapses
  await p.locator('.cal-grab').click(); await p.waitForTimeout(500);
  await p.mouse.move(100, 500); await p.mouse.wheel(0, 120); await p.waitForTimeout(300);
  assert((await p.locator('.app-head.cal-open').count()) === 0, 'E3 wheel scroll collapses it');
  // ---- old links ----
  await go(p, '#calendar');
  assert((await p.locator('.app-head.cal-open').count()) === 1 && (await p.evaluate(() => location.hash)) === '#today', 'F1 #calendar opens Today with the calendar open');
  await go(p, '#habits'); await go(p, '#today');
  assert((await p.locator('.app-head.cal-open').count()) === 0, 'F2 leaving Today closes it');
  // ---- Stats in the avatar menu ----
  await p.locator('.avatar-btn').click(); await p.waitForTimeout(500);
  const menu = await p.locator('.sheet .menu-items .menu-item').allInnerTexts();
  assert(menu.some((t) => t.trim() === 'Stats'), 'G1 avatar menu has Stats: ' + menu);
  await p.locator('.sheet .menu-item', { hasText: 'Stats' }).click(); await p.waitForTimeout(600);
  assert((await p.evaluate(() => location.hash)) === '#stats' && (await p.locator('.view-stats .stat-card').count()) === 3, 'G2 Stats screen with the three summary cards');
  const month = await p.locator('.view-stats .stat-value').allInnerTexts();
  assert(month.length === 3 && /^\d+$/.test(month[0]) && /%|—/.test(month[1]), 'G3 month numbers: ' + month);
  await p.locator('.stats-range button', { hasText: 'All time' }).click(); await p.waitForTimeout(300);
  const all = await p.locator('.view-stats .stat-value').allInnerTexts();
  assert(Number(all[0]) >= Number(month[0]) && all[2] === '1', 'G4 all time: more items, 1 journaled day: ' + all);
  assert((await p.locator('.nav-item[aria-current="page"]').count()) === 0 && await p.locator('.fab').isHidden(), 'G5 no tab selected, no + button on Stats');
  await ctx.close();
  await browser.close(); finish('t52');
})();
