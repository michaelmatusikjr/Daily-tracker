// v1.14: fixed compact header on every tab; Completed in the avatar menu; no avatar arrow; Completed names wrap.
const { chromium, devices } = require('playwright');
const APP = 'http://127.0.0.1:8080/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const pad = (n) => String(n).padStart(2, '0');
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const TODAY = key(new Date());
const LONG = 'A really long completed task name that must wrap across several lines instead of being cut off with an ellipsis at the end';
const task = (id, title, o = {}) => ({ id, title, notes: '', date: TODAY, time: null, duration: null, priority: 0, category: null, reminder: null, reminderAt: null, recur: { type: 'none', days: [], interval: 2 }, done: false, doneDates: {}, exceptions: [], createdAt: 1, order: 1, ...o });
const habit = (id, name, o = {}) => ({ id, name, emoji: '📚', color: '#22c55e', schedule: { type: 'daily', days: [] }, goal: { type: 'check', target: 1, unit: '' }, reminder: null, target: null, createdAt: 1, order: 1, archived: false, ...o });
const tasks = [
  ...Array.from({ length: 16 }, (_, i) => task('t' + i, 'Task number ' + i, { order: i, done: i > 0 && i % 2 === 0, completedAt: Date.now() - i * 1000 })),
  task('long', LONG, { done: true, completedAt: Date.now() }),
];
const data = (theme) => ({
  version: 6, settings: { onboarded: true, theme, weekStart: 1 }, categories: [], tasks,
  habits: Array.from({ length: 9 }, (_, i) => habit('h' + i, 'Habit ' + i, { order: i })), logs: {},
  journal: Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`2026-11-${pad(i + 1)}`, { mood: 3, note: 'Note ' + i + ' lorem ipsum dolor sit amet' }])),
  exercises: [{ id: 'sq', name: 'Squat', type: 'strength' }],
  workouts: Array.from({ length: 12 }, (_, i) => ({ id: 'w' + i, date: `2026-11-${pad(i + 1)}`, exerciseId: 'sq', lines: [{ weight: 185, sets: 3, reps: 5 }], weightUnit: 'lb', time: null, distance: null, distanceUnit: 'mi', note: '', createdAt: 1 })),
});

async function open(browser, theme) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, serviceWorkers: 'block', colorScheme: theme });
  for (const re of [/open-meteo\.com/, /nominatim/, /bigdatacloud/, /zippopotam/]) await ctx.route(re, (r) => r.abort());
  await ctx.addInitScript((d) => {
    if (localStorage.getItem('dailyTracker:profiles')) return;
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles: [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }] }));
    localStorage.setItem('dailyTracker:data:p', d);
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
  }, JSON.stringify(data(theme)));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push(m.text()); });
  await p.goto(APP); await p.waitForTimeout(700);
  return { ctx, p };
}
const go = async (p, tab) => { await p.evaluate((t) => { location.hash = '#' + t; }, tab); await p.waitForTimeout(450); };

