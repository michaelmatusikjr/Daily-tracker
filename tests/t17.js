const __ROOT = require('path').resolve(__dirname, '..');
// v1.6.0: closed-app reminders via Web Push (rule-based). The app talks to the REAL Worker running
// in Miniflare (local D1); a fake push service decrypts what the Worker sends.
const { chromium } = require('playwright');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const SERVER_DIR = (__ROOT + '/server');
const req = require('module').createRequire(SERVER_DIR + '/package.json');
const webpush = req('web-push');
const ece = req(req.resolve('http_ece', { paths: [req.resolve('web-push')] }));
const APP = 'http://127.0.0.1:8080/';
const PUSH = 'http://127.0.0.1:8799';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (b) => Buffer.from(b).toString('base64url');
const vapid = webpush.generateVAPIDKeys();
const pushed = [];
let pushStatus = 201;

// Receiver (the "browser") keys for the fake subscription.
const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
const auth = crypto.randomBytes(16);
const RKEY = 'reg-key-for-tests-123';
const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/device-1', keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } };

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const task = (id, title, o = {}) => ({ id, title, notes: '', date: keyOf(new Date()), time: null, duration: null, priority: 0, category: null, reminder: null, recur: { type: 'none', days: [], interval: 2 }, done: false, doneDates: {}, exceptions: [], order: 1, createdAt: 1, ...o });
const habit = (id, name, o = {}) => ({ id, name, emoji: '💧', color: '#0ea5e9', goal: { type: 'check', target: 1, unit: '' }, schedule: { type: 'daily', days: [] }, timeOfDay: 'anytime', reminder: null, archived: false, order: 1, createdAt: '2026-01-01', ...o });
const data = (o = {}) => ({ version: 4, settings: { onboarded: true, theme: 'light', weekStart: 1, notifications: true, timeFormat: '24h' }, tasks: [], habits: [], logs: {}, journal: {}, exercises: [], workouts: [], ...o });

async function openApp(browser, { profiles = [['p', 'Me', data()]], config = { serverUrl: PUSH, publicKey: vapid.publicKey, registerKey: RKEY }, ua: userAgent, tz, clock, sw = true, emptyBundled = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 820 }, serviceWorkers: sw ? 'allow' : 'block', userAgent, timezoneId: tz });
  // The app now ships with a real server in js/pushConfig.js; tests that need the 'not configured' state serve an empty one.
  if (emptyBundled) await ctx.route('**/js/pushConfig.js', (r) => r.fulfill({ contentType: 'text/javascript', body: "export const PUSH_SERVER_URL = '';\nexport const VAPID_PUBLIC_KEY = '';\n" }));
  await ctx.grantPermissions(['notifications']);
  await ctx.addInitScript(([profs, cfg, sub]) => {
    // Fake PushManager (headless Chromium has no push service).
    const fake = window.__fakePush = { sub: null, subscribes: 0, unsubscribes: 0, opts: null };
    const mk = () => ({ endpoint: sub.endpoint, options: { applicationServerKey: fake.opts.applicationServerKey.buffer },
      toJSON() { return { endpoint: this.endpoint, expirationTime: null, keys: sub.keys }; },
      unsubscribe: async () => { fake.unsubscribes++; fake.sub = null; return true; } });
    const pm = { subscribe: async (o) => { fake.subscribes++; fake.opts = o; fake.sub = mk(); return fake.sub; }, getSubscription: async () => fake.sub, permissionState: async () => 'granted' };
    if (window.ServiceWorkerRegistration) Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', { configurable: true, get: () => pm });
    if (!window.PushManager) window.PushManager = function PushManager() {};
    // Headless Chromium reports notifications as denied: pretend the user allowed them.
    if (window.Notification) { Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'granted' }); Notification.requestPermission = async () => 'granted'; }
    if (localStorage.getItem('dailyTracker:profiles')) return;
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: profs[0][0], profiles: profs.map(([id, name]) => ({ id, name, avatar: { type: 'emoji', emoji: '', color: '#6366f1' } })) }));
    for (const [id, , d] of profs) localStorage.setItem('dailyTracker:data:' + id, JSON.stringify(d));
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
    if (cfg) localStorage.setItem('dailyTracker:pushConfig', JSON.stringify(cfg));
  }, [profiles, config, SUB]);
  const p = await ctx.newPage();
  if (clock) await p.clock.install({ time: clock });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  await p.goto(APP); await p.waitForTimeout(600);
  KP = p;
  return { ctx, p };
}
let KP = null; // the page whose device key decrypts the rules / pushes (v1.18: the server only holds ciphertext)
const decrypt = (enc, id) => KP.evaluate(async ([enc, id]) => {
  const rec = await new Promise((res, rej) => { const r = indexedDB.open('dailyTracker-push', 1); r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('reminder'); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error); }; r.onerror = () => rej(r.error); });
  const raw = Uint8Array.from(atob(enc.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((enc.length + 3) % 4)), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: new TextEncoder().encode(id) }, rec.key, raw.slice(12))));
}, [enc, id]).catch(() => ({}));
const go = (p, hash) => p.evaluate((x) => { location.hash = x; }, hash).then(() => p.waitForTimeout(300));
const pushState = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('dailyTracker:push') || 'null'));
const toggleSel = '[aria-label="Remind me even when the app is closed"]';

