// v1.8.1 polish: focus after Edit › Save in View task, Strength progress scroll margin, 320px value wrapping.
const { chromium } = require('playwright');
const path = require('path');
const URL = 'http://127.0.0.1:8080/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const NOW = new Date(2026, 10, 18, 10, 0);
const W = (id, date, ex, lines, o = {}) => ({ id, date, exerciseId: ex, lines, weightUnit: 'lb', time: null, distance: null, distanceUnit: 'mi', note: '', createdAt: Number(id.replace(/\D/g, '')) || 1, ...o });
const L = (weight, sets, reps) => ({ weight, sets, reps });
const seed = (unit = 'lb') => ({
  version: 4, settings: { onboarded: true, theme: 'light', weekStart: 1, weightUnit: unit, distanceUnit: 'mi' },
  tasks: [{ id: 't1', title: 'Dentist', date: '2026-11-18', time: '15:00', recur: { type: 'none' } }],
  habits: [], logs: {}, journal: {},
  exercises: [{ id: 'sq', name: 'Squat', type: 'strength' }, { id: 'bp', name: 'Bench press', type: 'strength' }, { id: 'dl', name: 'Romanian deadlift', type: 'strength' }],
  workouts: [W('w1', '2026-11-02', 'sq', [L(235, 3, 5)]), W('w2', '2026-11-09', 'sq', [L(1015, 1, 1)]), W('w3', '2026-11-12', 'sq', [L(225, 3, 5)]),
    W('w4', '2026-11-05', 'bp', [L(187.5, 3, 5)]), W('w5', '2026-11-06', 'dl', [L(405.5, 3, 5)])],
});
async function open(browser, { width = 390, dark = false, data = seed(), height = 820 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', colorScheme: dark ? 'dark' : 'light' });
  data.settings.theme = dark ? 'dark' : 'light';
  await ctx.addInitScript(([d]) => {
    if (localStorage.getItem('dailyTracker:profiles')) return;
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles: [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }] }));
    localStorage.setItem('dailyTracker:data:p', d);
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
  }, [JSON.stringify(data)]);
  const p = await ctx.newPage();
  await p.clock.install({ time: NOW });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(URL); await p.waitForTimeout(400);
  return { ctx, p };
}
const go = (p, hash) => p.evaluate((x) => { location.hash = x; }, hash).then(() => p.waitForTimeout(300));
const active = (p) => p.evaluate(() => { const a = document.activeElement; return a === document.body ? 'body' : (a.className || a.tagName) + ':' + a.textContent.trim().slice(0, 20); });

