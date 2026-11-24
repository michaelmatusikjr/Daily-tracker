const __ROOT = require('path').resolve(__dirname, '..');
// 1.15.1: the first screen on a brand-new install (sign in or get started), the three-way profile
// picker (sync / keep / delete) and the "On this device only" tag staying inside its row. Real Worker in
// Miniflare, app on http://localhost:8080.
const { chromium } = require('playwright');
const fs = require('fs');
const SERVER_DIR = __ROOT + '/server';
const APP = 'http://localhost:8080/';
const API = 'http://127.0.0.1:8796';
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

async function openApp(browser, { profiles, active = null, authenticator = null, viewport = { width: 390, height: 844 }, colorScheme = 'light', legacy = null, syncState = null } = {}) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: 'block', colorScheme, deviceScaleFactor: 1 });
  await ctx.route('**/daily-tracker-push.michael-matusik-jr.workers.dev/**', (r) => r.abort());
  await ctx.addInitScript(([profs, act, api, rkey, leg, sst]) => {
    if (localStorage.getItem('dailyTracker:profiles')) return;
    if (leg) localStorage.setItem('dailyTracker:data', JSON.stringify(leg));
    if (sst) localStorage.setItem('dailyTracker:sync', JSON.stringify(sst));
    if (profs) {
      localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: act || profs[0][0], profiles: profs.map(([id, name]) => ({ id, name, avatar: { type: 'emoji', emoji: '', color: '#6366f1' } })) }));
      for (const [id, , d] of profs) localStorage.setItem('dailyTracker:data:' + id, JSON.stringify(d));
    }
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
    localStorage.setItem('dailyTracker:pushConfig', JSON.stringify({ serverUrl: api, registerKey: rkey }));
  }, [profiles, active, API, RKEY, legacy, syncState]);
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



const LONG = 'Alexandria Montgomery-Featherstonehaugh the Third';
const clickSheet = (p, text) => p.click(`.sheet-root.open .sheet-foot button:has-text("${text}")`);
const idxOf = (p) => lsJSON(p, 'dailyTracker:profiles');

async function createAccount(p, name) {
  await go(p, '#settings');
  await p.click('.acct-panel button:has-text("Create account")');
  await p.waitForTimeout(300);
  await p.fill('[aria-label="Username"]', name);
  await p.fill('.sheet-root.open [aria-label="Password"]', PW);
  await p.fill('[aria-label="Confirm password"]', PW);
  await p.click('.sheet-root.open .sheet-foot button:has-text("Create account")');
  await waitFor(async () => (await sheetTitle(p)) === 'Your recovery key', 15000);
  await p.check('#rec-saved');
  await p.click('.sheet-root.open .sheet-foot .btn.primary');
  await waitFor(async () => (await sheetTitle(p)) === 'Sync this device’s profiles?');
}
async function dismissPasskeyOffer(p) {
  await p.waitForTimeout(400);
  if ((await sheetTitle(p)) === 'Add a passkey?') { await p.click('.sheet-root.open button:has-text("Cancel")'); await p.waitForTimeout(300); }
}
async function signInSheet(p, user, pw = PW) {
  await p.fill('.sheet-root.open [aria-label="Username"]', user);
  await p.fill('.sheet-root.open [aria-label="Password"]', pw);
  await p.click('.sheet-root.open .sheet-foot button:has-text("Sign in")');
}
const firstScreen = (p) => p.locator('.onboarding.ob-first').count();
const tour = (p) => p.locator('.onboarding:not(.ob-first)').count();

