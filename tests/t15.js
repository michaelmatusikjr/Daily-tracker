// v1.4.1 QA fixes.
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
  // 4a grouping by raw kg
  let r = await rec(p, [W('w0', '2026-10-01', 'sq', { lines: [L(50, 1, 5)], weightUnit: 'kg' }), W('w1', '2026-11-01', 'sq', { lines: [L(101.25, 2, 5), L(101.5, 1, 5)], weightUnit: 'kg' })], 'sq', { weightUnit: 'kg' });
  assert(r.summary.threeByFive === null, 'P4a 101.25 kg and 101.5 kg sets do not combine');
  r = await rec(p, [W('w0', '2026-10-01', 'sq', { lines: [L(100, 1, 5)] }), W('w1', '2026-11-01', 'sq', { lines: [L(225, 2, 5)] }), W('w2', '2026-11-01', 'sq', { lines: [L(102.06, 1, 5)], weightUnit: 'kg' })], 'sq');
  assert(r.summary.threeByFive?.v === 225, 'P4a 225 lb and 102.06 kg combine');
  // 4b First 3×5 + priority
  assert(r.records.w2?.[0] === 'First 3×5: 225 lbs', 'P4b first 3×5 with earlier entries is a record: ' + r.records.w2);
  r = await rec(p, [W('w1', '2026-11-01', 'sq', { lines: [L(225, 3, 5)] })], 'sq');
  assert(!r.records.w1, 'P4b the very first entry is still not a record');
  r = await rec(p, [W('w1', '2026-11-01', 'sq', { lines: [L(225, 3, 5)] }), W('w2', '2026-11-02', 'sq', { lines: [L(235, 3, 5)] })], 'sq');
  assert(r.records.w2?.join('|') === 'New 3×5 max: 235 lbs|New 1-rep max: 235 lbs', 'P2 strength order: 3×5 before 1RM');
  r = await rec(p, [W('w1', '2025-12-01', 'pu', { lines: [L(null, 1, 10)] }), W('w2', '2026-11-02', 'pu', { lines: [L(null, 1, 20)], time: 30 }), W('w3', '2026-11-03', 'pu', { lines: [L(null, 1, 30)], time: 40 })], 'pu');
  assert(r.records.w3?.join('|') === 'Most reps in a year: 50|Most reps in a month: 50|Most reps in a week: 50|Most reps in a day: 30|Longest hold: 0:40', 'P2 bodyweight order year, month, week, day, hold: ' + r.records.w3);
  const tx = await p.evaluate(async () => { const M = await import('./js/workouts.js');
    const a = { kind: '3x5', title: 'New 3×5 max', value: '235 lbs' }, b = { kind: '1rm', title: 'New 1-rep max', value: '235 lbs' }, c = { kind: '1rm', title: 'New 1-rep max', value: '245 lbs' };
    return [M.recordToast([a], 'Squat'), M.recordToast([a, b], 'Squat'), M.recordToast([a, c], 'Squat'), M.recordToast([a, b, c], 'Squat')]; });
  assert(tx[0] === '🏆 New 3×5 max: Squat 235 lbs' && tx[1] === '🏆 New 3×5 max & 1-rep max: Squat 235 lbs' && tx[2] === '🏆 New 3×5 max: Squat 235 lbs · 1-rep max 245 lbs' && tx[3] === '🏆 New 3×5 max: Squat 235 lbs +2 more', 'P2 toast text names every record: ' + tx.join(' / '));
  // 3 import types
  const types = await p.evaluate(async () => { const S = await import('./js/store.js'); return S.validateImport({ version: 4, tasks: [], habits: [],
    exercises: [{ id: 'a', name: 'A', type: 'Bodyweight' }, { id: 'b', name: 'B', type: 'CARDIO' }, { id: 'c', name: 'C', type: 'running' }, { id: 'd', name: 'D', type: 'yoga' }],
    workouts: [{ id: 'x', date: '2026-11-01', exerciseId: 'c', lines: [], distance: 3, distanceUnit: 'mi', time: 1500 }, { id: 'y', date: '2026-11-01', exerciseId: 'd', lines: [{ weight: null, sets: 1, reps: 5 }] }] }).data.exercises.map((e) => e.type); });
  assert(JSON.stringify(types) === '["bodyweight","cardio","cardio","strength"]', 'P3 import: case-insensitive; unknown → cardio with distance, else strength: ' + types);
  await ctx.close();

  // 1 re-save does not re-celebrate; Undo
  {
    const hist = [W('w1', '2026-11-03', 'sq', { lines: [L(225, 3, 5)] }), W('w2', '2026-11-05', 'sq', { lines: [L(235, 3, 5)] })];
    const { ctx: c2, p: q } = await open(browser, { workouts: hist });
    await go(q, '#workouts');
    const openEdit = () => q.evaluate(async () => { const S = await import('./js/store.js'); const F = await import('./js/workoutForm.js'); F.openWorkoutForm(S.getState().workouts.find((w) => w.id === 'w2')); }).then(() => q.waitForTimeout(200));
    await openEdit(); await q.click('.sheet-foot .btn.primary'); await q.waitForTimeout(250);
    let t = await q.textContent('#toasts');
    assert(!t.includes('🏆') && t.includes('Saved Squat'), 'P1 unchanged re-save shows plain saved toast: ' + t.slice(0, 40));
    await q.click('.toast-action'); await q.waitForTimeout(200);
    await openEdit(); await q.click('.sheet button:has-text("Add note")'); await q.fill('.sheet textarea', 'felt good'); await q.click('.sheet-foot .btn.primary'); await q.waitForTimeout(250);
    t = await q.textContent('#toasts');
    assert(!t.includes('🏆'), 'P1 note-only change: no 🏆');
    await q.click('.toast-action'); await q.waitForTimeout(200);
    assert(!(await stored(q)).workouts.find((w) => w.id === 'w2').note, 'P1 Undo still restores the entry');
    await openEdit(); await q.locator('.wo-line input').nth(0).fill('245'); await q.click('.sheet-foot .btn.primary'); await q.waitForTimeout(250);
    t = await q.textContent('#toasts');
    assert(t.includes('🏆 New 3×5 max & 1-rep max: Squat 245 lbs'), 'P1 a raised weight is newly earned and toasts both records: ' + t.slice(0, 60));
    await q.click('.toast-action'); await q.waitForTimeout(200);
    assert((await stored(q)).workouts.find((w) => w.id === 'w2').lines[0].weight === 235, 'P1 Undo reverts the edit');
    await c2.close();
  }

  // 4c colours + 4d chips
  for (const [width, dark] of [[320, false], [320, true], [390, false], [390, true]]) {
    const hist = [W('w1', '2026-11-03', 'sq', { lines: [L(225, 3, 5)] }), W('w3', '2026-11-05', 'run', { distance: 3.1, time: 1500 }), W('w5', '2026-11-12', 'pu', { lines: [L(null, 3, 20)] })];
    const { ctx: c4, p: q } = await open(browser, { workouts: hist, width, dark });
    await go(q, '#stats');
    const cols = await q.$$eval('.split-bar > *', (e) => e.map((x) => getComputedStyle(x).backgroundColor));
    assert(cols.length === 3 && new Set(cols).size === 3, `P4c ${width}${dark ? ' dark' : ''} three distinct split colours ${cols.join(' ')}`);
    await go(q, '#workouts');
    const vis = await q.evaluate(() => { const b = [...document.querySelectorAll('.filter-chip')].find((x) => x.textContent.trim() === 'Cardio').getBoundingClientRect(); return b.right <= document.documentElement.clientWidth && b.width > 0; });
    assert(vis, `P4d ${width}${dark ? ' dark' : ''} "Cardio" chip fully visible`);
    assert(await q.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `P4d ${width} no page overflow`);
    if (width === 320) { await q.screenshot({ path: `${__dirname}/l15-workouts-${dark ? 'dark' : 'light'}.png` }); await go(q, '#stats'); await q.locator('.split-bar').scrollIntoViewIfNeeded(); await q.screenshot({ path: `${__dirname}/l15-stats-${dark ? 'dark' : 'light'}.png` }); }
    await c4.close();
  }
  console.log(errs.join('\n') || 'no console errors');
  await browser.close();
})();
