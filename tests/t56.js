const __ROOT = require('path').resolve(__dirname, '..');
// Household sign-in (SYNC.md › Household sign-in): Sign in with Google on the shared household server
// (toozbudgeting-bank, real handler when a ToozBudgeting checkout is next to this repo, otherwise a
// stand-in; see household-server.js), the REAL Daily Tracker Worker in Miniflare, and Google's button
// stubbed in the page (it hands the app a test ID token). Owner links once; others sign in with no password.
const { chromium } = require('playwright');
const fs = require('fs');
const { startHousehold, OWNER } = require('./household-server.js');
const SERVER_DIR = __ROOT + '/server';
const APP = 'http://localhost:8080/';
const ORIGIN = 'http://localhost:8080';
const API = 'http://127.0.0.1:8800';
const HH_PORT = 8801;
const RKEY = 'reg-key-for-household-tests';
const PW = 'correct horse battery';
const PW2 = 'a brand new passphrase';
const WIFE = 'kay@example.com', KID = 'kid@example.com', TEEN = 'teen@example.com';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const TODAY = keyOf(new Date());
const task = (id, title, o = {}) => ({ id, title, notes: '', date: TODAY, time: null, duration: null, priority: 0, category: null, reminder: null, recur: { type: 'none', days: [], interval: 2 }, done: false, doneDates: {}, exceptions: [], order: 1, createdAt: 1, ...o });
const data = (o = {}) => ({ version: 6, settings: { onboarded: true, theme: 'light', weekStart: 1, notifications: false, timeFormat: '24' }, tasks: [], habits: [], logs: {}, journal: {}, exercises: [], workouts: [], ...o });

let HH;
async function openApp(browser, { profiles = null, email = OWNER, hash = '', hhUrl = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', colorScheme: 'light' });
  await ctx.route('**/daily-tracker-push.michael-matusik-jr.workers.dev/**', (r) => r.abort());
  await ctx.route('**/toozbudgeting-bank.michael-matusik-jr.workers.dev/**', (r) => r.abort());
  await ctx.route('https://accounts.google.com/**', (r) => r.abort());
  await ctx.addInitScript(([profs, api, rkey, hh]) => {
    if (!localStorage.getItem('dailyTracker:pushConfig')) {
      if (profs) {
        localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: profs[0][0], profiles: profs.map(([id, name]) => ({ id, name, avatar: { type: 'emoji', emoji: '', color: '#6366f1' } })) }));
        for (const [id, , d] of profs) localStorage.setItem('dailyTracker:data:' + id, JSON.stringify(d));
      }
      localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
      localStorage.setItem('dailyTracker:pushConfig', JSON.stringify({ serverUrl: api, registerKey: rkey }));
      localStorage.setItem('dailyTracker:householdConfig', JSON.stringify({ serverUrl: hh }));
    }
    // Google's button, stubbed: initialize() keeps the config, the button hands the callback a test ID token.
    window.google = { accounts: { id: {
      initialize(cfg) { window.__gis = cfg; },
      renderButton(host, opts) {
        window.__gisOpts = opts;
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'fake-gsi'; b.textContent = 'Sign in with Google';
        b.onclick = async () => { const credential = await window.__mint(window.__gsiEmail); window.__gis.callback({ credential }); };
        host.append(b);
      },
    } } };
  }, [profiles, API, RKEY, hhUrl || HH.url]);
  const p = await ctx.newPage();
  await p.exposeFunction('__mint', (e) => HH.mint(e));
  await p.exposeFunction('__toastLog', (m) => { p.__toasts = [...(p.__toasts || []), m]; });
  await p.addInitScript((e) => { window.__gsiEmail = e; new MutationObserver(() => { document.querySelectorAll('.toast-msg:not([data-l])').forEach((t) => { t.dataset.l = 1; window.__toastLog(t.textContent); }); }).observe(document, { childList: true, subtree: true }); }, email);
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push(m.text()); });
  await p.goto(APP + hash); await p.waitForTimeout(600);
  return { ctx, p };
}
const go = (p, hash) => p.evaluate((x) => { location.hash = x; }, hash).then(() => p.waitForTimeout(300));
const lsJSON = (p, k) => p.evaluate((x) => JSON.parse(localStorage.getItem(x) || 'null'), k);
const syncSt = (p) => lsJSON(p, 'dailyTracker:sync');
const profiles = (p) => lsJSON(p, 'dailyTracker:profiles');
const syncNow = (p) => p.evaluate(async () => (await import('./js/sync.js')).syncNow());
const sheetTitle = (p) => p.locator('.sheet-root.open .sheet-title').last().textContent().catch(() => null);
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn().catch(() => null); if (v) return v; await sleep(150); } return v; };
const waitSheet = (p, title, ms = 15000) => waitFor(async () => (await sheetTitle(p)) === title, ms);
const clickIn = (p, text) => p.locator('.sheet-root.open').last().locator(`button:has-text("${text}")`).first().click();
const toasts = (p) => (p.__toasts || []).join(' | ');

