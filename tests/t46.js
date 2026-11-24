// 1.16.0 #31: Settings › Storage and "Clear completed tasks" (bulk clear by date, preview, Undo, photos).
const { chromium } = require('playwright');
const URL = 'http://127.0.0.1:8080/';
const SHOTS = process.env.SHOTS || '';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const NOW = new Date(2026, 10, 18, 10, 0);
const TODAY = '2026-11-18';
const at = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 12).getTime(); };
const task = (id, title, o = {}) => ({ id, title, notes: '', date: TODAY, time: null, duration: null, priority: 0, category: null, reminder: null, reminderAt: null, recur: { type: 'none', days: [], interval: 2 }, done: false, doneDates: {}, exceptions: [], order: 1, createdAt: 1, ...o });
const done = (id, title, k, o = {}) => task(id, title, { date: k, done: true, completedAt: at(k), ...o });
const att = (id) => ({ id, w: 10, h: 10, type: 'image/jpeg' });
const habit = (id, name) => ({ id, name, emoji: '💧', color: '#0ea5e9', goal: { type: 'check', target: 1, unit: '' }, schedule: { type: 'daily', days: [] }, reminder: null, target: null, archived: false, order: 1, createdAt: '2026-01-01' });
const allExc = []; { let d = new Date(2025, 0, 2, 12); for (let i = 0; i < 1500; i++) { allExc.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`); d.setDate(d.getDate() + 1); } }
const mkData = () => ({
  version: 6, settings: { onboarded: true, theme: 'light', accent: 'indigo', weekStart: 1, timeFormat: '12', notifications: false }, categories: [],
  tasks: [
    done('a', 'Recent', '2026-11-10', { attachments: [att('p1')] }),
    done('b', 'Sept one', '2026-09-01'),
    done('c', 'June one', '2026-06-01', { attachments: [att('p2')] }),
    done('d', 'Ancient one', '2025-05-01', { attachments: [att('p3')] }),
    done('h', 'Old shared photo', '2025-06-01', { attachments: [att('p5')] }),
    task('g', 'Open, same photo', { date: '2026-01-01', attachments: [att('p5')] }),
    task('r1', 'Running daily', { date: '2026-01-01', recur: { type: 'daily', days: [], interval: 1 }, doneDates: { '2026-02-01': true } }),
    task('r2', 'Finished series', { date: '2025-01-01', recur: { type: 'daily', days: [], interval: 1 }, doneDates: { '2025-01-01': true }, exceptions: allExc }),
    done('f', 'Early copy', '2026-06-05', { earlyOf: { id: 'r1', date: '2026-07-01' } }),
  ],
  habits: [habit('h1', 'Water')], logs: { h1: { '2026-01-01': 1 } }, journal: { '2026-01-02': { mood: 3, note: 'old' } }, exercises: [], workouts: [],
});

async function open(browser, { data = mkData(), hash = '', scheme = 'light', synced = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', colorScheme: scheme, deviceScaleFactor: 1 });
  await ctx.addInitScript(([d, sy]) => {
    if (localStorage.getItem('dailyTracker:profiles')) return;
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles: [{ id: 'p', name: 'Mick', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }] }));
    localStorage.setItem('dailyTracker:data:p', d);
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
    if (sy) localStorage.setItem('dailyTracker:sync', JSON.stringify({ accountId: 'acc1', synced: ['p'] }));
  }, [JSON.stringify(data), synced]);
  await ctx.route('**/daily-tracker-push.michael-matusik-jr.workers.dev/**', (r) => r.abort());
  const p = await ctx.newPage();
  await p.clock.install({ time: NOW });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push(m.text()); });
  await p.goto(URL + hash); await p.waitForTimeout(600);
  await p.evaluate(async () => { const a = await import('./js/attachments.js'); const blob = new Blob([new Uint8Array(2000)], { type: 'image/jpeg' });
    for (const id of ['p1', 'p2', 'p3', 'p5', 'p9']) await a.putFile({ id, profileId: 'p', taskId: null, blob, thumbBlob: new Blob([new Uint8Array(100)]), type: 'image/jpeg', w: 10, h: 10, size: 2000, createdAt: Date.now() }); });
  return { ctx, p };
}
const norm = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
const stored = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('dailyTracker:data:p')));
const ids = async (p) => (await stored(p)).tasks.map((t) => t.id).sort().join(',');
const files = (p) => p.evaluate(async () => (await (await import('./js/attachments.js')).allFiles()).map((f) => f.id).sort().join(','));
const go = (p, hash) => p.evaluate((x) => { location.hash = x; }, hash).then(() => p.waitForTimeout(500));
const sheetText = (p) => p.locator('.sheet-root.open .sheet').last().innerText();
const preview = async (p) => { await p.waitForTimeout(400); return (await p.locator('.clear-preview').innerText()).replace(/\s+/g, ' '); };
async function openSheet(p) { await go(p, 'settings'); await p.getByRole('button', { name: /Clear completed tasks…/ }).click(); await p.waitForTimeout(500); }
const pickSeg = async (p, name) => { await p.locator('.clear-sheet [role=radio], .clear-sheet .seg button').filter({ hasText: name }).first().click(); };

(async () => {
  const browser = await chromium.launch();
  try {
    let { ctx, p } = await open(browser);
    const before = await stored(p);
    await go(p, 'settings');
    const sec = await p.locator('#set-storage').innerText();
    assert(/storage/i.test(sec) && /App data/i.test(sec) && /Photos/i.test(sec) && /KB|MB/.test(sec), 'Settings has a Storage section with sizes');
    assert(/in Mick/.test(sec) && /\d photo/.test(sec) || /photos? ·/.test(sec), 'photos line shows this profile');
    if (SHOTS) await p.locator('#set-storage').screenshot({ path: SHOTS + '/storage-light.png' });

    await openSheet(p);
    assert(/Clear completed tasks/.test(await sheetText(p)), 'sheet opens from Settings');
    await pickSeg(p, '1 month');
    let t = await preview(p);
    assert(/6 completed tasks/.test(t) && /2 photos/.test(t) && /Frees about/.test(t), '1 month pick: 6 tasks, 2 photos (shared photo kept): ' + t);
    if (SHOTS) await p.locator('.sheet-root.open .sheet').last().screenshot({ path: SHOTS + '/sheet-light.png' });
    await pickSeg(p, '3 months'); t = await preview(p);
    assert(/5 completed tasks/.test(t) && /2 photos/.test(t), '3 months pick: 5 tasks, 2 photos: ' + t);
    await pickSeg(p, '1 year'); t = await preview(p);
    assert(/3 completed tasks/.test(t) && /1 photo\b/.test(t), '1 year pick: 3 tasks, 1 photo: ' + t);
    await pickSeg(p, 'Custom'); await p.locator('.clear-sheet input[type=date]').fill('2026-06-03'); await p.locator('.clear-sheet input[type=date]').dispatchEvent('change');
    t = await preview(p);
    assert(/4 completed tasks/.test(t) && /2 photos/.test(t) && /Jun 3/.test(t), 'custom date 2026-06-03: 4 tasks (early copy of Jun 5 stays), short month: ' + t);
    await p.locator('.clear-sheet input[type=date]').fill('2020-01-01'); await p.locator('.clear-sheet input[type=date]').dispatchEvent('change');
    t = await preview(p);
    assert(/No completed tasks/.test(t) && await p.getByRole('button', { name: /^Clear…/ }).isDisabled(), 'nothing to clear: message, button disabled');

    // Clear with 3 months, then Undo
    await pickSeg(p, '3 months'); await preview(p);
    await p.getByRole('button', { name: /^Clear…/ }).click(); await p.waitForTimeout(400);
    const cf = await sheetText(p);
    assert(/Delete 5 completed tasks/.test(cf) && /only affects this device/.test(cf) && !/account/.test(cf), 'confirm wording (device only)');
    await p.locator('.sheet-root.open .btn.danger').last().click(); await p.waitForTimeout(500);
    assert(await ids(p) === 'a,b,g,r1', 'cleared: kept recent, Sept, open, running series -> ' + await ids(p));
    let after = await stored(p);
    assert(norm(after.habits) === norm(before.habits) && norm(after.logs) === norm(before.logs) && norm(after.journal) === norm(before.journal) && after.workouts.length === 0, 'habits, logs, journal, workouts untouched');
    assert(/Cleared 5 completed tasks/.test(await p.locator('.toast').innerText()), 'toast with count');
    await p.clock.runFor(2000);
    assert((await files(p)).includes('p2') && (await files(p)).includes('p3'), 'photos not destroyed during the Undo window');
    // a remote edit arrives meanwhile: Undo must keep it
    await p.evaluate(async () => { (await import('./js/store.js')).update((s) => { s.tasks.find((x) => x.id === 'a').title = 'Edited elsewhere'; }); });
    await p.locator('#toasts .toast-action').click(); await p.waitForTimeout(400);
    after = await stored(p);
    assert(await ids(p) === 'a,b,c,d,f,g,h,r1,r2', 'Undo restores exactly those tasks by id');
    assert(after.tasks.find((x) => x.id === 'a').title === 'Edited elsewhere', 'Undo merges, never restores an old snapshot');
    assert(after.tasks.find((x) => x.id === 'c').attachments[0].id === 'p2', 'restored task keeps its photo link');
    await p.clock.runFor(30000); await p.waitForTimeout(300);
    assert(await files(p) === 'p1,p2,p3,p5,p9', 'after Undo the photos stay: ' + await files(p));

    // Clear again, let the Undo window pass
    await go(p, 'completed');
    assert(await p.getByText(/Clear old completed tasks/).count() === 1, 'Completed screen has the shortcut');
    await p.getByText(/Clear old completed tasks/).click(); await p.waitForTimeout(500);
    assert(/Clear completed tasks/.test(await sheetText(p)), 'shortcut opens the sheet');
    await pickSeg(p, '3 months'); await preview(p);
    await p.getByRole('button', { name: /^Clear…/ }).click(); await p.waitForTimeout(300);
    await p.locator('.sheet-root.open .btn.danger').last().click(); await p.waitForTimeout(400);
    await p.clock.runFor(30000); await p.waitForTimeout(500);
    assert(await files(p) === 'p1,p5,p9', 'photos removed after the Undo window, shared/recent/unrelated ones kept: ' + await files(p));
    assert(await ids(p) === 'a,b,g,r1', 'tasks stay cleared');

    // Storage-full banner links to Storage
    await go(p, 'today');
    await p.evaluate(() => { document.getElementById('save-banner').hidden = false; });
    await p.evaluate(() => document.querySelector('#toasts').replaceChildren()); await p.locator('#save-banner [data-action=storage]').dispatchEvent('click'); await p.waitForTimeout(700);
    assert((await p.evaluate(() => location.hash)) === '#settings' && await p.locator('#set-storage').isVisible(), 'storage-full banner links to Settings › Storage');
    assert(await p.evaluate(() => { const r = document.getElementById('set-storage').getBoundingClientRect(); return r.top < 300; }), 'and scrolls to it');
    await ctx.close();


    // ===== Running repeating tasks: old completions are cleared, the task keeps its schedule =====
    {
      const d = mkData();
      const days = []; { let x = new Date(2026, 6, 1, 12); for (let i = 0; i < 100; i++) { days.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`); x.setDate(x.getDate() + 1); } }
      d.tasks = [
        task('dd', 'Daily', { date: '2026-07-01', recur: { type: 'daily', days: [], interval: 1 }, doneDates: Object.fromEntries(days.map((k) => [k, true])), doneAt: Object.fromEntries(days.map((k) => [k, at(k)])), exceptions: ['2026-07-05', '2026-10-30'] }),
        task('wk', 'Weekly', { date: '2026-01-05', recur: { type: 'weekly', days: [1], interval: 1 }, doneDates: { '2026-03-02': true } }),
        task('mo', 'Monthly', { date: '2026-01-31', recur: { type: 'monthly', days: [], interval: 1 }, doneDates: { '2026-02-28': true } }),
        task('iv', 'Every 3', { date: '2026-01-01', recur: { type: 'interval', days: [], interval: 3 }, doneDates: { '2026-01-04': true } }),
      ];
      ({ ctx, p } = await open(browser, { data: d }));
      await openSheet(p); await pickSeg(p, '3 months'); t = await preview(p);
      assert(/Also clears 51 completions? of 4 repeating tasks before Aug 18, 2026\. The tasks keep repeating\./.test(t) && /0 completed tasks/.test(t), 'preview: completions of repeating tasks, tasks keep repeating: ' + t);
      assert(/Also clears 51 completions of 4 repeating/.test(t), '48 daily + 3 others... exact count: ' + t);
      await p.getByRole('button', { name: /^Clear…/ }).click(); await p.waitForTimeout(300);
      assert(/old completions of repeating tasks \(the tasks stay\)/.test(await sheetText(p)), 'confirm wording mentions completions');
      await p.locator('.sheet-root.open .btn.danger').last().click(); await p.waitForTimeout(500);
      let st = await stored(p);
      const dd = st.tasks.find((x) => x.id === 'dd');
      assert(st.tasks.length === 4 && dd.clearedBefore === '2026-08-18' && dd.date === '2026-07-01', 'tasks kept, clearedBefore set, date anchor untouched');
      assert(Object.keys(dd.doneDates).length === 52 && Object.keys(dd.doneAt).length === 52 && Object.keys(dd.doneDates).every((k) => k >= '2026-08-18') && !dd.exceptions.includes('2026-07-05') && dd.exceptions.includes('2026-10-30'), 'old completions/exceptions removed, later ones kept');
      assert(st.tasks.find((x) => x.id === 'wk').date === '2026-01-05' && st.tasks.find((x) => x.id === 'mo').date === '2026-01-31' && st.tasks.find((x) => x.id === 'iv').date === '2026-01-01', 'weekly/monthly/interval anchors unchanged');
      const chk = await p.evaluate(async () => {
        const L = await import('./js/logic.js'), S = await import('./js/store.js'), C = await import('./js/views/completed.js');
        const s = S.getState(); const g = (id) => s.tasks.find((x) => x.id === id);
        return {
          before: s.tasks.map((t) => L.occursOn(t, '2026-07-10') || L.occursOn(t, '2026-08-17') || L.occursOn(t, '2026-03-02')),
          overdue: L.overdueTasks(s, '2026-11-18').length,
          wk: [L.occursOn(g('wk'), '2026-09-07'), L.occursOn(g('wk'), '2026-09-08')], mo: [L.occursOn(g('mo'), '2026-09-30'), L.occursOn(g('mo'), '2026-09-29')],
          iv: [L.occursOn(g('iv'), '2026-09-07'), L.occursOn(g('iv'), '2026-09-08')], dd: L.occursOn(g('dd'), '2026-08-18'),
          completedBefore: C.completedEntries(s).filter((e) => e.k < '2026-08-18').length, future: L.futureTasks(s, '2026-11-18').soon.length,
        };
      });
      assert(chk.before.every((x) => !x) && chk.overdue === 0 && chk.completedBefore === 0, 'no occurrences, overdue or completed entries before the date');
      assert(chk.wk[0] && !chk.wk[1] && chk.mo[0] && !chk.mo[1] && chk.iv[0] && !chk.iv[1] && chk.dd, 'weekly Mon, monthly 31st->30th, every-3-days and daily still land on their days');
      await go(p, 'completed'); const ctext = await p.locator('.view-completed').innerText();
      assert(!/Jul \d|Aug 1[0-7]\b/.test(ctext), 'Completed screen shows nothing before the date');
      await go(p, 'calendar');
      // Undo, with a completion added meanwhile
      await p.evaluate(async () => { (await import('./js/store.js')).update((s) => { s.tasks.find((x) => x.id === 'dd').doneDates['2026-11-18'] = true; }); });
      await p.locator('#toasts .toast-action').click(); await p.waitForTimeout(400);
      st = await stored(p);
      const d2 = st.tasks.find((x) => x.id === 'dd');
      assert(d2.clearedBefore === undefined && Object.keys(d2.doneDates).length === 101 && d2.doneDates['2026-11-18'] === true && d2.doneDates['2026-07-01'] && d2.exceptions.includes('2026-07-05') && Object.keys(d2.doneAt).length === 100, 'Undo restores the cleared state and keeps a completion added since');
      await ctx.close();
    }

    // ===== A v6 backup still imports; clearedBefore survives import =====
    {
      ({ ctx, p } = await open(browser));
      const r = await p.evaluate(async () => {
        const S = await import('./js/store.js');
        const v6 = { version: 6, settings: { onboarded: true }, tasks: [{ id: 'x', title: 'Old', date: '2026-01-01', recur: { type: 'daily' } }], habits: [], logs: {}, journal: {}, exercises: [], workouts: [] };
        const a = S.validateImport(v6);
        const v7 = S.validateImport({ ...v6, version: 7, tasks: [{ ...v6.tasks[0], clearedBefore: '2026-05-05' }, { id: 'y', title: 'Bad', date: '2026-01-01', recur: { type: 'daily' }, clearedBefore: 'soon' }] });
        return { v: a.data.version, title: a.data.tasks[0].title, cb: v7.data.tasks[0].clearedBefore, bad: v7.data.tasks[1].clearedBefore, sv: S.SCHEMA_VERSION };
      });
      assert(r.v === 7 && r.title === 'Old' && r.cb === '2026-05-05' && r.bad === undefined && r.sv === 7, 'v6 backup imports; clearedBefore validated and kept: ' + JSON.stringify(r));
      await ctx.close();
    }

    // Synced profile wording
    ({ ctx, p } = await open(browser, { synced: true }));
    await openSheet(p); await pickSeg(p, '1 year'); await preview(p);
    await p.getByRole('button', { name: /^Clear…/ }).click(); await p.waitForTimeout(400);
    const sw = await sheetText(p);
    assert(/deleted from your account and from your other devices/.test(sw), 'synced confirm says account + other devices: ' + sw.replace(/\s+/g, ' '));
    await ctx.close();

    // Dark screenshots
    if (SHOTS) {
      ({ ctx, p } = await open(browser, { scheme: 'dark', data: { ...mkData(), settings: { ...mkData().settings, theme: 'dark' } } }));
      await go(p, 'settings'); await p.locator('#set-storage').screenshot({ path: SHOTS + '/storage-dark.png' });
      await p.getByRole('button', { name: /Clear completed tasks…/ }).click(); await p.waitForTimeout(500); await pickSeg(p, '3 months'); await preview(p);
      await p.locator('.sheet-root.open .sheet').last().screenshot({ path: SHOTS + '/sheet-dark.png' });
      await ctx.close();
    }
    assert(errs.length === 0, 'no console errors ' + errs.join(' | '));
  } finally { await browser.close(); }
})().catch((e) => { console.log('FAIL: ' + e.stack); process.exitCode = 1; });
