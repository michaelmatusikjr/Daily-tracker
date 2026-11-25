const __ROOT = require('path').resolve(__dirname, '..');
// Accounts and sync, phase 2 (SYNC.md › Phase 2: photos, Register key): task photos upload in the
// background (encrypted), download on the other device, offline then reconnect, Undo after a delete
// keeps the photo, a delete reaches the account only after the delay (and only when it's safe),
// profile copies / shared photo ids never share a file, account quota, storage full while
// downloading, Remove refused while photos aren't uploaded, the register key reaching a second
// device. Two (or more) browser contexts against the REAL Worker in Miniflare; app on localhost:8080.
const { chromium } = require('playwright');
const fs = require('fs');
const SERVER_DIR = __ROOT + '/server';
const APP = 'http://localhost:8080/';
const API = 'http://127.0.0.1:8794';
const RKEY = 'reg-key-for-sync-tests-1';
const PW = 'correct horse battery';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const TODAY = keyOf(new Date());
const task = (id, title, o = {}) => ({ id, title, notes: '', date: TODAY, time: null, duration: null, priority: 0, category: null, reminder: null, recur: { type: 'none', days: [], interval: 2 }, done: false, doneDates: {}, exceptions: [], order: 1, createdAt: 1, ...o });
const data = (o = {}) => ({ version: 6, settings: { onboarded: true, theme: 'light', weekStart: 1, notifications: false, timeFormat: '24' }, tasks: [], habits: [], logs: {}, journal: {}, exercises: [], workouts: [], ...o });

async function openApp(browser, { profiles, active = null, rkey = RKEY } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', deviceScaleFactor: 1 });
  await ctx.route('**/daily-tracker-push.michael-matusik-jr.workers.dev/**', (r) => r.abort());
  await ctx.addInitScript(([profs, act, api, key]) => {
    if (localStorage.getItem('dailyTracker:profiles')) return;
    if (profs) {
      localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: act || profs[0][0], profiles: profs.map(([id, name]) => ({ id, name, avatar: { type: 'emoji', emoji: '', color: '#6366f1' } })) }));
      for (const [id, , d] of profs) localStorage.setItem('dailyTracker:data:' + id, JSON.stringify(d));
    }
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
    localStorage.setItem('dailyTracker:pushConfig', JSON.stringify(key ? { serverUrl: api, registerKey: key } : { serverUrl: api }));
  }, [profiles, active, API, rkey]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push(m.text()); });
  await p.goto(APP); await p.waitForTimeout(500);
  return { ctx, p };
}
const lsJSON = (p, k) => p.evaluate((x) => JSON.parse(localStorage.getItem(x) || 'null'), k);
const syncSt = (p) => lsJSON(p, 'dailyTracker:sync');
const profData = (p, id) => lsJSON(p, 'dailyTracker:data:' + id);
const profiles = (p) => lsJSON(p, 'dailyTracker:profiles').then((x) => x.profiles);
const syncNow = (p) => p.evaluate(async () => (await import('./js/sync.js')).syncNow());
const filePass = (p, o = {}) => p.evaluate(async (x) => (await import('./js/fileSync.js')).runFilePass(x), o);
const timing = (p, t) => p.evaluate(async (x) => (await import('./js/fileSync.js')).setFileTiming(x), t);
const both = async (p) => { await syncNow(p); await filePass(p); };
const mutate = (p, id, fnSrc) => p.evaluate(async ([id, src]) => { const s = await import('./js/store.js'); return s.mutateProfileData(id, new Function('s', src)); }, [id, fnSrc]);
const S = (p, fn, arg) => p.evaluate(async ([src, a]) => { const m = await import('./js/sync.js'); return new Function('S', 'a', 'return (async () => {' + src + '})()')(m, a); }, [fn, arg]);
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; };
const fileSize = (p, id) => p.evaluate(async (x) => (await (await import('./js/attachments.js')).getFile(x))?.blob?.size || 0, id);
const fileOwner = (p, id) => p.evaluate(async (x) => (await (await import('./js/attachments.js')).getFile(x))?.profileId || null, id);
const fidOf = (p, pid, id) => p.evaluate(async ([pid, id]) => { const C = await import('./js/syncCrypto.js'); const k = await C.loadKeys(); return C.fileIdOf(k.macKey, pid, id); }, [pid, id]);
const fstate = (p) => p.evaluate(async () => { const C = await import('./js/syncCrypto.js'); const a = JSON.parse(localStorage.getItem('dailyTracker:sync')).accountId; return C.idb('shadow', 'readonly', (s) => s.get('files:' + a)); });
const note = (p) => S(p, 'return S.cantSyncNote();');
/** A real JPEG (noise makes it big: several 512 KB chunks) stored for a task. */
const addPhoto = (p, pid, taskId, id, { w = 320, h = 200, noise = false } = {}) => p.evaluate(async ([pid, taskId, id, w, h, noise]) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  if (noise) { const img = x.createImageData(w, h); for (let i = 0; i < img.data.length; i++) img.data[i] = (Math.random() * 256) | 0; x.putImageData(img, 0, 0); }
  else { x.fillStyle = '#' + ((Math.random() * 0xffffff) | 0).toString(16).padStart(6, '0'); x.fillRect(0, 0, w, h); x.fillStyle = '#000'; x.fillText(id, 10, 20); }
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
  const thumb = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.5));
  const a = await import('./js/attachments.js');
  await a.putFile({ id, profileId: pid, taskId, blob, thumbBlob: thumb, type: 'image/jpeg', w, h, size: blob.size, createdAt: Date.now() });
  const s = await import('./js/store.js');
  s.mutateProfileData(pid, (st) => { const t = st.tasks.find((y) => y.id === taskId); t.attachments = [...(t.attachments || []), { id, w, h, type: 'image/jpeg' }]; });
  return blob.size;
}, [pid, taskId, id, w, h, noise]);
const viewText = async (p, taskId) => {
  await p.evaluate(async ([id, d]) => (await import('./js/taskView.js')).openTaskView(id, d), [taskId, TODAY]);
  await p.waitForTimeout(400);
};
const closeSheets = async (p) => { await p.keyboard.press('Escape'); await p.waitForTimeout(300); };