(async () => {
  const { Miniflare } = await import(SERVER_DIR + '/node_modules/miniflare/dist/src/index.js');
  const mf = new Miniflare({
    modules: true, modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    modulesRoot: SERVER_DIR, scriptPath: SERVER_DIR + '/src/index.js', compatibilityDate: '2026-07-01', port: 8796, host: '127.0.0.1',
    d1Databases: ['DB'],
    bindings: { VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: 'mailto:test@example.com', ALLOWED_ORIGINS: 'http://localhost:8080', REGISTER_KEY: RKEY, MAX_ACCOUNTS: '20' },
  });
  await mf.ready;
  const db = await mf.getD1Database('DB');
  for (const s of fs.readFileSync(SERVER_DIR + '/schema.sql', 'utf8').replace(/--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean)) await db.prepare(s).run();
  const browser = await chromium.launch();

  // ===== Accounts to sign in to: "Family" (profile Mick, with data) and "Empty" (no profiles) =====
  const A = await openApp(browser, { profiles: [['pm', 'Mick', data({ tasks: [task('t1', 'Buy milk')], habits: [habit('h1', 'Water')] })]] });
  await createAccount(A.p, 'Family');
  await clickSheet(A.p, 'Done');
  await dismissPasskeyOffer(A.p);
  await waitFor(async () => (await syncSt(A.p))?.synced?.includes('pm') && (await syncSt(A.p))?.lastOk, 12000);
  assert((await syncSt(A.p)).synced.includes('pm'), 'A0 account "Family" holds Mick');
  const E = await openApp(browser, { profiles: [['pe', 'Solo', data({ tasks: [task('s1', 'Solo task')] })]] });
  await createAccount(E.p, 'Empty');
  await E.p.check('.picker-row input[value=keep]');
  await clickSheet(E.p, 'Done');
  await dismissPasskeyOffer(E.p);
  await waitFor(async () => (await syncSt(E.p))?.lastOk, 12000);
  assert((await syncSt(E.p)).synced.length === 0, 'A1 account "Empty" has no profiles');
  const V = await openApp(browser, { profiles: [['pv', 'Void', data()]] });
  await createAccount(V.p, 'Void');
  await V.p.check('.picker-row input[value=keep]');
  await clickSheet(V.p, 'Done');
  await dismissPasskeyOffer(V.p);
  await waitFor(async () => (await syncSt(V.p))?.lastOk, 12000);

  // ===== F: the first screen appears only on a fresh install =====
  {
    const F = await openApp(browser, {});
    assert(await firstScreen(F.p) === 1 && await tour(F.p) === 0, 'F1 fresh install: the first screen shows (no tour yet)');
    assert(await F.p.locator('.ob-first button:has-text("Sign in to your account")').count() === 1 && await F.p.locator('.ob-first button:has-text("Get started on this device")').count() === 1, 'F2 two choices: sign in / get started on this device');
    const ix = await idxOf(F.p);
    assert(ix.profiles.length === 1 && ix.profiles[0].name === 'Me' && ix.profiles[0].placeholder === true, 'F3 the default "Me" is marked as a placeholder');
    await F.p.waitForTimeout(800);
    assert((await idxOf(F.p)).profiles[0].placeholder === true, 'F4 the mark stays while nothing is edited');
    await F.p.reload(); await F.p.waitForTimeout(600);
    assert(await firstScreen(F.p) === 1, 'F5 a reload before choosing shows the first screen again');
    await F.p.click('.ob-first button:has-text("Get started on this device")');
    await F.p.waitForTimeout(500);
    assert(await firstScreen(F.p) === 0 && await tour(F.p) === 1 && await F.p.locator('.onboarding input.ob-name').count() === 1, 'F6 Get started → the welcome tour as before');
    await F.p.click('.ob-skip'); await F.p.waitForTimeout(500);
    const i2 = await idxOf(F.p);
    assert(i2.profiles.length === 1 && !i2.profiles[0].placeholder && (await profData(F.p, i2.profiles[0].id)).settings.onboarded === true, 'F7 after the tour the profile is a real one (mark cleared, onboarded)');
    await F.p.reload(); await F.p.waitForTimeout(600);
    assert(await firstScreen(F.p) === 0 && await tour(F.p) === 0, 'F8 later starts: neither screen');
    await F.ctx.close();
    // Existing index (not onboarded yet) and legacy pre-1.3 data never show the first screen.
    const X = await openApp(browser, { profiles: [['px', 'Pat', data({ settings: { onboarded: false, theme: 'light', notifications: false } })]] });
    assert(await firstScreen(X.p) === 0 && await tour(X.p) === 1, 'F9 an existing profile list: the tour only, no first screen');
    await X.ctx.close();
    const L = await openApp(browser, { legacy: data({ tasks: [task('lt', 'Old task')] }) });
    assert(await firstScreen(L.p) === 0, 'F10 legacy pre-1.3 data: no first screen');
    assert(!(await idxOf(L.p)).profiles[0].placeholder, 'F11 legacy data → its profile is not a placeholder');
    await L.ctx.close();
  }

  // ===== S: sign in from the first screen =====
  {
    const S = await openApp(browser, {});
    const ph = (await idxOf(S.p)).profiles[0].id;
    await S.p.click('.ob-first button:has-text("Sign in to your account")');
    await S.p.waitForTimeout(400);
    assert(await sheetTitle(S.p) === 'Sign in' && await firstScreen(S.p) === 1, 'S1 Sign in opens the sign-in sheet over the first screen');
    assert(await S.p.locator('.sheet-root.open button:has-text("Use recovery key")').count() === 1, 'S2 the sheet offers recovery too');
    // wrong password: stays, then cancel → first screen again
    await signInSheet(S.p, 'family', 'wrong password!!');
    await waitFor(async () => (await S.p.locator('.sheet-root.open .form-error').textContent()).length > 0, 10000);
    assert(await S.p.locator('.sheet-root.open .form-error').textContent() === 'Wrong username or password', 'S3 wrong password: message, still on the sheet');
    await S.p.click('.sheet-root.open .sheet-head button[aria-label="Close"]');
    await S.p.waitForTimeout(500);
    assert(await S.p.locator('.sheet-root.open').count() === 0 && await firstScreen(S.p) === 1 && await S.p.locator('.ob-first button:has-text("Sign in to your account")').isVisible(), 'S4 cancel → back on the first screen');
    assert(!(await syncSt(S.p))?.accountId && (await idxOf(S.p)).profiles.length === 1, 'S5 nothing changed by the failed/cancelled sign-in');
    await S.p.click('.ob-first button:has-text("Sign in to your account")');
    await S.p.waitForTimeout(400);
    await signInSheet(S.p, 'family');
    await waitFor(async () => (await firstScreen(S.p)) === 0 && (await idxOf(S.p)).profiles.some((x) => x.id === 'pm'), 20000);
    await S.p.waitForTimeout(600);
    const ix = await idxOf(S.p);
    assert(ix.profiles.length === 1 && ix.profiles[0].id === 'pm' && ix.profiles[0].name === 'Mick', 'S6 the account’s profile is the device’s profile, the placeholder is gone');
    assert(!(await S.p.evaluate((k) => localStorage.getItem('dailyTracker:data:' + k), ph)), 'S7 the placeholder’s data key is gone');
    assert((await profData(S.p, 'pm')).tasks[0].title === 'Buy milk', 'S8 Mick’s data downloaded');
    assert(await S.p.locator('.onboarding').count() === 0 && await S.p.locator('.sheet-root.open').count() === 0, 'S9 no tour, no picker');
    await S.p.click('.avatar-btn'); await S.p.waitForTimeout(300);
    assert(await S.p.locator('.profile-list li').count() === 1, 'S11 the profile menu lists only the account’s profile');
    await S.p.keyboard.press('Escape');
    await S.p.reload(); await S.p.waitForTimeout(600);
    assert(await firstScreen(S.p) === 0 && await tour(S.p) === 0, 'S12 reload: still no first screen or tour');
    await S.ctx.close();
  }

  // ===== An account without profiles: the tour on the placeholder, then the picker offers it =====
  {
    const S = await openApp(browser, {});
    const ph = (await idxOf(S.p)).profiles[0].id;
    await S.p.click('.ob-first button:has-text("Sign in to your account")');
    await S.p.waitForTimeout(400);
    await signInSheet(S.p, 'empty');
    await waitFor(async () => (await tour(S.p)) === 1, 20000);
    assert(await firstScreen(S.p) === 0 && (await idxOf(S.p)).profiles.length === 1 && (await idxOf(S.p)).profiles[0].id === ph, 'N1 empty account: the tour continues on the placeholder, which stays');
    await S.p.fill('.ob-name', 'Newbie');
    await S.p.click('.ob-skip');
    await waitFor(async () => (await sheetTitle(S.p)) === 'Sync this device’s profiles?');
    assert(await S.p.locator('.picker-row').count() === 1 && /Newbie/.test(await S.p.locator('.picker-row').textContent()), 'N2 after the tour the picker offers the profile to sync');
    await S.p.click('.picker-row input[value=sync]');
    await clickSheet(S.p, 'Done');
    await waitFor(async () => (await syncSt(S.p)).synced.includes(ph), 10000);
    assert((await syncSt(S.p)).synced.includes(ph), 'N3 it syncs to the account');
    await S.ctx.close();
  }

  // ===== A placeholder that has data is never removed =====
  {
    const S = await openApp(browser, {});
    const ph = (await idxOf(S.p)).profiles[0].id;
    await S.p.evaluate(([id, d]) => localStorage.setItem('dailyTracker:data:' + id, JSON.stringify(d)), [ph, data({ settings: { onboarded: false, theme: 'light', notifications: false }, tasks: [task('mine', 'My own task')] })]);
    await S.p.click('.ob-first button:has-text("Sign in to your account")');
    await S.p.waitForTimeout(400);
    await signInSheet(S.p, 'family');
    await waitFor(async () => (await sheetTitle(S.p)) === 'Sync this device’s profiles?', 20000);
    const ix = await idxOf(S.p);
    assert(ix.profiles.some((x) => x.id === ph) && ix.profiles.some((x) => x.id === 'pm'), 'D1 placeholder with data stays next to the account’s profile');
    assert((await profData(S.p, ph)).tasks[0].title === 'My own task', 'D2 its data is untouched');
    assert(await S.p.locator('.picker-row').count() === 1 && /Me/.test(await S.p.locator('.picker-row').textContent()), 'D3 it is offered in the picker (only the device’s own profile)');
    await S.ctx.close();
    // The store function itself: refuses data, and a profile whose mark was cleared.
    const T = await openApp(browser, {});
    const r = await T.p.evaluate(async () => {
      const s = await import('./js/store.js');
      const out = {};
      out.fresh = s.isFreshInstall();
      out.noOthers = s.removePlaceholderProfile(); // only profile: never removed
      s.addProfile({ name: 'Other' });
      s.switchProfile(s.getProfiles()[0].id);
      s.update((st) => { st.tasks.push({ id: 'x', title: 'x' }); }, { silent: true });
      out.markAfterEdit = !!s.getProfiles()[0].placeholder;
      out.removedEdited = s.removePlaceholderProfile();
      out.count = s.getProfiles().length;
      return out;
    });
    assert(r.fresh === true && r.noOthers === false, 'D4 isFreshInstall on a new install; the only profile is never removed');
    assert(r.markAfterEdit === false && r.removedEdited === false && r.count === 2, 'D5 any data save clears the mark; an edited profile is never removed');
    await T.ctx.close();
    const R = await openApp(browser, {});
    const r2 = await R.p.evaluate(async () => {
      const s = await import('./js/store.js');
      const ph = s.getProfiles()[0];
      s.addProfile({ name: 'Other' });
      s.switchProfile(ph.id);
      s.updateProfile(ph.id, { name: 'Renamed' });
      return [!!s.getProfiles().find((x) => x.id === ph.id).placeholder, s.removePlaceholderProfile(), s.getProfiles().length];
    });
    assert(r2[0] === false && r2[1] === false && r2[2] === 2, 'D6 a rename clears the mark');
    await R.ctx.close();
  }

  // ===== P: the three-way picker after signing in =====
  {
    const mk = (t) => data({ tasks: [task('x' + t, t + ' task')] });
    const P = await openApp(browser, { profiles: [['k1', 'Keeper', mk('Keeper')], ['s1', 'Syncer', mk('Syncer')], ['d1', 'Doomed', mk('Doomed')]] });
    await go(P.p, '#settings');
    await P.p.click('.acct-panel button:has-text("Sign in")');
    await P.p.waitForTimeout(300);
    await signInSheet(P.p, 'family');
    await waitFor(async () => (await sheetTitle(P.p)) === 'Sync this device’s profiles?', 15000);
    assert(await P.p.locator('.picker-row').count() === 3, 'P1 one row per device profile (the account’s Mick is not listed)');
    for (const row of await P.p.locator('.picker-row').all()) {
      assert(await row.locator('input[type=radio]').count() === 3 && await row.locator('input[value=keep]').isChecked(), 'P2 three options, default Keep on this device only: ' + (await row.locator('.picker-name').textContent()));
    }
    const labels = await P.p.locator('.picker-row').first().locator('.picker-opt').allTextContents();
    assert(labels.join('|') === 'Sync to account|Keep on this device only|Delete from this device', 'P3 labels: ' + labels.join('|'));
    const box = await P.p.locator('.sheet-root.open .sheet').boundingBox();
    const over = await P.p.evaluate(() => { const b = document.querySelector('.sheet-root.open .sheet-body'); return b.scrollWidth - b.clientWidth; });
    assert(box.x >= 0 && box.x + box.width <= 390 && over <= 0, 'P4 fits 390 px without horizontal overflow');
    await P.p.locator('.picker-row', { hasText: 'Syncer' }).locator('input[value=sync]').check();
    await P.p.locator('.picker-row', { hasText: 'Doomed' }).locator('input[value=delete]').check();
    await clickSheet(P.p, 'Done');
    await P.p.waitForTimeout(300);
    assert(await sheetTitle(P.p) === 'Delete Doomed?', 'P5 delete asks first, naming the profile: ' + await sheetTitle(P.p));
    await P.p.click('.sheet-root.open button:has-text("Cancel")'); await P.p.waitForTimeout(400);
    assert(await sheetTitle(P.p) === 'Sync this device’s profiles?' && (await profiles(P.p)).some((x) => x.id === 'd1') && !(await syncSt(P.p)).synced.includes('s1'), 'P6 Cancel changes nothing (picker still open, nothing synced or deleted)');
    await clickSheet(P.p, 'Done'); await P.p.waitForTimeout(300);
    await P.p.click('.sheet-root.open button:has-text("Continue")'); await P.p.waitForTimeout(300);
    const t2 = await sheetTitle(P.p), m2 = await P.p.locator('.sheet-root.open').last().textContent();
    assert(t2 === 'Are you absolutely sure?' && /cannot be undone/.test(m2) && /Doomed/.test(m2), 'P7 second step: absolutely sure, can’t be undone, names the profile');
    await P.p.click('.sheet-root.open button:has-text("Delete Doomed")');
    await waitFor(async () => !(await profiles(P.p)).some((x) => x.id === 'd1'), 8000);
    await P.p.waitForTimeout(500);
    const pp = await profiles(P.p);
    assert(!pp.some((x) => x.id === 'd1') && !(await P.p.evaluate(() => localStorage.getItem('dailyTracker:data:d1'))), 'P8 Doomed is deleted (index and data)');
    assert(pp.some((x) => x.id === 'k1') && pp.some((x) => x.id === 's1') && pp.some((x) => x.id === 'pm'), 'P9 the others stay');
    await waitFor(async () => (await syncSt(P.p)).synced.includes('s1'), 10000);
    const st = await syncSt(P.p);
    assert(st.synced.includes('s1') && !st.synced.includes('k1') && !st.synced.includes('d1'), 'P10 Syncer syncs, Keeper stays device-only, Doomed was never synced');
    assert(!st.deletes?.d1 && !Object.keys(st.deletes || {}).includes('d1'), 'P11 deleting a device-only profile doesn’t tombstone anything in the account');
    assert(await P.p.locator('.sheet-root.open').count() === 0, 'P12 picker closed');
    await go(P.p, '#today');
    await P.p.click('.avatar-btn'); await P.p.waitForTimeout(300);
    assert(await P.p.locator('.profile-list li.device-only').count() === 1 && /Keeper/.test(await P.p.locator('.profile-list li.device-only').textContent()), 'P13 only Keeper is marked "On this device only"');
    await P.p.keyboard.press('Escape');
    await P.ctx.close();
  }

  // ===== P2: at least one profile always stays =====
  {
    const Q = await openApp(browser, { profiles: [['q1', 'Solo', data({ tasks: [task('qq', 'q')] })]] });
    await go(Q.p, '#settings');
    await Q.p.click('.acct-panel button:has-text("Sign in")');
    await Q.p.waitForTimeout(300);
    await signInSheet(Q.p, 'void');
    await waitFor(async () => (await sheetTitle(Q.p)) === 'Sync this device’s profiles?', 15000);
    await Q.p.click('.picker-row input[value=delete]');
    await clickSheet(Q.p, 'Done'); await Q.p.waitForTimeout(300);
    assert(await sheetTitle(Q.p) === 'Sync this device’s profiles?' && /at least one profile/i.test(await Q.p.locator('.sheet-root.open .form-error').last().textContent()), 'M1 deleting every profile with none in the account is blocked with a message');
    assert((await profiles(Q.p)).length === 1, 'M2 nothing was deleted');
    await Q.p.click('.picker-row input[value=keep]');
    assert((await Q.p.locator('.sheet-root.open .form-error').last().textContent()) === '', 'M3 choosing again clears the message');
    await Q.ctx.close();
    // account has profiles: deleting all of this device's profiles is fine (Mick remains)
    const Q2 = await openApp(browser, { profiles: [['q2', 'Gone', data({ tasks: [task('qq', 'q')] })]] });
    await go(Q2.p, '#settings');
    await Q2.p.click('.acct-panel button:has-text("Sign in")');
    await Q2.p.waitForTimeout(300);
    await signInSheet(Q2.p, 'family');
    await waitFor(async () => (await sheetTitle(Q2.p)) === 'Sync this device’s profiles?', 15000);
    await Q2.p.click('.picker-row input[value=delete]');
    await clickSheet(Q2.p, 'Done'); await Q2.p.waitForTimeout(300);
    await Q2.p.click('.sheet-root.open button:has-text("Continue")'); await Q2.p.waitForTimeout(300);
    await Q2.p.click('.sheet-root.open button:has-text("Delete Gone")');
    await waitFor(async () => (await profiles(Q2.p)).length === 1, 8000);
    const left = await profiles(Q2.p);
    assert(!left.some((x) => x.id === 'q2') && left.some((x) => x.id === 'pm') && left.length >= 1, 'M4 with profiles in the account, all of the device’s own profiles can be deleted (the account’s remain)');
    await Q2.ctx.close();
    // name clash still needs the rename for Sync
    const Q3 = await openApp(browser, { profiles: [['q3', 'mick', data({ tasks: [task('qq', 'q')] })]] });
    await go(Q3.p, '#settings');
    await Q3.p.click('.acct-panel button:has-text("Sign in")');
    await Q3.p.waitForTimeout(300);
    await signInSheet(Q3.p, 'family');
    await waitFor(async () => (await sheetTitle(Q3.p)) === 'Sync this device’s profiles?', 15000);
    assert(!(await Q3.p.locator('.picker-rename').isVisible()), 'C1 no rename field while on Keep');
    await Q3.p.click('.picker-row input[value=sync]');
    assert(await Q3.p.locator('.picker-rename').isVisible() && /already has “Mick”/.test(await Q3.p.locator('.picker-rename .field-hint').textContent()), 'C2 choosing Sync on a clashing name asks for a new name');
    await Q3.p.click('.picker-row input[value=delete]');
    assert(!(await Q3.p.locator('.picker-rename').isVisible()), 'C3 no rename needed for Delete');
    await Q3.ctx.close();
  }

  // ===== T: "On this device only" stays inside its row (profile menu and Settings › Account) =====
  for (const scheme of ['light', 'dark']) {
    const names = [LONG, 'Averyveryveryverylongprofilenamewithoutanyspacesatall', 'Sam'];
    const sst = { dev: 'd', accountId: 'acc', username: 'family', expired: true, synced: [], pulled: true };
    const T = await openApp(browser, { colorScheme: scheme, syncState: sst, profiles: names.map((n, i) => ['t' + i, n, data()]) });
    await T.p.click('.avatar-btn'); await T.p.waitForTimeout(500);
    const rows = await T.p.evaluate(() => [...document.querySelectorAll('.profile-list li.device-only')].map((li) => {
      const r = li.getBoundingClientRect(), l = li.querySelector('.device-only-label'), lr = l.getBoundingClientRect(), tx = l.querySelector('.device-only-text'), nm = li.querySelector('.profile-name').getBoundingClientRect();
      return { l: r.left, r: r.right, t: r.top, b: r.bottom, ll: lr.left, lr: lr.right, lt: lr.top, lb: lr.bottom, nb: nm.bottom, clipped: tx.scrollWidth > tx.clientWidth + 1 };
    }));
    assert(rows.length === 3 && rows.every((x) => x.ll >= x.l - 0.5 && x.lr <= x.r + 0.5 && x.lt >= x.t - 0.5 && x.lb <= x.b + 0.5), `T1 (${scheme}) the tag is inside its profile-menu row`);
    assert(rows.every((x) => x.lt >= x.nb - 1) && rows.every((x) => !x.clipped), `T2 (${scheme}) it sits under the name (no overlap) and its text isn't clipped`);
    const sheetOver = await T.p.evaluate(() => { const b = document.querySelector('.sheet-root.open .sheet-body'); return b.scrollWidth - b.clientWidth; });
    assert(sheetOver <= 0, `T3 (${scheme}) no horizontal overflow in the profile menu`);
    await T.p.keyboard.press('Escape'); await T.p.waitForTimeout(300);
    await go(T.p, '#settings');
    await T.p.waitForTimeout(400);
    const acct = await T.p.evaluate(() => [...document.querySelectorAll('.acct-prof')].map((li) => {
      const r = li.getBoundingClientRect(), g = li.querySelector('.device-only-tag').getBoundingClientRect();
      return { in: g.left >= r.left - 0.5 && g.right <= r.right + 0.5 && g.top >= r.top - 0.5 && g.bottom <= r.bottom + 0.5 };
    }));
    assert(acct.length === 3 && acct.every((x) => x.in), `T4 (${scheme}) the tag is inside its Settings › Account row`);
    assert(await T.p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `T5 (${scheme}) no horizontal page scroll in Settings`);
    await T.ctx.close();
  }

  // ===== R: 1.15.1 QA fixes =====
  // R1 deleting the active profile from the picker runs onDone once (one passkey offer, not two).
  {
    const O = await openApp(browser, { profiles: [['o1', 'Active one', data({ tasks: [task('a', 'a')] })], ['o2', 'Other', data({ tasks: [task('b', 'b')] })]], active: 'o1' });
    await createAccount(O.p, 'Onceonly');
    const rows = O.p.locator('.picker-row');
    await rows.nth(0).locator('input[value=delete]').click();
    await clickSheet(O.p, 'Done'); await O.p.waitForTimeout(300);
    await O.p.click('.sheet-root.open button:has-text("Continue")'); await O.p.waitForTimeout(300);
    await O.p.click('.sheet-root.open button:has-text("Delete Active one")');
    await waitFor(async () => (await sheetTitle(O.p)) === 'Add a passkey?', 8000);
    assert(await sheetTitle(O.p) === 'Add a passkey?', 'R1a the passkey offer shows after the picker');
    await O.p.click('.sheet-root.open button:has-text("Cancel")'); await O.p.waitForTimeout(900);
    assert(await sheetTitle(O.p) !== 'Add a passkey?' && await O.p.locator('.sheet-root.open').count() === 0, 'R1b …and only once (deleting the active profile did not run onDone twice)');
    assert(!(await profiles(O.p)).some((x) => x.id === 'o1'), 'R1c the active profile was deleted');
    await O.ctx.close();
  }
  // R2 a profile that got synced (another tab) while the picker was open is not deleted from the account.
  {
    const Y = await openApp(browser, { profiles: [['y1', 'Keeper', data({ tasks: [task('a', 'a')] })], ['y2', 'Racer', data({ tasks: [task('b', 'b')] })]] });
    await go(Y.p, '#settings');
    await Y.p.click('.acct-panel button:has-text("Sign in")');
    await Y.p.waitForTimeout(300);
    await signInSheet(Y.p, 'family');
    await waitFor(async () => (await sheetTitle(Y.p)) === 'Sync this device’s profiles?', 15000);
    await Y.p.locator('.picker-row').nth(1).locator('input[value=delete]').click();
    await Y.p.evaluate(() => { const s = JSON.parse(localStorage.getItem('dailyTracker:sync')); s.synced = [...(s.synced || []), 'y2']; localStorage.setItem('dailyTracker:sync', JSON.stringify(s)); });
    await clickSheet(Y.p, 'Done'); await Y.p.waitForTimeout(300);
    await Y.p.click('.sheet-root.open button:has-text("Continue")'); await Y.p.waitForTimeout(300);
    await Y.p.click('.sheet-root.open button:has-text("Delete Racer")');
    await Y.p.waitForTimeout(800);
    assert((await profiles(Y.p)).some((x) => x.id === 'y2'), 'R2a the profile that became synced is still there');
    assert((Y.p.__toasts || []).some((m) => /Racer.*now synced.*not deleted/.test(m)), 'R2b the user is told it was not deleted');
    assert(!(await syncSt(Y.p)).deletes?.y2, 'R2c no account delete was queued for it');
    await Y.ctx.close();
  }
  // R3 "Later" on the failed download: the automatic retry completing continues the first-screen flow.
  {
    const L = await openApp(browser, {});
    await L.ctx.route('**/api/sync/pull**', (r) => r.abort());
    await L.p.click('.ob-first button:has-text("Sign in to your account")');
    await L.p.waitForTimeout(400);
    await signInSheet(L.p, 'family');
    await waitFor(async () => (await sheetTitle(L.p)) === 'Download didn’t finish', 20000);
    await clickSheet(L.p, 'Later'); await L.p.waitForTimeout(400);
    assert(await L.p.locator('.sheet-root.open').count() === 0 && (await syncSt(L.p)).accountId, 'R3a Later closes the dialog; the device is signed in');
    await L.ctx.unroute('**/api/sync/pull**');
    await L.p.evaluate(async () => (await import('./js/sync.js')).syncNow());
    await waitFor(async () => (await firstScreen(L.p)) === 0 && (await profiles(L.p)).some((x) => x.id === 'pm'), 15000);
    await L.p.waitForTimeout(500);
    const ix = await profiles(L.p);
    assert(await firstScreen(L.p) === 0 && ix.some((x) => x.id === 'pm') && !ix.some((x) => x.placeholder), 'R3b the automatic retry finished: first screen gone, placeholder replaced by the account’s profile');
    await L.ctx.close();
  }
  // R4 signed in (download pending) and the app restarts: no first screen, the download dialog continues the flow.
  {
    const L = await openApp(browser, {});
    await L.ctx.route('**/api/sync/pull**', (r) => r.abort());
    await L.p.click('.ob-first button:has-text("Sign in to your account")');
    await L.p.waitForTimeout(400);
    await signInSheet(L.p, 'family');
    await waitFor(async () => (await sheetTitle(L.p)) === 'Download didn’t finish', 20000);
    await clickSheet(L.p, 'Later'); await L.p.waitForTimeout(300);
    await L.p.reload(); await L.p.waitForTimeout(1200);
    assert(await firstScreen(L.p) === 0, 'R4a signed in: the first screen is never shown');
    assert(await sheetTitle(L.p) === 'Download didn’t finish', 'R4b …the signed-in flow continues with the download dialog');
    await L.ctx.unroute('**/api/sync/pull**');
    await clickSheet(L.p, 'Retry');
    await waitFor(async () => (await profiles(L.p)).some((x) => x.id === 'pm'), 15000);
    await L.p.waitForTimeout(500);
    assert(await firstScreen(L.p) === 0 && (await profiles(L.p)).some((x) => x.id === 'pm') && !(await profiles(L.p)).some((x) => x.placeholder), 'R4c Retry completes: the account’s profile replaces the placeholder');
    await L.ctx.close();
  }

  await browser.close();
  await mf.dispose();
  assert(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  process.exit(process.exitCode || 0);
})().catch((e) => { console.log('FAIL: crash ' + (e.stack || e)); process.exit(1); });
