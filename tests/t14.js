// v1.4.0: Strength / Bodyweight / Cardio types and the new personal records.
const { chromium } = require('playwright');
const URL = 'http://127.0.0.1:8080/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const NOW = new Date(2026, 10, 13, 10, 0); // Fri Nov 13 2026
const EX = [
  { id: 'sq', name: 'Squat', type: 'strength' }, { id: 'pu', name: 'Push-ups', type: 'bodyweight' },
  { id: 'run', name: 'Run', type: 'cardio' }, { id: 'old', name: 'Plank (old)', type: 'strength' },
];
const W = (id, date, ex, o = {}) => ({ id, date, exerciseId: ex, lines: [], weightUnit: 'lb', time: null, distance: null, distanceUnit: 'mi', createdAt: Number(id.replace(/\D/g, '')) || 1, ...o });
const L = (weight, sets, reps) => ({ weight, sets, reps });

async function open(browser, { workouts = [], habits = [], settings = {}, width = 390, dark = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 820 }, serviceWorkers: 'block', colorScheme: dark ? 'dark' : 'light' });
  const data = { version: 4, settings: { onboarded: true, theme: dark ? 'dark' : 'light', weekStart: 1, weightUnit: 'lb', distanceUnit: 'mi', ...settings }, tasks: [], habits, logs: {}, journal: {}, exercises: EX, workouts };
  await ctx.addInitScript(([d]) => {
    if (localStorage.getItem('dailyTracker:profiles')) return;
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles: [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }] }));
    localStorage.setItem('dailyTracker:data:p', d);
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true}');
  }, [JSON.stringify(data)]);
  const p = await ctx.newPage();
  await p.clock.install({ time: NOW });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(URL); await p.waitForTimeout(400);
  return { ctx, p };
}
const go = (p, hash) => p.evaluate((x) => { location.hash = x; }, hash).then(() => p.waitForTimeout(250));
const stored = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('dailyTracker:data:p')));
/** Run computeRecords in the page on a given workout list. */
const rec = (p, workouts, exId, settings = {}) => p.evaluate(async ([ws, id, st]) => {
  const M = await import('./js/workouts.js');
  const state = { settings: { weightUnit: 'lb', distanceUnit: 'mi', weekStart: 1, ...st }, exercises: [
    { id: 'sq', name: 'Squat', type: 'strength' }, { id: 'pu', name: 'Push-ups', type: 'bodyweight' }, { id: 'run', name: 'Run', type: 'cardio' }], workouts: ws };
  const r = M.computeRecords(state, id);
  const sum = { ...r.summary }; if (sum.days35) sum.days35 = [...sum.days35]; if (sum.distances) for (const k in sum.distances) delete sum.distances[k].w;
  return { records: Object.fromEntries([...r.records].map(([k, v]) => [k, v.map((x) => `${x.title}: ${x.value}`)])), summary: sum };
}, [workouts, exId, settings]);