(async () => {
  const browser = await chromium.launch();
  for (const theme of ['light', 'dark']) {
    const { ctx, p } = await open(browser, theme);
    for (const tab of ['today', 'calendar', 'habits', 'workouts', 'journal', 'completed']) {
      await go(p, tab);
      const L = `${theme} ${tab}`;
      const head = p.locator('.app-head');
      assert(await head.count() === 1, `${L}: has a .app-head`);
      assert(await p.locator('.eyebrow').count() === 0, `${L}: no eyebrow line`);
      const row = await p.locator('.app-head-row').boundingBox();
      assert(row.height <= 57, `${L}: title row <= 56px (${row.height})`);
      const before = await head.boundingBox();
      assert(before.y === 0, `${L}: header at top (${before.y})`);
      await p.evaluate(() => window.scrollTo(0, 500)); await p.waitForTimeout(250);
      const sy = await p.evaluate(() => window.scrollY);
      const after = await head.boundingBox();
      assert(sy > 0, `${L}: page actually scrolled (${sy})`);
      assert(after.y === before.y && Math.abs(after.height - before.height) < 1, `${L}: header stays fixed after scrolling`);
      const first = await p.evaluate(() => {
        const hb = document.querySelector('.app-head').getBoundingClientRect().bottom;
        // some content element sits just below the header (nothing hidden behind it is needed; it scrolls underneath)
        const el = document.elementFromPoint(195, hb + 6);
        return { hb, ok: !!el && !el.closest('.app-head') };
      });
      assert(first.ok, `${L}: content visible directly below the header`);
      const bg = await p.evaluate(() => getComputedStyle(document.querySelector('.app-head')).backgroundColor);
      assert(/rgba\(|\/ 0?\.\d+\)/.test(bg), `${L}: header slightly translucent (${bg})`);
      await p.evaluate(() => window.scrollTo(0, 0));
    }
    // Today: header height budget, pinned week strip, greeting in the top card, ◀ ▶
    await go(p, 'today');
    assert(await p.locator('.app-head .week-strip').count() === 1, `${theme}: week strip pinned in the header`);
    assert(/Nov|Dec|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct/.test(await p.locator('.app-title').innerText()), `${theme}: Today title is the date`);
    assert(await p.locator('.progress-card .progress-greet').count() === 1 && /Good (morning|afternoon|evening)/.test(await p.locator('.progress-card .progress-greet').innerText()), `${theme}: greeting is in the top progress card`);
    assert(await p.locator('.app-head [aria-label="Previous day"]').count() === 1 && await p.locator('.app-head [aria-label="Next day"]').count() === 1, `${theme}: Today has arrows in the header`);
    await p.locator('.app-head [aria-label="Next day"]').click(); await p.waitForTimeout(300);
    assert(await p.locator('.app-head .chip-btn', { hasText: 'Today' }).count() === 1, `${theme}: "Today" chip appears on another day`);
    await p.locator('.app-head .chip-btn', { hasText: 'Today' }).click(); await p.waitForTimeout(300);
    // Calendar: month + arrows, no Completed button
    await go(p, 'calendar');
    assert(/^[A-Z][a-z]{2} \d{4}$/.test((await p.locator('.app-title').innerText()).trim()), `${theme}: Calendar title is the month (short name)`);
    assert(await p.locator('.app-head [aria-label="Previous month"]').count() === 1 && await p.locator('.app-head [aria-label="Next month"]').count() === 1, `${theme}: Calendar arrows in header`);
    assert(await p.locator('.cal-completed-btn, a[href="#completed"]').count() === 0, `${theme}: Calendar has no Completed button`);
    // Sub-tabs pinned
    await go(p, 'habits');
    assert(await p.locator('.app-head [role=tablist]').count() === 1, `${theme}: Habits sub-tabs pinned under the title`);
    await go(p, 'workouts');
    assert(await p.locator('.app-head [role=tablist]').count() === 1, `${theme}: Workouts sub-tabs pinned under the title`);
    await go(p, 'journal');
    assert(await p.locator('.app-head input[type=search]').count() === 1, `${theme}: Journal search pinned in the header`);
    await ctx.close();
  }

  // Avatar: no arrow, opens the menu; menu has "Completed tasks"
  {
    const { ctx, p } = await open(browser, 'light');
    assert(await p.locator('.avatar-chevron').count() === 0, 'avatar has no dropdown arrow');
    assert(await p.locator('.avatar-btn svg').count() === 0, 'avatar button holds no icon');
    for (const tab of ['habits', 'workouts', 'calendar', 'journal']) {
      await go(p, tab);
      assert(await p.locator('.app-head .avatar-btn').count() === 1, `avatar on ${tab}`);
    }
    await go(p, 'today');
    await p.locator('.avatar-btn').click(); await p.waitForTimeout(400);
    assert(await p.locator('.profile-list').count() === 1, 'tapping the avatar opens the profile menu');
    const item = p.locator('.menu-item', { hasText: 'Completed tasks' });
    assert(await item.count() === 1, 'menu has "Completed tasks"');
    await item.click(); await p.waitForTimeout(500);
    assert(p.url().endsWith('#completed') && await p.locator('.view-completed').count() === 1, 'Completed tasks opens the Completed view');
    assert(await p.locator('.app-head input[type=search]').count() === 1, 'Completed: search pinned in the header');
    assert(await p.locator('.completed-filters .filter-chip').count() >= 4, 'Completed: filters kept');
    // long name wraps
    const t = p.locator('.completed-title', { hasText: 'A really long completed' });
    assert(await t.count() === 1, 'long completed task listed');
    const m = await t.evaluate((el) => { const cs = getComputedStyle(el); const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3; return { h: el.getBoundingClientRect().height, lh, to: cs.textOverflow, ws: cs.whiteSpace }; });
    assert(m.h > m.lh * 1.6, `long completed name wraps (height ${m.h} vs line ${m.lh})`);
    assert(m.to !== 'ellipsis' && m.ws !== 'nowrap', `no ellipsis / nowrap (${m.to}, ${m.ws})`);
    // Back returns to where we came from
    await p.locator('.app-head [aria-label="Back"]').click(); await p.waitForTimeout(400);
    assert(await p.locator('.view-today').count() === 1, 'Back from Completed returns to Today');
    await ctx.close();
  }

  assert(errs.length === 0, 'no console/page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await browser.close();
})();
