const __ROOT = require('path').resolve(__dirname, '..');
// v1.17.0 (backlog #35): invite friends. Owner: Settings › Account › Invite someone (code, link, list,
// revoke). Friend: "#invite=CODE" link (fragment removed from the URL), "Install first" on an iPhone browser
// tab, the setup wizard (code → account without the register key → notifications via the account
// session → done), the first screen's "I have an invite", reachable again from Settings.
// Browser + the REAL Worker in Miniflare (local D1); app on http://localhost:8080.
const { chromium } = require('playwright');
const fs = require('fs');
const SERVER_DIR = __ROOT + '/server';
const req = require('module').createRequire(SERVER_DIR + '/package.json');
const webpush = req('web-push');
const crypto = require('crypto');
const APP = 'http://localhost:8080/';
const API = 'http://127.0.0.1:8793';
const RKEY = 'reg-key-for-invite-tests-1';
const PW = 'correct horse battery';
const UA_IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.88 Mobile/15E148 Safari/604.1';
const UA_IOS_OLD = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Mobile/15E148 Safari/604.1';
const UA_IOS_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 320.0.0.12.99';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const UA_ANDROID_APP = 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36 FBAV/450.0';
const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const vapid = webpush.generateVAPIDKeys();
const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/invite-device', keys: { p256dh: Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)]).toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
const data = (o = {}) => ({ version: 6, settings: { onboarded: true, theme: 'light', weekStart: 1, notifications: false, timeFormat: '24' }, tasks: [], habits: [], logs: {}, journal: {}, exercises: [], workouts: [], ...o });

/** profiles: seeded profiles (null = a fresh install). rkey: the owner's register key on this device. */
async function openApp(browser, { profiles = null, rkey = null, ua = null, standalone = false, hash = '', push = true, override = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'allow', deviceScaleFactor: 1, ...(ua ? { userAgent: ua, hasTouch: !/Macintosh/.test(ua) } : {}) });
  await ctx.route('**/daily-tracker-push.michael-matusik-jr.workers.dev/**', (r) => r.abort());
  if (override) await ctx.addInitScript((o) => { window.__platformOverride = o; }, override);
  await ctx.addInitScript(([profs, api, key, pushOn, sub, vpub, sa]) => {
    // Fake PushManager and notifications (headless Chromium has neither a push service nor permission).
    const fake = window.__fakePush = { sub: null, subscribes: 0 };
    const mk = () => ({ endpoint: sub.endpoint, options: { applicationServerKey: fake.opts.applicationServerKey.buffer }, toJSON() { return { endpoint: this.endpoint, expirationTime: null, keys: sub.keys }; }, unsubscribe: async () => { fake.sub = null; return true; } });
    const pm = { subscribe: async (o) => { fake.subscribes++; fake.opts = o; fake.sub = mk(); return fake.sub; }, getSubscription: async () => fake.sub, permissionState: async () => 'granted' };
    if (window.ServiceWorkerRegistration) Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', { configurable: true, get: () => pm });
    if (!window.PushManager) window.PushManager = function PushManager() {};
    window.__notifs = [];
    const N = function Notification(title, opts) { window.__notifs.push({ title, body: opts?.body }); };
    N.permission = 'granted'; N.requestPermission = async () => 'granted';
    window.Notification = N;
    if (sa) Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
    if (localStorage.getItem('dailyTracker:pushConfig')) return;
    if (profs) {
      localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: profs[0][0], profiles: profs.map(([id, name]) => ({ id, name, avatar: { type: 'emoji', emoji: '', color: '#6366f1' } })) }));
      for (const [id, , d] of profs) localStorage.setItem('dailyTracker:data:' + id, JSON.stringify(d));
    }
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
    localStorage.setItem('dailyTracker:pushConfig', JSON.stringify({ serverUrl: api, ...(pushOn ? { publicKey: vpub } : {}), ...(key ? { registerKey: key } : {}) }));
  }, [profiles, API, rkey, push, SUB, vapid.publicKey, standalone]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push(m.text()); });
  await p.goto(APP + hash); await p.waitForTimeout(700);
  return { ctx, p };
}
const go = (p, hash) => p.evaluate((x) => { location.hash = x; }, hash).then(() => p.waitForTimeout(300));
const lsJSON = (p, k) => p.evaluate((x) => JSON.parse(localStorage.getItem(x) || 'null'), k);
const syncSt = (p) => lsJSON(p, 'dailyTracker:sync');
const sheetTitle = (p) => p.locator('.sheet-root.open .sheet-title').last().textContent().catch(() => null);
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; };
const wizard = (p) => p.locator('.ob-wizard').count();
const wizTitle = (p) => p.locator('.ob-wizard .ob-title').textContent().catch(() => null);
const count = (p, sel) => p.locator(sel).count();