(async () => {
  HH = await startHousehold(HH_PORT, ORIGIN);
  console.log('household server:', HH.kind);
  const { Miniflare } = await import(SERVER_DIR + '/node_modules/miniflare/dist/src/index.js');
  const mf = new Miniflare({
    modules: true, modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    modulesRoot: SERVER_DIR, scriptPath: SERVER_DIR + '/src/index.js', compatibilityDate: '2026-07-01', port: 8800, host: '127.0.0.1',
    d1Databases: ['DB'],
    bindings: { VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: 'mailto:test@example.com', ALLOWED_ORIGINS: ORIGIN, REGISTER_KEY: RKEY, MAX_ACCOUNTS: '20' },
  });
  await mf.ready;
  const db = await mf.getD1Database('DB');
  for (const s of fs.readFileSync(SERVER_DIR + '/schema.sql', 'utf8').replace(/--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean)) await db.prepare(s).run();
  const browser = await chromium.launch();
  try {
    // ===== A: Mickey (owner), one device profile with data. Google first → not linked → create + link. =====
    const A = await openApp(browser, { profiles: [['pm', 'Mick', data({ tasks: [task('t1', 'Buy milk')] })]] });
    await go(A.p, '#settings');
    await waitFor(async () => (await A.p.locator('.acct-panel .hh-block .fake-gsi').count()) === 1, 5000);
    assert(await A.p.locator('.acct-panel .hh-block .fake-gsi').count() === 1, 'G1 signed out: Settings › Account offers Sign in with Google');
    const gis = await A.p.evaluate(() => ({ ux: window.__gis?.ux_mode }));
    assert(gis.ux === 'popup', 'G2 popup mode in a browser tab');
    await A.p.click('.acct-panel .hh-block .fake-gsi');
    assert(await waitSheet(A.p, 'Link Daily Tracker to your household'), 'G3 owner, nothing linked yet: asked to link once');
    await clickIn(A.p, 'Create a Daily Tracker account');
    await waitSheet(A.p, 'Create account');
    await A.p.fill('[aria-label="Username"]', 'Family');
    await A.p.fill('.sheet-root.open [aria-label="Password"]', PW);
    await A.p.fill('[aria-label="Confirm password"]', PW);
    await A.p.click('.sheet-root.open .sheet-foot button:has-text("Create account")');
    assert(await waitSheet(A.p, 'Your recovery key', 20000), 'G4 account created (recovery key shown)');
    const link1 = HH.linkRow();
    assert(link1 && link1.label === 'family', 'G5 the account is linked to the household (username kept as the label)');
    assert(link1 && !String(link1.sealed).includes(PW), 'G6 the password itself is never sent to the household server');
    await A.p.check('#rec-saved');
    await A.p.click('.sheet-root.open .sheet-foot .btn.primary');
    await waitSheet(A.p, 'Sync this device’s profiles?');
    await clickIn(A.p, 'Done');
    if (await waitSheet(A.p, 'Add a passkey?', 4000)) await clickIn(A.p, 'Cancel');
    assert(await waitSheet(A.p, 'Which profile is yours?'), 'G7 asked once which profile is Mickey’s');
    await clickIn(A.p, 'Mick');
    assert(await waitFor(async () => HH.prefsOf(OWNER)?.profileId === 'pm'), 'G8 Mickey ↔ Mick saved on the household server');
    await waitFor(async () => (await syncSt(A.p))?.lastOk);
    await go(A.p, '#today'); await go(A.p, '#settings');
    assert(await waitFor(async () => (await A.p.locator('.hh-block .hh-linked').count()) === 1), 'G9 Settings shows the household link');
    assert((await A.p.locator('.hh-block .hh-name').textContent()) === 'Mickey Matusik', 'G10 and who is signed in with Google');

    // ===== Household: invite Kay (owner), a kid (view only), a teen (member) — as ToozBudgeting does. =====
    const ownerSess = await HH.signIn(OWNER);
    for (const [e, r] of [[WIFE, 'owner'], [KID, 'viewer'], [TEEN, 'member']]) await HH.invite(ownerSess.token, e, r);

    // ===== B: Kay, brand-new install. First screen → Sign in → Google. No password anywhere. =====
    const B = await openApp(browser, { email: WIFE });
    assert(await waitFor(async () => (await B.p.locator('.ob-first').count()) === 1), 'K1 fresh install shows the first screen');
    await B.p.click('.ob-first button:has-text("Sign in to your account")');
    await waitSheet(B.p, 'Sign in');
    assert(await B.p.locator('.sheet-root.open .hh-signin .fake-gsi').count() === 1, 'K2 the sign-in sheet offers Google first');
    await B.p.click('.sheet-root.open .hh-signin .fake-gsi');
    assert(await waitSheet(B.p, 'Which profile is yours?', 20000), 'K3 signed in with Google; asked which profile is Kay’s');
    const stB = await syncSt(B.p);
    assert(stB?.username === 'family' && stB.via === 'google' && stB.token, 'K4 signed in to the household’s Daily Tracker account through Google');
    assert(await B.p.locator('.sheet-root.open button:has-text("Add a profile for Kay")').count() === 1, 'K5 Kay can add her own profile');
    await clickIn(B.p, 'Add a profile for Kay');
    await waitFor(async () => HH.prefsOf(WIFE)?.profileId);
    const pB = await profiles(B.p);
    const kayId = HH.prefsOf(WIFE)?.profileId;
    assert(pB.profiles.some((x) => x.name === 'Mick') && pB.profiles.find((x) => x.id === kayId)?.name === 'Kay' && pB.activeId === kayId, 'K6 Mick downloaded, Kay added and opened (the placeholder is gone)');
    assert(!pB.profiles.some((x) => x.placeholder), 'K7 no placeholder profile left');
    await waitFor(async () => { await syncNow(B.p); return (await syncSt(B.p)).synced?.includes(kayId); });
    await syncNow(A.p);
    assert(await waitFor(async () => { await syncNow(A.p); return (await profiles(A.p)).profiles.some((x) => x.name === 'Kay'); }), 'K8 Kay’s profile reaches Mickey’s device');

    // ===== C: Mickey's second device with its own device-only profile: Google → picker → Mick opens. =====
    const C = await openApp(browser, { profiles: [['pp', 'Phone', data({ tasks: [task('t9', 'Phone task')] })]] });
    await go(C.p, '#settings');
    await C.p.click('.acct-panel .hh-block .fake-gsi');
    assert(await waitSheet(C.p, 'Sync this device’s profiles?', 20000), 'M1 this device’s own profile is offered for sync (existing data kept)');
    await C.p.locator('.picker-row input[value=sync]').check();
    await clickIn(C.p, 'Done');
    assert(await waitFor(async () => (await profiles(C.p)).activeId === 'pm'), 'M2 Mick opens by itself (known from the household server)');
    assert((await sheetTitle(C.p)) !== 'Which profile is yours?', 'M3 not asked again');
    assert(await waitFor(async () => { await syncNow(C.p); return (await syncSt(C.p)).synced?.includes('pp'); }), 'M4 the device profile syncs to the account');
    assert(await waitFor(async () => { await syncNow(A.p); return (await profiles(A.p)).profiles.some((x) => x.id === 'pp'); }), 'M5 and reaches the other device');

    // ===== D: a view-only kid can't open Daily Tracker with Google. =====
    const D = await openApp(browser, { profiles: [['pk', 'Kid', data()]], email: KID });
    await go(D.p, '#settings');
    await D.p.click('.acct-panel .hh-block .fake-gsi');
    assert(await waitFor(async () => /View-only/.test(toasts(D.p))), 'V1 view-only: told they can’t use it yet');
    assert(!(await syncSt(D.p))?.token, 'V2 and not signed in to Daily Tracker');

    // ===== Password change on A keeps Google sign-in working (the owner's link is updated). =====
    const sealedBefore = HH.linkRow().sealed;
    await go(A.p, '#today'); await go(A.p, '#settings');
    await A.p.click('.acct-panel button:has-text("Change password")');
    await waitSheet(A.p, 'Change password');
    await A.p.fill('[aria-label="Current password"]', PW);
    await A.p.fill('[aria-label="New password"]', PW2);
    await A.p.fill('[aria-label="Confirm new password"]', PW2);
    await clickIn(A.p, 'Change password');
    assert(await waitFor(async () => /Household link updated/.test(toasts(A.p)), 20000), 'P1 changing the password updates the household link');
    assert(HH.linkRow().sealed !== sealedBefore, 'P2 new keys stored');
    const E = await openApp(browser, { email: TEEN });
    await E.p.click('.ob-first button:has-text("Sign in to your account")');
    await waitSheet(E.p, 'Sign in');
    await E.p.click('.sheet-root.open .hh-signin .fake-gsi');
    assert(await waitFor(async () => (await syncSt(E.p))?.token && (await syncSt(E.p)).via === 'google', 20000), 'P3 a member signs in with Google after the password change');
    if (await waitSheet(E.p, 'Which profile is yours?', 5000)) await clickIn(E.p, 'Not now');

    // ===== Unlink: Google sign-in stops for new devices; devices signed in now carry on. =====
    await go(A.p, '#today'); await go(A.p, '#settings');
    await waitFor(async () => (await A.p.locator('.hh-block button:has-text("Unlink")').count()) === 1);
    await A.p.click('.hh-block button:has-text("Unlink")');
    await waitSheet(A.p, 'Unlink Daily Tracker?');
    await clickIn(A.p, 'Unlink');
    assert(await waitFor(async () => HH.linkRow() === null), 'U1 owner unlinks');
    const E2 = await openApp(browser, { email: TEEN, profiles: [['pt', 'Teen', data()]] });
    await go(E2.p, '#settings');
    await E2.p.click('.acct-panel .hh-block .fake-gsi');
    assert(await waitSheet(E2.p, 'Not linked yet'), 'U2 a member is told an owner needs to link it');
    assert((await syncSt(E.p))?.token, 'U3 the device already signed in stays signed in');
    // Link again from Settings (signed in): password once.
    await go(A.p, '#today'); await go(A.p, '#settings');
    await waitFor(async () => (await A.p.locator('#hh-link').count()) === 1);
    await A.p.click('#hh-link');
    await waitSheet(A.p, 'Link to your household');
    await A.p.fill('.sheet-root.open [aria-label="Password"]', 'wrong password!!');
    await clickIn(A.p, 'Link');
    assert(await waitFor(async () => (await A.p.locator('.sheet-root.open .form-error').textContent()).length > 0, 20000) && HH.linkRow() === null, 'U4 a wrong password doesn’t link');
    await A.p.fill('.sheet-root.open [aria-label="Password"]', PW2);
    await clickIn(A.p, 'Link');
    assert(await waitFor(async () => HH.linkRow()?.label === 'family', 20000), 'U5 linked again with the password');

    // ===== F: the installed iPhone app's redirect sign-in comes back with #signin=<code>. =====
    const loc = await HH.redirectCode(WIFE);
    assert(/#signin=[\w-]+$/.test(loc), 'R1 the redirect sign-in returns to Daily Tracker with a one-time code');
    const F = await openApp(browser, { email: WIFE, hash: '#signin=' + loc.split('#signin=')[1] });
    assert(await waitFor(async () => (await syncSt(F.p))?.via === 'google' && (await profiles(F.p))?.activeId === kayId, 25000), 'R2 a fresh install finishes signing in by itself and opens Kay');
    assert(await F.p.evaluate(() => location.hash === '' || location.hash === '#today'), 'R3 the code is removed from the address');
    const bad = await openApp(browser, { email: WIFE, hash: '#signin-error=' + encodeURIComponent('That sign-in took too long. Try again.') + '&signin-code=STATE_EXPIRED' });
    assert(await waitFor(async () => /Google sign-in didn’t finish: That sign-in took too long\. Try again\. \(STATE_EXPIRED\)/.test(toasts(bad.p))), 'R4 a failed redirect says why, with its reason code');
    // The installed iPhone app gets a plain link to the household server's start page (no Google script).
    const ios = await openApp(browser, { profiles: [['pi', 'Pad', data()]], email: WIFE });
    await ios.p.evaluate(() => { Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }); Object.defineProperty(navigator, 'standalone', { get: () => true }); });
    await go(ios.p, '#settings');
    const href = await waitFor(async () => ios.p.locator('.hh-block a.gsi-link').getAttribute('href'));
    assert(href === HH.url + '/auth/google/start?app=daily-tracker', 'R5 installed iPhone app: Sign in with Google links to /auth/google/start?app=daily-tracker');

    // ===== Sign out (a Google session ends with it). =====
    await go(F.p, '#settings');
    await F.p.click('.acct-panel .acct-bottom button:has-text("Sign out")');
    await waitSheet(F.p, 'Sign out?');
    await clickIn(F.p, 'Keep copies on this device');
    assert(await waitFor(async () => !(await syncSt(F.p))?.token && !(await lsJSON(F.p, 'dailyTracker:household'))), 'S1 signing out of Daily Tracker also signs out of Google here');
    assert((await profiles(F.p)).profiles.some((x) => x.id === kayId), 'S2 profiles stay on the device');

    // ===== Household server down / offline: the app works without it. =====
    const O = await openApp(browser, { profiles: [['po', 'Solo', data({ tasks: [task('t5', 'Offline task')] })]], hhUrl: 'http://127.0.0.1:9' });
    await go(O.p, '#settings');
    assert(await waitFor(async () => /isn’t reachable|offline/i.test(await O.p.locator('.hh-block').textContent())), 'O1 server unreachable: a plain note instead of the button');
    await go(O.p, '#today');
    assert(await O.p.locator('text=Offline task').count() === 1, 'O2 the app is fully usable without the household server');
    const exp = await O.p.evaluate(async () => { const s = await import('./js/store.js'); return JSON.stringify(s.exportPayload()); }).catch(() => '');
    assert(!/dailyTracker:household|"token"/.test(exp), 'O3 exports never include the household session');

    assert(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' / ') : ''));
  } catch (e) {
    console.log('FAIL: crash ' + (e?.stack || e));
  } finally {
    await browser.close();
    await mf.dispose();
    await HH.close();
  }
})();
