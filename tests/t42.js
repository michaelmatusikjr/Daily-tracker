const __ROOT = require('path').resolve(__dirname, '..');
// Accounts and sync: regressions for the third QA round on phase 1 – a device-only reset / Start fresh of
// a kept copy never tombstones the account, a kept copy deleted from the account on another device stays
// here (device-only) with its signed-out edits, a deleted profile isn't revived by an order change
// elsewhere (profile order is per device), and a kept shadow restored after many account changes
// converges. Real Worker in Miniflare.
const { chromium } = require('playwright');
const fs = require('fs');
const SERVER_DIR = __ROOT + '/server';
const APP = 'http://localhost:8080/';
const API = 'http://127.0.0.1:8797';
const RKEY = 'reg-key-for-sync-tests-1';
const PW = 'correct horse battery';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const TODAY = keyOf(new Date());
const task = (id, title, o = {}) => ({ id, title, notes: '', date: TODAY, time: null, duration: null, priority: 0, category: null, reminder: null, recur: { type: 'none', days: [], interval: 2 }, done: false, doneDates: {}, exceptions: [], order: 1, createdAt: 1, ...o });
const habit = (id, name, o = {}) => ({ id, name, emoji: '💧', color: '#0ea5e9', goal: { type: 'check', target: 1, unit: '' }, schedule: { type: 'daily', days: [] }, target: null, reminder: null, archived: false, order: 1, createdAt: '2026-01-01', ...o });
const data = (o = {}) => ({ version: 6, settings: { onboarded: true, theme: 'light', weekStart: 1, notifications: false, timeFormat: '24' }, tasks: [], habits: [], logs: {}, journal: {}, exercises: [], workouts: [], ...o });

async function openApp(browser, { profiles, active = null, authenticator = null, viewport = { width: 390, height: 844 }, colorScheme = 'light' } = {}) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: 'block', colorScheme, deviceScaleFactor: 1 });
  await ctx.route('**/daily-tracker-push.michael-matusik-jr.workers.dev/**', (r) => r.abort());
  await ctx.addInitScript(([profs, act, api, rkey]) => {
    if (localStorage.getItem('dailyTracker:profiles')) return;
    if (profs) {
      localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: act || profs[0][0], profiles: profs.map(([id, name]) => ({ id, name, avatar: { type: 'emoji', emoji: '', color: '#6366f1' } })) }));
      for (const [id, , d] of profs) localStorage.setItem('dailyTracker:data:' + id, JSON.stringify(d));
    }
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
    localStorage.setItem('dailyTracker:pushConfig', JSON.stringify({ serverUrl: api, registerKey: rkey }));
  }, [profiles, active, API, RKEY]);
  const p = await ctx.newPage();
  await p.exposeFunction('__toastLog', (m) => { p.__toasts = [...(p.__toasts || []), m]; });
  await p.addInitScript(() => { new MutationObserver(() => { document.querySelectorAll('.toast-msg:not([data-l])').forEach((t) => { t.dataset.l = 1; window.__toastLog(t.textContent); }); }).observe(document, { childList: true, subtree: true }); });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push(m.text()); });
  let auth = null;
  if (authenticator) {
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: authenticator.prf } });
    auth = { cdp, authenticatorId };
  }
  await p.goto(APP); await p.waitForTimeout(500);
  return { ctx, p, auth };
}
const go = (p, hash) => p.evaluate((x) => { location.hash = x; }, hash).then(() => p.waitForTimeout(250));
const lsJSON = (p, k) => p.evaluate((x) => JSON.parse(localStorage.getItem(x) || 'null'), k);
const syncSt = (p) => lsJSON(p, 'dailyTracker:sync');
const profData = (p, id) => lsJSON(p, 'dailyTracker:data:' + id);
const profiles = (p) => lsJSON(p, 'dailyTracker:profiles').then((x) => x.profiles);
const syncNow = (p) => p.evaluate(async () => (await import('./js/sync.js')).syncNow());
const mutate = (p, id, fnSrc) => p.evaluate(async ([id, src]) => { const s = await import('./js/store.js'); return s.mutateProfileData(id, new Function('s', src)); }, [id, fnSrc]);
const sheetTitle = (p) => p.locator('.sheet-root.open .sheet-title').last().textContent().catch(() => null);
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; };