/** Owner: make an invite in the Settings sheet. Returns { code, link }. */
async function makeInvite(p, name) {
  await go(p, '#settings');
  await p.click('#acct-invite');
  await waitFor(async () => (await sheetTitle(p)) === 'Invite someone');
  await p.fill('.sheet-root.open [aria-label="Friend’s name"]', name);
  await p.click('.sheet-root.open .sheet-foot button:has-text("Create invite")');
  await waitFor(async () => (await count(p, '.sheet-root.open .invite-code')) === 1, 8000);
  const code = (await p.locator('.sheet-root.open .invite-code').textContent()).trim();
  const link = (await p.locator('.sheet-root.open .invite-link').textContent()).trim();
  return { code, link };
}
/** Answer the sheets the account flow opens after the recovery key (profile picker, passkey offer) until none is left. */
async function settle(p, { until = null } = {}) {
  let quiet = 0;
  for (let i = 0; i < 60 && quiet < 4; i++) {
    const t = await sheetTitle(p);
    if (t === 'Sync this device’s profiles?') { await p.click('.sheet-root.open .sheet-foot button:has-text("Done")'); quiet = 0; }
    else if (t === 'Add a passkey?') { await p.click('.sheet-root.open button:has-text("Cancel")'); quiet = 0; }
    else if (!(await count(p, '.sheet-root.open')) && (!until || (await until()))) quiet++;
    else quiet = 0;
    await sleep(250);
  }
}
const closeSheet = async (p) => { await p.keyboard.press('Escape'); await p.waitForTimeout(400); };

/** The friend's create-account sheet and recovery key. */
async function createFriendAccount(p, user) {
  await p.click('#setup-create');
  await waitFor(async () => (await sheetTitle(p)) === 'Create account');
  await p.fill('.sheet-root.open [aria-label="Username"]', user);
  await p.fill('.sheet-root.open [aria-label="Password"]', PW);
  await p.fill('.sheet-root.open [aria-label="Confirm password"]', PW);
  await p.click('.sheet-root.open .sheet-foot button:has-text("Create account")');
  await waitFor(async () => (await sheetTitle(p)) === 'Your recovery key', 15000);
  await p.check('#rec-saved');
  await p.click('.sheet-root.open .sheet-foot .btn.primary');
}

