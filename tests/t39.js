const __ROOT = require('path').resolve(__dirname, '..');
// Accounts and sync, phase 1 (SYNC.md): two (or more) browser contexts against the REAL Worker in
// Miniflare (local D1). The app is served from http://localhost:8080 (passkeys need a hostname,
// not an IP); passkeys use a CDP virtual authenticator, with and without PRF.
const { chromium } = require('playwright');
const fs = require('fs');
const SERVER_DIR = __ROOT + '/server';
const APP = 'http://localhost:8080/';
const API = 'http://127.0.0.1:8798';
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
    modulesRoot: SERVER_DIR, scriptPath: SERVER_DIR + '/src/index.js', compatibilityDate: '2026-07-01', port: 8798, host: '127.0.0.1',
    d1Databases: ['DB'],
    bindings: { VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: 'mailto:test@example.com', ALLOWED_ORIGINS: 'http://localhost:8080', REGISTER_KEY: RKEY, MAX_ACCOUNTS: '20' },
  });
  await mf.ready;
  const db = await mf.getD1Database('DB');
  for (const s of fs.readFileSync(SERVER_DIR + '/schema.sql', 'utf8').replace(/--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean)) await db.prepare(s).run();
  const serverRecords = async () => (await db.prepare('SELECT COUNT(*) n FROM records').first()).n;
  const browser = await chromium.launch();

  // ===== A: one profile with data. Before anyone signs in it's marked "On this device only". =====
  const dA = data({
    tasks: [task('t1', 'Buy milk'), task('t2', 'Call mom', { priority: 2 })],
    habits: [habit('h1', 'Water')], logs: { h1: { [TODAY]: 1 } }, journal: { [TODAY]: { mood: 4, note: 'Good day' } },
    categories: [{ id: 'work', name: 'Work', color: '#3b82f6' }],
  });
  const A = await openApp(browser, { profiles: [['pm', 'Mick', dA]], authenticator: { prf: true } });
  assert(await A.p.locator('.avatar-btn.device-only .device-badge').count() === 1, 'B1 device-only badge on the header avatar before sign-in');
  await A.p.click('.avatar-btn');
  await A.p.waitForTimeout(300);
  assert(await A.p.locator('.profile-list li.device-only .device-only-label').count() === 1, 'B2 profile menu row says "On this device only"');
  await A.p.click('.device-only-label');
  await A.p.waitForTimeout(400);
  assert(await sheetTitle(A.p) === 'Account' && await A.p.locator('.sheet-root.open .acct-panel button:has-text("Create account")').count() === 1, 'B3 tapping the label opens the Account sheet (signed out: Create account / Sign in)');
  await A.p.keyboard.press('Escape'); await A.p.waitForTimeout(300);

  // ===== Sign up on A (Settings › Account at the top) =====
  await go(A.p, '#settings');
  assert(await A.p.locator('.view-settings .set-group').first().locator('.set-title').textContent() === 'Account', 'S1 Account is the first section in Settings');
  await A.p.click('.acct-panel button:has-text("Create account")');
  await A.p.waitForTimeout(300);
  await A.p.fill('[aria-label="Username"]', 'Family');
  await A.p.fill('.sheet-root.open [aria-label="Password"]', PW);
  await A.p.fill('[aria-label="Confirm password"]', PW);
  assert(await A.p.inputValue('[aria-label="Register key"]') === RKEY, 'S2 register key prefilled from the reminders config');
  await A.p.click('.sheet-root.open .sheet-foot button:has-text("Create account")');
  await waitFor(async () => (await sheetTitle(A.p)) === 'Your recovery key', 15000);
  const recText = (await A.p.locator('.recovery-key').textContent()).trim();
  assert(/^([A-Z2-7]{4} ){12}[A-Z2-7]{4}$/.test(recText), 'S3 recovery key shown: 52 base32 characters in groups of 4');
  assert(await A.p.locator('.sheet-root.open .sheet-foot .btn.primary').isDisabled(), 'S4 Continue needs the "I’ve saved it" checkbox');
  await A.p.check('#rec-saved');
  await A.p.click('.sheet-root.open .sheet-foot .btn.primary');
  await waitFor(async () => (await sheetTitle(A.p)) === 'Sync this device’s profiles?');
  assert(await A.p.locator('.picker-row').count() === 1 && await A.p.locator('.picker-row input[type=checkbox]').isChecked(), 'S5 profile picker lists this device’s profile (preselected for a new account)');
  await A.p.click('.sheet-root.open .sheet-foot button:has-text("Sync selected")');
  await A.p.waitForTimeout(300);
  // Offer a passkey (with PRF)
  assert(await sheetTitle(A.p) === 'Add a passkey?', 'S6 a new account is offered a passkey');
  await A.p.click('.sheet-root.open button:has-text("Add a passkey")');
  await waitFor(async () => (await A.p.locator('.toast-msg').textContent().catch(() => '')).includes('Passkey added'), 10000);
  assert((await A.p.locator('.toast-msg').textContent()) === 'Passkey added', 'S7 passkey added (PRF: unlocks data by itself)');
  await waitFor(async () => (await syncSt(A.p))?.lastOk && (await serverRecords()) > 5, 10000);
  const stA = await syncSt(A.p);
  assert(stA.synced.includes('pm') && stA.username === 'family', 'S8 Mick syncs to the account');
  console.log('records on server:', await serverRecords());
  const raw = (await db.prepare('SELECT blob FROM records LIMIT 50').all()).results.map((r) => r.blob).join('');
  assert(!raw.includes('Buy milk') && !Buffer.from(raw, 'base64url').toString('latin1').includes('Buy milk'), 'S9 the server only stores ciphertext');
  await go(A.p, '#today');
  assert(await A.p.locator('.avatar-btn .device-badge').count() === 0, 'S10 synced profile: no device-only badge');


  // ===== B: own profiles "Kid" and a different "Mick" (name clash). Sign in with the password. =====
  const dB = data({ tasks: [task('kt1', 'Homework')], habits: [habit('kh1', 'Read', { emoji: '📚' })] });
  const B = await openApp(browser, { profiles: [['pk', 'Kid', dB], ['pb', 'mick ', data({ tasks: [task('bt', 'B Mick task')] })]], authenticator: { prf: false } });
  await go(B.p, '#settings');
  await B.p.click('.acct-panel button:has-text("Sign in")');
  await B.p.fill('.sheet-root.open [aria-label="Username"]', 'family');
  await B.p.fill('.sheet-root.open [aria-label="Password"]', 'wrong password!!');
  await B.p.click('.sheet-root.open .sheet-foot button:has-text("Sign in")');
  await waitFor(async () => (await B.p.locator('.sheet-root.open .form-error').textContent()).length > 0, 10000);
  assert(await B.p.locator('.sheet-root.open .form-error').textContent() === 'Wrong username or password', 'I1 wrong password: clear message');
  await B.p.fill('.sheet-root.open [aria-label="Password"]', PW);
  await B.p.click('.sheet-root.open .sheet-foot button:has-text("Sign in")');
  await waitFor(async () => (await sheetTitle(B.p)) === 'Sync this device’s profiles?', 15000);
  let pB = await profiles(B.p);
  assert(pB.some((x) => x.id === 'pm' && x.name === 'Mick'), 'I2 sign-in downloads the account’s profiles');
  const mB = await profData(B.p, 'pm');
  assert(mB.tasks.map((t) => t.title).sort().join() === 'Buy milk,Call mom' && mB.logs.h1[TODAY] === 1 && mB.journal[TODAY].note === 'Good day' && mB.categories.map((c) => c.name).join() === 'Work', 'I3 tasks, habits, logs, journal and categories arrive');
  assert(await B.p.locator('.picker-row').count() === 2 && !(await B.p.locator('.picker-row input[type=checkbox]').first().isChecked()), 'I4 picker lists B’s own profiles (not preselected when signing in)');
  // Select both; "mick " clashes with the account's "Mick" → inline rename.
  for (const cb of await B.p.locator('.picker-row input[type=checkbox]').all()) await cb.check();
  const clashRow = B.p.locator('.picker-row', { hasText: 'mick' });
  assert(await clashRow.locator('.picker-rename').isVisible() && /already has “Mick”/.test(await clashRow.locator('.picker-rename .field-hint').textContent()), 'I5 name clash (case/space-insensitive): rename field in the same flow');
  await B.p.click('.sheet-root.open .sheet-foot button:has-text("Sync selected")');
  await B.p.waitForTimeout(200);
  assert(await sheetTitle(B.p) === 'Sync this device’s profiles?' && /unique/.test(await B.p.locator('.sheet-root.open > .sheet .form-error').last().textContent()), 'I6 can’t sync with a clashing name');
  await clashRow.locator('.picker-rename input').fill('Mick B');
  await B.p.click('.sheet-root.open .sheet-foot button:has-text("Sync selected")');
  await B.p.waitForTimeout(300);
  await waitFor(async () => { await syncNow(B.p); const st = await syncSt(B.p); return st.synced.length === 3 && st.lastOk; });
  pB = await profiles(B.p);
  assert(pB.find((x) => x.id === 'pb').name === 'Mick B', 'I7 the device profile was renamed before syncing');
  await syncNow(A.p);
  let pA = await profiles(A.p);
  assert(pA.map((x) => x.name).sort().join() === 'Kid,Mick,Mick B', 'I8 A gets B’s synced profiles');
  assert((await profData(A.p, 'pk')).tasks[0].title === 'Homework' && (await profData(A.p, 'pk')).habits[0].emoji === '📚', 'I9 their data too');
  assert(await A.p.locator('.avatar-btn .device-badge').count() === 0, 'I10 still no device-only badge on A');

  // ===== Edits both ways: tasks, habits, logs, journal, settings =====
  await A.p.evaluate(async (d) => { const a = await import('./js/actions.js'); a.saveTask({ title: 'From A', date: d }); }, TODAY);
  await mutate(A.p, 'pm', `s.tasks.find((t) => t.id === 't1').title = 'Buy oat milk'; s.tasks.find((t) => t.id === 't1').updatedAt = Date.now();`);
  await mutate(B.p, 'pm', `s.logs.h1['2026-01-02'] = 1; s.journal['2026-01-02'] = { mood: 2, note: 'From B' }; s.settings.theme = 'dark'; s.settings.weekStart = 0; s.habits.push({ id: 'h2', name: 'Stretch', emoji: '🧘', color: '#8b5cf6', goal: { type: 'check', target: 1, unit: '' }, schedule: { type: 'daily', days: [] }, target: null, reminder: null, archived: false, order: 2, createdAt: '2026-01-01' });`);
  await syncNow(A.p); await syncNow(B.p); await syncNow(A.p);
  let mA = await profData(A.p, 'pm');
  const mB2 = await profData(B.p, 'pm');
  assert(mB2.tasks.some((t) => t.title === 'From A') && mB2.tasks.find((t) => t.id === 't1').title === 'Buy oat milk', 'E1 task added and edited on A shows on B');
  assert(mA.logs.h1['2026-01-02'] === 1 && mA.journal['2026-01-02'].note === 'From B' && mA.habits.some((x) => x.name === 'Stretch'), 'E2 habit, log and journal from B show on A');
  assert(mA.settings.theme === 'dark' && mA.settings.weekStart === 0, 'E3 settings sync');
  assert(await A.p.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'E4 the active profile re-renders with the remote settings (theme applied)');
  assert(mA.settings.notifications === false && mB2.settings.onboarded === true, 'E5 device-only settings are not synced');

  // ===== Offline edit, then reconnect =====
  await B.ctx.setOffline(true);
  await mutate(B.p, 'pm', `s.tasks.push({ id: 'off1', title: 'Offline task', notes: '', date: '${TODAY}', recur: { type: 'none' }, done: false, doneDates: {}, exceptions: [], order: 9, createdAt: 1 });`);
  assert(await syncNow(B.p) === false, 'O1 sync fails while offline');
  await B.p.evaluate(() => window.dispatchEvent(new Event('offline')));
  await go(B.p, '#settings');
  assert(/Offline – changes will sync/.test(await B.p.locator('.acct-status').textContent()), 'O2 status: "Offline – changes will sync"');
  await B.ctx.setOffline(false);
  await B.p.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitFor(async () => { const st = await syncSt(B.p); return st.lastOk && !st.offline && !st.error; });
  await B.p.waitForTimeout(1500);
  await syncNow(A.p);
  assert((await profData(A.p, 'pm')).tasks.some((t) => t.id === 'off1'), 'O3 the offline edit syncs after reconnecting (persisted queue)');
  await go(B.p, '#settings');
  assert(/Synced just now/.test(await B.p.locator('.acct-status').textContent()), 'O4 status: "Synced just now"');

  // ===== Latest edit wins (both offline, B edits later; B pushes first, then A) =====
  await A.ctx.setOffline(true); await B.ctx.setOffline(true);
  await mutate(A.p, 'pm', `s.tasks.find((t) => t.id === 't2').title = 'Call mom (A)'; s.tasks.find((t) => t.id === 't2').notes = 'A';`);
  await syncNow(A.p); // diffs (timestamps the edit) but can't push
  await sleep(30);
  await mutate(B.p, 'pm', `s.tasks.find((t) => t.id === 't2').title = 'Call mom (B)';`);
  await syncNow(B.p);
  await A.ctx.setOffline(false); await B.ctx.setOffline(false);
  await syncNow(B.p); await syncNow(A.p); await syncNow(B.p);
  const tA = (await profData(A.p, 'pm')).tasks.find((t) => t.id === 't2'), tB = (await profData(B.p, 'pm')).tasks.find((t) => t.id === 't2');
  assert(tA.title === 'Call mom (B)' && tB.title === 'Call mom (B)' && tA.notes === '', 'L1 the later edit wins on both devices (per record)');

  // ===== Tombstones =====
  await A.p.evaluate(async () => { const s = await import('./js/store.js'); s.update((x) => { x.tasks = x.tasks.filter((t) => t.id !== 't2'); x.categories = []; }); });
  await syncNow(A.p); await syncNow(B.p);
  const mB3 = await profData(B.p, 'pm');
  assert(!mB3.tasks.some((t) => t.id === 't2') && mB3.categories.length === 0, 'T1 deletions (tombstones) sync');
  assert(mB3.tasks.some((t) => t.id === 't1'), 'T2 other records untouched');

  // ===== Rename clash on a synced profile =====
  await A.p.evaluate(async () => (await import('./js/profiles.js')).openProfileEditor((await import('./js/store.js')).getActiveProfile()));
  await A.p.waitForTimeout(300);
  await A.p.fill('.sheet-root.open [aria-label="Name"]', ' KID');
  await A.p.click('.sheet-root.open .sheet-foot .btn.primary');
  assert(/Another profile in your account is called “Kid”/.test(await A.p.locator('.sheet-root.open .form-error').textContent()), 'R1 renaming a synced profile to an account name is refused');
  await A.p.fill('.sheet-root.open [aria-label="Name"]', 'Mick R');
  await A.p.click('.sheet-root.open .sheet-foot .btn.primary');
  await A.p.waitForTimeout(300);
  await syncNow(A.p); await syncNow(B.p);
  assert((await profiles(B.p)).find((x) => x.id === 'pm').name === 'Mick R', 'R2 a rename syncs');

  // ===== Add profile while signed in: Save to device / account =====
  await A.p.evaluate(async () => (await import('./js/profiles.js')).openProfileEditor(null));
  await A.p.waitForTimeout(300);
  assert(await A.p.locator('.sheet-root.open [aria-label="Save to"] button[aria-checked="true"], .sheet-root.open [aria-label="Save to"] [aria-pressed="true"], .sheet-root.open [aria-label="Save to"] .active').first().textContent().catch(() => '') !== '' , 'P1 add-profile form asks where to save');
  await A.p.fill('.sheet-root.open [aria-label="Name"]', 'Guest');
  await A.p.click('.sheet-root.open [aria-label="Save to"] button:has-text("This device only")');
  await A.p.click('.sheet-root.open .sheet-foot .btn.primary');
  await A.p.waitForTimeout(400);
  const guest = (await profiles(A.p)).find((x) => x.name === 'Guest');
  assert(guest && !(await syncSt(A.p)).synced.includes(guest.id) && await A.p.locator('.avatar-btn .device-badge').count() === 1, 'P2 "This device only": stays device-only (badge on the avatar)');
  await A.p.evaluate(async () => (await import('./js/profiles.js')).openProfileEditor(null));
  await A.p.waitForTimeout(300);
  await A.p.fill('.sheet-root.open [aria-label="Name"]', 'Grandma');
  await A.p.click('.sheet-root.open .sheet-foot .btn.primary'); // default: Account
  await A.p.waitForTimeout(400);
  const gma = (await profiles(A.p)).find((x) => x.name === 'Grandma');
  assert(gma && (await syncSt(A.p)).synced.includes(gma.id) && await A.p.locator('.avatar-btn .device-badge').count() === 0, 'P3 default "Account": synced');
  await syncNow(A.p); await syncNow(B.p);
  assert((await profiles(B.p)).some((x) => x.id === gma.id) && !(await profiles(B.p)).some((x) => x.name === 'Guest'), 'P4 only the account profile reaches B');


  // ===== Remote changes vs an open Undo: Undo re-finds by id, never restores an old snapshot =====
  await A.p.evaluate(async () => { const s = await import('./js/store.js'); s.switchProfile('pm'); });
  await A.p.waitForTimeout(200);
  await A.p.evaluate(async () => { const a = await import('./js/actions.js'); a.deleteTask('off1', null); });
  await A.p.waitForTimeout(200);
  await mutate(B.p, 'pm', `s.tasks.find((t) => t.id === 't1').title = 'Milk (B, during undo)';`);
  await syncNow(B.p); await syncNow(A.p);
  await A.p.click('.toast-action');
  await A.p.waitForTimeout(200);
  const mU = await A.p.evaluate(async () => (await import('./js/store.js')).getState());
  assert(mU.tasks.some((t) => t.id === 'off1') && mU.tasks.find((t) => t.id === 't1').title === 'Milk (B, during undo)', 'U1 Undo after a remote change restores the item and keeps the remote edit');

  // ===== Phase 2 placeholders: a synced photo not on this device, an image habit icon =====
  await mutate(A.p, 'pm', `s.tasks.find((t) => t.id === 't1').attachments = [{ id: 'nofile1', w: 10, h: 10, type: 'image/jpeg' }];`);
  await syncNow(A.p); await syncNow(B.p);
  await B.p.evaluate(async () => { (await import('./js/store.js')).switchProfile('pm'); });
  await B.p.waitForTimeout(200);
  await B.p.evaluate(async (d) => (await import('./js/taskView.js')).openTaskView('t1', d), TODAY);
  await B.p.waitForTimeout(600);
  assert(await B.p.locator('.tv-photos .photo-item.missing .photo-elsewhere').textContent() === 'Photo on another device', 'F1 a synced photo missing on this device shows "Photo on another device"');
  await B.p.keyboard.press('Escape'); await B.p.waitForTimeout(300);
  assert((await profData(B.p, 'pm')).tasks.find((t) => t.id === 't1').attachments[0].id === 'nofile1', 'F2 the photo reference is kept');
  await mutate(B.p, 'pm', `s.habits.find((x) => x.id === 'h1').icon = { type: 'image', data: 'data:image/png;base64,AAAA' };`);
  await go(B.p, '#habits');
  await B.p.waitForTimeout(500);
  const bubble = await B.p.locator('.habit-row[data-id="h1"], li[data-id="h1"]').first().textContent().catch(() => '');
  assert(bubble.includes('💧') && await B.p.locator('img.habit-img').count() === 0, 'F3 an image icon that can’t be shown falls back to the emoji');

  // ===== Deleting a synced profile deletes it everywhere (the confirm says so) =====
  await A.p.evaluate(async () => { (await import('./js/store.js')).switchProfile('pb'); });
  await A.p.waitForTimeout(300);
  await A.p.click('.avatar-btn'); await A.p.waitForTimeout(300);
  await A.p.click('.menu-item.danger');
  await A.p.waitForTimeout(300);
  assert(/from your account and every signed-in device/.test(await A.p.locator('.dialog-msg').textContent()), 'D1 delete confirm says it’s removed from the account and every device');
  await A.p.click('.dialog-actions .btn.danger'); await A.p.waitForTimeout(300);
  assert(/deleted from your account and every device/.test(await A.p.locator('.dialog-msg').textContent()), 'D2 second confirm says so too');
  await A.p.click('.dialog-actions .btn.danger'); await A.p.waitForTimeout(300);
  await syncNow(A.p); await syncNow(B.p);
  assert(!(await profiles(B.p)).some((x) => x.id === 'pb') && (await profData(B.p, 'pb')) === null && !(await syncSt(B.p)).synced.includes('pb'), 'D3 the profile is gone on B too (explicit tombstone)');

  // ===== Import while signed in =====
  await go(B.p, '#settings');
  const backup = { app: 'daily-tracker', format: 'profiles', activeId: 'pm', profiles: [
    { id: 'pm', name: 'Mick (backup)', avatar: { type: 'emoji', emoji: '', color: '#6366f1' }, data: { ...(await profData(B.p, 'pm')), tasks: [task('imp1', 'Imported task')] } },
    { id: 'pnew', name: 'Imported one', avatar: { type: 'emoji', emoji: '', color: '#6366f1' }, data: data() },
  ] };
  const bfile = require('path').join(fs.mkdtempSync(require('path').join(require('os').tmpdir(), 't39-')), 'backup.json');
  fs.writeFileSync(bfile, JSON.stringify(backup));
  await B.p.setInputFiles('input[type=file][accept*="json"]', bfile);
  await B.p.waitForTimeout(400);
  const impMsg = await B.p.locator('.dialog-msg').textContent();
  assert(/Profiles in your account stay in the account\./.test(impMsg), 'M1 import confirm: "Profiles in your account stay in the account."');
  assert(/Mick \(backup\) is also synced in your account: the account’s version stays unchanged/.test(impMsg), 'M1b the confirm names the synced profile the backup also has, and says it becomes a device-only copy');
  const pmBefore = (await profData(A.p, 'pm')).tasks.map((t) => t.id).sort().join();
  await B.p.click('.dialog-actions .btn.danger'); await B.p.waitForTimeout(500);
  const pB2 = await profiles(B.p);
  const stB = await syncSt(B.p);
  assert(pB2.some((x) => x.id === 'pk') && pB2.some((x) => x.id === gma.id), 'M2 synced profiles missing from the backup stay');
  assert(pB2.some((x) => x.id === 'pnew') && !stB.synced.includes('pnew'), 'M3 other imported profiles are device-only');
  await syncNow(B.p); await syncNow(A.p);
  const impCopy = pB2.find((x) => x.name === 'Mick (backup)');
  assert(impCopy && impCopy.id !== 'pm' && !stB.synced.includes(impCopy.id) && (await profData(B.p, impCopy.id)).tasks.map((t) => t.id).join() === 'imp1', 'M4 an imported profile with a synced id becomes a device-only copy (new id)');
  assert((await profData(A.p, 'pm')).tasks.map((t) => t.id).sort().join() === pmBefore && (await profData(B.p, 'pm')).tasks.map((t) => t.id).sort().join() === pmBefore, 'M4b the account’s profile is not changed by the import');
  // Normal edits (rename + replace the tasks) sync as usual; the rest of this test builds on them.
  await B.p.evaluate(async () => (await import('./js/store.js')).updateProfile('pm', { name: 'Mick R' }));
  await mutate(B.p, 'pm', `s.tasks = [${JSON.stringify(task('imp1', 'Imported task'))}];`);
  await syncNow(B.p); await syncNow(A.p);
  assert((await profData(A.p, 'pm')).tasks.map((t) => t.id).join() === 'imp1', 'M4c normal edits of a synced profile sync');
  assert((await profiles(A.p)).some((x) => x.id === 'pk'), 'M5 nothing is deleted from the account');

  // ===== An unreadable profile never produces tombstones =====
  const before = (await profData(A.p, 'pk')).tasks.length;
  await B.p.evaluate(() => localStorage.setItem('dailyTracker:data:pk', '{"broken'));
  await mutate(A.p, 'pk', `s.tasks.push({ id: 'kt2', title: 'Remote while broken', date: '${TODAY}', recur: { type: 'none' }, doneDates: {}, exceptions: [], order: 2, createdAt: 1 });`);
  await syncNow(A.p); await syncNow(B.p); await syncNow(A.p);
  const kA = await profData(A.p, 'pk');
  assert(kA.tasks.length === before + 1 && kA.habits.length === 1, 'N1 B can’t read Kid: no tombstones reach the account');
  assert(await B.p.evaluate(() => localStorage.getItem('dailyTracker:data:pk')) === '{"broken', 'N2 the unreadable data is left alone (no remote apply over it)');
  await B.p.evaluate(() => localStorage.setItem('dailyTracker:data:pk', JSON.stringify({ version: 6, tasks: [], habits: [], settings: { onboarded: true } })));
  await syncNow(B.p); await B.p.waitForTimeout(300); await syncNow(B.p);
  const kB = await profData(B.p, 'pk');
  assert(kB.tasks.some((t) => t.id === 'kt2') && kB.tasks.some((t) => t.id === 'kt1') && kB.habits.length === 1, 'N3 once readable again, the account’s data is pulled again');
  await syncNow(A.p);
  const kA2 = await profData(A.p, 'pk');
  assert(kA2.tasks.some((t) => t.id === 'kt1') && kA2.tasks.some((t) => t.id === 'kt2') && kA2.habits.length === 1, 'N4 …and nothing in the account was deleted by it');


  // ===== Two tabs on one device: only one syncs at a time; the other picks changes up =====
  const B2 = await B.ctx.newPage();
  B2.on('pageerror', (e) => errs.push('pageerror(B2): ' + e.message));
  await B2.goto(APP); await B2.waitForTimeout(600);
  await mutate(A.p, 'pk', `s.tasks.push({ id: 'tab1', title: 'Two tabs', date: '${TODAY}', recur: { type: 'none' }, doneDates: {}, exceptions: [], order: 3, createdAt: 1 });`);
  await syncNow(A.p);
  const both = await Promise.all([syncNow(B.p), syncNow(B2)]);
  assert(both.every((x) => x === true), 'W1 two tabs sync without stepping on each other (lock)');
  assert((await profData(B.p, 'pk')).tasks.filter((t) => t.id === 'tab1').length === 1, 'W2 the change is applied once');
  await B2.close();

  // ===== First sync of a big profile: several push batches (500) and pull pages (1000) =====
  await mutate(A.p, gma.id, `for (let i = 0; i < 1300; i++) s.tasks.push({ id: 'big' + i, title: 'Big ' + i, notes: 'x'.repeat(200), date: '${TODAY}', recur: { type: 'none' }, doneDates: {}, exceptions: [], order: i, createdAt: 1 });`);
  const pushes = [];
  const onReq = (r) => { if (r.url().includes('/api/sync/push')) pushes.push(1); };
  A.p.on('request', onReq);
  assert(await syncNow(A.p) === true && pushes.length >= 3, 'G1 a big change is uploaded in batches');
  A.p.off('request', onReq);
  assert(await syncNow(B.p) === true && (await profData(B.p, gma.id)).tasks.length === 1300, 'G2 …and downloaded completely');

  // ===== Passkey sign-in with PRF (A): sign out, removing the account's profiles, then sign back in =====
  await go(A.p, '#settings');
  await A.p.click('.acct-bottom button:has-text("Sign out")');
  await A.p.waitForTimeout(300);
  assert(await A.p.locator('.dialog-actions .btn').first().textContent() === 'Keep copies on this device', 'X1 sign out: "Keep copies on this device" is the default');
  await A.p.click('.dialog-actions button:has-text("Remove from this device")');
  await waitFor(async () => (await A.p.locator('.dialog-actions .btn.danger:has-text("Remove")').count()) === 1, 15000);
  assert(/has been uploaded/.test(await A.p.locator('.sheet-root.open .dialog-msg').last().textContent()), 'X1b the Remove confirm says everything was uploaded (checked first)');
  await A.p.click('.dialog-actions .btn.danger'); await A.p.waitForTimeout(800);
  let pA2 = await profiles(A.p);
  assert(pA2.map((x) => x.name).sort().join() === 'Guest', 'X2 "Remove from this device": only the device-only profile is left');
  assert(!(await syncSt(A.p)).accountId && await A.p.locator('.acct-panel button:has-text("Create account")').count() === 1, 'X3 signed out');
  assert(await A.p.evaluate(async () => !(await (await import('./js/syncCrypto.js')).loadKeys())), 'X4 the keys are gone from this device');
  await A.p.click('.acct-panel button:has-text("Sign in with passkey")');
  await waitFor(async () => (await profiles(A.p)).some((x) => x.id === 'pm'), 15000);
  await A.p.waitForTimeout(500);
  assert((await profiles(A.p)).some((x) => x.id === 'pk') && (await profData(A.p, 'pm')).tasks.some((t) => t.id === 'imp1'), 'X5 passkey with PRF: signed in and unlocked without a password; profiles downloaded');
  assert(await sheetTitle(A.p) === 'Sync this device’s profiles?', 'X6 then the picker for this device’s own profiles');
  await A.p.click('.sheet-root.open .sheet-foot button:has-text("Not now")'); await A.p.waitForTimeout(300);
  assert(!(await syncSt(A.p)).synced.includes(guest.id), 'X7 "Not now": Guest stays device-only');

  // ===== Sign out keeping copies (B), then sign in again: the copies stay as separate device profiles =====
  await go(B.p, '#settings');
  await B.p.click('.acct-bottom button:has-text("Sign out")');
  await B.p.waitForTimeout(300);
  await B.p.click('.dialog-actions button:has-text("Keep copies on this device")'); await B.p.waitForTimeout(800);
  const keptB = await profiles(B.p);
  assert(keptB.some((x) => x.id === 'pm') && keptB.some((x) => x.id === 'pk') && !(await syncSt(B.p)).accountId, 'K1 "Keep copies": the account’s profiles stay on B as device-only profiles');
  await go(B.p, '#today');
  assert(await B.p.locator('.avatar-btn .device-badge').count() === 1, 'K2 …marked "On this device only"');
  await go(B.p, '#settings');
  const shadowsLeft = await B.p.evaluate(async () => (await (await import('./js/syncCrypto.js')).idb('shadow', 'readonly', (s) => s.count())));
  assert(shadowsLeft === 0, 'K3 shadows cleared');
  await mutate(B.p, 'pm', `s.tasks.push({ id: 'signedout1', title: 'Edited while signed out', date: '${TODAY}', recur: { type: 'none' }, doneDates: {}, exceptions: [], order: 5, createdAt: 1 });`);
  await syncNow(A.p);
  assert(!(await profData(A.p, 'pm')).tasks.some((t) => t.id === 'signedout1'), 'K4 a signed-out device doesn’t sync');

  // ===== Passkey without PRF (B's authenticator): password needed once =====
  await B.p.click('.acct-panel button:has-text("Sign in")');
  await B.p.fill('.sheet-root.open [aria-label="Username"]', 'family');
  await B.p.fill('.sheet-root.open [aria-label="Password"]', PW);
  await B.p.click('.sheet-root.open .sheet-foot button:has-text("Sign in")');
  await waitFor(async () => (await sheetTitle(B.p)) === 'Sync this device’s profiles?', 15000);
  const pB3 = await profiles(B.p);
  const copies = pB3.filter((x) => x.name === 'Mick R');
  assert(copies.length === 1 && copies[0].id === 'pm' && (await syncSt(B.p)).synced.includes('pm') && (await syncSt(B.p)).synced.includes('pk'), 'K5 signing in again to the same account: the kept copies are merged back (no duplicates)');
  const copyId = impCopy.id; // the device-only import copy stays as it is
  await syncNow(B.p); await syncNow(A.p);
  assert((await profData(B.p, 'pm')).tasks.some((t) => t.id === 'signedout1') && (await profData(A.p, 'pm')).tasks.some((t) => t.id === 'signedout1') && (await profData(B.p, 'pm')).tasks.some((t) => t.id === 'imp1'), 'K6 nothing edited while signed out is lost: it is uploaded on sign-in');
  await B.p.click('.sheet-root.open .sheet-foot button:has-text("Not now")'); await B.p.waitForTimeout(300);
  await go(B.p, '#settings');
  await waitFor(async () => (await B.p.locator('.acct-panel button:has-text("Add a passkey")').count()) === 1, 8000);
  await B.p.click('.acct-panel button:has-text("Add a passkey")');
  await B.p.waitForTimeout(300);
  if (await sheetTitle(B.p) === 'Add a passkey') { await B.p.fill('.sheet-root.open [aria-label="Password"]', PW); await B.p.click('.sheet-root.open .sheet-foot .btn.primary'); }
  await waitFor(async () => (B.p.__toasts || []).some((m) => /Passkey added/.test(m)), 15000);
  if (!(B.p.__toasts || []).some((m) => /New devices will ask/.test(m))) console.log('toasts', B.p.__toasts);
  assert((B.p.__toasts || []).some((m) => /New devices will ask for your password once/.test(m)), 'K7 a passkey without PRF is added (needs the password on new devices)');
  await B.p.click('.acct-bottom button:has-text("Sign out")'); await B.p.waitForTimeout(300);
  await B.p.click('.dialog-actions button:has-text("Remove from this device")');
  await waitFor(async () => (await B.p.locator('.dialog-actions .btn.danger:has-text("Remove")').count()) === 1, 15000);
  await B.p.click('.dialog-actions .btn.danger'); await B.p.waitForTimeout(800);
  assert(!(await profiles(B.p)).some((x) => x.id === 'pm') && (await profiles(B.p)).some((x) => x.id === copyId), 'K8 "Remove": synced profiles removed, device-only copies kept');
  await B.p.click('.acct-panel button:has-text("Sign in with passkey")');
  await waitFor(async () => (await sheetTitle(B.p)) === 'Unlock your data', 15000);
  assert(await sheetTitle(B.p) === 'Unlock your data', 'K9 passkey without PRF: asks for the password once');
  await B.p.fill('.sheet-root.open [aria-label="Password"]', 'not it at all');
  await B.p.click('.sheet-root.open .sheet-foot .btn.primary');
  await waitFor(async () => (await B.p.locator('.sheet-root.open .form-error').textContent()) !== '', 10000);
  assert(await B.p.locator('.sheet-root.open .form-error').textContent() === 'Wrong password', 'K10 wrong password: refused');
  await B.p.fill('.sheet-root.open [aria-label="Password"]', PW);
  await B.p.click('.sheet-root.open .sheet-foot .btn.primary');
  await waitFor(async () => (await profiles(B.p)).some((x) => x.id === 'pm'), 15000);
  assert((await profData(B.p, 'pm')).tasks.some((t) => t.id === 'imp1'), 'K11 unlocked: the account’s profiles are downloaded');
  await B.p.waitForTimeout(400);
  if (await sheetTitle(B.p) === 'Sync this device’s profiles?') { await B.p.click('.sheet-root.open .sheet-foot button:has-text("Not now")'); await B.p.waitForTimeout(300); }

  // ===== Change password (A), then sign in with the new one (C) =====
  const NEWPW = 'a brand new password 2';
  await go(A.p, '#settings');
  await A.p.click('.acct-panel button:has-text("Change password")'); await A.p.waitForTimeout(300);
  await A.p.fill('.sheet-root.open [aria-label="Current password"]', PW);
  await A.p.fill('.sheet-root.open [aria-label="New password"]', NEWPW);
  await A.p.fill('.sheet-root.open [aria-label="Confirm new password"]', NEWPW);
  await A.p.click('.sheet-root.open .sheet-foot .btn.primary');
  await waitFor(async () => /Password changed/.test(await A.p.locator('.toast-msg').textContent().catch(() => '')), 15000);
  assert(/Password changed/.test(await A.p.locator('.toast-msg').textContent()), 'C1 password changed');
  await syncNow(B.p);
  assert(!(await syncSt(B.p)).token && (await syncSt(B.p)).expired && await syncNow(A.p) === true, 'C1b a password change signs the other devices out (this one stays)');
  await B.p.evaluate(async (pw) => (await import('./js/sync.js')).signIn({ username: 'family', password: pw }), NEWPW);
  assert((await syncSt(B.p)).token && (await syncSt(B.p)).synced.includes('pm'), 'C1c …and they sign in again with the new password, carrying on');
  const C = await openApp(browser, { profiles: [['pc', 'Tablet', data()]] });
  await go(C.p, '#settings');
  await C.p.click('.acct-panel button:has-text("Sign in")');
  await C.p.fill('.sheet-root.open [aria-label="Username"]', 'family');
  await C.p.fill('.sheet-root.open [aria-label="Password"]', NEWPW);
  await C.p.click('.sheet-root.open .sheet-foot button:has-text("Sign in")');
  await waitFor(async () => (await profiles(C.p)).some((x) => x.id === 'pm'), 15000);
  assert((await profData(C.p, 'pm')).tasks.some((t) => t.id === 'imp1'), 'C2 the new password signs in and unlocks the same data');
  await C.p.waitForTimeout(300);
  if (await sheetTitle(C.p) === 'Sync this device’s profiles?') { await C.p.click('.sheet-root.open .sheet-foot button:has-text("Not now")'); await C.p.waitForTimeout(300); }
  // Devices list + sign out another device (C signs B out) → B treats the 401 as signed out.
  await go(C.p, '#settings');
  await waitFor(async () => (await C.p.locator('.acct-list li').count()) >= 3, 8000);
  assert(await C.p.locator('.acct-list li:has-text("This device")').count() === 1, 'C3 signed-in devices listed (this one marked)');
  const sessions = await C.p.evaluate(async () => (await (await import('./js/sync.js')).accountInfo()).sessions);
  const bSession = (await syncSt(B.p)).sessionId;
  await C.p.evaluate(async (id) => (await import('./js/sync.js')).signOutDevice(id), bSession);
  void sessions;
  await mutate(B.p, 'pm', `s.tasks.push({ id: 'afterkick', title: 'After being signed out', date: '${TODAY}', recur: { type: 'none' }, doneDates: {}, exceptions: [], order: 6, createdAt: 1 });`);
  await syncNow(B.p);
  await go(B.p, '#settings');
  assert(/You were signed out of your account/.test(await B.p.locator('.acct-status').textContent()) && (await profiles(B.p)).some((x) => x.id === 'pm'), 'Z1 401: treated as signed out, local data kept, message shown');
  await B.p.click('.acct-panel button:has-text("Sign in again")'); await B.p.waitForTimeout(300);
  await B.p.fill('.sheet-root.open [aria-label="Password"]', NEWPW);
  await B.p.click('.sheet-root.open .sheet-foot button:has-text("Sign in")');
  await waitFor(async () => (await syncSt(B.p))?.token && (await syncSt(B.p)).lastOk, 15000);
  await B.p.waitForTimeout(400);
  if (await sheetTitle(B.p) === 'Sync this device’s profiles?') { await B.p.click('.sheet-root.open .sheet-foot button:has-text("Not now")'); await B.p.waitForTimeout(300); }
  await syncNow(B.p); await syncNow(A.p);
  assert((await profData(A.p, 'pm')).tasks.some((t) => t.id === 'afterkick'), 'Z2 signing in again to the same account carries on: the edit made meanwhile syncs');

  // ===== Recovery key (D): new password, every other device signed out =====
  const D = await openApp(browser, { profiles: [['pd', 'Laptop', data()]] });
  await go(D.p, '#settings');
  await D.p.click('.acct-panel button:has-text("Forgot password? Use recovery key")'); await D.p.waitForTimeout(300);
  await D.p.fill('.sheet-root.open [aria-label="Username"]', 'family');
  await D.p.fill('.sheet-root.open [aria-label="Recovery key"]', recText.toLowerCase().replace(/ /g, '-'));
  await D.p.fill('.sheet-root.open [aria-label="New password"]', 'recovered password 3');
  await D.p.fill('.sheet-root.open [aria-label="Confirm new password"]', 'recovered password 3');
  await D.p.click('.sheet-root.open .sheet-foot .btn.primary');
  await waitFor(async () => (await profiles(D.p)).some((x) => x.id === 'pm'), 15000);
  assert((await profData(D.p, 'pm')).tasks.some((t) => t.id === 'afterkick'), 'V1 recovery key: new password set, data unlocked and downloaded');
  await syncNow(C.p);
  assert(!(await syncSt(C.p)).token && (await syncSt(C.p)).expired, 'V2 other devices are signed out by a recovery');
  await D.p.waitForTimeout(300);
  if (await sheetTitle(D.p) === 'Sync this device’s profiles?') { await D.p.click('.sheet-root.open .sheet-foot button:has-text("Not now")'); await D.p.waitForTimeout(300); }

  // ===== A record from a newer app version pauses sync (nothing applied) =====
  const pushed = await D.p.evaluate(async ([today]) => {
    const C = await import('./js/syncCrypto.js');
    const keys = await C.loadKeys();
    const st = JSON.parse(localStorage.getItem('dailyTracker:sync'));
    const k = 'pm/task/fromfuture';
    const rid = await C.ridOf(keys.macKey, k);
    const t = Date.now() + 5;
    const dev = 'ZZZZZZZZZZZZZZZZZZZZZZ';
    const blob = await C.encryptRecord(keys.encKey, rid, { k, v: { id: 'fromfuture', title: 'Future', date: today, newField: 1 }, t, dev, sv: 99 });
    const r = await fetch(st.serverUrl + '/api/sync/push', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + st.token }, body: JSON.stringify({ records: [{ rid, t, dev, blob }] }) });
    return r.status;
  }, [TODAY]);
  assert(pushed === 200, 'Y0 (a newer app version pushed a record)');
  await syncNow(D.p);
  await go(D.p, '#settings');
  assert(/Update the app to keep syncing/.test(await D.p.locator('.acct-status').textContent()) && await D.p.locator('.acct-status button:has-text("Reload")').count() === 1, 'Y1 newer sv: "Update the app to keep syncing" with Reload');
  assert(!(await profData(D.p, 'pm')).tasks.some((t) => t.id === 'fromfuture') && (await syncSt(D.p)).paused.sv === 99, 'Y2 nothing from it is applied; sync is paused');
  const cur0 = (await syncSt(D.p)).cursor;
  await mutate(D.p, 'pm', `s.tasks.push({ id: 'whilepaused', title: 'Paused edit', date: '${TODAY}', recur: { type: 'none' }, doneDates: {}, exceptions: [], order: 7, createdAt: 1 });`);
  await syncNow(D.p);
  assert((await syncSt(D.p)).cursor === cur0, 'Y3 paused: the cursor doesn’t move past the newer record');

  // ===== Delete account (D): server data wiped, local copies stay =====
  await D.p.evaluate(async () => { const s = JSON.parse(localStorage.getItem('dailyTracker:sync')); s.paused = null; localStorage.setItem('dailyTracker:sync', JSON.stringify(s)); });
  await go(D.p, '#today'); await go(D.p, '#settings');
  await D.p.click('.acct-panel button:has-text("Delete account")'); await D.p.waitForTimeout(300);
  await D.p.click('.dialog-actions .btn.danger'); await D.p.waitForTimeout(300);
  await D.p.fill('.sheet-root.open [aria-label="Password"]', 'wrong one here');
  await D.p.click('.sheet-root.open .sheet-foot .btn.danger');
  await waitFor(async () => (await D.p.locator('.sheet-root.open .form-error').textContent()) !== '', 10000);
  assert(await D.p.locator('.sheet-root.open .form-error').textContent() === 'Wrong password', 'A1 delete account needs the right password');
  await D.p.fill('.sheet-root.open [aria-label="Password"]', 'recovered password 3');
  await D.p.click('.sheet-root.open .sheet-foot .btn.danger');
  await waitFor(async () => !(await syncSt(D.p)).accountId, 15000);
  assert((await db.prepare('SELECT COUNT(*) n FROM accounts').first()).n === 0 && (await serverRecords()) === 0, 'A2 the account and its records are deleted on the server');
  assert((await profiles(D.p)).some((x) => x.id === 'pm') && (await profData(D.p, 'pm')).tasks.some((t) => t.id === 'whilepaused'), 'A3 local copies stay as device-only profiles');

  console.log(errs.length ? 'errors: ' + errs.join('\n') : 'no page errors');
  await browser.close();
  await mf.dispose();
})().catch((e) => { console.log('FAIL: crashed ' + (e.stack || e)); process.exitCode = 1; process.exit(1); });
