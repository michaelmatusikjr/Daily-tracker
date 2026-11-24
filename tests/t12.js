// v1.3.1 regression tests for QA round on 1.3.0 (items 1–9).
const { chromium } = require('playwright');
const fs = require('fs');
const SP = __dirname;
const URL = 'http://127.0.0.1:8080/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const NOW = new Date(2026, 10, 12, 10, 0);
const IDX = 'dailyTracker:profiles';
const dk = (id) => 'dailyTracker:data:' + id;
const base = (extra = {}) => ({ version: 4, settings: { onboarded: true, theme: 'light' }, tasks: [], habits: [], logs: {}, journal: {}, exercises: [], workouts: [], ...extra });
const meta = (id, name) => ({ id, name, avatar: { type: 'emoji', emoji: '', color: '#6366f1' } });

/** Seed localStorage once per context (keys → strings), with the "settings moved" tip already seen. */
function seedScript(entries) {
  // Only on app pages: a helper tab on the same origin (e.g. icon.svg in test 2) must not seed again –
  // its write of the legacy key raced with the old-tab write (the cause of the "storage event" flake).
  return `(() => { if (sessionStorage.getItem('seeded') || !(location.pathname.endsWith('/') || location.pathname.endsWith('index.html'))) return; ${Object.entries(entries).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('')}
    if (!localStorage.getItem('dailyTracker:tips')) localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true}'); sessionStorage.setItem('seeded', '1'); })();`;
}
async function context(browser, { seed = {}, width = 390, init = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 820 }, serviceWorkers: 'block', acceptDownloads: true });
  await ctx.addInitScript(seedScript(seed));
  if (init) await ctx.addInitScript(init);
  return ctx;
}
async function page(ctx, { clock = NOW, url = URL } = {}) {
  const p = await ctx.newPage();
  if (clock) await p.clock.install({ time: clock });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(url); await p.waitForTimeout(450);
  return p;
}
const ls = (p, k) => p.evaluate((x) => localStorage.getItem(x), k);
const idx = (p) => p.evaluate((x) => JSON.parse(localStorage.getItem(x)), IDX);
const active = (p) => p.evaluate((x) => { const i = JSON.parse(localStorage.getItem(x)); return JSON.parse(localStorage.getItem('dailyTracker:data:' + i.activeId)); }, IDX);
const go = (p, hash) => p.evaluate((x) => { location.hash = x; }, hash).then(() => p.waitForTimeout(250));

