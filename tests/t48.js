const __ROOT = require('path').resolve(__dirname, '..');
// 1.16.1: Settings › Account shows each profile with an Edit button (the Profile group and its Switch
// button are gone), and changing a setting re-renders Settings without the passkeys/devices block
// dropping to "Loading…" (the layout jump that flickered on iOS). Real Worker in Miniflare.
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

  // ===== Signed out: profiles listed in Account with Edit; no Profile group, no Switch =====
  const A = await openApp(browser, { profiles: [['pm', 'Mick', data()], ['ps', 'Sam', data()]] });
  await go(A.p, '#settings'); await A.p.waitForTimeout(300);
  if (process.env.T48_SHOT) await A.p.screenshot({ path: process.env.T48_SHOT.replace('.png', '-out.png') });
  const titles = await A.p.locator('.set-title').allTextContents();
  assert(!titles.includes('Profile') && titles[0] === 'Account', 'P1 no Profile group; Account is first: ' + titles.slice(0, 3).join(', '));
  assert(await A.p.locator('main button:has-text("Switch")').count() === 0, 'P2 no Switch button in Settings');
  const rows = await A.p.evaluate(() => [...document.querySelectorAll('.acct-panel .acct-prof')].map((li) => {
    const e = li.querySelector('.acct-prof-edit'), n = li.querySelector('.acct-prof-name');
    const er = e?.getBoundingClientRect(), nr = n.getBoundingClientRect();
    return { name: n.textContent, edit: e?.getAttribute('aria-label'), sameLine: !!er && er.top < nr.bottom && er.bottom > nr.top - 12 };
  }));
  assert(rows.length === 2 && rows[0].edit === 'Edit Mick' && rows[1].edit === 'Edit Sam' && rows.every((r) => r.sameLine), 'P3 signed out: each profile row has its own Edit button on the same line: ' + JSON.stringify(rows));
  assert(rows[0].name.includes('current') && !rows[1].name.includes('current'), 'P4 the active profile is marked current');
  await A.p.click('[aria-label="Edit Sam"]'); await A.p.waitForTimeout(300);
  assert(await sheetTitle(A.p) === 'Edit profile' && await A.p.inputValue('.sheet-root.open [aria-label="Name"]') === 'Sam', 'P5 Edit opens the editor for that profile (not the active one)');
  await A.p.fill('.sheet-root.open [aria-label="Name"]', 'Samantha');
  await clickSheet(A.p, 'Save'); await A.p.waitForTimeout(300);
  assert((await profiles(A.p)).find((x) => x.id === 'ps').name === 'Samantha' && (await idxOf(A.p)).activeId === 'pm', 'P6 renamed Sam; active profile unchanged');
  assert(await A.p.locator('.acct-prof-name:has-text("Samantha")').count() === 1, 'P7 the list shows the new name');

  // ===== Signed in: a settings change keeps the passkeys/devices block (no "Loading…", no jump) =====
  await createAccount(A.p, 'Flicker');
  await A.p.check('.picker-row input[value=sync]').catch(() => {});
  await clickSheet(A.p, 'Done');
  await dismissPasskeyOffer(A.p);
  await go(A.p, '#settings');
  await waitFor(() => A.p.locator('.acct-details .acct-list').count(), 8000);
  assert(await A.p.locator('.acct-panel .acct-prof-edit').count() === 2, 'S1 signed in: Edit buttons on both profile rows');
  // Scroll so the Appearance controls are on screen, then watch the account block while toggling.
  await A.p.evaluate(() => document.querySelector('[aria-label="Accent color"]').scrollIntoView({ block: 'center' }));
  await A.p.waitForTimeout(200);
  await A.p.evaluate(() => {
    window.__seen = [];
    const mo = new MutationObserver(() => { const d = document.querySelector('.acct-details'); if (d && /Loading/.test(d.textContent)) window.__seen.push('loading'); });
    mo.observe(document.querySelector('main'), { childList: true, subtree: true, characterData: true });
    window.__mo = mo;
  });
  const before = await A.p.evaluate(() => [window.scrollY, document.querySelector('[aria-label="Accent color"]').getBoundingClientRect().top]);
  const sw = A.p.locator('[aria-label="Accent color"] .swatch');
  for (let i = 0; i < 3; i++) {
    await sw.nth(i).click();
    const y = await A.p.evaluate(() => document.querySelector('[aria-label="Accent color"]').getBoundingClientRect().top);
    assert(Math.abs(y - before[1]) <= 1, `S2.${i} accent tap: the controls stay put right after the re-render (${before[1]} → ${y})`);
  }
  await A.p.waitForTimeout(800);
  const after = await A.p.evaluate(() => [window.scrollY, document.querySelector('[aria-label="Accent color"]').getBoundingClientRect().top]);
  assert(Math.abs(after[1] - before[1]) <= 1, `S3 …and after the background refresh (${before[1]} → ${after[1]})`);
  assert((await A.p.evaluate(() => window.__seen.length)) === 0, 'S4 the passkeys/devices block never went back to "Loading…"');
  assert(await A.p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'S5 no horizontal page scroll');
  if (process.env.T48_SHOT) { await A.p.evaluate(() => window.scrollTo(0, 0)); await A.p.waitForTimeout(3000); await A.p.screenshot({ path: process.env.T48_SHOT }); }
  await A.ctx.close();

  await browser.close();
  await mf.dispose();
  assert(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  process.exit(process.exitCode || 0);
})().catch((e) => { console.log('FAIL: crash ' + (e.stack || e)); process.exit(1); });