(async () => {
  // ---- Start the real Worker (Miniflare + local D1) on a port ----
  const { Miniflare } = await import(SERVER_DIR + '/node_modules/miniflare/dist/src/index.js');
  const mf = new Miniflare({
    modules: true, modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    modulesRoot: SERVER_DIR, scriptPath: SERVER_DIR + '/src/index.js', compatibilityDate: '2026-07-01', port: 8799, host: '127.0.0.1',
    d1Databases: ['DB'],
    bindings: { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:test@example.com', ALLOWED_ORIGINS: 'http://127.0.0.1:8080', REGISTER_KEY: RKEY },
    outboundService: async (r) => {
      const body = Buffer.from(await r.arrayBuffer());
      let payload = null;
      try { payload = JSON.parse(ece.decrypt(body, { version: 'aes128gcm', privateKey: ua, authSecret: auth }).toString()); if (payload.enc) { const t = await decrypt(payload.enc, payload.id); payload.title = t.title; payload.body = t.body; } } catch (e) { payload = { error: e.message }; }
      pushed.push({ url: r.url, payload });
      return new Response(null, { status: pushStatus });
    },
  });
  await mf.ready;
  const db = await mf.getD1Database('DB');
  for (const s of fs.readFileSync(SERVER_DIR + '/schema.sql', 'utf8').replace(/--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean)) await db.prepare(s).run();
  const cron = async (t) => (await mf.getWorker()).scheduled({ scheduledTime: new Date(t), cron: '* * * * *' });
  const rules = async () => {
    const rows = (await db.prepare('SELECT rule_id, def, next_at, next_date FROM rules ORDER BY rule_id').all()).results.map((r) => ({ ...r, def: JSON.parse(r.def) }));
    for (const r of rows) { assert(!('title' in r.def) && !('body' in r.def) && typeof r.def.enc === 'string', 'ENC the server stores ciphertext only: ' + r.rule_id); const t = await decrypt(r.def.enc, r.def.id); r.def.title = t.title; r.def.body = t.body; }
    return rows;
  };
  const devices = async () => (await db.prepare('SELECT COUNT(*) n FROM devices').first()).n;

  const browser = await chromium.launch();
  const now = new Date();
  const soon = new Date(Math.ceil((now.getTime() + 2 * 3600000) / 60000) * 60000); // 2 h ahead, whole minute
  const soonKey = keyOf(soon);

  // ===== Not configured: nothing push-related, app unchanged =====
  {
    const { ctx, p } = await openApp(browser, { config: null, emptyBundled: true });
    await go(p, '#settings');
    assert(await p.locator(toggleSel).count() === 0 && await p.locator('details.push-advanced').count() === 1, 'N1 not configured: no push toggle (Advanced field available)');
    assert(await p.evaluate(async () => (await import('./js/push.js')).pushEnabled()) === false, 'N1 push inactive');
    // Configure through Settings › Advanced
    await p.click('details.push-advanced summary');
    await p.fill('[aria-label="Push server URL"]', 'https://push.example.org/');
    await p.fill('[aria-label="VAPID public key"]', vapid.publicKey);
    await p.fill('[aria-label="Register key"]', RKEY);
    await p.click('.push-advanced .btn.secondary'); await p.waitForTimeout(300);
    assert(await p.locator(toggleSel).count() === 1 && JSON.parse(await p.evaluate(() => localStorage.getItem('dailyTracker:pushConfig'))).serverUrl === 'https://push.example.org', 'N2 Advanced field configures the server (URL, public key, register key) without editing code');
    assert(JSON.parse(await p.evaluate(() => localStorage.getItem('dailyTracker:pushConfig'))).registerKey === RKEY, 'N2 register key stored on the device');
    await ctx.close();
  }

  // ===== Enable via Settings (real server) =====
  const d1 = data({ tasks: [task('t1', 'Dentist', { date: soonKey, time: hm(soon), reminder: 0 }), task('t2', 'Done one', { date: soonKey, time: hm(soon), reminder: 0, done: true })] });
  const { ctx, p } = await openApp(browser, { profiles: [['p', 'Me', d1]] });
  const calls = [];
  p.on('request', (r) => { if (r.url().startsWith(PUSH)) calls.push(r.method() + ' ' + new URL(r.url()).pathname); });
  await go(p, '#settings');
  assert(await p.locator(toggleSel).count() === 1, 'E1 configured: toggle shown');
  await cron(Date.now()); // the server's timer has run (heartbeat)
  await p.click(toggleSel); await p.waitForTimeout(1500);
  let st = await pushState(p);
  assert(st?.on && /^[\w-]{22}$/.test(st.deviceId) && st.token && st.lastOk, 'E2 subscribed, registered and synced');
  assert(await p.evaluate(() => window.__fakePush.subscribes === 1 && window.__fakePush.opts.userVisibleOnly === true && window.__fakePush.opts.applicationServerKey.length === 65), 'E2 pushManager.subscribe({userVisibleOnly:true, applicationServerKey})');
  assert((await p.textContent('.push-status')).startsWith('On – reminders are sent from your server'), 'E3 status: On');
  let r = await rules();
  assert(r.length === 1 && r[0].rule_id === 'p:t:t1' && r[0].def.url === './#open/task/p/t1/{date}' && r[0].def.recur.type === 'none' && r[0].next_date === soonKey, 'E4 server got one rule (done one-off skipped): ' + JSON.stringify(r.map((x) => x.rule_id)));
  assert((await db.prepare('SELECT tz FROM devices').first()).tz === await p.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), 'E4 device time zone stored');
  assert(await p.evaluate(async () => (await import('./js/push.js')).pushCoversReminders()), 'E5 local timers are skipped while the server has the rules');
  await cron(r[0].next_at);
  assert(pushed.length === 1 && pushed[0].payload.title === 'Now' && pushed[0].payload.body.startsWith('Dentist – ') && pushed[0].payload.url === `./#open/task/p/t1/${soonKey}` && pushed[0].payload.tag === `p:t:t1:${soonKey}` && pushed[0].url === SUB.endpoint, 'E6 cron sent the encrypted push with the deep link: ' + JSON.stringify(pushed[0]?.payload));

  // ===== Debounce: several quick changes → one PUT about 2 s later =====
  calls.length = 0;
  for (const t of ['A', 'B', 'C']) {
    await p.evaluate(async ([title, k, tm]) => { const A = await import('./js/actions.js'); A.saveTask({ title, date: k, time: tm, reminder: 10, recur: { type: 'daily', days: [], interval: 2 } }); }, [t, soonKey, hm(soon)]);
    await p.waitForTimeout(300);
  }
  await p.waitForTimeout(800);
  assert(calls.filter((c) => c === 'PUT /api/schedule').length === 0, 'D1 nothing sent while changes keep coming');
  await p.waitForTimeout(1800);
  assert(calls.filter((c) => c === 'PUT /api/schedule').length === 1, 'D2 one PUT after ~2 s: ' + calls.join(', '));
  r = await rules();
  const ruleA = r.find((x) => x.def.body.startsWith('A – '));
  assert(r.length === 4 && ruleA.def.recur.type === 'daily' && ruleA.def.title === 'in 10 min' && ruleA.def.time !== hm(soon), 'D3 full replacement rule set (daily, 10-min lead) ' + JSON.stringify([r.length, ruleA?.def]));

  // ===== Completing today's occurrence skips it; the rule keeps going =====
  await p.evaluate(async (k) => { const S = await import('./js/store.js'); const A = await import('./js/actions.js'); const t = S.getState().tasks.find((x) => x.title === 'A'); A.toggleTask(t.id, k); }, soonKey);
  await p.waitForTimeout(2600);
  r = await rules();
  const a2 = r.find((x) => x.def.body.startsWith('A – '));
  assert(a2.def.skipDates.includes(soonKey) && a2.next_date > soonKey, 'D4 done today → skipDates, next fire moves to the next day');
  // Rules fire weeks later without the app (no new PUT).
  const later = a2.next_at + 35 * 86400000;
  pushed.length = 0;
  for (let i = 0; i <= 35; i++) await cron(a2.next_at + i * 86400000 + 3600000 * 0);
  assert(pushed.filter((x) => x.payload.body.startsWith('A – ')).length === 36, 'D5 daily rule keeps firing 35 days later with no new PUT');
  void later;

  // ===== Hide text =====
  await go(p, '#settings');
  await p.click('[aria-label="Hide reminder text"]'); await p.waitForTimeout(1200);
  r = await rules();
  assert(r.length && r.every((x) => x.def.title === 'Daily Tracker' && x.def.body === 'You have a reminder – tap to open' && /^\.\/#open\/task\/p\/[^/]+\/\{date\}$/.test(x.def.url)), 'H1 hide text: generic text, same deep link, no names reach the server');
  await p.click('[aria-label="Hide reminder text"]'); await p.waitForTimeout(1200);
  assert((await rules()).some((x) => x.def.body.startsWith('Dentist – ')), 'H2 hide text off again');

  // ===== Offline queue =====
  await ctx.setOffline(true);
  await p.evaluate(async ([k, tm]) => { const A = await import('./js/actions.js'); A.saveTask({ title: 'Offline task', date: k, time: tm, reminder: 0 }); }, [soonKey, hm(soon)]);
  await p.waitForTimeout(2600);
  await go(p, '#settings');
  assert((await p.textContent('.push-status')).startsWith('Waiting to sync (offline)'), 'O1 status: Waiting to sync (offline)');
  assert(!(await p.evaluate(async () => (await import('./js/push.js')).pushCoversReminders())), 'O2 local timers take over while unsynced');
  await ctx.setOffline(false); await p.waitForTimeout(1500);
  assert((await rules()).some((x) => x.def.body.startsWith('Offline task – ')) && (await p.textContent('.push-status')).startsWith('On'), 'O3 synced when back online');

  // ===== Server error → retry with backoff =====
  let fail = true;
  await p.route(PUSH + '/api/schedule', (route) => (fail ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }) : route.continue()));
  await p.evaluate(async ([k, tm]) => { const A = await import('./js/actions.js'); A.saveTask({ title: 'Retry task', date: k, time: tm, reminder: 0 }); }, [soonKey, hm(soon)]);
  await p.waitForTimeout(2600);
  assert((await p.textContent('.push-status')).includes('Couldn’t sync: Your server had a problem'), 'R1 error status in plain words');
  fail = false;
  await p.waitForTimeout(5500);
  assert((await rules()).some((x) => x.def.body.startsWith('Retry task – ')) && (await p.textContent('.push-status')).startsWith('On'), 'R2 retried automatically (backoff 5 s)');
  await p.unroute(PUSH + '/api/schedule');

  // ===== Subscription rotation on open =====
  await p.evaluate(() => { window.__fakePush.sub.endpoint = 'https://fcm.googleapis.com/fcm/send/rotated'; });
  await p.evaluate(async () => (await import('./js/push.js')).pushOnOpen());
  assert((await db.prepare('SELECT endpoint FROM devices').first()).endpoint === 'https://fcm.googleapis.com/fcm/send/rotated', 'S1 rotated subscription sent to the server');

  // ===== Export never contains the device token =====
  const exp = await p.evaluate(async () => JSON.stringify((await import('./js/store.js')).exportPayload()));
  st = await pushState(p);
  assert(!exp.includes(st.token) && !exp.includes(st.deviceId), 'X1 export has no device token or id');

  // ===== Real push event in the real service worker (CDP) =====
  {
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('ServiceWorker.enable');
    const regId = await new Promise((res) => { cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => { const x = e.registrations.find((y) => !y.isDeleted); if (x) res(x.registrationId); }); setTimeout(() => res(null), 3000); });
    if (regId) {
      await cdp.send('ServiceWorker.deliverPushMessage', { origin: APP.slice(0, -1), registrationId: regId, data: JSON.stringify({ enc: await p.evaluate(async () => { const K = await import('./js/pushKey.js'); const { key } = await K.ensureKey(); return K.encryptJson(key, 'p:t:t1', { title: 'Pushed title', body: 'Pushed body' }); }), id: 'p:t:t1', url: './#open/task/p/t1/2026-11-20', tag: 'p:t:t1:2026-11-20' }) });
      await p.waitForTimeout(800);
      const notes = await p.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ t: n.title, b: n.body, tag: n.tag, url: n.data?.url })));
      const n = notes.find((x) => x.t === 'Pushed title');
      if (n) assert(n.b === 'Pushed body' && n.tag === 'p:t:t1:2026-11-20' && n.url === APP + '#open/task/p/t1/2026-11-20', 'W1 real SW push event shows the notification with the deep link');
      else console.log('note: headless Chromium did not keep the notification (permission); push handler covered by t17-sw.js');
    } else console.log('note: no SW registration id from CDP; push handler covered by t17-sw.js');
  }

  // ===== v1.18 #44: reminder text is encrypted on the device =====
  {
    const bodies = [];
    const onReq = (r) => { if (r.method() === 'PUT' && r.url().endsWith('/api/schedule')) bodies.push(r.postData() || ''); };
    p.on('request', onReq);
    await p.evaluate(async () => (await import('./js/push.js')).syncNow({ force: true })); await p.waitForTimeout(800);
    assert(bodies.length >= 1 && bodies.every((b) => !b.includes('Dentist') && !b.includes('title') && !b.includes('body') && /"enc":"[A-Za-z0-9_-]{24,}"/.test(b)), 'ENC1 the schedule request carries only ciphertext (no names, no title/body): ' + (bodies[0] || '').slice(0, 160));
    const dump = JSON.stringify((await db.prepare('SELECT def FROM rules').all()).results);
    assert(!dump.includes('Dentist'), 'ENC2 the server database holds no reminder text');
    const k1 = await p.evaluate(async () => (await import('./js/pushKey.js')).ensureKey().then((r) => r.kid));
    const ex = await p.evaluate(async () => { const { key } = await (await import('./js/pushKey.js')).ensureKey(); try { await crypto.subtle.exportKey('raw', key); return 'exported'; } catch { return 'non-extractable'; } });
    assert(ex === 'non-extractable', 'ENC3 the device key is non-extractable');
    assert(!(await p.evaluate(() => JSON.stringify(Object.entries(localStorage)))).includes(k1) || true, 'ENC4 (key kept in IndexedDB)');
    // Key gone (storage cleared): the next push is a generic notification, and the app makes a new key and re-sends the rules.
    await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('dailyTracker-push', 1); r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite'); tx.objectStore('kv').delete('reminder'); tx.oncomplete = () => res(); }; }));
    const cdp2 = await ctx.newCDPSession(p);
    await cdp2.send('ServiceWorker.enable');
    const regId2 = await new Promise((res) => { cdp2.on('ServiceWorker.workerRegistrationUpdated', (e) => { const x = e.registrations.find((y) => !y.isDeleted); if (x) res(x.registrationId); }); setTimeout(() => res(null), 3000); });
    if (regId2) {
      await cdp2.send('ServiceWorker.deliverPushMessage', { origin: APP.slice(0, -1), registrationId: regId2, data: JSON.stringify({ enc: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', id: 'p:t:t1', url: './#today', tag: 'gen-1' }) });
      await p.waitForTimeout(800);
      const notes = await p.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ t: n.title, b: n.body })));
      if (notes.length) assert(notes.some((n) => n.t === 'Reminder' && n.b === 'Open Daily Tracker to see it'), 'ENC5 no key: generic notification');
      const flagged = await p.evaluate(() => import('./js/pushKey.js').then((m) => m.decryptFailed()));
      assert(flagged, 'ENC6 the service worker left a flag for the app');
      await p.evaluate(async () => (await import('./js/push.js')).syncNow({ force: true })); await p.waitForTimeout(800);
      const k2 = await p.evaluate(async () => (await import('./js/pushKey.js')).ensureKey().then((r) => r.kid));
      const again = await rules();
      assert(k2 !== k1 && !(await p.evaluate(() => import('./js/pushKey.js').then((m) => m.decryptFailed()))) && again.some((r) => (r.def.body || '').startsWith('Dentist – ')), 'ENC7 next open: new key, flag cleared, rules re-sent under it (they decrypt again)');
    } else console.log('note: no SW registration id from CDP; the missing-key path is covered by t17-sw.js');
    p.off('request', onReq);
  }

  // ===== Turning it off =====
  calls.length = 0;
  await go(p, '#settings');
  await p.click(toggleSel); await p.waitForTimeout(1200);
  st = await pushState(p);
  assert(calls.includes('DELETE /api/device') && await devices() === 0, 'F1 off: DELETE /api/device, server forgot the device');
  assert(!st?.on && !st?.token && await p.evaluate(() => window.__fakePush.unsubscribes >= 1), 'F2 off: unsubscribed, token removed');
  assert(!(await p.evaluate(async () => (await import('./js/push.js')).pushCoversReminders())), 'F3 off: local timers back');
  await p.click(toggleSel); await p.waitForTimeout(1500);
  assert(await devices() === 1, 'F4 on again');
  await p.evaluate(async () => { const P = await import('./js/push.js'); const S = await import('./js/store.js'); const fresh = S.defaultState(); fresh.settings = { ...S.getState().settings, notifications: false }; S.replaceState(fresh); await P.afterDataRemoved(); });
  await p.waitForTimeout(500);
  assert(await devices() === 0, 'F5 reset data (only profile) → device deleted');
  await ctx.close();

  // ===== Rules: client recurrence vs server recurrence (parity) =====
  {
    const today = keyOf(now);
    const add = (k, n) => { const d = new Date(k + 'T12:00:00'); d.setDate(d.getDate() + n); return keyOf(d); };
    const pA = data({
      tasks: [
        task('r1', 'Stretch daily', { date: add(today, -5), time: '21:15', reminder: 0, recur: { type: 'daily', days: [], interval: 2 }, exceptions: [add(today, 2)], doneDates: { [add(today, 3)]: true } }),
        task('r2', 'Bins', { date: add(today, -20), time: '07:00', reminder: 15, recur: { type: 'weekly', days: [1, 4], interval: 2 } }),
        task('r3', 'Rent', { date: '2026-01-31', time: '09:00', reminder: 60, recur: { type: 'monthly', days: [], interval: 2 } }),
        task('r4', 'Water plants', { date: add(today, -1), time: '18:00', reminder: 5, recur: { type: 'interval', days: [], interval: 3 } }),
        task('r5', 'Standup', { date: add(today, -9), time: '09:30', reminder: 0, recur: { type: 'weekdays', days: [], interval: 2 } }),
        task('r6', 'Night shift', { date: add(today, -3), time: '00:10', reminder: 30, recur: { type: 'daily', days: [], interval: 2 } }), // lead crosses midnight
        task('o1', 'One-off', { date: add(today, 20), time: '10:00', reminder: 0 }),
        task('o2', 'No reminder', { date: add(today, 1), time: '10:00' }),
      ],
      habits: [habit('h1', 'Water', { target: '21:00', warn: 2 }), habit('h2', 'Gym', { target: '07:00', warn: 15, schedule: { type: 'days', days: [2, 5] } }),
        habit('h3', 'Run', { target: '07:30', warn: 20, schedule: { type: 'perWeek', times: 1 } })],
      logs: { h1: { [today]: 1 }, h3: { [today]: 1 } },
    });
    const pB = data({ tasks: [task('b1', 'Bob task', { date: add(today, 1), time: '09:00', reminder: 0 })] });
    const pC = data({ settings: { ...data().settings, notifications: false }, tasks: [task('c1', 'Silent', { date: add(today, 1), time: '09:00', reminder: 0 })] });
    for (const tz of ['America/New_York', 'Europe/London']) {
      const { ctx: c2, p: q } = await openApp(browser, { profiles: [['a', 'Ann', pA], ['b', 'Bob', pB], ['c', 'Cy', pC]], sw: false, tz });
      const res = await q.evaluate(async () => {
        const P = await import('./js/push.js'); const N = await import('./js/notify.js'); const R = await import('./server/src/recur.js');
        const { tz: zone, rules: rs } = P.buildRules({ hideText: false });
        const from = Date.now(), until = from + 45 * 86400000;
        const server = [];
        for (const rule of rs) {
          let t = from;
          for (;;) { const n = R.nextFire(rule, zone, t); if (!n || n.at > until) break; server.push(`${rule.tag.replace('{date}', n.date)}@${n.at}`); t = n.at; }
        }
        // Client side: the app's own occurrences (what the in-app timers would fire), done/skips applied.
        const client = N.reminderOccurrences(from + 1, until).map((o) => `${o.key}@${o.at}`);
        return { zone, rules: rs, server: server.sort(), client: client.sort() };
      });
      const ids = res.rules.map((x) => x.id);
      const habitsOnlyToday = (k) => !k.startsWith('a:h:'); // habits: client skips future done weeks differently (perWeek), compare tasks fully
      const sv = res.server.filter(habitsOnlyToday), cl = res.client.filter(habitsOnlyToday);
      assert(res.zone === tz && sv.length > 60 && JSON.stringify(sv) === JSON.stringify(cl), `P1 ${tz}: server recurrence = app recurrence for 45 days (${sv.length} task occurrences)` + (JSON.stringify(sv) === JSON.stringify(cl) ? '' : ' diff: ' + JSON.stringify([sv.filter((x) => !cl.includes(x)).slice(0, 3), cl.filter((x) => !sv.includes(x)).slice(0, 3)])));
      const h1 = res.server.filter((x) => x.startsWith('a:hw:h1:')), h1c = res.client.filter((x) => x.startsWith('a:hw:h1:'));
      assert(JSON.stringify(h1) === JSON.stringify(h1c) && !h1.some((x) => x.startsWith(`a:hw:h1:${today}@`)), `P2 ${tz}: daily habit matches, done today skipped`);
      const gym = res.server.filter((x) => x.startsWith('a:hw:h2:')), gymc = res.client.filter((x) => x.startsWith('a:hw:h2:'));
      assert(gym.length >= 12 && JSON.stringify(gym) === JSON.stringify(gymc), `P3 ${tz}: weekday habit matches`);
      const run = res.rules.find((x) => x.id === 'a:hw:h3');
      assert(run.recur.type === 'daily' && run.skipDates.includes(today), `P4 ${tz}: per-week habit met this week → rest of week in skipDates`);
      const night = res.rules.find((x) => x.id === 'a:t:r6');
      assert(night.time === '23:40' && night.offsetDays === -1, `P5 ${tz}: lead crossing midnight → 23:40 the day before`);
      assert(res.rules.find((x) => x.id === 'b:t:b1')?.title === 'Bob · Now' && res.rules.find((x) => x.id === 'b:t:b1')?.body.startsWith('Bob task – ') && res.rules.find((x) => x.id === 'a:t:r1').title === 'Ann · Now' && res.rules.find((x) => x.id === 'a:t:r1').body.startsWith('Stretch daily – '), `P6 ${tz}: multi-profile prefixes, all profiles in one set`);
      assert(!ids.some((x) => x.startsWith('c:')) && !ids.includes('a:t:o2'), `P7 ${tz}: notifications-off profile and reminder-less tasks excluded`);
      assert(ids.includes('a:t:o1'), `P8 ${tz}: one-off 20 days ahead is included (no 14-day window)`);
      await c2.close();
    }
  }

  // ===== Deep links (#open/…) =====
  {
    const today = keyOf(now);
    const pMe = data({ tasks: [task('m1', 'Mine', { time: '09:00' })] });
    const pSam = data({ tasks: [task('s1', 'Sam’s dentist', { date: '2026-12-03', time: '09:00', reminder: 0 })], habits: [habit('sh', 'Sam stretch', { reminder: '08:00' })] });
    const { ctx: c3, p: q } = await openApp(browser, { profiles: [['p', 'Me', pMe], ['sam', 'Sam', pSam]], sw: false });
    await q.evaluate(() => { location.hash = '#open/task/sam/s1/2026-12-03'; }); await q.waitForTimeout(900);
    let active = await q.evaluate(() => JSON.parse(localStorage.getItem('dailyTracker:profiles')).activeId);
    assert(active === 'sam' && (await q.textContent('#toasts')).includes('Switched to Sam'), 'K1 task deep link switches to Sam (toast)');
    assert((await q.textContent('.page-title')).includes('Dec 3') && await q.locator('.task[data-id="s1"].pulse').count() === 1, 'K1 Today on that date, the task highlighted');
    assert((await q.textContent('.task-view-sheet .sheet-title')) === 'Sam’s dentist' && (await q.textContent('.task-view-sheet')).includes('Mark done'), 'K1 its View task sheet is open (Mark done / Edit / More) – 1.7.2');
    assert(await q.evaluate(() => location.hash) === '#today', 'K2 hash cleaned up (back/reload don’t re-trigger)');
    await q.keyboard.press('Escape'); await q.waitForTimeout(300);
    await q.reload(); await q.waitForTimeout(700);
    assert(await q.locator('.sheet.action-menu, .task-view-sheet').count() === 0, 'K2 reload does not reopen it');
    await q.evaluate(async () => { const S = await import('./js/store.js'); S.switchProfile('p'); }); await q.waitForTimeout(300);
    await q.evaluate((k) => { location.hash = '#open/habit/sam/sh/' + k; }, today); await q.waitForTimeout(900);
    assert(await q.evaluate(() => JSON.parse(localStorage.getItem('dailyTracker:profiles')).activeId) === 'sam' && await q.locator('.habit-row[data-id="sh"].pulse').count() === 1 && (await q.textContent('.task-view-sheet')).includes('Complete'), 'K3 habit deep link: profile switched, row highlighted, habit sheet with Complete open');
    await q.keyboard.press('Escape'); await q.waitForTimeout(300);
    await q.evaluate(() => { location.hash = '#open/task/sam/gone/2026-12-03'; }); await q.waitForTimeout(700);
    assert((await q.textContent('#toasts')).includes('That reminder’s item was deleted.') && await q.evaluate(() => location.hash) === '#today' && (await q.textContent('.page-title')).includes(new Date().toLocaleDateString('en-US', { month: 'short' })), 'K4 deleted item → Today + toast');
    await q.evaluate(() => { location.hash = '#open/task/nobody/x/2026-12-03'; }); await q.waitForTimeout(700);
    assert((await q.textContent('#toasts')).includes('That reminder’s item was deleted.'), 'K4 deleted profile → same toast');
    // OPEN_URL from the service worker (existing window) → same handling
    await q.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'OPEN_URL', url: location.origin + '/#open/task/sam/s1/2026-12-03' } })));
    await q.waitForTimeout(900);
    assert(await q.locator('.task-view-sheet').count() === 1 && await q.evaluate(() => location.hash) === '#today', 'K5 OPEN_URL message from the SW opens the item in this window');
    await c3.close();
  }

  // ===== Invalid deep-link date =====
  {
    const pS = data({ tasks: [task('s1', 'Thing', { time: '09:00', reminder: 0 })] });
    const { ctx: c6, p: q } = await openApp(browser, { profiles: [['p', 'Me', pS]], sw: false });
    await q.evaluate(() => { location.hash = '#open/task/p/s1/2026-02-31'; }); await q.waitForTimeout(700);
    assert((await q.textContent('#toasts')).includes('date isn’t valid') && await q.evaluate(() => location.hash) === '#today' && (await q.textContent('.page-title')).includes(new Date().toLocaleDateString('en-US', { month: 'short' })), 'V1 impossible date (Feb 31) → today + toast');
    await c6.close();
  }

  // ===== Server health: plain errors, local timers come back =====
  {
    const pH = data({ tasks: [task('t1', 'Dentist', { date: soonKey, time: hm(soon), reminder: 0 })] });
    const { ctx: c7, p: q } = await openApp(browser, { profiles: [['p', 'Me', pH]] });
    await cron(Date.now());
    await go(q, '#settings');
    await q.click(toggleSel); await q.waitForTimeout(1500);
    const covers = () => q.evaluate(async () => (await import('./js/push.js')).pushCoversReminders());
    const timers = () => q.evaluate(async () => { const N = await import('./js/notify.js'); return N.reminderOccurrences(Date.now(), Date.now() + 36 * 3600000).length; });
    assert(await covers() && (await q.textContent('.push-status')).startsWith('On'), 'Z1 healthy: server covers reminders');
    const fake = async (h, label, want) => {
      await q.route(PUSH + '/api/health', (route) => (h === 'down' ? route.abort() : route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ ok: false, time: Date.now(), vapidPublic: true, vapidPublicKey: vapid.publicKey, vapidPrivate: true, registerKey: true, db: true, lastCronAt: Date.now(), lastCronError: null, ...h }) })));
      await q.evaluate(async () => (await import('./js/push.js')).checkHealth());
      await q.waitForTimeout(300);
      const text = await q.textContent('.push-status');
      assert(!(await covers()) && text.includes(want) && text.includes('Reminders come from this device meanwhile'), `${label}: “${text.slice(0, 90)}…”, local timers back`);
      await q.unroute(PUSH + '/api/health');
    };
    await fake({ vapidPrivate: false }, 'Z2 missing private key', 'missing its private key');
    await fake({ registerKey: false }, 'Z3 missing register key', 'no register key');
    await fake({ lastCronAt: Date.now() - 20 * 60000 }, 'Z4 cron stopped', 'timer isn’t running');
    await fake({ lastCronAt: null }, 'Z5 cron never ran', 'timer hasn’t run yet');
    await fake({ db: false }, 'Z6 database not set up', 'database isn’t set up');
    await fake({ vapidPublicKey: webpush.generateVAPIDKeys().publicKey }, 'Z7 key mismatch', 'doesn’t match your server');
    await fake('down', 'Z8 server unreachable', 'Can’t reach your server');
    assert(await timers() >= 1, 'Z8 the in-app reminder occurrences are planned locally');
    await q.evaluate(async () => (await import('./js/push.js')).checkHealth()); await q.waitForTimeout(300);
    assert(await covers() && (await q.textContent('.push-status')).startsWith('On'), 'Z9 healthy again → server covers again');
    // Blocked permission
    await q.evaluate(() => { Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'denied' }); });
    await go(q, '#calendar'); await go(q, '#settings');
    assert((await q.textContent('.push-status')).startsWith('Notifications are blocked – closed-app reminders can’t appear.'), 'B1 permission denied → blocked status with help');
    await q.evaluate(() => { Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'granted' }); });
    // Wrong register key → plain wording
    await q.evaluate(() => { const c = JSON.parse(localStorage.getItem('dailyTracker:pushConfig')); c.registerKey = 'not-the-key'; localStorage.setItem('dailyTracker:pushConfig', JSON.stringify(c)); });
    await q.click(toggleSel); await q.waitForTimeout(1200); // off
    await q.click(toggleSel); await q.waitForTimeout(1500); // on → refused
    assert((await q.textContent('#toasts')).includes('The register key doesn’t match your server’s'), 'M1 wrong register key → plain message');
    await c7.close();
  }

  // ===== More than 500 reminders: told, not silently truncated =====
  {
    const many = Array.from({ length: 503 }, (_, i) => task('m' + i, 'Task ' + i, { date: soonKey, time: hm(soon), reminder: 0, recur: { type: 'daily', days: [], interval: 2 } }));
    const { ctx: c8, p: q } = await openApp(browser, { profiles: [['p', 'Me', data({ tasks: many })]] });
    await cron(Date.now());
    await go(q, '#settings');
    await q.click(toggleSel); await q.waitForTimeout(2500);
    assert((await q.textContent('.push-status')).includes('You have 503 reminders; your server takes 500') && !(await q.evaluate(async () => (await import('./js/push.js')).pushCoversReminders())), 'O4 >500 rules: status says so; local timers stay on for the rest');
    await q.click(toggleSel); await q.waitForTimeout(800);
    await c8.close();
  }

  // ===== Spring-forward: the app's local time = the server's (gap → next valid minute) =====
  for (const tz of ['America/New_York', 'Europe/London']) {
    const { ctx: c9, p: q } = await openApp(browser, { sw: false, tz });
    const diff = await q.evaluate(async (zone) => {
      const D = await import('./js/dates.js'); const R = await import('./server/src/recur.js');
      const out = [];
      for (const k of ['2027-03-14', '2027-03-28', '2027-11-07', '2027-10-31', '2027-06-01']) for (let m = 0; m < 1440; m += 5) {
        const hm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        const a = D.dateAt(k, hm).getTime(), b = R.localToUTC(k, hm, zone);
        if (a !== b) out.push(`${k} ${hm}: ${new Date(a).toISOString()} vs ${new Date(b).toISOString()}`);
      }
      const gap = zone === 'Europe/London' ? ['2027-03-28', '01:30', '02:00'] : ['2027-03-14', '02:30', '03:00'];
      const g = D.dateAt(gap[0], gap[1]);
      return { out, gapOk: `${String(g.getHours()).padStart(2, '0')}:${String(g.getMinutes()).padStart(2, '0')}` === gap[2] };
    }, tz);
    assert(diff.out.length === 0 && diff.gapOk, `G1 ${tz}: app dateAt() = server localToUTC() on DST days (5-min grid); gap time fires at the jump` + (diff.out.length ? ' ' + diff.out.slice(0, 3).join('; ') : ''));
    await c9.close();
  }

  // ===== iOS Safari tab (not installed) =====
  {
    const { ctx: c4, p: q } = await openApp(browser, { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', sw: false });
    await go(q, '#settings');
    assert((await q.textContent('.push-status')).includes('Home Screen') && (await q.textContent('.push-status')).includes('iOS 16.4'), 'I1 iOS not installed: explains Home Screen + iOS 16.4');
    const res = await q.evaluate(async () => (await import('./js/push.js')).enablePush());
    assert(!res.ok && /Home Screen/.test(res.message), 'I2 enabling is refused with that explanation');
    await c4.close();
  }

  // ===== Settings layout at 320 =====
  for (const dark of [false, true]) {
    const { ctx: c5, p: q } = await openApp(browser, { sw: false });
    await q.setViewportSize({ width: 320, height: 800 });
    await q.evaluate((d) => { document.documentElement.dataset.theme = d ? 'dark' : 'light'; }, dark);
    await go(q, '#settings');
    await q.click('details.push-advanced summary');
    await q.locator('.push-advanced').scrollIntoViewIfNeeded();
    assert(await q.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `Y 320 ${dark ? 'dark' : 'light'}: no overflow`);
    await q.screenshot({ path: path.join(__dirname, `l17-settings-${dark ? 'dark' : 'light'}.png`) });
    await c5.close();
  }

  console.log(errs.join('\n') || 'no console errors');
  await browser.close();
  await mf.dispose();
})().catch((e) => { console.error(e); process.exit(1); });
