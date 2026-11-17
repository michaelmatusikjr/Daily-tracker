// v1.3.2: three-way legacy merge, deferred update reload, stale legacy sheet, permission reschedule.
const { chromium } = require('playwright');
const URL = 'http://127.0.0.1:8080/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const T = (id, title) => ({ id, title, date: '2026-11-12' });
const v3 = (tasks, extra = {}) => JSON.stringify({ version: 3, settings: { onboarded: true }, categories: [], tasks, habits: [{ id: 'h', name: 'Read', createdAt: '2026-11-01' }], logs: { h: { '2026-11-10': 1, '2026-11-09': 1 } }, journal: { '2026-11-08': { mood: 3, note: 'base' } }, ...extra });
async function ctxWith(browser, seed, init) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 820 }, serviceWorkers: 'block' });
  await ctx.addInitScript(([d]) => { if (!sessionStorage.getItem('s')) { sessionStorage.setItem('s', 1); if (!localStorage.getItem('dailyTracker:profiles') && d) localStorage.setItem('dailyTracker:data', d); localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true}'); } }, [seed]);
  if (init) await ctx.addInitScript(init);
  return ctx;
}
async function open(ctx, url = URL, clock = new Date(2026, 10, 12, 10, 0)) {
  const p = await ctx.newPage();
  if (clock) await p.clock.install({ time: clock });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(url); await p.waitForTimeout(500);
  return p;
}
const active = (p) => p.evaluate(() => { const i = JSON.parse(localStorage.getItem('dailyTracker:profiles')); return JSON.parse(localStorage.getItem('dailyTracker:data:' + i.activeId)); });

(async () => {
  const browser = await chromium.launch();

  // ===== 1. Three-way merge (QA x2 scenario) =====
  {
    const ctx = await ctxWith(browser, v3([T('t1', 'T1'), T('t2', 'T2'), T('t3', 'T3'), T('t4', 'T4')]));
    const p = await open(ctx);
    await p.click('.sheet-foot .btn.ghost'); await p.waitForTimeout(300);
    assert(await p.evaluate(() => localStorage.getItem('dailyTracker:legacyBaseline') !== null), '1 baseline stored at migration');
    // Local edits after the upgrade: delete T4, rename T2, un-check 11-10, edit journal 11-08
    await p.evaluate(async () => {
      const S = await import('./js/store.js'); const A = await import('./js/actions.js');
      S.update((s) => { s.tasks = s.tasks.filter((t) => t.id !== 't4'); const t = s.tasks.find((x) => x.id === 't2'); t.title = 'T2 new'; t.updatedAt = Date.now(); });
      A.toggleHabitDay('h', '2026-11-10');
    });
    await p.clock.runFor(2000);
    // Old tab: still has T4 and the 11-10 check (unchanged), edited T1, deleted T3, added T5, un-checked 11-09, changed journal
    const oldData = v3([T('t1', 'T1 edited in old tab'), T('t2', 'T2'), T('t4', 'T4'), T('t5', 'T5 from old tab')], { logs: { h: { '2026-11-10': 1 } }, journal: { '2026-11-08': { mood: 3, note: 'old tab note' } } });
    const q = await open(ctx, URL + 'manifest.webmanifest', null);
    await q.evaluate((d) => localStorage.setItem('dailyTracker:data', d), oldData);
    await p.waitForTimeout(500);
    await p.click('.dialog-actions button:has-text("Merge into")'); await p.waitForTimeout(400);
    const s = await active(p);
    const titles = s.tasks.map((t) => t.title).sort();
    assert(!titles.includes('T4'), '1 task deleted locally since the upgrade is not resurrected');
    assert(titles.includes('T2 new') && !titles.includes('T2'), '1 local rename kept (old tab didn’t change it)');
    assert(titles.includes('T1 edited in old tab') && titles.includes('T5 from old tab'), '1 old-tab edit and addition applied');
    assert(!titles.includes('T3'), '1 old-tab deletion applied (unchanged locally)');
    assert(!s.logs.h['2026-11-10'], '1 local un-check is not re-checked');
    assert(!s.logs.h['2026-11-09'], '1 old-tab un-check applied');
    assert(s.journal['2026-11-08']?.note === 'old tab note', '1 old-tab journal change applied');
    // Old tab writes again (only change: adds T6) → nothing else reverts
    await q.evaluate((d) => localStorage.setItem('dailyTracker:data', d), v3([T('t1', 'T1 edited in old tab'), T('t2', 'T2'), T('t4', 'T4'), T('t5', 'T5 from old tab'), T('t6', 'T6')], { logs: { h: { '2026-11-10': 1 } }, journal: { '2026-11-08': { mood: 3, note: 'old tab note' } } }));
    await p.waitForTimeout(500);
    await p.click('.dialog-actions button:has-text("Merge into")'); await p.waitForTimeout(400);
    const t2 = (await active(p)).tasks.map((t) => t.title).sort();
    assert(JSON.stringify(t2) === JSON.stringify(['T1 edited in old tab', 'T2 new', 'T5 from old tab', 'T6']), '1 second write from the same old tab merges against the updated baseline');
    await ctx.close();
  }

  // ===== 3. Another window resolves the legacy sheet → ours closes =====
  {
    const ctx = await ctxWith(browser, v3([T('t1', 'T1')]));
    const p = await open(ctx);
    await p.click('.sheet-foot .btn.ghost'); await p.waitForTimeout(300);
    const q = await open(ctx, URL, null);
    const w = await open(ctx, URL + 'manifest.webmanifest', null);
    await w.evaluate((d) => localStorage.setItem('dailyTracker:data', d), v3([T('t1', 'T1'), T('t9', 'T9 old')]));
    await p.waitForTimeout(600);
    const both = [await p.textContent('.sheet-title').catch(() => ''), await q.textContent('.sheet-title').catch(() => '')];
    assert(both.every((t) => t === 'Changes from an older version'), '3 both windows ask');
    await p.click('.dialog-actions button:has-text("Merge into")'); await p.waitForTimeout(600);
    assert(!(await q.locator('.sheet-root').count()) && (await q.textContent('#toasts')).includes('handled in another window'), '3 the other window’s sheet closes with a note');
    assert((await active(p)).tasks.some((t) => t.title === 'T9 old'), '3 merged once');
    await ctx.close();
  }

  // ===== 2. Update reload waits for typed text / open sheet; once per version =====
  {
    const idx = JSON.stringify({ version: 1, activeId: 'p', profiles: [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }] });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 820 } });
    await ctx.addInitScript(([i]) => { if (!localStorage.getItem('dailyTracker:profiles')) { localStorage.setItem('dailyTracker:profiles', i); localStorage.setItem('dailyTracker:data:p', JSON.stringify({ version: 4, settings: { onboarded: true }, tasks: [], habits: [] })); localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true}'); } }, [idx]);
    const p = await open(ctx, URL, null);
    const fire = (v) => p.evaluate((ver) => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'APP_UPDATED', version: ver } })), v);
    await p.evaluate(() => { window.__mark = 1; });
    await p.click('.fab'); await p.fill('.qa-input', 'Half-typed task');
    await fire('9.9.9'); await p.waitForTimeout(1500);
    assert(await p.evaluate(() => window.__mark) === 1 && await p.inputValue('.qa-input') === 'Half-typed task', '2 no reload while typing in a sheet');
    assert((await p.textContent('#toasts')).includes('Update ready – finishing when you’re done'), '2 "Update ready" note');
    await p.keyboard.press('Enter'); await p.waitForTimeout(400); // saves the task and closes the sheet
    await p.waitForLoadState('load'); await p.waitForTimeout(1800);
    assert(await p.evaluate(() => window.__mark) === undefined, '2 reloads once the user is done');
    assert((await active(p)).tasks.some((t) => t.title === 'Half-typed task'), '2 typed task was saved, not lost');
    assert(await p.evaluate(() => sessionStorage.getItem('dailyTracker:reloadedFor')) === '9.9.9', '2 reload recorded for that version');
    await p.evaluate(() => { window.__mark = 2; });
    await fire('9.9.9'); await p.waitForTimeout(1500);
    assert(await p.evaluate(() => window.__mark) === 2, '2 never reloads twice for the same version (no loop)');
    await ctx.close();
  }

  // ===== Note: permission change → reminders scheduled on the 60 s tick =====
  {
    const notif = `(() => { let p = 'default'; window.__n = []; class N { constructor(t) { window.__n.push(t); } static get permission() { return p; } static requestPermission() { return Promise.resolve(p); } } window.Notification = N; window.__grant = () => { p = 'granted'; }; })();`;
    const idx = JSON.stringify({ version: 1, activeId: 'p', profiles: [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }] });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 820 }, serviceWorkers: 'block' });
    await ctx.addInitScript(notif);
    await ctx.addInitScript(([i]) => { if (!localStorage.getItem('dailyTracker:profiles')) { localStorage.setItem('dailyTracker:profiles', i); localStorage.setItem('dailyTracker:data:p', JSON.stringify({ version: 4, settings: { onboarded: true, notifications: true }, tasks: [{ id: 't', title: 'Call', date: '2026-11-12', time: '10:05', reminder: 0 }], habits: [] })); localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true}'); } }, [idx]);
    const p = await open(ctx);
    await p.evaluate(() => window.__grant());
    await p.clock.runFor(61000); await p.waitForTimeout(100);
    await p.clock.runFor(4 * 60000); await p.waitForTimeout(100);
    assert(JSON.stringify(await p.evaluate(() => window.__n)) === '["Call"]', 'N permission granted later → reminder scheduled without a data change');
    await ctx.close();
  }

  console.log(errs.join('\n') || 'no console errors');
  await browser.close();
})();