(async () => {
  const { Miniflare } = await import(SERVER_DIR + '/node_modules/miniflare/dist/src/index.js');
  const mf = new Miniflare({
    modules: true, modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    modulesRoot: SERVER_DIR, scriptPath: SERVER_DIR + '/src/index.js', compatibilityDate: '2026-07-01', port: 8794, host: '127.0.0.1',
    d1Databases: ['DB'],
    bindings: { VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: 'mailto:test@example.com', ALLOWED_ORIGINS: 'http://localhost:8080', REGISTER_KEY: RKEY, MAX_ACCOUNTS: '20' },
  });
  await mf.ready;
  const db = await mf.getD1Database('DB');
  for (const s of fs.readFileSync(SERVER_DIR + '/schema.sql', 'utf8').replace(/--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean)) await db.prepare(s).run();
  const serverFids = async () => new Set((await db.prepare('SELECT fid FROM files').all()).results.map((r) => r.fid));
  const browser = await chromium.launch();

  // ===== Upload: A signs up with a task photo (several chunks) =====
  const A = await openApp(browser, { profiles: [['pm', 'Mick', data({ tasks: [task('t1', 'Receipt'), task('t2', 'Fridge'), task('t3', 'Spare')] })]] });
  const big = await addPhoto(A.p, 'pm', 't1', 'fA1', { w: 1200, h: 900, noise: true });
  assert(big > 600 * 1024, 'U0 a big photo (' + Math.round(big / 1024) + ' KB, more than one chunk)');
  await S(A.p, `await S.createAccount({ username: 'fam', password: '${PW}', registerKey: '${RKEY}' }); await S.syncProfiles(['pm']); await S.syncNow();`);
  await filePass(A.p);
  const fid1 = await fidOf(A.p, 'pm', 'fA1');
  assert((await serverFids()).has(fid1), 'U1 the photo is in the account after the task record synced');
  const row = await db.prepare('SELECT size, chunks FROM files WHERE fid = ?1').bind(fid1).first();
  assert(row.chunks >= 2, 'U2 stored in chunks: ' + row.chunks);
  const chunk0 = (await db.prepare('SELECT c.data FROM file_chunks c JOIN files f ON f.upload = c.upload WHERE f.fid = ?1 AND c.n = 0').bind(fid1).first()).data;
  const raw0 = Buffer.from(chunk0, 'base64url');
  assert(raw0.indexOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])) < 0 && !raw0.includes('JFIF') && !raw0.includes('image/jpeg'), 'U3 the server only has ciphertext (no JPEG bytes or type)');
  assert(!JSON.stringify((await db.prepare('SELECT * FROM files').all()).results).includes('fA1'), 'U4 the file id is opaque (not the photo id)');

  // ===== Download on B (which has no register key yet) =====
  const B = await openApp(browser, { profiles: [['pk', 'Kid', data()]], rkey: null });
  await S(B.p, `await S.signIn({ username: 'fam', password: '${PW}' });`);
  await filePass(B.p);
  assert(await fileSize(B.p, 'fA1') === big && await fileOwner(B.p, 'fA1') === 'pm', 'D1 B downloads the photo (same size, stored for the profile)');
  const bThumb = await B.p.evaluate(async () => !!(await (await import('./js/attachments.js')).getFile('fA1'))?.thumbBlob);
  assert(bThumb, 'D2 …with its thumbnail');
  // Register key (#33): B gets the account's copy.
  const bKey = await B.p.evaluate(async () => (await import('./js/push.js')).pushConfig().registerKey);
  assert(bKey === RKEY, 'K1 the register key reaches a newly signed-in device');
  // Changed on B → reaches A (latest wins).
  await B.p.evaluate(async () => { const p = await import('./js/push.js'); const c = p.pushConfig(); p.setPushConfig({ serverUrl: c.serverUrl, publicKey: '', registerKey: 'changed-on-b-12345' }); });
  await syncNow(B.p); await syncNow(A.p);
  assert(await A.p.evaluate(async () => (await import('./js/push.js')).pushConfig().registerKey) === 'changed-on-b-12345', 'K2 a key changed on one device updates the others');
  const exp = await B.p.evaluate(async () => JSON.stringify((await import('./js/store.js')).exportPayload()));
  assert(!exp.includes('changed-on-b') && !exp.includes(RKEY), 'K3 the register key is never in an export');
  const recs = (await db.prepare('SELECT blob FROM records').all()).results.map((r) => Buffer.from(r.blob, 'base64url').toString('latin1')).join('');
  assert(!recs.includes('changed-on-b'), 'K4 the key is end-to-end encrypted in the account');
  // An older value doesn't win: A's copy with an older time isn't uploaded over B's.
  const aMeta = await A.p.evaluate(async () => (await import('./js/push.js')).registerKeyMeta());
  assert(aMeta.t > 0 && aMeta.dev && aMeta.key === 'changed-on-b-12345', 'K5 the key keeps its edit time and device when it arrives');
  await B.p.evaluate(async (k) => { const p = await import('./js/push.js'); const c = p.pushConfig(); p.setPushConfig({ serverUrl: c.serverUrl, publicKey: '', registerKey: k }); }, RKEY);
  await syncNow(B.p); await syncNow(A.p);

  // ===== "Downloading…" while on its way, then the photo; "Photo on another device" when it can't be downloaded =====
  const C = await openApp(browser, { profiles: [['pc', 'Cee', data()]] });
  let release;
  const held = new Promise((r) => { release = r; });
  await C.ctx.route('**/api/files/*/0', async (route) => { await held; route.continue(); });
  await S(C.p, `await S.signIn({ username: 'fam', password: '${PW}' });`);
  await C.p.evaluate(async () => (await import('./js/store.js')).switchProfile('pm'));
  await C.p.waitForTimeout(300);
  const passC = filePass(C.p);
  await viewText(C.p, 't1');
  assert(await C.p.locator('.tv-photos .photo-item.missing .photo-elsewhere').textContent() === 'Downloading…', 'V1 the View sheet shows "Downloading…" while the photo is on its way');
  release();
  await passC;
  await waitFor(async () => (await C.p.locator('.tv-photos .photo-item img[src]').count()) === 1, 5000);
  assert(await C.p.locator('.tv-photos .photo-item img[src]').count() === 1 && await C.p.locator('.tv-photos .photo-item.missing').count() === 0, 'V2 …and the photo as soon as it arrives');
  await closeSheets(C.p);
  await C.ctx.unroute('**/api/files/*/0');

  // ===== Offline: a photo added offline uploads on reconnect; offline devices show the placeholder =====
  await A.ctx.setOffline(true);
  await addPhoto(A.p, 'pm', 't2', 'fA2');
  await syncNow(A.p);
  await filePass(A.p);
  const fid2 = await fidOf(A.p, 'pm', 'fA2');
  assert(!(await serverFids()).has(fid2), 'O1 offline: nothing uploaded (and no error loop)');
  await A.ctx.setOffline(false);
  await A.p.evaluate(() => window.dispatchEvent(new Event('online')));
  await both(A.p);
  assert((await serverFids()).has(fid2), 'O2 back online: the photo uploads');
  // B gets the record but can't reach the photo files, then goes offline: the placeholder.
  await B.ctx.route('**/api/files/**', (r) => r.abort());
  await syncNow(B.p); await filePass(B.p);
  await B.ctx.setOffline(true);
  await B.p.evaluate(async () => (await import('./js/store.js')).switchProfile('pm'));
  await viewText(B.p, 't2');
  assert(await B.p.locator('.tv-photos .photo-item.missing .photo-elsewhere').textContent() === 'Photo on another device', 'O3 offline: a photo not downloaded yet shows "Photo on another device"');
  await closeSheets(B.p);
  await B.ctx.unroute('**/api/files/**');
  await B.ctx.setOffline(false);
  await B.p.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitFor(async () => (await fileSize(B.p, 'fA2')) > 0, 10000);
  assert(await fileSize(B.p, 'fA2') > 0, 'O4 back online: the download happens by itself');

  // ===== Undo after a delete keeps the photo (on the server and on the devices) =====
  await A.p.evaluate(async () => (await import('./js/store.js')).switchProfile('pm'));
  await A.p.evaluate(async () => (await import('./js/actions.js')).deleteTask('t1'));
  await syncNow(A.p); // the tombstone reaches the account during the Undo window
  await filePass(A.p, { gc: true }); // a clean-up now only starts the delay
  await A.p.click('.toast-action');
  await A.p.waitForTimeout(300);
  await syncNow(A.p); await filePass(A.p, { gc: true });
  assert((await serverFids()).has(fid1), 'N1 Undo after the delete synced: the photo is still in the account');
  await A.p.waitForTimeout(8500); // past the local photo clean-up of a deleted task
  assert(await fileSize(A.p, 'fA1') === big, 'N2 …and still on this device');
  await both(B.p);
  assert((await profData(B.p, 'pm')).tasks.find((t) => t.id === 't1')?.attachments?.[0]?.id === 'fA1' && await fileSize(B.p, 'fA1') === big, 'N3 the other device has the task and its photo again');

  // ===== A delete reaches the account only after the delay, and only when it's safe =====
  await timing(A.p, { gcDelay: 4000, gcEvery: 0 });
  await A.p.evaluate(async () => { const s = await import('./js/store.js'); s.update((st) => { st.tasks = st.tasks.filter((t) => t.id !== 't2'); }); });
  await syncNow(A.p); await filePass(A.p, { gc: true });
  assert((await serverFids()).has(fid2), 'G1 right after the delete synced the file stays (the delay starts)');
  const unref = (await fstate(A.p)).unref || {};
  assert(unref[fid2] && !unref[fid1], 'G2 only the unreferenced file is waiting');
  await both(B.p); // B (default 7-day delay) never deletes it
  await filePass(B.p, { gc: true });
  assert((await serverFids()).has(fid2), 'G3 a device with the normal delay keeps it');
  await sleep(4300);
  // Not safe: an edit not uploaded yet → nothing is deleted.
  await A.ctx.route('**/api/sync/push', (r) => r.abort());
  await mutate(A.p, 'pm', `s.tasks.find((t) => t.id === 't3').title = 'Spare (not uploaded)';`);
  await syncNow(A.p);
  await filePass(A.p, { gc: true });
  assert((await serverFids()).has(fid2), 'G4 with edits still to upload, nothing is deleted');
  await A.ctx.unroute('**/api/sync/push');
  await syncNow(A.p); await filePass(A.p, { gc: true });
  assert(!(await serverFids()).has(fid2) && (await serverFids()).has(fid1), 'G5 after the delay, synced and settled: the unreferenced file is deleted (the other stays)');
  const bytesNow = (await db.prepare('SELECT bytes FROM accounts').first()).bytes;
  assert(bytesNow > 0, 'G6 account bytes still count the remaining files');

  // ===== Shared photo ids / copies: never one file for two profiles =====
  // A second synced profile whose task refers to the same local photo id as Mick's.
  await A.p.evaluate(async () => { const s = await import('./js/store.js'); s.addProfile({ name: 'Twin' }); });
  const twin = await A.p.evaluate(async () => (await import('./js/store.js')).getActiveProfile().id);
  await mutate(A.p, twin, `s.tasks.push(${JSON.stringify(task('tw1', 'Shares a photo id', { attachments: [{ id: 'fA1', w: 1200, h: 900, type: 'image/jpeg' }] }))});`);
  await S(A.p, `await S.syncProfiles(['${twin}']); await S.syncNow();`);
  await filePass(A.p);
  const fidTwin = await fidOf(A.p, twin, 'fA1');
  assert(fidTwin !== fid1 && (await serverFids()).has(fidTwin) && (await serverFids()).has(fid1), 'I1 the same photo id in two profiles: two separate files in the account');
  await A.p.evaluate(async (id) => { const st = await import('./js/store.js'); st.switchProfile('pm'); st.deleteProfile(id); (await import('./js/sync.js')).profileDeleted(id); }, twin);
  await syncNow(A.p); await filePass(A.p, { gc: true });
  await sleep(4300);
  await syncNow(A.p); await filePass(A.p, { gc: true });
  assert(!(await serverFids()).has(fidTwin) && (await serverFids()).has(fid1), 'I2 deleting one profile deletes its file only – the other profile’s photo stays');
  assert(await fileSize(A.p, 'fA1') === big, 'I3 …and the shared local photo stays on this device');
  // A device-only profile with the account profile's id gets a new id with copied photos: separate files.
  const E = await openApp(browser, { profiles: [['pm', 'Other Mick', data({ tasks: [task('pe1', 'Mine', { attachments: [{ id: 'fE1', w: 1, h: 1, type: 'image/jpeg' }] })] })]] });
  await E.p.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 8; c.height = 8;
    const b = await new Promise((r) => c.toBlob(r, 'image/jpeg'));
    await (await import('./js/attachments.js')).putFile({ id: 'fE1', profileId: 'pm', taskId: 'pe1', blob: b, thumbBlob: b, type: 'image/jpeg', w: 8, h: 8, size: b.size, createdAt: Date.now() });
  });
  await S(E.p, `await S.signIn({ username: 'fam', password: '${PW}' });`);
  await filePass(E.p);
  const other = (await profiles(E.p)).find((x) => x.name === 'Other Mick');
  const eAtt = (await profData(E.p, other.id)).tasks[0].attachments[0].id;
  assert(other.id !== 'pm' && eAtt !== 'fE1', 'I4 the same-id device profile moved to a new id with its photo copied');
  const fidE = await fidOf(E.p, other.id, eAtt);
  assert(!(await serverFids()).has(fidE) && !(await serverFids()).has(await fidOf(E.p, 'pm', 'fE1')), 'I5 a device-only copy’s photos are never uploaded');
  await S(E.p, `await S.syncProfiles(['${other.id}']); await S.syncNow();`);
  await filePass(E.p);
  assert((await serverFids()).has(fidE) && (await serverFids()).has(fid1), 'I6 synced later: its own file, next to the account profile’s');
  await E.p.close(); await E.ctx.close();

  // ===== Remove refused while photos aren't uploaded =====
  await A.ctx.route('**/api/files/upload', (r) => r.abort());
  await addPhoto(A.p, 'pm', 't3', 'fA3');
  await syncNow(A.p);
  const why = await S(A.p, 'return S.checkRemove();');
  assert(/photo on this device hasn’t been uploaded yet/.test(why || ''), 'R1 Remove is refused while a photo isn’t uploaded: ' + why);
  await A.ctx.unroute('**/api/files/upload');
  const why2 = await S(A.p, 'return S.checkRemove();');
  assert(why2 === null, 'R2 once it is uploaded, Remove is allowed: ' + why2);
  const photoCount = await A.p.evaluate(async () => (await import('./js/attachments.js')).photosOfProfiles(['pm']));
  assert(photoCount === 2, 'R3 the confirm’s count is the photos on this device (2): ' + photoCount);

  // ===== Account quota: 413 → shown, Remove refused, uploads once there is room =====
  await db.prepare('UPDATE accounts SET bytes = ?1').bind(200 * 1024 * 1024 - 2000).run();
  await addPhoto(A.p, 'pm', 't3', 'fA4');
  await both(A.p);
  const fid4 = await fidOf(A.p, 'pm', 'fA4');
  assert(!(await serverFids()).has(fid4), 'Q1 account full: not uploaded');
  assert(/couldn’t be uploaded: your account’s storage is full/.test((await note(A.p)) || ''), 'Q2 Settings › Account says so: ' + (await note(A.p)));
  const why3 = await S(A.p, 'return S.checkRemove();');
  assert(/storage is full/.test(why3 || ''), 'Q3 Remove explains it: ' + why3);
  await db.prepare('UPDATE accounts SET bytes = 1000').run();
  await A.p.evaluate(async () => { const C = await import('./js/syncCrypto.js'); const a = JSON.parse(localStorage.getItem('dailyTracker:sync')).accountId; const st = await C.idb('shadow', 'readonly', (s) => s.get('files:' + a)); st.tries = {}; await C.idb('shadow', 'readwrite', (s) => s.put(st, 'files:' + a)); });
  await filePass(A.p);
  assert((await serverFids()).has(fid4) && !(await note(A.p)), 'Q4 with room again it uploads and the note goes');

  // ===== Storage full on this device while downloading =====
  await timing(B.p, { fullRetry: 1500 });
  await B.p.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    window.__unfill = () => { IDBObjectStore.prototype.put = put; };
    IDBObjectStore.prototype.put = function (...a) { if (this.name === 'files') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); return put.apply(this, a); };
  });
  await both(B.p);
  assert(await fileSize(B.p, 'fA4') === 0, 'F1 device full: the photo isn’t stored');
  assert(/Not enough space on this device to download \d+ photos?/.test((await note(B.p)) || ''), 'F2 …it says so: ' + (await note(B.p)));
  const fsB = await fstate(B.p);
  assert(fsB.deviceFull > 0, 'F3 downloads stop and are tried again later');
  assert(await syncNow(B.p) === true, 'F4 record sync isn’t blocked');
  await viewText(B.p, 't3');
  assert((await B.p.locator('.tv-photos .photo-elsewhere').allTextContents()).includes('Not enough space on this device'), 'F5 the View sheet says there isn’t enough space');
  await closeSheets(B.p);
  await B.p.evaluate(() => window.__unfill());
  await sleep(1700);
  await filePass(B.p);
  assert(await fileSize(B.p, 'fA4') > 0 && await fileSize(B.p, 'fA3') > 0 && !(await note(B.p)), 'F6 with space again, the downloads finish');

  // ===== Sign out: per-account photo state is cleared; account delete removes every file =====
  await S(B.p, 'await S.signOut({ remove: false });');
  const leftB = await B.p.evaluate(async () => (await import('./js/syncCrypto.js')).idb('shadow', 'readonly', (s) => s.getAllKeys()));
  assert(!leftB.some((k) => String(k).startsWith('files:')), 'X1 sign-out clears this device’s photo-sync state');
  assert(await B.p.evaluate(async () => (await import('./js/push.js')).pushConfig().registerKey) === RKEY, 'X2 sign-out leaves the device’s register key');
  assert(await fileSize(B.p, 'fA1') === big, 'X3 Keep: the photos stay on the device');
  await S(A.p, `await S.deleteAccount('${PW}');`);
  assert((await db.prepare('SELECT COUNT(*) n FROM files').first()).n === 0 && (await db.prepare('SELECT COUNT(*) n FROM file_chunks').first()).n === 0, 'X4 deleting the account removes every file');


  // ===== QA round regressions (1.16.0) =====
  {
    const RA = await openApp(browser, { profiles: [['pm', 'Mick', data({ tasks: [task('t1', 'Receipt'), task('t2', 'Other')] })]] });
    await addPhoto(RA.p, 'pm', 't1', 'fR1');
    await S(RA.p, `await S.createAccount({ username: 'regr', password: '${PW}', registerKey: '${RKEY}' }); await S.syncProfiles(['pm']); await S.syncNow();`);
    await filePass(RA.p);
    const fidR1 = await fidOf(RA.p, 'pm', 'fR1');
    assert((await serverFids()).has(fidR1), 'W0 uploaded');
    // R1: the server loses the file; the device that still has the photo uploads it again after its task record changed.
    await db.prepare('DELETE FROM files WHERE fid = ?1').bind(fidR1).run();
    await mutate(RA.p, 'pm', `s.tasks.find((t) => t.id === 't1').title = 'Receipt edited';`);
    await syncNow(RA.p); await filePass(RA.p); await syncNow(RA.p); await filePass(RA.p);
    assert((await serverFids()).has(fidR1), 'W1 a device that has the photo uploads it again after the account lost it');
    // R2: …and without any record change, once the daily re-check is due.
    await db.prepare('DELETE FROM files WHERE fid = ?1').bind(fidR1).run();
    await RA.p.evaluate(async () => { const C = await import('./js/syncCrypto.js'); const a = JSON.parse(localStorage.getItem('dailyTracker:sync')).accountId; const st = await C.idb('shadow', 'readonly', (s) => s.get('files:' + a)); for (const f of Object.keys(st.chk || {})) st.chk[f][0] -= 2 * 86400000; await C.idb('shadow', 'readwrite', (s) => s.put(st, 'files:' + a)); });
    await filePass(RA.p);
    assert((await serverFids()).has(fidR1), 'W2 the daily re-check finds the file missing and uploads it again');
    // R3: the "Remove from this device" upload pass ignores the cache.
    await db.prepare('DELETE FROM files WHERE fid = ?1').bind(fidR1).run();
    await filePass(RA.p, { uploadOnly: true });
    assert((await serverFids()).has(fidR1), 'W3 the upload-only pass (before Remove) re-checks the server too');

    // R4: a device that couldn't store a remote task never deletes its photo from the account (behind).
    const RB = await openApp(browser, { profiles: [['pk', 'Kid', data()]], rkey: null });
    await S(RB.p, `await S.signIn({ username: 'regr', password: '${PW}' });`);
    await filePass(RB.p);
    await syncNow(RA.p);
    await RA.p.evaluate(() => { const orig = Storage.prototype.setItem; window.__origSet = orig; Storage.prototype.setItem = function (k, v) { if (k === 'dailyTracker:data:pm') { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; } return orig.call(this, k, v); }; });
    await mutate(RB.p, 'pm', `s.tasks.push(${JSON.stringify(task('tb', 'From B'))});`);
    await addPhoto(RB.p, 'pm', 'tb', 'fB1');
    await syncNow(RB.p); await filePass(RB.p); await syncNow(RB.p); await filePass(RB.p);
    const fidB = await fidOf(RB.p, 'pm', 'fB1');
    assert((await serverFids()).has(fidB), 'W4a B uploaded its photo');
    await timing(RA.p, { gcDelay: 1500, gcEvery: 0 });
    await syncNow(RA.p);
    assert(await S(RA.p, 'return S.gcReady();') === false, 'W4b gcReady is false while a remote change couldn’t be stored');
    await filePass(RA.p, { gc: true });
    await sleep(1800);
    await syncNow(RA.p); await filePass(RA.p, { gc: true });
    assert((await serverFids()).has(fidB), 'W4c the photo of a task this device couldn’t store stays in the account');
    // With room again, a pull that applies everything clears `behind`.
    await RA.p.evaluate(() => { Storage.prototype.setItem = window.__origSet; });
    await syncNow(RA.p); await syncNow(RA.p);
    assert(!(await syncSt(RA.p)).behind, 'W4d a complete pull clears behind');

    // R5: clean-up only deletes files this client derived itself; an unknown file is never touched.
    const acct = (await syncSt(RA.p)).accountId;
    const unknown = 'U' + 'x'.repeat(42);
    await db.prepare('INSERT INTO files (account_id, fid, upload, size, chunks, created_at) VALUES (?1, ?2, ?3, 100, 1, 1)').bind(acct, unknown, 'up' + 'y'.repeat(20)).run();
    await mutate(RA.p, 'pm', `s.tasks = s.tasks.filter((t) => t.id !== 't1');`);
    await syncNow(RA.p); await filePass(RA.p, { gc: true });
    await sleep(1800);
    await syncNow(RA.p); await filePass(RA.p, { gc: true });
    const left = await serverFids();
    assert(left.has(unknown), 'W5a a file of unknown origin is never deleted by clean-up');
    assert(!left.has(fidR1), 'W5b a photo this device knew and nothing refers to any more is deleted');

    // R6: a custom cutoff after today is limited to today.
    const same = await RA.p.evaluate(async () => {
      const { planClear } = await import('./js/clearCompleted.js');
      const { getState } = await import('./js/store.js');
      const { todayKey, addDays } = await import('./js/dates.js');
      const st = getState();
      const a = planClear(st, addDays(todayKey(), 30)), b = planClear(st, todayKey());
      return a.tasks.length === b.tasks.length && a.partial.length === b.partial.length;
    });
    assert(same, 'W6 a future cutoff clears no more than a cutoff of today');
    await RA.ctx.close(); await RB.ctx.close();
  }

  const real = errs.filter((e) => !/Photo sync|Sync failed/.test(e));
  assert(real.length === 0, 'no page errors: ' + real.join(' | '));
  await browser.close();
  await mf.dispose();
})().catch((e) => { console.log('FAIL: crashed', e); process.exitCode = 1; process.exit(1); });