(async () => {
  const { Miniflare } = await import(SERVER_DIR + '/node_modules/miniflare/dist/src/index.js');
  const mf = new Miniflare({
    modules: true, modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    modulesRoot: SERVER_DIR, scriptPath: SERVER_DIR + '/src/index.js', compatibilityDate: '2026-07-01', port: 8793, host: '127.0.0.1',
    d1Databases: ['DB'],
    bindings: { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:test@example.com', ALLOWED_ORIGINS: 'http://localhost:8080', REGISTER_KEY: RKEY, MAX_ACCOUNTS: '25', MAX_DEVICES: '60' },
  });
  await mf.ready;
  const db = await mf.getD1Database('DB');
  for (const s of fs.readFileSync(SERVER_DIR + '/schema.sql', 'utf8').replace(/--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean)) await db.prepare(s).run();
  const browser = await chromium.launch();

  // ===== O: the owner =====
  const O = await openApp(browser, { profiles: [['po', 'Owner', data()]], rkey: RKEY });
  await go(O.p, '#settings');
  assert(await count(O.p, '#acct-invite') === 1, 'O1 the owner (has the register key) sees Invite someone, also signed out');
  const sam = await makeInvite(O.p, 'Sam');
  assert(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(sam.code), 'O2 the code is short and unambiguous: ' + sam.code);
  assert(sam.link === APP + '#invite=' + sam.code, 'O3 the share link is the app address + #invite=CODE: ' + sam.link);
  assert(await count(O.p, '.sheet-root.open button:has-text("Copy code")') === 1 && await count(O.p, '.sheet-root.open button:has-text("Copy link")') === 1, 'O4 Copy code / Copy link');
  assert(await count(O.p, '.sheet-root.open button:has-text("Share")') === 0, 'O5 no Share button where the Web Share sheet is not available');
  assert((await O.p.locator('.invite-list li').first().textContent()).includes('Sam') && (await O.p.locator('.invite-list li').first().textContent()).includes('Unused'), 'O6 the list shows the invite as unused');
  const rows = (await db.prepare('SELECT * FROM invites').all()).results;
  assert(rows.length === 1 && !JSON.stringify(rows).includes(sam.code.replace('-', '')) && /^[0-9a-f]{64}$/.test(rows[0].code_hash), 'O7 the server stores only a hash');
  // names are text, never markup
  await O.p.fill('.sheet-root.open [aria-label="Friend’s name"]', '<img src=x onerror=window.__xss=1>');
  await O.p.click('.sheet-root.open .sheet-foot button:has-text("Create invite")');
  await waitFor(async () => (await count(O.p, '.invite-list li')) === 2);
  assert(await count(O.p, '.invite-list img') === 0 && (await O.p.locator('.invite-list').textContent()).includes('<img src=x'), 'O8 a name with markup shows as plain text');
  assert(await O.p.evaluate(() => window.__xss) === undefined, 'O9 …and runs nothing');
  // revoke
  const xssRow = O.p.locator('.invite-list li', { hasText: '<img' });
  await xssRow.locator('button:has-text("Revoke")').click();
  await waitFor(async () => (await count(O.p, '.sheet-root.open .sheet-title:has-text("Revoke this invite?")')) === 1);
  await O.p.click('.sheet.dialog button.danger');
  await waitFor(async () => (await O.p.locator('.invite-list li', { hasText: '<img' }).textContent()).includes('Revoked'), 8000);
  assert(await O.p.locator('.invite-list li', { hasText: '<img' }).locator('button').count() === 0, 'O10 a revoked invite shows Revoked, with no button');
  await closeSheet(O.p);

  // ===== L: the link on a desktop/Android browser: wizard right away, fragment removed =====
  const L = await openApp(browser, { hash: '#invite=' + sam.code.toLowerCase() });
  assert(!(await L.p.url()).includes('invite') && !(await L.p.url()).includes('#'), 'L1 #invite= is removed from the address');
  assert(await wizard(L.p) === 1 && await count(L.p, '.onboarding.ob-first') === 0, 'L2 a fresh install with a link goes to the wizard, not the first screen');
  assert(await L.p.inputValue('#setup-code') === sam.code, 'L3 the code is prefilled (from the link)');
  assert(await wizTitle(L.p) === 'Your invite code', 'L4 step 1: invite code');
  // a wrong code
  await L.p.fill('#setup-code', 'ZZZZ-ZZZZ');
  await L.p.click('#setup-code-next');
  await waitFor(async () => (await L.p.locator('.ob-wizard .form-error').textContent()).length > 0);
  assert(/doesn’t work/.test(await L.p.locator('.ob-wizard .form-error').textContent()) && await wizTitle(L.p) === 'Your invite code', 'L5 a wrong code is refused with a plain message (checked by the server)');
  await L.p.fill('#setup-code', 'garbage');
  await L.p.click('#setup-code-next');
  assert(/doesn’t look like/.test(await L.p.locator('.ob-wizard .form-error').textContent()), 'L6 a malformed code is caught on the device');
  // a whole link pasted into the field works too
  await L.p.fill('#setup-code', 'Hi! Join: ' + sam.link);
  await L.p.click('#setup-code-next');
  await waitFor(async () => (await wizTitle(L.p)) === 'Create your account');
  assert(await wizTitle(L.p) === 'Create your account', 'L7 a valid code (even pasted as a whole link) → step 2');
  assert((await db.prepare('SELECT used_at FROM invites WHERE account_id IS NULL AND revoked = 0').all()).results.every((r) => r.used_at === null), 'L8 checking a code does not use it up');
  // account
  await L.p.click('#setup-create');
  await waitFor(async () => (await sheetTitle(L.p)) === 'Create account');
  assert(await count(L.p, '.sheet-root.open [aria-label="Register key"]') === 0, 'L9 no register key asked for: the invite code is used instead');
  await L.p.click('.sheet-root.open .sheet-head button[aria-label="Close"]');
  await L.p.waitForTimeout(400);
  assert(await wizard(L.p) === 1 && await wizTitle(L.p) === 'Create your account', 'L10 closing the sheet leaves the wizard on the account step');
  await createFriendAccount(L.p, 'sam');
  await waitFor(async () => (await wizTitle(L.p)) === 'Get reminders', 15000);
  assert(await wizTitle(L.p) === 'Get reminders', 'L11 account created → step 3: notifications');
  const inv1 = await db.prepare('SELECT used_at, account_id FROM invites WHERE name = ?').bind('Sam').first();
  const acc1 = await db.prepare('SELECT id, username FROM accounts WHERE username = ?').bind('sam').first();
  assert(inv1.used_at && inv1.account_id === acc1.id, 'L12 the invite is now used by the new account');
  const lsAll = await L.p.evaluate(() => JSON.stringify({ ...localStorage }));
  assert(!lsAll.includes(RKEY) && !(await lsJSON(L.p, 'dailyTracker:pushConfig')).registerKey, 'L13 the friend\'s device never gets the owner\'s register key');
  // notifications
  assert(await count(L.p, '#setup-test') === 0, 'L14 no test button before notifications are on');
  await L.p.click('#setup-notify-on');
  await waitFor(async () => (await wizTitle(L.p)) === 'Notifications are on', 15000);
  assert(await wizTitle(L.p) === 'Notifications are on', 'L15 one tap turns notifications on');
  const dev = (await db.prepare('SELECT COUNT(*) n FROM devices').first()).n;
  assert(dev === 1, 'L16 the device signed up for reminders through the account session (no register key): ' + dev);
  await L.p.click('#setup-test');
  await waitFor(async () => (await L.p.evaluate(() => window.__notifs.length)) === 1);
  assert((await L.p.evaluate(() => window.__notifs[0].title)) === 'Daily Tracker' && /Sent/.test(await L.p.locator('.setup-note.ok').textContent()), 'L17 Send a test notification shows one');
  await L.p.click('#setup-notify-next');
  assert(await wizTitle(L.p) === 'You’re all set' && (await L.p.locator('.setup-sums').textContent()).includes('sam') && (await L.p.locator('.setup-sums').textContent()).includes('On'), 'L18 done screen summarises account + notifications');
  await L.p.click('#setup-finish');
  await L.p.waitForTimeout(700);
  assert(await wizard(L.p) === 0 && await count(L.p, '.onboarding:not(.ob-setup)') === 1, 'L19 finishing continues into the welcome tour on a fresh install');
  await L.p.click('.ob-skip'); await L.p.waitForTimeout(500);
  assert(await count(L.p, '.sheet-root.open') === 1 && (await sheetTitle(L.p)) === 'Sync this device’s profiles?', 'L20 …then offers this device’s profile for the (empty) account');
  await L.p.click('.sheet-root.open button:has-text("Not now")'); await L.p.waitForTimeout(400);
  const lReg = await lsJSON(L.p, 'dailyTracker:pushConfig');
  assert(!lReg.registerKey, 'L21 still no register key after everything');
  // no code is left behind: reload shows nothing
  await L.p.reload(); await L.p.waitForTimeout(700);
  assert(await wizard(L.p) === 0, 'L22 a reload does not reopen the wizard');
  await go(L.p, '#settings');
  assert(await count(L.p, '#acct-invite') === 0, 'L23 the friend does not see Invite someone (no register key)');
  assert(await count(L.p, '#acct-setup') === 0, 'L24 notifications are on: no "Set up notifications" row');

  // the owner's list now says who used it
  await O.p.reload(); await O.p.waitForTimeout(600);
  await go(O.p, '#settings');
  await O.p.click('#acct-invite');
  await waitFor(async () => (await O.p.locator('.invite-list li').count()) === 2);
  const samRow = await O.p.locator('.invite-list li', { hasText: 'Sam' }).textContent();
  assert(/Used by sam/.test(samRow) && await O.p.locator('.invite-list li', { hasText: 'Sam' }).locator('button').count() === 0, 'O11 the list: "Used by sam", nothing to revoke');
  await closeSheet(O.p);

  // ===== R: a used code does nothing =====
  const R = await openApp(browser, { hash: '#invite=' + sam.code });
  await R.p.click('#setup-code-next');
  await waitFor(async () => (await R.p.locator('.ob-wizard .form-error').textContent()).length > 0);
  assert(/doesn’t work/.test(await R.p.locator('.ob-wizard .form-error').textContent()), 'R1 a used code is refused (the same words as any bad code)');
  // skipping every step still ends cleanly, and later paths exist
  await R.p.click('#setup-skip-code');
  assert(await wizTitle(R.p) === 'Create your account', 'R2 skip → account step');
  await R.p.click('#setup-skip-account');
  assert(await wizTitle(R.p) === 'Notifications' && /through your account/.test(await R.p.locator('.ob-wizard .ob-text').textContent()), 'R3 notifications need an account first (explained)');
  await R.p.click('#setup-notify-next');
  assert(await wizTitle(R.p) === 'You’re all set' && /Not set up/.test(await R.p.locator('.setup-sums').textContent()) && /only fire while the app is open/.test(await R.p.locator('.setup-sums').textContent()), 'R4 the done screen says what was skipped (and that reminders only fire while the app is open)');
  await R.p.click('#setup-finish'); await R.p.waitForTimeout(600);
  assert(await wizard(R.p) === 0 && await count(R.p, '.onboarding') === 1, 'R5 → the welcome tour');
  await R.p.click('.ob-skip'); await R.p.waitForTimeout(500);
  await go(R.p, '#settings');
  assert(await count(R.p, '#acct-have-invite') === 1, 'R6 Settings › Account has "I have an invite code" while signed out');
  await R.p.click('#acct-have-invite');
  await R.p.waitForTimeout(400);
  assert(await wizard(R.p) === 1 && await wizTitle(R.p) === 'Your invite code' && await R.p.inputValue('#setup-code') === '', 'R7 …which reopens the wizard (empty code box)');
  // second friend with a fresh code, from Settings, existing profile (not a fresh install)
  const pat = await makeInvite(O.p, 'Pat');
  await closeSheet(O.p);
  await R.p.fill('#setup-code', pat.code.toLowerCase());
  await R.p.click('#setup-code-next');
  await waitFor(async () => (await wizTitle(R.p)) === 'Create your account');
  await createFriendAccount(R.p, 'pat');
  await settle(R.p, { until: async () => (await wizTitle(R.p)) === 'Get reminders' });
  assert(await wizTitle(R.p) === 'Get reminders', 'R8 on a device with a profile the flow goes: account → profile picker → notifications');
  await R.p.click('#setup-notify-next'); // Skip for now
  await R.p.click('#setup-finish'); await R.p.waitForTimeout(500);
  await go(R.p, '#settings');
  assert(await count(R.p, '#acct-setup') === 1, 'R9 notifications skipped: Settings › Account offers "Set up notifications"');
  await R.p.click('#acct-setup'); await R.p.waitForTimeout(400);
  assert(await wizard(R.p) === 1 && await wizTitle(R.p) === 'Get reminders', 'R10 …which opens the wizard at the notifications step');
  await R.p.click('#setup-notify-on');
  await waitFor(async () => (await wizTitle(R.p)) === 'Notifications are on', 15000);
  assert(await wizTitle(R.p) === 'Notifications are on' && (await db.prepare('SELECT COUNT(*) n FROM devices').first()).n === 2, 'R11 turned on later: second device registered via the session');
  await R.p.keyboard.press('Escape'); await R.p.waitForTimeout(400);
  assert(await wizard(R.p) === 0, 'R12 Escape closes the wizard');

  // ===== I: iPhone in a Safari tab: Install first =====
  const kim = await makeInvite(O.p, 'Kim');
  await closeSheet(O.p);
  const I = await openApp(browser, { ua: IPHONE, hash: '#invite=' + kim.code });
  assert(await count(I.p, '.ob-install') === 1 && await wizard(I.p) === 0, 'I1 an iPhone browser tab with an invite link: "Install it first"');
  assert((await I.p.locator('.ob-install .setup-code').textContent()) === kim.code && await count(I.p, '#setup-copy') === 1, 'I2 the code is shown big, with Copy code');
  assert((await I.p.locator('.ob-install .setup-steps').textContent()).includes('Add to Home Screen') && (await I.p.locator('.ob-install').textContent()).includes('don’t share anything'), 'I3 illustrated steps + why the code must be copied');
  assert(!(await I.p.url()).includes('invite'), 'I4 the fragment is gone from the address');
  await I.p.click('#setup-continue-browser'); await I.p.waitForTimeout(400);
  assert(await count(I.p, '.ob-install') === 0 && await wizard(I.p) === 1 && await I.p.inputValue('#setup-code') === kim.code, 'I5 "Continue in this browser anyway" → the wizard with the code');
  await I.p.click('#setup-skip-all'); await I.p.waitForTimeout(600);
  assert(await wizard(I.p) === 0 && await count(I.p, '.onboarding') === 1, 'I6 closing the wizard goes on to the tour');
  await I.ctx.close();
  // iPhone, fresh install, plain link: first screen → I have an invite → Install first (no code)
  const I2 = await openApp(browser, { ua: IPHONE });
  assert(await count(I2.p, '.ob-first') === 1 && await count(I2.p, '.ob-first button:has-text("I have an invite")') === 1 && await count(I2.p, '.ob-first button:has-text("Sign in to your account")') === 1 && await count(I2.p, '.ob-first button:has-text("Get started on this device")') === 1, 'I7 the first screen: Sign in / I have an invite / Get started');
  await I2.p.click('#ob-invite'); await I2.p.waitForTimeout(400);
  assert(await count(I2.p, '.ob-first') === 0 && await count(I2.p, '.ob-install') === 1 && await count(I2.p, '.ob-install .setup-code') === 0, 'I8 I have an invite (iPhone browser) → Install first, without a code');
  await I2.ctx.close();
  // The installed app (standalone) goes straight on, without a code
  const I3 = await openApp(browser, { ua: IPHONE, standalone: true });
  await I3.p.click('#ob-invite'); await I3.p.waitForTimeout(400);
  assert(await count(I3.p, '.ob-install') === 0 && await wizard(I3.p) === 1 && await I3.p.inputValue('#setup-code') === '', 'I9 installed app: I have an invite → the wizard, ready for a pasted code');
  assert(await count(I3.p, '#setup-paste') === 0 || await count(I3.p, '#setup-paste') === 1, 'I10 a Paste button is offered where the clipboard can be read');
  await I3.p.fill('#setup-code', kim.code);
  await I3.p.click('#setup-code-next');
  await waitFor(async () => (await wizTitle(I3.p)) === 'Create your account');
  await createFriendAccount(I3.p, 'kim');
  await waitFor(async () => (await wizTitle(I3.p)) === 'Get reminders', 15000);
  assert(await wizTitle(I3.p) === 'Get reminders', 'I11 the installed iPhone app: code → account → notifications');
  await I3.ctx.close();

  // ===== P: each platform sees only its own steps =====
  const IOS_ONLY = /iPhone|iPad|Safari|Share|Home Screen/;
  const OTHER_ONLY = /Android|⋮|address bar|lock icon|browser is running|Install app/;
  const text = (p, sel = '.onboarding') => p.locator(sel).last().textContent();
  const toNotify = async (p) => { await p.click('#setup-skip-code'); await p.click('#setup-skip-account'); await p.waitForTimeout(150); };
  const fireInstall = (p) => p.evaluate(() => { const e = new Event('beforeinstallprompt'); e.prompt = () => { window.__installPrompted = true; }; e.userChoice = Promise.resolve({ outcome: 'accepted' }); window.dispatchEvent(e); });
  const code9 = 'AB23-CD45';
  {
    // iOS Safari tab
    const a = await openApp(browser, { ua: IPHONE, hash: '#invite=' + code9 });
    const t = await text(a.p, '.ob-install');
    assert(/Add to Home Screen/.test(t) && !/Android|⋮|address bar|lock icon|browser is running|Install app|Open this link in Safari|Open in your browser/.test(t), 'P1 iOS Safari tab: Install first (Share › Add to Home Screen), no Android/desktop text');
    assert(await a.p.locator('.ob-install .setup-code').textContent() === code9 && await count(a.p, '#setup-copy') === 1, 'P2 …with the code and Copy code');
    await a.ctx.close();
    // iOS standalone
    const b = await openApp(browser, { ua: IPHONE, standalone: true, rkey: RKEY, hash: '#invite=' + code9 });
    assert(await wizard(b.p) === 1 && await count(b.p, '.ob-install') === 0, 'P3 iOS installed app: the wizard, no gate');
    await toNotify(b.p);
    const tb = await text(b.p);
    assert(await count(b.p, '#setup-notify-on') === 1 && !OTHER_ONLY.test(tb) && !/Add Daily Tracker to your Home Screen/.test(tb), 'P4 iOS installed: notifications button, no desktop/Android text, no install nag');
    await b.ctx.close();
    // iOS third-party browser
    const c = await openApp(browser, { ua: UA_IOS_CHROME, hash: '#invite=' + code9 });
    const tc = await text(c.p, '.ob-install');
    assert(/Open this link in Safari/.test(tc) && await count(c.p, '#setup-copy-link') === 1 && await count(c.p, '#setup-copy') === 1 && !/Add to Home Screen|Android|⋮|lock icon|Install app/.test(tc), 'P5 iOS Chrome: "Open this link in Safari" with Copy link + Copy code, no install steps');
    await c.ctx.close();
    // iOS older than 16.4: no gate, says reminders need the app open
    const d = await openApp(browser, { ua: UA_IOS_OLD, hash: '#invite=' + code9 });
    assert(await wizard(d.p) === 1 && await count(d.p, '.ob-install') === 0, 'P6 iOS < 16.4: no install gate');
    await toNotify(d.p);
    const td = await text(d.p);
    assert(/Update iOS to 16.4/.test(td) && /only while the app is open/.test(td) && await count(d.p, '#setup-notify-on') === 0 && !OTHER_ONLY.test(td), 'P7 iOS < 16.4: notifications step explains (update iOS), no permission button');
    await d.ctx.close();
    // Android Chrome
    const e = await openApp(browser, { ua: UA_ANDROID, rkey: RKEY, hash: '#invite=' + code9 });
    assert(await wizard(e.p) === 1 && await count(e.p, '.ob-install') === 0, 'P8 Android Chrome: no install gate, straight to the steps');
    await toNotify(e.p);
    const te = await text(e.p);
    assert(await count(e.p, '#setup-notify-on') === 1 && !/iPhone|iPad|Safari|Share|browser is running|lock icon/.test(te), 'P9 Android: notifications button, no iOS/desktop text');
    await e.p.click('#setup-notify-next'); // Skip for now → optional install step
    const ti = await text(e.p);
    assert(await wizTitle(e.p) === 'Add to your home screen' && /⋮/.test(ti) && /Install app/.test(ti) && !/iPhone|iPad|Safari|Share|lock icon/.test(ti), 'P10 Android without a prompt: short browser-menu instructions, no iOS text');
    await e.ctx.close();
    const f = await openApp(browser, { ua: UA_ANDROID });
    await fireInstall(f.p);
    await f.p.click('#ob-invite'); await f.p.waitForTimeout(300);
    await toNotify(f.p);
    await f.p.click('#setup-notify-next');
    assert(await count(f.p, '#setup-install') === 1, 'P11 Android with a captured beforeinstallprompt: one-tap Install');
    await f.p.click('#setup-install'); await f.p.waitForTimeout(300);
    assert(await f.p.evaluate(() => window.__installPrompted === true) && await wizTitle(f.p) === 'You’re all set', 'P12 Install runs the prompt and moves on');
    await f.ctx.close();
    // Android in installed mode: no install step
    const g = await openApp(browser, { ua: UA_ANDROID, standalone: true, hash: '#invite=' + code9 });
    await toNotify(g.p); await g.p.click('#setup-notify-next');
    assert(await wizTitle(g.p) === 'You’re all set', 'P13 Android already installed: no install step');
    await g.ctx.close();
    // Desktop (Mac Safari-like and Chrome)
    const h2 = await openApp(browser, { ua: UA_MAC, rkey: RKEY, hash: '#invite=' + code9 });
    assert(await wizard(h2.p) === 1 && await count(h2.p, '.ob-install') === 0, 'P14 desktop: no gate');
    await toNotify(h2.p);
    const th = await text(h2.p);
    assert(/browser is running/.test(th) && !/iPhone|iPad|Android|⋮|Home Screen/.test(th), 'P15 desktop: a short note that reminders arrive while the browser runs, no iOS/Android text');
    await h2.p.click('#setup-notify-next');
    assert(await wizTitle(h2.p) === 'You’re all set', 'P16 desktop without a prompt event (Firefox/Safari): no install step');
    await h2.ctx.close();
    const i = await openApp(browser, { hash: '' });
    await fireInstall(i.p);
    await i.p.click('#ob-invite'); await i.p.waitForTimeout(300);
    await toNotify(i.p); await i.p.click('#setup-notify-next');
    assert(await count(i.p, '#setup-install') === 1 && !/iPhone|Android|⋮/.test(await text(i.p)), 'P17 desktop Chrome/Edge with the prompt: optional Install button');
    await i.ctx.close();
    // In-app browsers
    const j = await openApp(browser, { ua: UA_IOS_APP, hash: '#invite=' + code9 });
    const tj = await text(j.p, '.ob-install');
    assert(/Open in your browser/.test(tj) && /Safari/.test(tj) && await count(j.p, '#setup-copy-link') === 1 && !/Android|⋮|Chrome|Add to Home Screen/.test(tj), 'P18 iOS in-app browser: Open in Safari, Copy link');
    await j.ctx.close();
    const k = await openApp(browser, { ua: UA_ANDROID_APP, hash: '#invite=' + code9 });
    const tk = await text(k.p, '.ob-install');
    assert(/Open in your browser/.test(tk) && !/Safari|iPhone|iPad|Home Screen/.test(tk) && await count(k.p, '#setup-copy-link') === 1, 'P19 Android in-app browser: open in your browser, no iOS text');
    await k.p.click('#setup-continue-browser'); await k.p.waitForTimeout(300);
    assert(await wizard(k.p) === 1, 'P20 …and "Continue here anyway" goes on');
    await k.ctx.close();
    // No push at all
    const l2 = await openApp(browser, { override: { canPush: false }, hash: '#invite=' + code9 });
    await toNotify(l2.p);
    const tl = await text(l2.p);
    assert(await count(l2.p, '#setup-notify-on') === 0 && /only while the app is open/.test(tl) && !/iPhone|Android|Safari/.test(tl), 'P21 no push support: no permission button, reminders only while the app is open');
    await l2.ctx.close();
    // Denied: only the user's own re-allow hint
    for (const [name, o, re, no] of [['iOS', { ua: IPHONE, standalone: true }, /Settings › Notifications › Daily Tracker/, /site settings|lock icon/], ['Android', { ua: UA_ANDROID }, /site settings/, /iPhone|lock icon/], ['desktop', {}, /lock icon/, /iPhone|site settings/]]) {
      const m = await openApp(browser, { ...o, override: { permission: 'denied' }, hash: '#invite=' + code9 });
      await toNotify(m.p);
      const tm = await text(m.p);
      assert(re.test(tm) && !no.test(tm) && await count(m.p, '#setup-notify-on') === 0, 'P22 denied on ' + name + ': one re-allow hint for that platform only');
      await m.ctx.close();
    }
  }

  // ===== E: other first-screen paths still work =====
  const E = await openApp(browser, {});
  assert(await count(E.p, '.ob-first') === 1, 'E1 a plain fresh install shows the first screen');
  await E.p.click('.ob-first button:has-text("Get started on this device")'); await E.p.waitForTimeout(500);
  assert(await count(E.p, '.onboarding') === 1 && await count(E.p, '.ob-setup') === 0 && await count(E.p, '.ob-name') === 1, 'E2 Get started → the welcome tour as before');
  await E.ctx.close();
  // an invite link on a device that is already signed in: ignored (and removed)
  const S2 = await openApp(browser, { profiles: [['px', 'Pat', data()]], rkey: RKEY });
  await go(S2.p, '#settings');
  await S2.p.click('.acct-panel button:has-text("Create account")');
  await S2.p.waitForTimeout(300);
  assert(await count(S2.p, '.sheet-root.open [aria-label="Register key"]') === 1, 'E3 the owner\'s own sign-up still asks for the register key (prefilled)');
  await S2.p.fill('.sheet-root.open [aria-label="Username"]', 'owner1');
  await S2.p.fill('.sheet-root.open [aria-label="Password"]', PW);
  await S2.p.fill('.sheet-root.open [aria-label="Confirm password"]', PW);
  await S2.p.click('.sheet-root.open .sheet-foot button:has-text("Create account")');
  await waitFor(async () => (await sheetTitle(S2.p)) === 'Your recovery key', 15000);
  await S2.p.check('#rec-saved');
  await S2.p.click('.sheet-root.open .sheet-foot .btn.primary');
  await settle(S2.p);
  assert(!!(await syncSt(S2.p)).accountId, 'E4 the register-key account was created');
  await S2.p.goto(APP + '?again=1#invite=' + kim.code); await S2.p.waitForTimeout(800);
  assert(await wizard(S2.p) === 0 && !(await S2.p.url()).includes('invite'), 'E5 already signed in: the link opens nothing and the fragment is removed');

  // ===== The server's own checks, once more through the API =====
  const raw = async (m, path, o = {}) => { const r = await fetch(API + path, { method: m, headers: { Origin: 'http://localhost:8080', 'Content-Type': 'application/json', ...(o.key ? { 'X-Register-Key': o.key } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }); return { status: r.status, body: await r.json() }; };
  assert((await raw('GET', '/api/invites')).status === 403 && (await raw('GET', '/api/invites', { key: 'wrong-wrong-1' })).status === 403, 'S1 the owner calls need the register key');
  const l = await raw('GET', '/api/invites', { key: RKEY });
  assert(l.status === 200 && l.body.invites.length >= 4 && !JSON.stringify(l.body).match(/[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}/), 'S2 the list never contains a code');
  assert((await raw('POST', '/api/invites/check', { body: { code: kim.code } })).body.valid === false, 'S3 Kim\'s code was used by the wizard run above');

  assert(errs.length === 0, 'no console errors: ' + errs.slice(0, 5).join(' | '));
  await browser.close();
  await mf.dispose();
})().catch((e) => { console.log('FAIL: crashed: ' + (e.stack || e)); process.exit(1); });

