const __ROOT = require('path').resolve(__dirname, '..');
// Accounts and sync: regressions for the second QA round on phase 1 – kept copies resume with their
// preserved shadows (never account-wins), stale kept markers never merge into another account, new edits
// win over future-stamped records, refused records/deletes are surfaced, orphaned backups are exported,
// the Remove photo count. Real Worker in Miniflare.
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
  const titlesOf = async (p, pid) => ((await profData(p, pid))?.tasks || []).map((t) => t.title);
  const refuse = (ctx) => ctx.route('**/api/sync/push', (r) => (r.request().method() === 'POST'
    ? r.fulfill({ status: 400, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': 'http://localhost:8080' }, body: JSON.stringify({ error: 'records[0]: refused for the test', now: Date.now() }) })
    : r.continue()));

  // ===== 1. "Keep copies", then signing in to the same account again: nothing is reverted =====
  const A = await openApp(browser, { profiles: [['pm', 'Mick', data({ tasks: [task('t1', 'v1'), task('t2', 'two'), task('t3', 'three')] })]] });
  await S(A.p, `await S.createAccount({ username: 'fam', password: '${PW}', registerKey: '${RKEY}' }); await S.syncProfiles(['pm']); await S.syncNow();`);
  const B = await openApp(browser, { profiles: [['pz', 'Zed', data()]] });
  await S(B.p, `await S.signIn({ username: 'fam', password: '${PW}' });`);
  await A.ctx.setOffline(true);
  await mutate(A.p, 'pm', `s.tasks.find((t) => t.id === 't1').title = 'edited-offline';`);
  await syncNow(A.p);
  const rr = await S(A.p, `return await S.signOut({ remove: true });`);
  assert(rr.ok === false, 'K0 Remove is refused while an edit is pending');
  await S(A.p, `return await S.signOut({ remove: false });`);
  const st0 = await syncSt(A.p);
  const kp = await shadowOf(A.p, 'kept:pm');
  assert(st0.kept?.pm && kp && kp.accountId === st0.kept.pm && kp.shadow['pm/task/t1'][3] === 1, 'K1 Keep preserves the shadow (with the pending edit) for this account');
  assert(!(await shadowOf(A.p, 'pm')), 'K2 …the live shadow is cleared');
  await mutate(A.p, 'pm', `s.tasks.find((t) => t.id === 't2').title = 'edited-while-signed-out'; ${newTask('new1', 'added-while-signed-out')}`);
  // Meanwhile another device edits a different record (newer) – it must still arrive.
  await mutate(B.p, 'pm', `s.tasks.find((t) => t.id === 't3').title = 'three-from-B';`);
  await syncNow(B.p);
  await A.ctx.setOffline(false);
  await S(A.p, `return await S.signIn({ username: 'fam', password: '${PW}' });`);
  await syncNow(A.p);
  const ta = await titlesOf(A.p, 'pm');
  assert(ta.includes('edited-offline'), 'K3 an edit pending at the Keep sign-out survives signing in again');
  assert(ta.includes('edited-while-signed-out') && ta.includes('added-while-signed-out'), 'K4 edits made while signed out survive');
  assert(ta.includes('three-from-B'), 'K5 …and the account’s newer edit on another record is applied (latest edit wins)');
  assert((await profiles(A.p)).filter((x) => x.name === 'Mick').length === 1 && (await syncSt(A.p)).synced.includes('pm') && !(await syncSt(A.p)).kept?.pm, 'K6 resumed as the same synced profile (no copy, marker gone)');
  assert(!(await shadowOf(A.p, 'kept:pm')), 'K7 the preserved shadow is dropped once resumed');
  await syncNow(B.p);
  const tb = await titlesOf(B.p, 'pm');
  assert(tb.includes('edited-offline') && tb.includes('edited-while-signed-out') && tb.includes('added-while-signed-out'), 'K8 the edits are uploaded to the account');

  // ===== 2. A kept marker without a preserved shadow (older data) is copied, never merged =====
  await S(A.p, `await S.signOut({ remove: false });`);
  await A.p.evaluate(async () => (await import('./js/syncCrypto.js')).idb('shadow', 'readwrite', (s) => s.delete('kept:pm')));
  await mutate(A.p, 'pm', `s.tasks.find((t) => t.id === 't1').title = 'old-style-kept-edit';`);
  await S(A.p, `return await S.signIn({ username: 'fam', password: '${PW}' });`);
  await syncNow(A.p);
  const pa = await profiles(A.p);
  const copy = pa.find((x) => x.name === 'Mick' && x.id !== 'pm');
  assert(pa.some((x) => x.id === 'pm') && copy, 'O1 the account’s profile is downloaded and the old kept copy stays beside it under a new id');
  assert(copy && (await titlesOf(A.p, copy.id)).includes('old-style-kept-edit') && !(await titlesOf(A.p, 'pm')).includes('old-style-kept-edit'), 'O2 the copy keeps its edit; the account isn’t changed by it');
  assert(!(await syncSt(A.p)).synced.includes(copy?.id), 'O3 the copy is device-only');

  // ===== 3. A new edit wins over a record with a future time (within the server's window) =====
  await mutate(A.p, 'pm', `s.tasks.find((t) => t.id === 't1').title = 'skewed';`);
  await syncNow(A.p);
  const sh = await shadowOf(A.p, 'pm');
  sh['pm/task/t1'] = [sh['pm/task/t1'][0], Date.now() + 2 * 3600000, sh['pm/task/t1'][2], 1]; // a device clock 2 h ahead
  await putShadow(A.p, 'pm', sh);
  await syncNow(A.p); await syncNow(B.p);
  await mutate(B.p, 'pm', `s.tasks.find((t) => t.id === 't1').title = 'newest-from-B';`);
  await syncNow(B.p); await syncNow(A.p); await syncNow(B.p);
  const t1b = (await profData(B.p, 'pm')).tasks.find((t) => t.id === 't1').title, t1a = (await profData(A.p, 'pm')).tasks.find((t) => t.id === 't1').title;
  assert(t1a === 'newest-from-B' && t1b === 'newest-from-B', 'C1 the newest edit wins over a record timed 2 h ahead');
  const tB = (await shadowOf(B.p, 'pm'))['pm/task/t1'][1];
  assert(tB > Date.now() + 3600000 && tB < Date.now() + 23 * 3600000 + 60000, 'C2 …its time is just after the future one (capped at 23 h ahead)');

  // ===== 4. A stale kept marker never merges another account's profile =====
  const D = await openApp(browser, { profiles: [['pd', 'Dee', data({ tasks: [task('d1', 'v1')] })]] });
  await S(D.p, `await S.signIn({ username: 'fam', password: '${PW}' }); await S.syncProfiles(['pd']); await S.syncNow();`);
  await S(D.p, `await S.signOut({ remove: false });`);
  assert((await syncSt(D.p)).kept?.pd, 'Y0 kept from fam');
  await S(D.p, `await S.createAccount({ username: 'fam2', password: '${PW}', registerKey: '${RKEY}' }); await S.syncProfiles(['pd']); await S.syncNow();`);
  assert(!(await syncSt(D.p)).kept?.pd && !(await shadowOf(D.p, 'kept:pd')), 'Y1 syncing to another account drops the old kept marker and preserved shadow');
  await mutate(D.p, 'pd', `s.tasks.find((t) => t.id === 'd1').title = 'fam2-era'; s.tasks.push(${JSON.stringify(task('d2', 'only-in-fam2'))});`);
  await syncNow(D.p);
  // fam2's session ends (e.g. password changed elsewhere); the user signs in to fam instead.
  await D.p.evaluate(() => { const s = JSON.parse(localStorage.getItem('dailyTracker:sync')); s.token = null; s.expired = true; localStorage.setItem('dailyTracker:sync', JSON.stringify(s)); });
  await S(D.p, `return await S.signIn({ username: 'fam', password: '${PW}' });`);
  await syncNow(D.p);
  await syncNow(B.p);
  assert(!(await profData(B.p, 'pd')).tasks.some((t) => t.id === 'd2') && (await profData(B.p, 'pd')).tasks.find((t) => t.id === 'd1').title === 'v1', 'Y2 fam2’s profile is not merged into fam');
  const pD = await profiles(D.p);
  const famCopy = pD.find((x) => x.id === 'pd'), fam2Copy = pD.find((x) => x.name === 'Dee' && x.id !== 'pd');
  assert(famCopy && (await titlesOf(D.p, 'pd')).includes('v1') && fam2Copy && (await titlesOf(D.p, fam2Copy.id)).includes('fam2-era') && (await titlesOf(D.p, fam2Copy.id)).includes('only-in-fam2'), 'Y3 the fam2 copy (with its edits) stays beside fam’s under a new id');

  // ===== 5. Expired session, then another account: the old account's profiles resume later =====
  const E = await openApp(browser, { profiles: [['pq', 'Queue', data({ tasks: [task('q1', 'q-v1')] })]] });
  await S(E.p, `await S.signIn({ username: 'fam2', password: '${PW}' }); await S.syncProfiles(['pq']); await S.syncNow();`);
  await E.p.evaluate(() => { const s = JSON.parse(localStorage.getItem('dailyTracker:sync')); s.token = null; s.expired = true; localStorage.setItem('dailyTracker:sync', JSON.stringify(s)); });
  await mutate(E.p, 'pq', `s.tasks.find((t) => t.id === 'q1').title = 'edited-while-expired';`);
  await S(E.p, `return await S.signIn({ username: 'fam', password: '${PW}' });`);
  const se = await syncSt(E.p);
  const fam2Id = (await shadowOf(E.p, 'kept:pq'))?.accountId;
  assert(se.kept?.pq && se.kept.pq === fam2Id && se.kept.pq !== se.accountId && !se.synced.includes('pq'), 'E1 the old account’s profile is kept for it (with its shadow), device-only now');
  await mutate(E.p, 'pq', `s.tasks.push(${JSON.stringify(task('q2', 'added-under-fam'))});`);
  await S(E.p, `await S.signOut({ remove: false }); await S.signIn({ username: 'fam2', password: '${PW}' }); await S.syncNow();`);
  assert((await syncSt(E.p)).synced.includes('pq') && (await profiles(E.p)).filter((x) => x.name === 'Queue').length === 1, 'E2 signing in to the old account resumes it');
  const F = await openApp(browser, { profiles: [['pf', 'Eff', data()]] });
  await S(F.p, `await S.signIn({ username: 'fam2', password: '${PW}' });`);
  const tf = await titlesOf(F.p, 'pq');
  assert(tf.includes('edited-while-expired') && tf.includes('added-under-fam'), 'E3 the edits made meanwhile reach the account');

  // ===== 6. A record the server refuses twice: "can't sync", shown, never pending forever =====
  await refuse(B.ctx);
  await mutate(B.p, 'pm', newTask('rf1', 'refused-one'));
  await syncNow(B.p);
  const shB = await shadowOf(B.p, 'pm');
  assert(shB['pm/task/rf1'] && shB['pm/task/rf1'][3] === 3, 'R1 a record refused twice is set aside as can’t sync');
  const note = await S(B.p, `return S.cantSyncNote();`);
  assert(/refused by the server/.test(note || ''), 'R2 Settings › Account says so: ' + note);
  await go(B.p, '#settings');
  assert(/refused/.test(await B.p.locator('.acct-cantsync').textContent().catch(() => '')), 'R3 UI: the note is shown under the status');
  const why = await S(B.p, `return await S.checkRemove();`);
  assert(/refused by the server/.test(why || '') && !/hasn’t been uploaded/.test(why || ''), 'R4 Remove explains it (not "pending"): ' + why);
  await B.ctx.unroute('**/api/sync/push');
  await mutate(B.p, 'pm', `s.tasks.find((t) => t.id === 'rf1').title = 'refused-one-edited';`);
  await syncNow(B.p);
  assert((await shadowOf(B.p, 'pm'))['pm/task/rf1'][3] === 0 && !(await S(B.p, `return S.cantSyncNote();`)), 'R5 editing it tries again; once uploaded the note goes');

  // ===== 7. A profile delete the server refuses twice stays pending and is shown =====
  await mutate(B.p, 'pz', newTask('z1', 'Zed task'));
  await S(B.p, `await S.syncProfiles(['pz']); await S.syncNow();`);
  await syncNow(A.p); await syncNow(A.p); await syncNow(B.p); // let the profile order settle
  assert((await profiles(A.p)).some((x) => x.id === 'pz'), 'X0 A has Zed');
  await refuse(B.ctx);
  await B.p.evaluate(async () => { const st = await import('./js/store.js'); st.switchProfile('pm'); st.deleteProfile('pz'); (await import('./js/sync.js')).profileDeleted('pz'); });
  await syncNow(B.p);
  const sb = await syncSt(B.p);
  assert(sb.deletes?.pz && sb.refusedDeletes?.pz, 'X1 the refused delete is still pending');
  assert(/profile deletion was refused/.test(await S(B.p, `return S.cantSyncNote();`) || ''), 'X2 …and shown in Settings › Account');
  assert(/deletion was refused/.test(await S(B.p, `return await S.checkRemove();`) || ''), 'X3 Remove explains it');
  await B.ctx.unroute('**/api/sync/push');
  await B.p.reload(); await B.p.waitForTimeout(500);
  await syncNow(B.p);
  assert(!(await syncSt(B.p)).deletes?.pz && !(await S(B.p, `return S.cantSyncNote();`)), 'X4 tried again after the app starts: uploaded, note gone');
  await syncNow(A.p);
  assert(!(await profiles(A.p)).some((x) => x.id === 'pz'), 'X5 the delete reaches the other device');

  // ===== 8. Orphaned raw backups are exported (and imports ignore them) =====
  await A.p.evaluate(() => { localStorage.setItem('dailyTracker:data:pgone:backup-1700000000000', '{"broken'); });
  const ex = await A.p.evaluate(async () => { const st = await import('./js/store.js'); const p = st.exportPayload(); const v = st.validateImport(JSON.parse(JSON.stringify(p))); return { rec: p.recovered, n: v.profiles.length, m: p.profiles.length }; });
  assert(ex.rec && ex.rec.length === 1 && ex.rec[0].profileId === 'pgone' && ex.rec[0].raw === '{"broken' && /^2023-/.test(ex.rec[0].savedAt), 'B1 an orphaned backup is in the export’s "recovered" section');
  assert(ex.n === ex.m, 'B2 the importer ignores it (same profiles)');
  assert(await A.p.evaluate(() => localStorage.getItem('dailyTracker:data:pgone:backup-1700000000000')) === '{"broken', 'B3 nothing prunes it');

  // ===== 10. An import that replaces a kept copy's data: the copy is never resumed (no revert) =====
  await S(E.p, `await S.signOut({ remove: false });`);
  assert((await syncSt(E.p)).kept?.pq && await shadowOf(E.p, 'kept:pq'), 'I0 kept');
  await S(E.p, `await S.forgetKept(['pq']);`);
  assert(!(await syncSt(E.p)).kept?.pq && !(await shadowOf(E.p, 'kept:pq')), 'I1 forgetKept drops the marker and the preserved shadow');

  // ===== 9. Remove's photo count: only photos the removed profiles' tasks refer to =====
  const G = await openApp(browser, { profiles: [['pg', 'Gee', data({ tasks: [task('g1', 'With photos', { attachments: [{ id: 'fG1', w: 1, h: 1, type: 'image/jpeg' }, { id: 'fG2', w: 1, h: 1, type: 'image/jpeg' }] })] })], ['ph', 'Aitch', data({ tasks: [task('h1', 'Shares', { attachments: [{ id: 'fG2', w: 1, h: 1, type: 'image/jpeg' }] })] })]] });
  const cnt = await G.p.evaluate(async () => {
    const a = await import('./js/attachments.js');
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
    const f = (id, pid) => a.putFile({ id, profileId: pid, taskId: 'g1', blob, thumbBlob: blob, type: 'image/jpeg', w: 1, h: 1, createdAt: Date.now() });
    await f('fG1', 'pg'); await f('fG2', 'pg'); await f('fStray', 'pg'); await f('fOther', 'ph');
    return a.photosOfProfiles(['pg']);
  });
  assert(cnt === 1, 'P1 counts only photos the removed profile refers to that no other profile uses: ' + cnt);

  console.log(errs.length ? 'errors: ' + errs.join('\n') : 'no page errors');
  await browser.close();
  await mf.dispose();
})().catch((e) => { console.log('FAIL: crashed ' + (e.stack || e)); process.exitCode = 1; process.exit(1); });
