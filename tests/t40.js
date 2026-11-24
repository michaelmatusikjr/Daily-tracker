const __ROOT = require('path').resolve(__dirname, '..');
// Accounts and sync: regression tests for the QA findings on phase 1 (re-syncing kept copies, Sign out ›
// Remove with pending edits, Start fresh on a synced profile, kept copies merged / re-id with photos,
// future edit times, delete tombstone time, remote delete of an unreadable profile). Real Worker in Miniflare.
const { chromium } = require('playwright');
const fs = require('fs');
const SERVER_DIR = __ROOT + '/server';
const APP = 'http://localhost:8080/';
const API = 'http://127.0.0.1:8795';
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
    modulesRoot: SERVER_DIR, scriptPath: SERVER_DIR + '/src/index.js', compatibilityDate: '2026-07-01', port: 8795, host: '127.0.0.1',
    d1Databases: ['DB'],
    bindings: { VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: 'mailto:test@example.com', ALLOWED_ORIGINS: 'http://localhost:8080', REGISTER_KEY: RKEY, MAX_ACCOUNTS: '20' },
  });
  await mf.ready;
  const db = await mf.getD1Database('DB');
  for (const s of fs.readFileSync(SERVER_DIR + '/schema.sql', 'utf8').replace(/--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean)) await db.prepare(s).run();
  const browser = await chromium.launch();
  const S = (p, fn, arg) => p.evaluate(async ([src, a]) => { const m = await import('./js/sync.js'); return new Function('S', 'a', 'return (async () => {' + src + '})()')(m, a); }, [fn, arg]);
  const shadowOf = (p, pid) => p.evaluate(async (id) => (await import('./js/syncCrypto.js')).idb('shadow', 'readonly', (s) => s.get(id)), pid);
  const putShadow = (p, pid, sh) => p.evaluate(async ([id, x]) => (await import('./js/syncCrypto.js')).idb('shadow', 'readwrite', (s) => s.put(x, id)), [pid, sh]);
  const newTask = (id, title) => `s.tasks.push({ id: '${id}', title: '${title}', notes: '', date: '${TODAY}', recur: { type: 'none' }, done: false, doneDates: {}, exceptions: [], order: 9, createdAt: 1 });`;

  // ===== Finding 1: re-syncing a kept copy after a failed first sync never reverts the account =====
  const A = await openApp(browser, { profiles: [['pm', 'Mick', data({ tasks: [task('t1', 'v1'), task('t2', 'keep-or-delete')] })]] });
  await S(A.p, `await S.createAccount({ username: 'fam', password: '${PW}', registerKey: '${RKEY}' }); await S.syncProfiles(['pm']); await S.syncNow();`);
  assert((await syncSt(A.p)).synced.includes('pm'), 'R0 a new account can add profiles right away (nothing to download)');
  await S(A.p, `await S.signOut({ remove: false });`);
  assert((await syncSt(A.p)).kept?.pm, 'R1 "Keep copies" remembers which account the copy came from');
  await mutate(A.p, 'pm', newTask('whileout', 'Edited while signed out'));
  const B = await openApp(browser, { profiles: [['pz', 'Zed', data()]] });
  await S(B.p, `await S.signIn({ username: 'fam', password: '${PW}' });`);
  await mutate(B.p, 'pm', `s.tasks.find((t) => t.id === 't1').title = 'v2-from-B'; s.tasks = s.tasks.filter((t) => t.id !== 't2');`);
  await syncNow(B.p);
  // A signs in again, but the download fails.
  await A.ctx.route('**/api/sync/pull**', (r) => r.abort());
  const r1 = await S(A.p, `return await S.signIn({ username: 'fam', password: '${PW}' });`);
  assert(r1.pulled === false && typeof r1.error === 'string' && r1.error.length > 0, 'R2 a failed first download is reported (pulled: false, with a reason): ' + r1.error);
  assert(await S(A.p, `return S.canSyncProfiles();`) === false && await S(A.p, `return await S.syncProfiles(['pm']);`) === false, 'R3 profiles can’t be added before the account was downloaded');
  assert(!(await syncSt(A.p)).synced.includes('pm'), 'R4 …so the kept copy isn’t synced from an empty shadow');
  await A.ctx.unroute('**/api/sync/pull**');
  assert(await syncNow(A.p) === true && (await syncSt(A.p)).pulled === true, 'R5 the download completes later');
  await syncNow(B.p);
  const bm = await profData(B.p, 'pm'), am = await profData(A.p, 'pm');
  assert(bm.tasks.find((t) => t.id === 't1').title === 'v2-from-B' && am.tasks.find((t) => t.id === 't1').title === 'v2-from-B', 'R6 B’s newer edit survives (the account wins over the kept copy)');
  assert(!bm.tasks.some((t) => t.id === 't2') && !am.tasks.some((t) => t.id === 't2'), 'R7 B’s delete survives');
  assert(bm.tasks.some((t) => t.id === 'whileout') && (await profiles(A.p)).filter((x) => x.name === 'Mick').length === 1, 'R8 the kept copy is merged back: its own edit is uploaded, no duplicate profile');
  // UI: a sign-in whose download fails shows the reason and Retry, not the profile picker.
  await S(A.p, `await S.signOut({ remove: false });`);
  await A.ctx.route('**/api/sync/pull**', (r) => r.abort());
  await go(A.p, '#settings');
  await A.p.click('.acct-panel button:has-text("Sign in")');
  await A.p.fill('.sheet-root.open [aria-label="Username"]', 'fam');
  await A.p.fill('.sheet-root.open [aria-label="Password"]', PW);
  await A.p.click('.sheet-root.open .sheet-foot button:has-text("Sign in")');
  await waitFor(async () => (await sheetTitle(A.p)) === 'Download didn’t finish', 15000);
  assert(await sheetTitle(A.p) === 'Download didn’t finish' && /couldn’t be downloaded/.test(await A.p.locator('.sheet-root.open .set-desc').first().textContent()), 'R9 UI: the failed download is shown with a reason (no picker)');
  await A.ctx.unroute('**/api/sync/pull**');
  await A.p.click('.sheet-root.open .sheet-foot button:has-text("Retry")');
  await waitFor(async () => (await sheetTitle(A.p)) !== 'Download didn’t finish', 15000);
  assert((await syncSt(A.p)).pulled === true && (await sheetTitle(A.p)) !== 'Download didn’t finish', 'R10 Retry downloads and carries on');
  if (await sheetTitle(A.p) === 'Sync this device’s profiles?') { await A.p.click('.sheet-root.open .sheet-foot button:has-text("Not now")'); await A.p.waitForTimeout(300); }

  // ===== Finding 2: Sign out › Remove never deletes edits that weren't uploaded =====
  await B.ctx.setOffline(true);
  await mutate(B.p, 'pm', newTask('off9', 'offline-only'));
  await syncNow(B.p);
  const rr = await S(B.p, `return await S.signOut({ remove: true });`);
  assert(rr.ok === false && /n’t been uploaded/.test(rr.reason), 'U1 Remove is refused while an edit is pending: ' + rr.reason);
  assert((await syncSt(B.p)).token && (await profData(B.p, 'pm')).tasks.some((t) => t.id === 'off9'), 'U2 …still signed in, the edit is still here');
  await go(B.p, '#settings');
  await B.p.click('.acct-bottom button:has-text("Sign out")'); await B.p.waitForTimeout(300);
  await B.p.click('.dialog-actions button:has-text("Remove from this device")');
  await waitFor(async () => (await sheetTitle(B.p)) === 'Can’t remove yet', 15000);
  assert(await sheetTitle(B.p) === 'Can’t remove yet' && await B.p.locator('.sheet-root.open .dialog-actions button:has-text("Keep copies on this device")').count() === 1, 'U3 UI: explains why and offers Keep copies');
  await B.p.click('.sheet-root.open .dialog-actions button:has-text("Cancel")'); await B.p.waitForTimeout(300);
  await B.ctx.setOffline(false);
  const rr2 = await S(B.p, `return await S.signOut({ remove: true });`);
  assert(rr2.ok === true && !(await profiles(B.p)).some((x) => x.id === 'pm'), 'U4 once online, Remove first uploads, then removes');
  await S(B.p, `await S.signIn({ username: 'fam', password: '${PW}' });`);
  assert((await profData(B.p, 'pm')).tasks.some((t) => t.id === 'off9'), 'U5 the offline edit is in the account');

  // ===== Finding 8: the delete tombstone is newer than the profile's last meta time =====
  await mutate(B.p, 'pz', newTask('z1', 'Zed task'));
  await S(B.p, `await S.syncProfiles(['pz']); await S.syncNow();`);
  await syncNow(A.p);
  assert((await profiles(A.p)).some((x) => x.id === 'pz'), 'T0 A has Zed');
  const shz = await shadowOf(B.p, 'pz');
  shz['pz/meta'] = [shz['pz/meta'][0], Date.now() + 30 * 60000, shz['pz/meta'][2], 1];
  await putShadow(B.p, 'pz', shz);
  assert(await syncNow(B.p) === true, 'T1 a meta time 30 min ahead is uploaded');
  await B.p.evaluate(async () => { const st = await import('./js/store.js'); st.deleteProfile('pz'); (await import('./js/sync.js')).profileDeleted('pz'); });
  await syncNow(B.p); await syncNow(A.p);
  assert(!(await profiles(A.p)).some((x) => x.id === 'pz'), 'T2 the delete reaches A (tombstone t > meta t)');

  // ===== Finding 7: a record with a time far in the future doesn't block the push =====
  await mutate(B.p, 'pm', newTask('fut1', 'Future'));
  await syncNow(B.p);
  const shm = await shadowOf(B.p, 'pm');
  shm['pm/task/fut1'] = [shm['pm/task/fut1'][0], Date.now() + 3 * 86400000, shm['pm/task/fut1'][2], 1]; // e.g. a device clock that was days ahead
  await putShadow(B.p, 'pm', shm);
  await mutate(B.p, 'pm', newTask('fut2', 'After the future one'));
  assert(await syncNow(B.p) === true, 'F1 a refused (future) record is re-timed and the push goes through');
  await syncNow(A.p);
  assert((await profData(A.p, 'pm')).tasks.some((t) => t.id === 'fut2') && (await profData(A.p, 'pm')).tasks.some((t) => t.id === 'fut1'), 'F2 both records reach the other device');
  const shm2 = await shadowOf(B.p, 'pm');
  await mutate(B.p, 'pm', `s.tasks.find((t) => t.id === 'fut1').title = 'Future edited';`);
  await syncNow(B.p);
  const t3 = (await shadowOf(B.p, 'pm'))['pm/task/fut1'][1];
  assert(t3 <= Date.now() + 2 * 60000 && shm2['pm/task/fut1'][3] === 0, 'F3 new edit times are never more than a minute ahead');

  // ===== Finding 3: Start fresh on a synced profile keeps edits made since =====
  await A.p.evaluate(() => { localStorage.setItem('dailyTracker:data:pm', '{corrupt'); });
  await A.p.evaluate(async () => (await import('./js/store.js')).switchProfile('pm'));
  await A.p.reload(); await A.p.waitForTimeout(800);
  const active = await A.p.evaluate(async () => (await import('./js/store.js')).getActiveProfile().id);
  if (active !== 'pm') console.log('active profile is', active);
  await A.ctx.setOffline(true);
  assert(await A.p.evaluate(async () => !!(await import('./js/store.js')).getLoadFailure()), 'S0 load failure on the synced profile');
  await A.p.evaluate(async () => { const st = await import('./js/store.js'); const sy = await import('./js/sync.js'); sy.profileReset(st.getActiveProfile().id); st.resolveLoadFailure(); });
  await A.p.evaluate(async (d) => { const a = await import('./js/actions.js'); a.saveTask({ title: 'Added after start fresh', date: d }); }, TODAY);
  await A.p.waitForTimeout(300);
  await A.ctx.setOffline(false);
  await syncNow(A.p); await syncNow(A.p);
  const after = (await profData(A.p, 'pm')).tasks.map((t) => t.title);
  assert(after.includes('Added after start fresh'), 'S1 a task added after Start fresh survives the account download');
  assert(after.includes('v2-from-B') && after.includes('offline-only'), 'S2 …and the account’s data is merged in');
  await syncNow(B.p);
  assert((await profData(B.p, 'pm')).tasks.some((t) => t.title === 'Added after start fresh') && (await profData(B.p, 'pm')).tasks.some((t) => t.id === 'fut2'), 'S3 the new task is uploaded; nothing in the account was deleted');
  const backups = await A.p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('dailyTracker:data:pm:backup-')).length);
  assert(backups >= 1, 'S4 the unreadable data stays as a backup');

  // ===== Finding 9: a remote delete of an unreadable profile keeps its raw backup =====
  const C = await openApp(browser, { profiles: [['pc', 'Cee', data()]] });
  await S(C.p, `await S.signIn({ username: 'fam', password: '${PW}' }); `);
  await B.p.evaluate(async () => { const st = await import('./js/store.js'); st.addProfile({ name: 'Doomed' }); });
  const doomed = await B.p.evaluate(async () => (await import('./js/store.js')).getActiveProfile().id);
  await S(B.p, `await S.syncProfiles(['${doomed}']); await S.syncNow();`);
  await syncNow(C.p);
  assert((await profiles(C.p)).some((x) => x.id === doomed), 'D0 C has the profile');
  await C.p.evaluate((id) => localStorage.setItem('dailyTracker:data:' + id, '{"unreadable'), doomed);
  await B.p.evaluate(async (id) => { const st = await import('./js/store.js'); st.switchProfile('pm'); st.deleteProfile(id); (await import('./js/sync.js')).profileDeleted(id); }, doomed);
  await syncNow(B.p); await syncNow(C.p);
  const cb = await C.p.evaluate((id) => Object.keys(localStorage).filter((k) => k.startsWith('dailyTracker:data:' + id + ':backup-')).map((k) => localStorage.getItem(k)), doomed);
  assert(!(await profiles(C.p)).some((x) => x.id === doomed) && cb.includes('{"unreadable'), 'D1 deleted on another device: removed here, but its unreadable data is kept as a backup');

  // ===== Finding 4: a same-id device profile from elsewhere keeps its photos (copied, not moved) =====
  const E = await openApp(browser, { profiles: [['pm', 'Other Mick', data({ tasks: [task('pe1', 'With photo', { attachments: [{ id: 'fE1', w: 10, h: 10, type: 'image/jpeg' }] })] })], ['px', 'X', data({ tasks: [task('px1', 'Shares', { attachments: [{ id: 'fS1', w: 1, h: 1, type: 'image/jpeg' }] })] })]] });
  await E.p.evaluate(async () => {
    const a = await import('./js/attachments.js');
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
    await a.putFile({ id: 'fE1', profileId: 'pm', taskId: 'pe1', blob, thumbBlob: blob, type: 'image/jpeg', w: 10, h: 10, createdAt: Date.now() });
    await a.putFile({ id: 'fS1', profileId: 'pq', taskId: 'px1', blob, thumbBlob: blob, type: 'image/jpeg', w: 1, h: 1, createdAt: Date.now() });
  });
  await S(E.p, `await S.signIn({ username: 'fam', password: '${PW}' });`);
  const pE = await profiles(E.p);
  const other = pE.find((x) => x.name === 'Other Mick');
  assert(other && other.id !== 'pm' && pE.some((x) => x.id === 'pm' && x.name === 'Mick'), 'P1 a same-id profile from elsewhere stays under a new id beside the account’s');
  const att = (await profData(E.p, other.id)).tasks[0].attachments[0].id;
  const files = await E.p.evaluate(async (ids) => { const a = await import('./js/attachments.js'); return Promise.all(ids.map((id) => a.getFile(id).then((f) => f && f.profileId))); }, ['fE1', att]);
  assert(att !== 'fE1' && files[0] === 'pm' && files[1] === other.id, 'P2 its photos are copied to the new id (the originals stay)');
  await E.p.evaluate(async (id) => (await import('./js/attachments.js')).deleteProfileFiles(id), 'pq');
  const shared = await E.p.evaluate(async () => (await (await import('./js/attachments.js')).getFile('fS1'))?.profileId);
  assert(shared === 'px', 'P3 deleting a profile’s photos keeps files another profile still refers to');

  console.log(errs.length ? 'errors: ' + errs.join('\n') : 'no page errors');
  await browser.close();
  await mf.dispose();
})().catch((e) => { console.log('FAIL: crashed ' + (e.stack || e)); process.exitCode = 1; process.exit(1); });
