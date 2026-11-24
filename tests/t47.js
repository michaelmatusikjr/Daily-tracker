// v1.15.1: a corrupt profile index must never orphan the profiles' data: it is rebuilt from the stored
// data keys (old text kept as a backup), no first screen, and the photo GC keeps photos of stored profiles.
const { chromium } = require('playwright');
const APP = process.env.APP_URL || 'http://127.0.0.1:8080/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const data = (o = {}) => ({ version: 6, settings: { onboarded: true, theme: 'light', weekStart: 1, accent: 'indigo' }, tasks: [], habits: [], logs: {}, journal: {}, exercises: [], workouts: [], ...o });
const task = (id, title, o = {}) => ({ id, title, notes: '', date: '2026-01-01', time: null, duration: null, priority: 0, category: null, reminder: null, recur: { type: 'none', days: [], interval: 2 }, done: false, doneDates: {}, exceptions: [], order: 1, createdAt: 1, ...o });
const putPhoto = (p, id, profileId) => p.evaluate(async ([id, profileId]) => {
  const a = await import('./js/attachments.js');
  await a.putFile({ id, profileId, taskId: 'x', blob: new Blob(['x'], { type: 'image/jpeg' }), type: 'image/jpeg', createdAt: 1 });
}, [id, profileId]);
const hasPhoto = (p, id) => p.evaluate(async (id) => !!(await (await import('./js/attachments.js')).getFile(id)), id);

(async () => {
  const browser = await chromium.launch();
  const open = async (seed) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await ctx.addInitScript((seed) => {
      if (localStorage.getItem('dailyTracker:seeded')) return;
      localStorage.setItem('dailyTracker:seeded', '1');
      for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
    }, seed);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    await p.goto(APP); await p.waitForTimeout(700);
    return { ctx, p };
  };
  const ls = (p, k) => p.evaluate((k) => localStorage.getItem(k), k);

  // ===== A: unreadable index, two profiles' data on disk =====
  {
    const d1 = JSON.stringify(data({ tasks: [task('t1', 'Keep me', { attachments: [{ id: 'f1', w: 1, h: 1, type: 'image/jpeg' }] })] }));
    const d2 = JSON.stringify(data({ tasks: [task('t2', 'Second profile')] }));
    const { ctx, p } = await open({
      'dailyTracker:profiles': '{"version":1,"profiles":[{"id":"p1","na',
      'dailyTracker:data:p1': d1, 'dailyTracker:data:p2': d2, 'dailyTracker:data:p1:backup-5': '{old backup}',
    });
    const ix = JSON.parse(await ls(p, 'dailyTracker:profiles'));
    assert(ix.profiles.length === 2 && ix.profiles.map((x) => x.id).join() === 'p1,p2', 'A1 the index is rebuilt from the data keys (backups not counted)');
    assert(ix.profiles.every((x) => !x.placeholder) && ix.profiles[0].name === 'Recovered profile 1' && ix.profiles[1].name === 'Recovered profile 2', 'A2 recovered profiles are named and never placeholders');
    assert(JSON.parse(await ls(p, 'dailyTracker:data:p1')).tasks[0].title === 'Keep me' && JSON.parse(await ls(p, 'dailyTracker:data:p2')).tasks[0].title === 'Second profile', 'A3 the data keys still hold their data');
    const keys = await p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('dailyTracker:profiles:backup-')).map((k) => localStorage.getItem(k)));
    assert(keys.length === 1 && keys[0].startsWith('{"version":1,"profiles":[{"id":"p1","na'), 'A4 the unreadable index text is kept as a backup');
    assert(await p.locator('.onboarding').count() === 0, 'A5 no first screen / tour');
    await putPhoto(p, 'f1', 'p1');
    await p.reload(); await p.waitForTimeout(4500);
    assert(await hasPhoto(p, 'f1'), 'A6 after the rebuild the GC keeps the recovered profile’s photo (it is referenced again)');
    await ctx.close();
  }
  // ===== B: valid index, but a profile's data exists that the index doesn't list =====
  {
    const { ctx, p } = await open({
      'dailyTracker:profiles': JSON.stringify({ version: 1, activeId: 'p1', profiles: [{ id: 'p1', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }] }),
      'dailyTracker:data:p1': JSON.stringify(data()),
      'dailyTracker:data:p3': JSON.stringify(data({ tasks: [task('t3', 'Orphan', { attachments: [{ id: 'f3', w: 1, h: 1, type: 'image/jpeg' }] })] })),
    });
    await putPhoto(p, 'f3', 'p3'); await putPhoto(p, 'f9', 'p1');
    await p.reload(); await p.waitForTimeout(4500);
    assert(await hasPhoto(p, 'f3'), 'B1 a photo of a profile whose data key exists (but is missing from the index) is kept');
    assert(!(await hasPhoto(p, 'f9')), 'B2 the GC still removes unreferenced photos of listed profiles');
    await ctx.close();
  }
  // ===== C: no index and no data: a brand-new install is unchanged =====
  {
    const { ctx, p } = await open({});
    const ix = JSON.parse(await ls(p, 'dailyTracker:profiles'));
    assert(ix.profiles.length === 1 && ix.profiles[0].placeholder === true && !(await p.evaluate(() => Object.keys(localStorage).some((k) => k.includes(':backup-')))), 'C1 fresh install: one placeholder, no backups');
    await ctx.close();
  }
  assert(!errs.length, 'no page errors ' + errs.join(' | '));
  await browser.close();
})().catch((e) => { console.log('FAIL: ' + e.stack); process.exitCode = 1; });