(async () => {
  const { Miniflare } = await import(SERVER_DIR + '/node_modules/miniflare/dist/src/index.js');
  const mf = new Miniflare({
    modules: true, modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    modulesRoot: SERVER_DIR, scriptPath: SERVER_DIR + '/src/index.js', compatibilityDate: '2026-07-01', port: 8797, host: '127.0.0.1',
    d1Databases: ['DB'],
    bindings: { VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: 'mailto:test@example.com', ALLOWED_ORIGINS: 'http://localhost:8080', REGISTER_KEY: RKEY, MAX_ACCOUNTS: '20' },
  });
  await mf.ready;
  const db = await mf.getD1Database('DB');
  for (const s of fs.readFileSync(SERVER_DIR + '/schema.sql', 'utf8').replace(/--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean)) await db.prepare(s).run();
  const browser = await chromium.launch();
  const S = (p, fn, arg) => p.evaluate(async ([src, a]) => { const m = await import('./js/sync.js'); return new Function('S', 'a', 'return (async () => {' + src + '})()')(m, a); }, [fn, arg]);
  const shadowOf = (p, pid) => p.evaluate(async (id) => (await import('./js/syncCrypto.js')).idb('shadow', 'readonly', (s) => s.get(id)), pid);
  const newTask = (id, title) => `s.tasks.push({ id: '${id}', title: '${title}', notes: '', date: '${TODAY}', recur: { type: 'none' }, done: false, doneDates: {}, exceptions: [], order: 9, createdAt: 1 });`;
  const titlesOf = async (p, pid) => ((await profData(p, pid))?.tasks || []).map((t) => t.title);
  const delProf = (p, id, other) => p.evaluate(async ([id, other]) => { const st = await import('./js/store.js'); st.switchProfile(other); st.deleteProfile(id); (await import('./js/sync.js')).profileDeleted(id); }, [id, other]);

  // R1: "Reset data" (device-only confirm) on a kept copy while signed out, then sign in again
  {
    const A = await openApp(browser, { profiles: [['pm', 'Mick', data({ tasks: [task('t1', 'one'), task('t2', 'two'), task('t3', 'three')] })]] });
    await S(A.p, `await S.createAccount({ username: 'qar1', password: '${PW}', registerKey: '${RKEY}' }); await S.syncProfiles(['pm']); await S.syncNow();`);
    const B = await openApp(browser, { profiles: [['pz', 'Zed', data()]] });
    await S(B.p, `await S.signIn({ username: 'qar1', password: '${PW}' });`); await syncNow(B.p);
    assert((await titlesOf(B.p, 'pm')).length === 3, 'R1 setup: B has 3 tasks');
    await go(A.p, '#settings');
    await A.p.click('.acct-bottom button:has-text("Sign out")'); await A.p.waitForTimeout(300);
    assert(/changes you make to them while signed out \(deletions too\) sync to your account when you sign in again/.test(await A.p.locator('.sheet-root.open').last().textContent()), 'R0 the sign-out confirm says kept copies’ changes sync when signing in again');
    await A.p.click('.sheet-root.open .dialog-actions button:has-text("Cancel")'); await A.p.waitForTimeout(300);
    await S(A.p, `return await S.signOut({ remove: false });`);
    assert((await syncSt(A.p)).kept?.pm, 'R1 setup: A keeps a copy');
    await go(A.p, '#settings');
    await A.p.click('button:has-text("Reset Mick’s data")'); await A.p.waitForTimeout(300);
    assert(/on this device\./.test(await A.p.locator('.sheet-root.open').last().textContent()), 'R1 the confirm says "on this device"');
    await A.p.click('.sheet-root.open .dialog-actions button:has-text("Yes, continue")'); await A.p.waitForTimeout(300);
    await A.p.click('.sheet-root.open .dialog-actions button:has-text("Delete everything")'); await A.p.waitForTimeout(400);
    assert((await titlesOf(A.p, 'pm')).length === 0 && !(await syncSt(A.p)).kept?.pm, 'R1 reset done; the kept marker is forgotten');
    await S(A.p, `return await S.signIn({ username: 'qar1', password: '${PW}' });`);
    await syncNow(A.p); await syncNow(B.p);
    const tb = await titlesOf(B.p, 'pm');
    console.log('R1 B tasks after A signed in again:', JSON.stringify(tb));
    assert(tb.length === 3, 'R1 a device-only reset of a kept copy does not wipe the account (other device keeps tasks)');
    const pa = await profiles(A.p);
    assert((await titlesOf(A.p, 'pm')).length === 3 && pa.filter((x) => x.name.startsWith('Mick')).length === 2, 'R1 A gets the account copy beside its reset copy (new id)');
    await A.ctx.close(); await B.ctx.close();
  }

  // R1b: "Start fresh" after a load failure on a kept copy while signed out, then sign in again
  {
    const A = await openApp(browser, { profiles: [['pm', 'Mick', data({ tasks: [task('t1', 'one'), task('t2', 'two')] })]] });
    await S(A.p, `await S.createAccount({ username: 'qar1b', password: '${PW}', registerKey: '${RKEY}' }); await S.syncProfiles(['pm']); await S.syncNow();`);
    const B = await openApp(browser, { profiles: [['pz', 'Zed', data()]] });
    await S(B.p, `await S.signIn({ username: 'qar1b', password: '${PW}' });`); await syncNow(B.p);
    await S(A.p, `return await S.signOut({ remove: false });`);
    await A.p.evaluate(() => { localStorage.setItem('dailyTracker:data:pm', '{corrupt'); });
    await A.p.reload(); await A.p.waitForTimeout(800);
    await go(A.p, '#today');
    await A.p.click('#takeover button:has-text("Show")'); await A.p.waitForTimeout(400);
    await A.p.click('.load-fail button:has-text("Reset")'); await A.p.waitForTimeout(300);
    await A.p.click('.sheet-root.open .dialog-actions button:has-text("Start fresh")'); await A.p.waitForTimeout(500);
    assert(!(await syncSt(A.p)).kept?.pm, 'R1b Start fresh forgets the kept marker');
    await S(A.p, `return await S.signIn({ username: 'qar1b', password: '${PW}' });`);
    await syncNow(A.p); await syncNow(B.p);
    assert((await titlesOf(B.p, 'pm')).length === 2, 'R1b Start fresh on a kept copy does not wipe the account');
    await A.ctx.close(); await B.ctx.close();
  }

  // R2: another device deletes the profile while this one is signed out with edits
  {
    const A = await openApp(browser, { profiles: [['pm', 'Mick', data({ tasks: [task('t1', 'one')] })], ['po', 'Other', data()]] });
    await S(A.p, `await S.createAccount({ username: 'qar2', password: '${PW}', registerKey: '${RKEY}' }); await S.syncProfiles(['pm']); await S.syncNow();`);
    const B = await openApp(browser, { profiles: [['pz', 'Zed', data()]] });
    await S(B.p, `await S.signIn({ username: 'qar2', password: '${PW}' });`); await syncNow(B.p);
    await S(A.p, `return await S.signOut({ remove: false });`);
    await mutate(A.p, 'pm', newTask('w1', 'weeks-of-signed-out-work'));
    await delProf(B.p, 'pm', 'pz'); await syncNow(B.p);
    await S(A.p, `return await S.signIn({ username: 'qar2', password: '${PW}' });`);
    await syncNow(A.p);
    const pa = (await profiles(A.p)).map((x) => x.id + ':' + x.name);
    const all = [];
    for (const x of await profiles(A.p)) all.push(...await titlesOf(A.p, x.id));
    console.log('R2 A profiles:', JSON.stringify(pa), 'titles:', JSON.stringify(all));
    assert(all.includes('weeks-of-signed-out-work'), 'R2 edits made in a kept copy survive a profile delete on another device');
    const st2 = await syncSt(A.p);
    assert(pa.includes('pm:Mick') && !(st2.synced || []).includes('pm'), 'R2 …the copy stays here as a device-only profile');
    assert((await profiles(B.p)).every((x) => x.id !== 'pm'), 'R2 …and stays deleted on the other device');
    await S(A.p, `return await S.syncProfiles(['pm']);`); await syncNow(A.p); await syncNow(B.p);
    const np = (await profiles(B.p)).find((x) => x.name === 'Mick');
    assert(np && np.id !== 'pm' && (await titlesOf(B.p, np.id)).includes('weeks-of-signed-out-work'), 'R2 synced again, it gets a new id and reaches the other device');
    await A.ctx.close(); await B.ctx.close();
  }

  // R3: profile delete undone by an order-only meta rewrite on another device
  {
    const A = await openApp(browser, { profiles: [['pa', 'Ann', data()], ['pb', 'Bob', data({ tasks: [task('b1', 'bob-task')] })]] });
    await S(A.p, `await S.createAccount({ username: 'qar3', password: '${PW}', registerKey: '${RKEY}' }); await S.syncProfiles(['pa','pb']); await S.syncNow();`);
    const B = await openApp(browser, { profiles: [['pz', 'Zed', data()]] });
    await S(B.p, `await S.signIn({ username: 'qar3', password: '${PW}' });`); await syncNow(B.p);
    assert((await profiles(B.p)).some((x) => x.id === 'pb'), 'R3 setup: B has Bob');
    // B deletes Bob; A (not yet pulled) deletes Ann – Bob's position shifts on A
    await delProf(B.p, 'pb', 'pz'); await syncNow(B.p);
    await A.ctx.setOffline(true);
    await delProf(A.p, 'pa', 'pb'); await sleep(2500);
    await A.ctx.setOffline(false);
    await syncNow(A.p); await syncNow(B.p); await syncNow(B.p);
    const pbB = (await profiles(B.p)).some((x) => x.id === 'pb'), pbA = (await profiles(A.p)).some((x) => x.id === 'pb');
    console.log('R3 Bob on A:', pbA, 'on B:', pbB);
    assert(!pbB && !pbA, 'R3 a deleted profile is not revived by an order-only change elsewhere');
    await A.ctx.close(); await B.ctx.close();
  }

  await db.prepare('DELETE FROM rate').run(); // account creation is limited to 5 an hour per IP
  // R4: kept shadow restored after the account changed a lot – no spurious tombstones, nothing lost
  {
    const A = await openApp(browser, { profiles: [['pm', 'Mick', data({ tasks: [task('t1', 'one'), task('t2', 'two')] })]] });
    await S(A.p, `await S.createAccount({ username: 'qar4', password: '${PW}', registerKey: '${RKEY}' }); await S.syncProfiles(['pm']); await S.syncNow();`);
    const B = await openApp(browser, { profiles: [['pz', 'Zed', data()]] });
    await S(B.p, `await S.signIn({ username: 'qar4', password: '${PW}' });`); await syncNow(B.p);
    await S(A.p, `return await S.signOut({ remove: false });`);
    await mutate(B.p, 'pm', `s.tasks = s.tasks.filter((t) => t.id !== 't2'); ${newTask('n1', 'B-new')}`); await syncNow(B.p);
    await mutate(A.p, 'pm', `s.tasks.find((t) => t.id === 't1').title = 'A-edit'; ${newTask('n2', 'A-new')}`);
    // A: sign in to another account in between, then back
    await S(A.p, `await S.createAccount({ username: 'qar4other', password: '${PW}', registerKey: '${RKEY}' }); await S.syncNow();`);
    await S(A.p, `return await S.signOut({ remove: false });`);
    await S(A.p, `return await S.signIn({ username: 'qar4', password: '${PW}' });`);
    await syncNow(A.p); await syncNow(B.p);
    const ta = (await titlesOf(A.p, 'pm')).sort(), tb = (await titlesOf(B.p, 'pm')).sort();
    console.log('R4 A:', JSON.stringify(ta), 'B:', JSON.stringify(tb), 'A profiles', JSON.stringify((await profiles(A.p)).map((x) => x.id)));
    assert(JSON.stringify(ta) === JSON.stringify(['A-edit', 'A-new', 'B-new']) && JSON.stringify(tb) === JSON.stringify(ta), 'R4 both devices converge, nothing lost/duplicated');
    await A.ctx.close(); await B.ctx.close();
  }
  console.log(errs.length ? 'errors: ' + errs.join(' | ') : 'no page errors');
  await browser.close(); await mf.dispose();
})().catch((e) => { console.error(e); process.exit(1); });