(async () => {
  const browser = await chromium.launch();
  // 1. Focus after Edit › Save (and after Cancel/Esc), checked well after the closing animation
  {
    const { ctx, p } = await open(browser);
    await p.click('.task:has-text("Dentist") .task-main'); await p.waitForTimeout(400);
    await p.click('.tv-actions .tv-edit'); await p.waitForTimeout(400);
    await p.fill('.sheet-root:last-child input[placeholder="What do you need to do?"]', 'Dentist 2');
    await p.click('.sheet-root:last-child .sheet-foot .btn.primary');
    await p.waitForTimeout(900);
    let a = await active(p);
    assert(/tv-edit|sheet-title/.test(a) && (await p.textContent('.task-view-sheet .sheet-title')) === 'Dentist 2', 'F1 after Edit › Save focus is in the view (Edit button or title), not <body>: ' + a);
    // Keyboard save (Enter in the title field)
    await p.keyboard.press('Enter'); await p.waitForTimeout(400); // activates Edit again
    await p.fill('.sheet-root:last-child input[placeholder="What do you need to do?"]', 'Dentist 3');
    await p.locator('.sheet-root:last-child .sheet-foot .btn.primary').focus(); await p.keyboard.press('Enter'); await p.waitForTimeout(900);
    a = await active(p);
    assert(/tv-edit|sheet-title/.test(a) && (await p.textContent('.task-view-sheet .sheet-title')) === 'Dentist 3', 'F2 keyboard Save (Enter on Save) also returns focus to the view: ' + a);
    await p.click('.tv-actions .tv-edit'); await p.waitForTimeout(400);
    await p.keyboard.press('Escape'); await p.waitForTimeout(900);
    a = await active(p);
    assert(/tv-edit|sheet-title/.test(a), 'F3 Esc from the edit form returns focus to the view: ' + a);
    await p.keyboard.press('Escape'); await p.waitForTimeout(600);
    assert((await active(p)).includes('Dentist 3'), 'F4 closing the view returns focus to the row');
    await ctx.close();
  }
  // 4. Months always abbreviated (shared formatters)
  {
    const { ctx, p } = await open(browser);
    const head = await p.textContent('.page-title .title-long');
    assert(head === 'Wednesday, Nov 18', 'M1 Today header for today: ' + head);
    await p.click('[aria-label="Next day"]'); await p.waitForTimeout(300);
    assert((await p.textContent('.page-title .title-long')) === 'Thursday, Nov 19', 'M2 Today header for another day');
    await p.click('.task-main').catch(() => {});
    await go(p, '#calendar');
    assert((await p.textContent('.page-title')) === 'Nov 2026', 'M3 calendar month title: ' + await p.textContent('.page-title'));
    const labels = await p.$$eval('.cal-day', (e) => e.map((x) => x.getAttribute('aria-label')).join(' '));
    assert(!/January|February|March|April|June|July|August|September|October|November|December/.test(labels), 'M4 calendar day labels use short months');
    await go(p, '#today'); await p.click('button:has-text("Today")').catch(() => {}); await p.waitForTimeout(200);
    await p.click('.task:has-text("Dentist") .task-main'); await p.waitForTimeout(400);
    assert((await p.textContent('.task-view')).includes('Today · Wednesday, Nov 18'), 'M5 View task “When” line');
    const all = await p.evaluate(() => document.body.innerText);
    assert(!/January|February|March|April|June|July|August|September|October|November|December/.test(all), 'M6 no full month names on screen');
    await ctx.close();
  }
  // 2. Workouts › Stats: the Progress card is on the first screen, fully in view
  {
    const { ctx, p } = await open(browser, { height: 600 });
    await go(p, '#workouts'); await p.click('[role=tab]:has-text("Stats")'); await p.waitForTimeout(250);
    const top = await p.evaluate(() => document.getElementById('progress-card').getBoundingClientRect().top);
    assert(top >= 8 && top <= 420, `S1 Progress card top sits ${top.toFixed(1)}px below the viewport top (not cut off)`);
    await ctx.close();
  }
  // 3. 320px: number and unit stay on one line; no overflow (kg and lbs, light and dark)
  for (const [unit, dark] of [['kg', false], ['kg', true], ['lb', false]]) {
    const { ctx, p } = await open(browser, { width: 320, dark, data: seed(unit) });
    await go(p, '#workouts'); await p.click('[role=tab]:has-text("Stats")'); await p.waitForTimeout(250);
    const r = await p.evaluate(() => [...document.querySelectorAll('.progress-table .pt-val')].map((v) => { const rects = [...v.getClientRects()]; const b = v.getBoundingClientRect(); const td = v.closest('td').getBoundingClientRect(); return { t: v.textContent, lines: new Set(rects.map((x) => Math.round(x.top))).size, inside: b.right <= td.right + 0.5 && b.left >= td.left - 0.5 }; }));
    const page = await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    assert(r.length >= 6 && r.every((x) => x.lines === 1 && x.inside) && page, `W1 320 ${unit}${dark ? ' dark' : ''}: values never split, stay inside their cells: ${r.map((x) => x.t).join(', ')}`);
    await p.locator('.progress-table-card').screenshot({ path: path.join(__dirname, `l23-progress-${unit}-${dark ? 'dark' : 'light'}.png`) });
    await ctx.close();
  }
  console.log(errs.join('\n') || 'no console errors');
  await browser.close();
})();