(async () => {
  const browser = await chromium.launch();

  // ===== 1. Unreadable profiles survive export + replace-all import =====
  {
    const index = JSON.stringify({ version: 1, activeId: 'pA', profiles: [meta('pA', 'Ann'), meta('pB', 'Ben')] });
    const ctx = await context(browser, { seed: { [IDX]: index, [dk('pA')]: JSON.stringify(base({ tasks: [{ id: 't', title: 'Ann task', date: '2026-11-12' }] })), [dk('pB')]: '{broken', [dk('pB') + ':backup-1']: '{broken' } });
    const p = await page(ctx);
    const exp = await p.evaluate(async () => (await import('./js/store.js')).exportPayload());
    const b = exp.profiles.find((x) => x.id === 'pB');
    assert(exp.profiles.length === 2 && b.unreadable === true && b.raw === '{broken', '1 export includes the unreadable profile as raw text');
    // Active profile unreadable → its raw text, not an empty placeholder
    await p.evaluate(async () => (await import('./js/store.js')).switchProfile('pB')); await p.waitForTimeout(200);
    assert(await p.locator('.load-fail').count() === 1, '1 unreadable profile shows the load-failure card');
    const exp2 = await p.evaluate(async () => (await import('./js/store.js')).exportPayload());
    assert(exp2.profiles.find((x) => x.id === 'pB').raw === '{broken', '1 active unreadable profile exports its raw text');
    fs.writeFileSync(SP + '/b1-full.json', JSON.stringify(exp2));
    await p.evaluate(async () => (await import('./js/store.js')).switchProfile('pA')); await p.waitForTimeout(200);
    // Import a backup that only contains Ann → must ask before touching Ben
    const onlyAnn = { ...exp, profiles: exp.profiles.filter((x) => x.id === 'pA') };
    fs.writeFileSync(SP + '/b1-ann.json', JSON.stringify(onlyAnn));
    await go(p, '#settings');
    await p.setInputFiles('input[type=file]', SP + '/b1-ann.json'); await p.waitForTimeout(250);
    await p.click('.sheet .btn.danger'); await p.waitForTimeout(300); // Replace all
    assert((await p.textContent('.sheet .dialog-msg')).includes('Ben can’t be read'), '1 separate confirmation for the unreadable profile');
    await p.click('.sheet .btn:has-text("Keep")'); await p.waitForTimeout(350);
    assert((await idx(p)).profiles.some((x) => x.id === 'pB') && await ls(p, dk('pB')) === '{broken' && await ls(p, dk('pB') + ':backup-1') === '{broken', '1 "Keep": Ben, its data key and backup survive');
    // Restore the full export (with Ben's raw text): the guard stays intact
    await go(p, '#settings');
    await p.setInputFiles('input[type=file]', SP + '/b1-full.json'); await p.waitForTimeout(250);
    await p.click('.sheet .btn.danger'); await p.waitForTimeout(350);
    assert(await ls(p, dk('pB')) === '{broken', '1 import restores raw text of unreadable profile');
    assert(await p.locator('.load-fail').count() === 1, '1 restored unreadable profile still protected by the guard');
    await ctx.close();
  }

  // ===== 2. Legacy key written by an old tab after the upgrade =====
  {
    const legacy = JSON.stringify({ version: 3, settings: { onboarded: true }, tasks: [{ id: 'old', title: 'Original', date: '2026-11-12', createdAt: 1 }], habits: [], logs: {}, journal: {} });
    const ctx = await context(browser, { seed: { 'dailyTracker:data': legacy } });
    const p = await page(ctx);
    await p.click('.sheet-foot .btn.ghost'); await p.waitForTimeout(300); // skip intro
    const i0 = await idx(p);
    assert(i0.migratedLegacy && i0.migratedLegacy.hash && i0.migratedLegacy.profileId === i0.activeId, '2 migration recorded in the index');
    // New-version edit after the upgrade (stamped) + old tab writes later
    await p.evaluate(async () => { const S = await import('./js/store.js'); S.update((s) => { s.tasks.push({ id: 'new13', title: 'Made in 1.3', date: '2026-11-12', createdAt: Date.now(), updatedAt: Date.now() }); }); });
    const oldTab = JSON.stringify({ version: 3, settings: { onboarded: true }, tasks: [{ id: 'old', title: 'Original (edited in old tab)', date: '2026-11-12', createdAt: 1 }, { id: 'oldnew', title: 'Added in old tab', date: '2026-11-12', createdAt: 5 }], habits: [], logs: {}, journal: { '2026-11-11': { mood: 3, note: 'old tab note' } } });
    const p2 = await ctx.newPage(); await p2.goto('about:blank');
    await p2.goto(URL.replace(/\/$/, '') + '/icons/icon.svg'); // same origin page that doesn't run the app
    await p2.evaluate((v) => localStorage.setItem('dailyTracker:data', v), oldTab);
    // Wait for the sheet (the storage event + sheet animation can be slow under load) instead of a fixed delay.
    await p.waitForFunction(() => [...document.querySelectorAll('.sheet-title')].some((t) => t.textContent === 'Changes from an older version'), null, { timeout: 8000 }).catch(() => {});
    assert([...await p.$$eval('.sheet-title', (t) => t.map((x) => x.textContent))].includes('Changes from an older version'), '2 storage event → sheet appears in the open tab');
    await p.click('.sheet .btn:has-text("Merge into")'); await p.waitForTimeout(300);
    const s = await active(p);
    const titles = s.tasks.map((t) => t.title).sort();
    assert(JSON.stringify(titles) === JSON.stringify(['Added in old tab', 'Made in 1.3', 'Original (edited in old tab)']) && s.journal['2026-11-11']?.note === 'old tab note', '2 merge by id: old-tab additions + edits in, new-version items kept');
    assert(await ls(p, 'dailyTracker:data') === null, '2 legacy key removed after merging');
    // Startup path + "Add as new profile"
    await p2.evaluate((v) => localStorage.setItem('dailyTracker:data', v), oldTab.replace('Added in old tab', 'Second round'));
    await p.reload(); await p.waitForTimeout(800);
    assert((await p.textContent('.sheet-title').catch(() => '')) === 'Changes from an older version', '2 shown on startup too');
    await p.click('.sheet .btn:has-text("Add as new profile")'); await p.waitForTimeout(400);
    const i1 = await idx(p);
    assert(i1.profiles.length === 2 && i1.profiles.find((x) => x.id === i1.activeId).name === 'Older version', '2 "Add as new profile"');
    // Discard (with confirmation)
    await p2.evaluate((v) => localStorage.setItem('dailyTracker:data', v), oldTab.replace('Added in old tab', 'Third'));
    await p.waitForTimeout(400);
    await p.click('.sheet .btn:has-text("Discard")'); await p.waitForTimeout(250);
    await p.click('.sheet .btn.danger'); await p.waitForTimeout(300);
    assert(await ls(p, 'dailyTracker:data') === null && (await idx(p)).profiles.length === 2, '2 "Discard" removes the legacy key only');
    await ctx.close();
  }

  // ===== 3. No fake records when units are mixed =====
  {
    const ctx = await context(browser, { seed: { [IDX]: JSON.stringify({ version: 1, activeId: 'p', profiles: [meta('p', 'Me')] }), [dk('p')]: JSON.stringify(base()) } });
    const p = await page(ctx);
    const r = await p.evaluate(async () => {
      const W = await import('./js/workouts.js');
      const st = (unitSetting, ws, du = 'mi') => ({ settings: { weightUnit: unitSetting, distanceUnit: du }, exercises: [{ id: 'e', name: 'Sq', type: 'strength' }, { id: 'c', name: 'Run', type: 'cardio' }], workouts: ws });
      const w = (id, date, weight, unit, reps = 5) => ({ id, date, exerciseId: 'e', lines: [{ weight, sets: 3, reps }], weightUnit: unit, time: null, distance: null, distanceUnit: 'mi', createdAt: 1 });
      const tie = W.computeRecords(st('lb', [w('a', '2026-11-01', 100, 'kg'), w('b', '2026-11-02', 220.5, 'lb')]), 'e').records.size;
      const tie2 = W.computeRecords(st('kg', [w('a', '2026-11-01', 225, 'lb'), w('b', '2026-11-02', 102, 'kg')]), 'e').records.size;
      const real = W.computeRecords(st('lb', [w('a', '2026-11-01', 100, 'kg'), w('b', '2026-11-02', 225, 'lb')]), 'e').records.size;
      const run = (id, date, km, unit, t) => ({ id, date, exerciseId: 'c', lines: [], weightUnit: 'lb', time: t, distance: km, distanceUnit: unit, createdAt: 1 });
      const dtie = W.computeRecords(st('mi', [run('a', '2026-11-01', 5, 'km', 1800), run('b', '2026-11-02', 3.11, 'mi', 1800)]), 'c').records.size;
      return { tie, tie2, real, dtie };
    });
    assert(r.tie === 0 && r.tie2 === 0, '3 converted equal weights are ties, not records');
    assert(r.real === 1, '3 a real heavier lift is still a record');
    assert(r.dtie === 0, '3 5 km vs 3.11 mi (same distance) is not a record');
    await ctx.close();
  }

  // ===== 4. Time parsing rules + live hint =====
  {
    const ctx = await context(browser, { seed: { [IDX]: JSON.stringify({ version: 1, activeId: 'p', profiles: [meta('p', 'Me')] }), [dk('p')]: JSON.stringify(base({ exercises: [{ id: 'c', name: 'Run', type: 'cardio' }, { id: 's', name: 'Plank', type: 'strength' }] })) } });
    const p = await page(ctx);
    const r = await p.evaluate(async () => {
      const W = await import('./js/workouts.js');
      const t = (s, type = 'cardio', flip = false) => { const x = W.readTime(s, type, flip); return x.error ? 'ERR' : x.sec; };
      return {
        a: t('25:30'), b: t('1:15'), c: t('5:59'), d: t('6:00'), e: t('1:02:03'), f: t('25m30s'), g: t('1h15m'), h: t('45s'),
        i: t('1:30', 'strength'), j: t('6:30', 'cardio', true), k: t('1:15', 'cardio', true), l: t('1,000'), m: t('2,5'), n: t('25:00:00'), o: t('45'), q: t('45', 'strength'),
        amb: W.readTime('6:30', 'cardio').ambiguous, txt: W.readTime('6:30', 'cardio').text, alt: W.readTime('6:30', 'cardio').altText, amb25: W.readTime('25:30', 'cardio').ambiguous,
      };
    });
    assert(r.a === 1530 && r.d === 360 && r.b === 4500 && r.c === 21540, '4 cardio a:bb → m:ss when a ≥ 6, h:mm when a ≤ 5');
    assert(r.e === 3723 && r.f === 1530 && r.g === 4500 && r.h === 45 && r.o === 2700 && r.q === 45, '4 h:mm:ss, 25m30s, 1h15m, 45s, plain numbers');
    assert(r.i === 90, '4 strength 1:30 = 90 s');
    assert(r.j === 23400 && r.k === 75, '4 flipping an ambiguous reading');
    assert(r.l === 'ERR' && r.m === 150 && r.n === 'ERR', '4 "1,000" rejected, "2,5" decimal, > 24 h rejected');
    assert(r.amb && r.txt === '6 min 30 s' && r.alt === '6 h 30 min' && !r.amb25, '4 ambiguity: 6:30 can be either; 25:30 can only be m:ss');
    await go(p, '#workouts'); await p.click('.fab'); await p.click('.ex-chip:has-text("Run")'); await p.waitForTimeout(150);
    await p.fill('#wo-time', '25:30'); await p.waitForTimeout(100);
    assert((await p.textContent('.time-hint')) === '= 25 min 30 s', '4 live hint under the field');
    await p.fill('#wo-time', '6:30'); await p.waitForTimeout(100);
    assert((await p.textContent('.time-hint')).startsWith('= 6 min 30 s · tap if you meant 6 h 30 min'), '4 ambiguous value offers the other reading');
    await p.click('.time-hint'); await p.waitForTimeout(100);
    assert((await p.textContent('.time-hint')).startsWith('= 6 h 30 min'), '4 tapping the hint flips the reading');
    await p.fill('#wo-time', '25:30'); await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(300);
    assert((await active(p)).workouts[0].time === 1530, '4 "25:30" saved as 25 min 30 s');
    await ctx.close();
  }

  // ===== 5. No drift on unchanged edits in the other unit =====
  {
    const ws = [
      { id: 'w1', date: '2026-11-10', exerciseId: 's', lines: [{ weight: 100, sets: 3, reps: 5 }], weightUnit: 'kg', time: null, distance: null, distanceUnit: 'mi', createdAt: 1 },
      { id: 'w2', date: '2026-11-10', exerciseId: 'c', lines: [], weightUnit: 'lb', time: 1800, distance: 5, distanceUnit: 'km', createdAt: 2 },
      { id: 'w3', date: '2026-11-11', exerciseId: 's', lines: [{ weight: 60, sets: 3, reps: 5 }, { weight: 70, sets: 1, reps: 3 }], weightUnit: 'kg', time: null, distance: null, distanceUnit: 'mi', createdAt: 3 },
    ];
    const ctx = await context(browser, { seed: { [IDX]: JSON.stringify({ version: 1, activeId: 'p', profiles: [meta('p', 'Me')] }), [dk('p')]: JSON.stringify(base({ settings: { onboarded: true, weightUnit: 'lb', distanceUnit: 'mi' }, exercises: [{ id: 's', name: 'Squat', type: 'strength' }, { id: 'c', name: 'Run', type: 'cardio' }], workouts: ws })) } });
    const p = await page(ctx);
    const editSave = async (id) => {
      await p.evaluate(async (x) => { const S = await import('./js/store.js'); const F = await import('./js/workoutForm.js'); F.openWorkoutForm(S.getState().workouts.find((w) => w.id === x)); }, id);
      await p.waitForTimeout(200); await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(250);
    };
    const get = async (id) => (await active(p)).workouts.find((w) => w.id === id);
    await editSave('w1');
    let w1 = await get('w1');
    assert(w1.weightUnit === 'kg' && w1.lines[0].weight === 100 && !w1.lines[0].unit, '5 kg entry saved unchanged in lb mode → still 100 kg');
    await p.evaluate(async () => (await import('./js/store.js')).update((s) => { s.settings.weightUnit = 'kg'; }));
    await editSave('w1'); w1 = await get('w1');
    assert(w1.weightUnit === 'kg' && w1.lines[0].weight === 100, '5 round trip kg → lb → kg: no drift');
    await p.evaluate(async () => (await import('./js/store.js')).update((s) => { s.settings.weightUnit = 'lb'; }));
    await editSave('w2');
    const w2 = await get('w2');
    assert(w2.distanceUnit === 'km' && w2.distance === 5, '5 km entry saved unchanged in mi mode → still 5 km');
    // Change one line of a two-line kg entry in lb mode
    await p.evaluate(async () => { const S = await import('./js/store.js'); const F = await import('./js/workoutForm.js'); F.openWorkoutForm(S.getState().workouts.find((w) => w.id === 'w3')); });
    await p.waitForTimeout(200);
    await p.locator('.wo-line').nth(1).locator('input').nth(0).fill('160');
    await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(250);
    const w3 = await get('w3');
    const l0 = w3.lines[0], l1 = w3.lines[1];
    assert(l0.weight === 60 && (l0.unit || w3.weightUnit) === 'kg' && l1.weight === 160 && (l1.unit || w3.weightUnit) === 'lb', '5 only the changed line is re-stored in the current unit');
    await ctx.close();
  }

  // ===== 6. Stale tabs: index merge + storage events =====
  {
    const ctx = await context(browser, { seed: { [IDX]: JSON.stringify({ version: 1, activeId: 'pA', profiles: [meta('pA', 'Ann')] }), [dk('pA')]: JSON.stringify(base()) } });
    const p1 = await page(ctx, { clock: null });
    const p2 = await page(ctx, { clock: null });
    await p1.evaluate(async () => (await import('./js/store.js')).addProfile({ name: 'Bea' }));
    await p1.waitForTimeout(200);
    // p2's in-memory index may be stale; renaming Ann must not drop Bea
    await p2.evaluate(async () => { const S = await import('./js/store.js'); S.updateProfile('pA', { name: 'Ann B' }); });
    const names = (await idx(p1)).profiles.map((x) => x.name).sort();
    assert(JSON.stringify(names) === '["Ann B","Bea"]', '6 stale tab’s save merges the index (no orphaned profile)');
    // p2 switches to Bea; p1 deletes Bea → p2 switches gracefully
    const beaId = (await idx(p1)).profiles.find((x) => x.name === 'Bea').id;
    await p2.evaluate(async (id) => (await import('./js/store.js')).switchProfile(id), beaId); await p2.waitForTimeout(200);
    await p1.evaluate(async () => { const S = await import('./js/store.js'); if (S.getActiveProfile().name === 'Bea') S.switchProfile('pA'); });
    await p1.evaluate(async (id) => (await import('./js/store.js')).deleteProfile(id), beaId); await p1.waitForTimeout(400);
    assert(await p2.evaluate(async () => (await import('./js/store.js')).getActiveProfile().name) === 'Ann B' && (await p2.textContent('#toasts')).includes('deleted in another window'), '6 active profile deleted elsewhere → switched with a message');
    // Data edited in the other tab shows up
    await p1.evaluate(async () => (await import('./js/store.js')).update((s) => { s.tasks.push({ id: 'x', title: 'From tab 1', date: '2026-11-12', createdAt: 1 }); }));
    await p2.waitForTimeout(300); await go(p2, '#today');
    assert((await p2.textContent('.view')).includes('From tab 1'), '6 other tab’s data change re-renders');
    await ctx.close();
  }

  // ===== 7. Storage full: persistent banner, no success toast =====
  {
    const full = `(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (window.__full && String(k).startsWith('dailyTracker:data:')) throw new DOMException('full', 'QuotaExceededError'); return set.call(this, k, v); }; })();`;
    const ctx = await context(browser, { seed: { [IDX]: JSON.stringify({ version: 1, activeId: 'p', profiles: [meta('p', 'Me')] }), [dk('p')]: JSON.stringify(base()) }, init: full });
    const p = await page(ctx);
    await p.evaluate(() => { window.__full = true; });
    await p.click('.fab'); await p.fill('.qa-input', 'Will not save'); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
    assert(await p.locator('#save-banner').isVisible() && (await p.textContent('#save-banner')).includes('Not saved – storage is full'), '7 persistent "Not saved" banner');
    assert(!(await p.textContent('#toasts')).includes('Added'), '7 success toast suppressed');
    await p.waitForTimeout(5000);
    assert(await p.locator('#save-banner').isVisible(), '7 banner stays');
    await p.evaluate(() => { window.__full = false; });
    await p.click('.fab'); await p.fill('.qa-input', 'Saves now'); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
    assert(!(await p.locator('#save-banner').isVisible()), '7 banner hides after a successful save');
    await ctx.close();
  }

  // ===== 8. Habit-link edge cases =====
  {
    const habits = [{ id: 'hA', name: 'Gym', createdAt: '2026-11-01' }, { id: 'hB', name: 'Move', createdAt: '2026-11-01' }];
    const data = base({ habits, settings: { onboarded: true, workoutHabit: { habitId: 'hA', filter: 'any' } },
      exercises: [{ id: 'pl', name: 'Plank', type: 'strength' }],
      workouts: [{ id: 'w', date: '2026-11-10', exerciseId: 'pl', lines: [], weightUnit: 'lb', time: 60, distance: null, distanceUnit: 'mi', createdAt: 1 }],
      logs: { hA: { '2026-11-10': 1, '2026-11-09': 1 } }, autoHabit: { hA: { '2026-11-10': true } } });
    const ctx = await context(browser, { seed: { [IDX]: JSON.stringify({ version: 1, activeId: 'p', profiles: [meta('p', 'Me')] }), [dk('p')]: JSON.stringify(data) } });
    const p = await page(ctx);
    await go(p, '#settings');
    await p.selectOption('select[aria-label="Habit to check off when you log a workout"]', 'hB'); await p.waitForTimeout(200);
    let s = await active(p);
    assert(!s.logs.hA['2026-11-10'] && s.logs.hA['2026-11-09'] === 1 && !s.autoHabit.hA, '8 changing the linked habit removes the old habit’s auto checks only');
    // Cardio-only filter, then Plank becomes cardio → re-sync checks hB on its date
    await p.click('.segmented button:has-text("Cardio")'); await p.waitForTimeout(150);
    await p.evaluate(async () => { const A = await import('./js/actions.js'); const S = await import('./js/store.js'); S.update((st) => { st.exercises[0].type = 'cardio'; A.resyncExerciseDates(st, 'pl'); }); });
    s = await active(p);
    assert(s.logs.hB?.['2026-11-10'] === 1 && s.autoHabit.hB?.['2026-11-10'], '8 exercise type change re-syncs its dates');
    await go(p, '#exercise/pl'); await p.click('[aria-label="Edit Plank"]'); await p.click('.sheet .segmented button:has-text("Strength")'); await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(250);
    s = await active(p);
    assert(!s.logs.hB?.['2026-11-10'], '8 switching back via the editor un-checks (auto only)');
    // Linked habit becomes a count habit → link cleared + note
    await p.evaluate(async () => { const A = await import('./js/actions.js'); A.saveHabit({ id: 'hB', name: 'Move', goal: { type: 'count', target: 3, unit: '' } }); });
    await p.waitForTimeout(200);
    s = await active(p);
    assert(s.settings.workoutHabit.habitId === null && (await p.textContent('#toasts')).includes('Workout link removed'), '8 count goal clears the link with a note');
    await ctx.close();
  }

  // ===== 9. Polish: desktop Settings nav, avatar affordance, one-time tip, caps =====
  {
    const seed = { [IDX]: JSON.stringify({ version: 1, activeId: 'p', profiles: [meta('p', 'Me')] }), [dk('p')]: JSON.stringify(base({ exercises: [{ id: 's', name: 'Squat', type: 'strength' }] })) };
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, serviceWorkers: 'block' });
    await ctx.addInitScript(`(() => { if (sessionStorage.getItem('s')) return; ${Object.entries(seed).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('')} sessionStorage.setItem('s', 1); })();`);
    const p = await page(ctx);
    assert(await p.locator('.nav-item[data-tab="settings"]').isVisible(), '9 desktop side nav has Settings');
    assert(await p.locator('.avatar-btn[aria-label^="Profile and settings"]').count() === 1 && await p.locator('.avatar-chevron').count() === 0, '9 avatar has no chevron (v1.14) and a "Profile and settings" label');
    assert(await p.locator('.coach-tip').isVisible() && (await p.textContent('.coach-tip')).includes('Settings moved here'), '9 one-time “Settings moved here” tip');
    await p.click('.coach-tip .link-btn'); await p.reload(); await p.waitForTimeout(400);
    assert(await p.locator('.coach-tip').count() === 0, '9 tip not shown again');
    await p.setViewportSize({ width: 390, height: 820 }); await p.waitForTimeout(100);
    assert(!(await p.locator('.nav-item[data-tab="settings"]').isVisible()), '9 no Settings tab on mobile');
    // Caps + thousands separator
    await go(p, '#workouts'); await p.click('.fab'); await p.click('.ex-chip:has-text("Squat")'); await p.waitForTimeout(150);
    const row = p.locator('.wo-line').nth(0).locator('input');
    await row.nth(2).fill('2000'); await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(100);
    assert((await p.textContent('.sheet .form-error')).includes('Reps: max 1000'), '9 reps cap');
    await row.nth(2).fill('5'); await row.nth(1).fill('101'); await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(100);
    assert((await p.textContent('.sheet .form-error')).includes('Sets: max 100'), '9 sets cap');
    await row.nth(1).fill('3'); await row.nth(0).fill('1,000'); await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(100);
    assert((await p.textContent('.sheet .form-error')).includes('thousands separators'), '9 "1,000" explained');
    await row.nth(0).fill('2500'); await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(100);
    assert((await p.textContent('.sheet .form-error')).includes('max 2000 lbs'), '9 weight cap');
    const clamp = await p.evaluate(async () => {
      const S = await import('./js/store.js');
      const d = S.validateImport({ version: 4, tasks: [], habits: [], exercises: [{ id: 'e', name: 'X', type: 'strength' }],
        workouts: [{ id: 'a', date: '2026-11-01', exerciseId: 'e', lines: [{ weight: 9999, sets: 500, reps: 5000 }], weightUnit: 'kg', time: 999999, distance: 5000, distanceUnit: 'km' }] }).data;
      const w = d.workouts[0];
      return [w.lines[0].weight, w.lines[0].sets, w.lines[0].reps, w.time, w.distance];
    });
    assert(JSON.stringify(clamp) === '[1000,100,1000,86400,1000]', '9 import caps ' + JSON.stringify(clamp));
    await ctx.close();
  }

  console.log(errs.join('\n') || 'no console errors');
  await browser.close();
})();