(async () => {
  const browser = await chromium.launch();
  const { ctx, p } = await open(browser);

  // ===== Strength: 3×5 and 1RM =====
  let r = await rec(p, [W('w1', '2026-11-01', 'sq', { lines: [L(225, 2, 5)] }), W('w2', '2026-11-01', 'sq', { lines: [L(225, 1, 5)] })], 'sq');
  assert(r.summary.threeByFive?.v === 225, 'S1 225 2×5 + 225 1×5 on one day = 3×5 ✔');
  r = await rec(p, [W('w1', '2026-11-01', 'sq', { lines: [L(225, 2, 5), L(225, 1, 4)] })], 'sq');
  assert(r.summary.threeByFive === null && r.summary.oneRm?.v === 225, 'S2 225 2×5 + 1×4 is not 3×5 (1RM still 225)');
  r = await rec(p, [W('w1', '2026-11-01', 'sq', { lines: [L(200, 3, 8)] }), W('w2', '2026-11-02', 'sq', { lines: [L(210, 5, 5)] })], 'sq');
  assert(r.summary.threeByFive?.v === 210 && r.records.w2.includes('New 3×5 max: 210 lbs'), 'S3 3×8 ✔ and 5×5 ✔ (new 3×5 max)');
  r = await rec(p, [W('w1', '2026-11-01', 'sq', { lines: [L(225, 3, 5)] }), W('w2', '2026-11-02', 'sq', { lines: [L(135, 3, 20)] })], 'sq');
  assert(!r.records.w2, 'S4 more reps at a lighter weight is not a record (no max-reps record)');
  assert(!r.records.w1, 'S4 first-ever entry is not a record');
  r = await rec(p, [W('w1', '2026-11-01', 'sq', { lines: [L(225, 3, 5)] }), W('w2', '2026-11-03', 'sq', { lines: [L(235, 2, 5)] }), W('w3', '2026-11-03', 'sq', { lines: [L(235, 1, 5)] }), W('w4', '2026-11-05', 'sq', { lines: [L(275, 1, 1)] })], 'sq');
  assert(r.records.w2?.join() === 'New 1-rep max: 235 lbs' && r.records.w3?.join() === 'New 3×5 max: 235 lbs', 'S5 the entry completing the 3rd set gets the 3×5 record');
  assert(r.records.w4?.join() === 'New 1-rep max: 275 lbs' && r.summary.oneRm.v === 275 && r.summary.threeByFive.v === 235, 'S6 single heavy rep = 1RM only');
  // Property: 1RM ≥ 3×5 max on random histories
  let okProp = true;
  for (let t = 0; t < 30 && okProp; t++) {
    const ws = [];
    for (let i = 0; i < 12; i++) ws.push(W('w' + (i + 1), `2026-10-${String(1 + (i % 9)).padStart(2, '0')}`, 'sq', { lines: [L(95 + 10 * Math.floor(Math.random() * 15), 1 + Math.floor(Math.random() * 4), 1 + Math.floor(Math.random() * 8))] }));
    const x = await rec(p, ws, 'sq');
    if (x.summary.threeByFive && !(x.summary.oneRm.v >= x.summary.threeByFive.v)) okProp = false;
  }
  assert(okProp, 'S7 1-rep max ≥ 3×5 max on 30 random histories');
  r = await rec(p, [W('w1', '2026-11-01', 'sq', { lines: [L(100, 3, 5)], weightUnit: 'kg' }), W('w2', '2026-11-02', 'sq', { lines: [L(220.5, 3, 5)] })], 'sq');
  assert(!r.records.w2, 'S8 100 kg vs 220.5 lb is a tie, not a record');

  // ===== Bodyweight =====
  const bw = [
    W('w1', '2026-10-26', 'pu', { lines: [L(null, 3, 15)] }), // Mon wk A: 45
    W('w2', '2026-10-27', 'pu', { lines: [L(null, 2, 20)] }), // 40 → wk A 85
    W('w3', '2026-11-02', 'pu', { lines: [L(null, 5, 10)] }), // Mon wk B: 50 (day record) ; Nov month starts
    W('w4', '2026-11-03', 'pu', { lines: [L(20, 2, 25)] }),   // vest: 50 → wk B 100 (week record), day tie
    W('w5', '2026-11-10', 'pu', { lines: [L(null, 1, 30)], time: 45 }), // wk C: 30 ; hold 45 (first time)
    W('w6', '2026-11-12', 'pu', { lines: [L(null, 1, 10)], time: 60 }), // wk C: 40 ; hold 60 → record
  ];
  r = await rec(p, bw, 'pu');
  assert(r.records.w3?.includes('Most reps in a day: 50'), 'B1 most reps in a day');
  assert(!(r.records.w4 || []).some((x) => x.startsWith('Most reps in a day')), 'B1 equal day total is a tie');
  assert(r.records.w4?.includes('Most reps in a week: 100'), 'B2 most reps in a calendar week (Mon start)');
  assert(!(r.records.w3 || []).some((x) => x.includes('month')) && (r.records.w4 || []).some((x) => x === 'Most reps in a month: 100'), 'B3 month record needs a previous month to beat');
  assert(!Object.values(r.records).flat().some((x) => x.includes('year')), 'B4 no year record without a previous year');
  assert(r.records.w6?.includes('Longest hold: 1:00') && !r.records.w5?.some((x) => x.startsWith('Longest')), 'B5 longest hold (first hold isn’t a record)');
  assert(r.summary.current.week === 40 && r.summary.current.month === 140 && r.summary.week.v === 100, 'B6 current periods so far alongside bests');
  const rs = await rec(p, bw, 'pu', { weekStart: 0 });
  assert(rs.summary.week.v === 100 && rs.summary.current.week === 40, 'B7 week follows the week-start setting');

  // ===== Cardio: standard distances =====
  const runs = [
    W('w1', '2026-11-01', 'run', { distance: 5, distanceUnit: 'km', time: 25 * 60 }),
    W('w2', '2026-11-03', 'run', { distance: 5.05, distanceUnit: 'km', time: 24 * 60 + 50 }), // within 2%
    W('w3', '2026-11-05', 'run', { distance: 5.2, distanceUnit: 'km', time: 23 * 60 }),        // 4% off: not a 5K
    W('w4', '2026-11-07', 'run', { distance: 3.1, distanceUnit: 'mi', time: 24 * 60 + 30 }),   // 4.99 km → 5K
    W('w5', '2026-11-08', 'run', { distance: 1, distanceUnit: 'mi', time: 7 * 60 }),
    W('w6', '2026-11-09', 'run', { distance: 8, distanceUnit: 'mi', time: 70 * 60 }),          // no standard
  ];
  r = await rec(p, runs, 'run');
  assert(r.records.w2?.join() === 'Fastest 5K: 24:50' && !r.records.w3 && r.records.w4?.join() === 'Fastest 5K: 24:30', 'C1 fastest 5K with ±2% tolerance, unit conversion, no pro-rating');
  assert(!r.records.w5 && !r.records.w6 && r.summary.distances['1mi'].time === 420 && !r.summary.distances['10k'], 'C2 first at a distance isn’t a record; only qualifying distances listed');

  // ===== UI: toasts, Undo, badge, detail cards =====
  await ctx.close();
  {
    const hist = [W('w1', '2026-11-03', 'sq', { lines: [L(225, 3, 5)] }), W('w2', '2026-11-05', 'run', { distance: 3.11, distanceUnit: 'mi', time: 25 * 60 })];
    const { ctx: c2, p: q } = await open(browser, { workouts: hist });
    const log = async (name, fill) => {
      await q.keyboard.press('Escape'); await q.waitForTimeout(250); // dismiss any takeover
      await go(q, '#workouts'); await q.click('.fab'); await q.click(`.ex-chip:has-text("${name}")`); await q.waitForTimeout(150);
      await fill(); await q.click('.sheet-foot .btn.primary'); await q.waitForTimeout(300);
    };
    await log('Squat', async () => { const i = q.locator('.wo-line input'); await i.nth(0).fill('235'); await i.nth(1).fill('3'); await i.nth(2).fill('5'); });
    const t1 = (await q.textContent('.takeover-emoji')) + ' ' + (await q.textContent('.takeover-msg'));
    assert(t1.includes('🏆 New 3×5 max & 1-rep max: Squat 235 lbs'), 'U1 record toast names the record: ' + t1.slice(0, 50));
    assert(await q.locator('.wo-entry .pr-badge').count() === 1, 'U1 🏆 badge in history');
    assert(await q.locator('.takeover button').count() === 0, 'U2 PR takeover has no Undo button');
    await q.click('.takeover'); await q.waitForTimeout(450);
    await q.evaluate(async () => { const S = await import('/js/store.js'); S.update((s) => { s.workouts.pop(); }); }); await q.waitForTimeout(300);
    assert((await stored(q)).workouts.length === 2 && await q.locator('.pr-badge').count() === 0, 'U2 record removed again for the next steps');
    await log('Squat', async () => { const i = q.locator('.wo-line input'); await i.nth(0).fill('235'); await i.nth(1).fill('2'); await i.nth(2).fill('5'); });
    await log('Squat', async () => { const i = q.locator('.wo-line input'); await i.nth(0).fill('235'); await i.nth(1).fill('1'); await i.nth(2).fill('5'); });
    assert(((await q.textContent('.takeover-emoji')) + ' ' + (await q.textContent('.takeover-msg'))).includes('🏆 New 3×5 max: Squat 235 lbs'), 'U3 "🏆 New 3×5 max: Squat 235 lbs" when the 3rd set completes');
    await log('Run', async () => { await q.fill('#wo-time', '24:50'); await q.fill('#wo-dist', '3.1'); });
    assert(((await q.textContent('.takeover-emoji')) + ' ' + (await q.textContent('.takeover-msg'))).includes('🏆 Fastest 5K: Run 24:50'), 'U4 "🏆 Fastest 5K: Run 24:50"');
    await go(q, '#exercise/sq');
    const card = await q.textContent('.view');
    assert(card.includes('1-rep max') && card.includes('3×5 max') && card.includes('235 lbs') && card.includes('Nov 13'), 'U5 Strength card: 1-rep max and 3×5 max with dates');
    assert(await q.locator('.line-chart .mark').count() === 2, 'U5 chart marks 3×5 days');
    await go(q, '#exercise/run');
    const rows = await q.$$eval('.dist-table tbody tr', (e) => e.map((x) => x.textContent));
    assert(rows.length === 1 && rows[0].startsWith('5K24:50') && rows[0].includes('/mi'), 'U6 Cardio table: qualifying distances with time, pace, date');
    assert((await q.textContent('.dist-records')).includes('Log a 1 mi (1.6 km) to set a record'), 'U6 muted hint for a missing distance');
    await go(q, '#workouts'); await q.click('[role=tab]:has-text("Stats")'); await q.waitForTimeout(250);
    assert((await q.textContent('.view-workouts')).includes('Fastest 5K: 24:50') && (await q.textContent('.split-legend')).includes('Bodyweight'), 'U7 Stats: recent records + three-way split');
    await c2.close();
  }

  // ===== Bodyweight UI, guessing, kept strength time, hint, habit filter, import =====
  {
    const hist = [W('w1', '2026-11-02', 'old', { time: 90 }), W('w2', '2026-11-09', 'pu', { lines: [L(null, 3, 20)] })];
    const habits = [{ id: 'hb', name: 'Calisthenics', createdAt: '2026-11-01' }];
    const { ctx: c3, p: q } = await open(browser, { workouts: hist, habits, settings: { workoutHabit: { habitId: 'hb', filter: 'bodyweight' } } });
    const guess = await q.evaluate(async () => { const F = await import('./js/workoutForm.js'); return ['Push-ups', 'pushup', 'Sit-ups', 'Pull up', 'Chin-ups', 'Dips', 'Plank', 'Burpees', 'Lunges', 'Crunches', 'Wall sit', 'Air squat', 'Bodyweight squats', 'Squats', 'Bench press', 'Run'].map(F.guessType); });
    assert(JSON.stringify(guess) === JSON.stringify([...Array(13).fill('bodyweight'), 'strength', 'strength', 'cardio']), 'G guessing: bodyweight names, strength and cardio');
    await go(q, '#workouts'); await q.click('.fab'); await q.click('.ex-chip:has-text("Push-ups")'); await q.waitForTimeout(150);
    assert(await q.locator('#wo-time').count() === 1 && (await q.textContent('.wo-fields')).includes('Extra weight'), 'F bodyweight form: sets/reps, optional extra weight and hold time');
    await q.keyboard.press('Escape'); await q.waitForTimeout(250);
    await q.click('.fab'); await q.click('.ex-chip:has-text("Squat")'); await q.waitForTimeout(150);
    assert(await q.locator('#wo-time').count() === 0, 'F strength form has no time box');
    await q.keyboard.press('Escape'); await q.waitForTimeout(250);
    // Old strength entry with a time: still shown, kept on save
    assert((await q.textContent('.view')).includes('Plank (old)1:30'), 'K old strength entry’s time is still displayed');
    await q.evaluate(async () => { const S = await import('./js/store.js'); const F = await import('./js/workoutForm.js'); F.openWorkoutForm(S.getState().workouts.find((w) => w.id === 'w1')); });
    await q.waitForTimeout(200);
    assert((await q.textContent('.sheet')).includes('Logged time 1:30 is kept'), 'K form explains the kept time');
    await q.click('.sheet-foot .btn.primary'); await q.waitForTimeout(250);
    assert((await stored(q)).workouts.find((w) => w.id === 'w1').time === 90, 'K stored time kept on save');
    await q.click('[aria-label="Manage exercises"]'); await q.waitForTimeout(250);
    assert((await q.textContent('.sheet')).includes('Bodyweight may fit better'), 'K Manage exercises suggests Bodyweight');
    await q.keyboard.press('Escape'); await q.waitForTimeout(250);
    // Habit link with Bodyweight filter
    await go(q, '#workouts'); await q.click('.fab'); await q.click('.ex-chip:has-text("Squat")'); await q.waitForTimeout(150);
    let i = q.locator('.wo-line input'); await i.nth(0).fill('135'); await i.nth(1).fill('3'); await i.nth(2).fill('5');
    await q.click('.sheet-foot .btn.primary'); await q.waitForTimeout(250);
    assert(!(await stored(q)).logs.hb?.['2026-11-13'], 'H Bodyweight-only link ignores strength');
    await q.click('.fab'); await q.click('.ex-chip:has-text("Push-ups")'); await q.waitForTimeout(150);
    i = q.locator('.wo-line input'); await i.nth(1).fill('3'); await i.nth(2).fill('20');
    await q.click('.sheet-foot .btn.primary'); await q.waitForTimeout(250);
    assert((await stored(q)).logs.hb?.['2026-11-13'] === 1, 'H bodyweight workout checks the linked habit');
    await go(q, '#settings');
    assert(await q.locator('.segmented button:has-text("Bodyweight")').count() >= 1, 'H Settings filter offers Bodyweight');
    // Bodyweight detail
    await go(q, '#exercise/pu');
    const t = await q.textContent('.view');
    assert(t.includes('Most in a day') && t.includes('Most in a week') && t.includes('Most in a month') && t.includes('Most in a year') && t.includes('This week so far: 120'), 'D bodyweight card: day/week/month/year + current period');
    assert((await q.textContent('.chart-card .section-title')) === 'Reps per day', 'D bodyweight chart: reps per day');
    await q.evaluate(async () => { const S = await import('./js/store.js'); const A = await import('./js/actions.js'); });
    const ent = await q.evaluate(async () => { const M = await import('./js/workouts.js'); return M.workoutSummary({ lines: [{ weight: 20, sets: 3, reps: 10 }], weightUnit: 'lb', time: 75, distance: null }, { type: 'bodyweight' }, { weightUnit: 'lb', distanceUnit: 'mi' }); });
    assert(ent.includes('3 × 10') && ent.includes('1:15'), 'D bodyweight entry shows sets/reps, vest and hold: ' + ent);
    // Import: new type accepted, unknown → strength
    const types = await q.evaluate(async () => { const S = await import('./js/store.js'); return S.validateImport({ version: 4, tasks: [], habits: [], exercises: [{ id: 'a', name: 'A', type: 'bodyweight' }, { id: 'b', name: 'B', type: 'yoga' }], workouts: [] }).data.exercises.map((e) => e.type); });
    assert(JSON.stringify(types) === '["bodyweight","strength"]', 'I import accepts bodyweight; unknown → strength');
    await c3.close();
  }

  // ===== Layout =====
  for (const [width, dark] of [[320, false], [320, true], [390, true], [1280, false]]) {
    const hist = [W('w1', '2026-11-03', 'sq', { lines: [L(225, 3, 5)] }), W('w2', '2026-11-04', 'sq', { lines: [L(235, 3, 5)] }), W('w3', '2026-11-05', 'run', { distance: 3.1, time: 1500 }), W('w4', '2026-11-06', 'run', { distance: 3.1, time: 1490 }), W('w5', '2026-11-12', 'pu', { lines: [L(null, 3, 20)], time: 60 })];
    const { ctx: c4, p: q } = await open(browser, { workouts: hist, width, dark });
    let ok = true;
    for (const h of ['#exercise/sq', '#exercise/pu', '#exercise/run', '#journal', '#workouts', '#settings']) {
      await go(q, h);
      if (!(await q.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))) { ok = false; console.log('  overflow', width, h); }
      if (width === 320 && h !== '#settings') await q.screenshot({ path: `${__dirname}/l14-${h.replace(/\W/g, '')}-${dark ? 'dark' : 'light'}.png`, fullPage: true });
    }
    await go(q, '#workouts'); await q.click('[role=tab]:has-text("Stats")'); await q.waitForTimeout(250);
    if (!(await q.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))) { ok = false; console.log('  overflow', width, 'workouts stats'); }
    assert(ok, `L ${width}${dark ? ' dark' : ''}: no horizontal overflow`);
    await c4.close();
  }

  console.log(errs.join('\n') || 'no console errors');
  await browser.close();
})();
