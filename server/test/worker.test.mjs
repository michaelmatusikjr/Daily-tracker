// End-to-end tests of the Worker in Miniflare (workerd + local D1): endpoints, auth, CORS,
// validation, rate limits, and the cron sender (with a fake push service that decrypts).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Miniflare } from 'miniflare';
import { b64urlEncode } from '../src/b64.js';

const require = createRequire(import.meta.url);
const webpush = require('web-push');
const ece = require(require.resolve('http_ece', { paths: [require.resolve('web-push')] }));

const ORIGIN = 'https://app.example.org';
const REGISTER_KEY = 'test-register-key-0123456789';
const vapid = webpush.generateVAPIDKeys();
const pushed = [];        // requests received by the fake push service
let pushStatus = 201;     // what the fake push service answers
let mf;

const receivers = new Map();
function subscription(name) {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const endpoint = `https://fcm.googleapis.com/fcm/send/${name}`;
  receivers.set(endpoint, { ua, auth });
  return { endpoint, keys: { p256dh: b64urlEncode(ua.getPublicKey()), auth: b64urlEncode(auth) } };
}

before(async () => {
  mf = new Miniflare({
    modules: true,
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    scriptPath: new URL('../src/index.js', import.meta.url).pathname,
    compatibilityDate: '2026-07-01',
    d1Databases: ['DB'],
    bindings: { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:test@example.com', ALLOWED_ORIGINS: `${ORIGIN}, http://localhost:8080`, REGISTER_KEY, MAX_DEVICES: '200' },
    // Every outbound fetch from the Worker lands here: a fake push service.
    outboundService: async (req) => {
      const body = Buffer.from(await req.arrayBuffer());
      const r = receivers.get(req.url);
      const text = r ? ece.decrypt(body, { version: 'aes128gcm', privateKey: r.ua, authSecret: r.auth }).toString() : null;
      pushed.push({ url: req.url, headers: Object.fromEntries(req.headers), payload: text && JSON.parse(text) });
      return new Response(null, { status: pushStatus });
    },
  });
  const db = await mf.getD1Database('DB');
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '');
  for (const stmt of schema.split(';').map((s) => s.trim()).filter(Boolean)) await db.prepare(stmt).run();
});
after(async () => { await mf?.dispose(); });

const call = (method, path, { body, token, device, origin = ORIGIN, headers = {}, key = REGISTER_KEY } = {}) => mf.dispatchFetch('https://push.local' + path, {
  method,
  headers: {
    ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json', ...(key && path === '/api/register' ? { 'X-Register-Key': key } : {}),
    ...(token ? { Authorization: 'Bearer ' + token, 'X-Device': device } : {}), ...headers,
  },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
});
const cron = async (time) => { const w = await mf.getWorker(); return w.scheduled({ scheduledTime: new Date(time), cron: '* * * * *' }); };
async function register(name, ip = '1.1.1.1') {
  const res = await call('POST', '/api/register', { body: { subscription: subscription(name) }, headers: { 'CF-Connecting-IP': ip } });
  assert.equal(res.status, 201);
  return res.json();
}
const TZ = 'UTC';
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const hmOf = (ms) => new Date(ms).toISOString().slice(11, 16);
/** A one-off rule firing at the minute of `at` (UTC). */
const encOf = (id) => `E${id.replace(/[^\w-]/g, '_')}_`.padEnd(40, 'x'); // stands for the device's ciphertext (opaque to the server)
const once = (id, at, extra = {}) => ({ id, kind: 'task', enc: encOf(id), url: `./#open/task/p/${id}/{date}`, tag: `p:t:${id}:{date}`, time: hmOf(at), recur: { type: 'none' }, date: keyOf(at), ...extra });
const daily = (id, at, extra = {}) => ({ ...once(id, at), recur: { type: 'daily', start: keyOf(at) }, date: undefined, ...extra });
const minute = (ms) => Math.floor(ms / 60000) * 60000;

test('health, CORS and origin checks', async () => {
  const h = await call('GET', '/api/health', { origin: null });
  assert.equal(h.status, 200);
  const hj = await h.json();
  assert.deepEqual([hj.vapidPublic, hj.vapidPrivate, hj.registerKey, hj.db, hj.vapidPublicKey], [true, true, true, true, vapid.publicKey]);
  assert.equal(hj.ok, false, 'not ok until the timer has run');
  assert.equal(hj.lastCronAt, null);
  await cron(Date.now());
  const h2 = await (await call('GET', '/api/health')).json();
  assert.equal(h2.ok, true);
  assert.ok(h2.lastCronAt > 0 && h2.lastCronError === null);
  const pre = await call('OPTIONS', '/api/schedule');
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(pre.headers.get('Access-Control-Allow-Headers'), /X-Device/);
  assert.equal((await call('OPTIONS', '/api/schedule', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('POST', '/api/register', { origin: 'https://evil.example', body: {} })).status, 403);
  assert.equal((await call('POST', '/api/register', { origin: null, body: {} })).status, 403);
  assert.equal((await call('GET', '/api/nope')).status, 404);
});

test('register validates the subscription and returns id + token (only a hash is stored)', async () => {
  assert.equal((await call('POST', '/api/register', { body: { subscription: { endpoint: 'http://insecure/x', keys: {} } } })).status, 400);
  assert.equal((await call('POST', '/api/register', { body: '{bad json' })).status, 400);
  assert.equal((await call('POST', '/api/register', { body: { subscription: subscription('big'), pad: 'x'.repeat(9000) } })).status, 413);
  const { deviceId, token } = await register('a', '2.2.2.2');
  assert.match(deviceId, /^[A-Za-z0-9_-]{22}$/); // 128 bits
  assert.ok(token.length >= 40);
  const db = await mf.getD1Database('DB');
  const row = await db.prepare('SELECT * FROM devices WHERE id = ?').bind(deviceId).first();
  assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.ok(!JSON.stringify(row).includes(token));
});

test('schedule: auth, strict validation, replace semantics', async () => {
  const { deviceId, token } = await register('b');
  const now = minute(Date.now()) + 5 * 60000;
  const put = (body) => call('PUT', '/api/schedule', { body, token, device: deviceId });
  assert.equal((await call('PUT', '/api/schedule', { body: { tz: TZ, rules: [] } })).status, 401);
  assert.equal((await call('PUT', '/api/schedule', { body: { tz: TZ, rules: [] }, token: 'x'.repeat(43), device: deviceId })).status, 401);
  const bad = async (rules, why, tz = TZ) => assert.equal((await put({ tz, rules })).status, 400, why);
  await bad([], 'bad tz', 'Mars/Olympus');
  await bad([once('a', now, { url: 'https://evil.example/' })], 'absolute url');
  await bad([once('a', now, { url: '//evil.example/' })], 'protocol-relative url');
  await bad([once('a', now, { url: 'javascript:alert(1)' })], 'javascript url');
  await bad([once('a', now, { title: 'Dentist', enc: undefined })], 'plaintext title (old client)');
  await bad([once('a', now, { title: 'Dentist' })], 'plaintext title next to enc');
  await bad([once('a', now, { body: 'Dentist – 6 PM' })], 'plaintext body');
  await bad([once('a', now, { enc: undefined })], 'no enc');
  await bad([once('a', now, { enc: 'short' })], 'enc too short');
  await bad([once('a', now, { enc: 'x'.repeat(2049) })], 'enc too long');
  await bad([once('a', now, { enc: 'not base64url! '.repeat(4) })], 'enc with other characters');
  await bad([once('a b', now)], 'bad id');
  await bad([once('a', now), once('a', now)], 'duplicate id');
  await bad([once('a', now, { time: '24:00' })], 'bad time');
  await bad([once('a', now, { date: '2026-02-30' })], 'impossible date');
  await bad([once('a', now, { kind: 'alarm' })], 'bad kind');
  await bad([daily('a', now, { recur: { type: 'yearly', start: keyOf(now) } })], 'bad recur type');
  await bad([daily('a', now, { recur: { type: 'interval', start: keyOf(now), interval: 0 } })], 'bad interval');
  await bad([daily('a', now, { recur: { type: 'weekly', start: keyOf(now), days: [7] } })], 'bad weekday');
  await bad([daily('a', now, { exceptions: ['nope'] })], 'bad exceptions');
  await bad([daily('a', now, { skipDates: Array.from({ length: 401 }, () => '2026-01-01') })], 'too many skipDates');
  await bad([once('a', now, { offsetDays: 1 })], 'bad offsetDays');
  await bad(Array.from({ length: 501 }, (_, i) => once('i' + i, now)), 'too many');
  let res = await put({ tz: TZ, rules: [once('one', now), daily('two', now)] });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  res = await put({ tz: 'Europe/London', rules: [daily('two', now)] });
  assert.equal((await res.json()).count, 1);
  const db = await mf.getD1Database('DB');
  const rows = (await db.prepare('SELECT rule_id, next_at FROM rules WHERE device_id = ?').bind(deviceId).all()).results;
  assert.deepEqual(rows.map((r) => r.rule_id), ['two'], 'whole rule set replaced');
  assert.equal((await db.prepare('SELECT tz FROM devices WHERE id = ?').bind(deviceId).first()).tz, 'Europe/London');
  res = await put({ tz: TZ, rules: Array.from({ length: 500 }, (_, i) => daily('i' + i, now)) });
  assert.equal(res.status, 200, '500 rules accepted');
});

test('cron: sends due occurrences once, fills {date}, catches up within 15 min, never late', async () => {
  const db = await mf.getD1Database('DB');
  await db.prepare('DELETE FROM rules').run();
  const a = await register('c1');
  const b = await register('c2');
  const t0 = minute(Date.now()) + 2 * 60000;            // a minute boundary just ahead
  const put = (d, rules, tz = TZ) => call('PUT', '/api/schedule', { body: { tz, rules }, token: d.token, device: d.deviceId });
  await put(a, [daily('every', t0), once('single', t0 + 60000), once('later', t0 + 3600000)]);
  await put(b, [daily('b-daily', t0)]);
  pushed.length = 0;
  await cron(t0);
  assert.deepEqual(pushed.map((p) => p.payload.id).sort(), ['b-daily', 'every']);
  const p = pushed.find((x) => x.payload.id === 'every');
  assert.deepEqual(p.payload, { enc: encOf('every'), id: 'every', url: `./#open/task/p/every/${keyOf(t0)}`, tag: `p:t:every:${keyOf(t0)}` });
  assert.equal(p.headers['content-encoding'], 'aes128gcm');
  assert.match(p.headers.authorization, /^vapid t=.+, k=/);
  pushed.length = 0;
  await cron(t0 + 30000);
  assert.equal(pushed.length, 0, 'consecutive crons: no double fire');
  // Re-PUT the same rules right after: already-sent occurrences don't come back.
  await put(a, [daily('every', t0), once('single', t0 + 60000), once('later', t0 + 3600000)]);
  await cron(t0 + 40000);
  assert.equal(pushed.length, 0, 're-sync does not re-send');
  // Missed cron: the next run 10 minutes late still sends "single".
  await cron(t0 + 11 * 60000);
  assert.deepEqual(pushed.map((x) => x.payload.id), ['single'], 'missed cron within 15 min still fires');
  // A cron gap longer than 15 min: "later" is skipped (not sent late), and the rule is done.
  pushed.length = 0;
  await cron(t0 + 3600000 + 20 * 60000);
  assert.ok(!pushed.some((x) => x.payload.id === 'later'), 'late occurrence not sent');
  assert.equal((await db.prepare("SELECT next_at FROM rules WHERE rule_id = 'later'").first()).next_at, null);
  // Daily rule keeps firing weeks later with no new PUT (simulated time).
  pushed.length = 0;
  for (let day = 1; day <= 35; day++) await cron(t0 + day * 86400000);
  assert.equal(pushed.filter((x) => x.payload.id === 'every').length, 35, 'fires every day for 35 days without a new PUT');
  // Find day 35's push by its tag (other devices' pushes can come after it in the same run).
  const day35 = pushed.find((x) => x.payload.tag === `p:t:every:${keyOf(t0 + 35 * 86400000)}`);
  assert.equal(day35?.payload.url, `./#open/task/p/every/${keyOf(t0 + 35 * 86400000)}`);
  // 410 from the push service removes the device and its rules.
  pushStatus = 410;
  await cron(t0 + 36 * 86400000);
  pushStatus = 201;
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM devices WHERE id IN (?, ?)').bind(a.deviceId, b.deviceId).first()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM rules').first()).n, 0);
});

test('moving a reminder later after it fired re-arms it (sent-marker is tied to the fire time)', async () => {
  const db = await mf.getD1Database('DB');
  await db.prepare('DELETE FROM rules').run();
  const d = await register('move1', '2.2.2.2');
  const t0 = minute(Date.now()) + 2 * 60000;
  const put = (rules) => call('PUT', '/api/schedule', { body: { tz: TZ, rules }, token: d.token, device: d.deviceId });
  await put([once('mv', t0), daily('mvd', t0)]);
  pushed.length = 0;
  await cron(t0);
  assert.deepEqual(pushed.map((p) => p.payload.id).sort(), ['mv', 'mvd']);
  // Same time re-synced: still not repeated.
  await put([once('mv', t0), daily('mvd', t0)]);
  pushed.length = 0;
  await cron(t0 + 60000);
  assert.equal(pushed.length, 0, 'unchanged time: no repeat');
  // Task moved 10 minutes later (same day): the marker for the old time must not block the new one.
  const t1 = t0 + 10 * 60000;
  await put([once('mv', t1), daily('mvd', t1)]);
  const row = await db.prepare("SELECT next_at FROM rules WHERE rule_id = 'mv'").first();
  assert.equal(row.next_at, t1, 're-armed for the new time');
  pushed.length = 0;
  await cron(t1);
  assert.deepEqual(pushed.map((p) => p.payload.id).sort(), ['mv', 'mvd'], 'fires again at the new time');
  pushed.length = 0;
  await cron(t1 + 60000);
  assert.equal(pushed.length, 0, 'and only once');
  // Moved to another date: fires there too.
  const t2 = t0 + 2 * 86400000;
  await put([once('mv', t2)]);
  pushed.length = 0;
  await cron(t2);
  assert.deepEqual(pushed.map((p) => p.payload.id), ['mv']);
  // Legacy markers (at = send time, up to 15 min after the fire time) still suppress a repeat.
  await db.prepare('DELETE FROM fired WHERE device_id = ?').bind(d.deviceId).run();
  await db.prepare("INSERT INTO fired (device_id, rule_id, date, at) VALUES (?, 'leg', ?, ?)").bind(d.deviceId, keyOf(t0), t0 + 30000).run();
  await put([once('leg', t0)]);
  assert.equal((await db.prepare("SELECT next_at FROM rules WHERE rule_id = 'leg'").first()).next_at, null, 'legacy marker still counts');
});

test('cron: at most 10 per device and 200 in all per run, the rest next minute', async () => {
  const db = await mf.getD1Database('DB');
  await db.prepare('DELETE FROM rules').run();
  const t0 = minute(Date.now()) + 2 * 60000;
  const devs = [];
  for (let i = 0; i < 30; i++) devs.push(await register('batch' + i, '9.9.' + i + '.1'));
  for (const d of devs) await call('PUT', '/api/schedule', { body: { tz: TZ, rules: Array.from({ length: 12 }, (_, j) => once('b' + j, t0)) }, token: d.token, device: d.deviceId });
  pushed.length = 0;
  await cron(t0);
  assert.equal(pushed.length, 200);
  await cron(t0 + 60000);
  assert.equal(pushed.length, 360, 'everything sent by the next run (still within 15 min)');
  for (const d of devs) await call('DELETE', '/api/device', { token: d.token, device: d.deviceId });
});

test('subscription update and device delete', async () => {
  const d = await register('rot');
  const fresh = subscription('rot2');
  assert.equal((await call('POST', '/api/subscription', { body: { subscription: fresh }, token: d.token, device: d.deviceId })).status, 200);
  const db = await mf.getD1Database('DB');
  assert.equal((await db.prepare('SELECT endpoint FROM devices WHERE id = ?').bind(d.deviceId).first()).endpoint, fresh.endpoint);
  await call('PUT', '/api/schedule', { body: { tz: TZ, rules: [daily('z', Date.now() + 120000)] }, token: d.token, device: d.deviceId });
  assert.equal((await call('DELETE', '/api/device', { token: d.token, device: d.deviceId })).status, 200);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM rules WHERE device_id = ?').bind(d.deviceId).first()).n, 0);
  assert.equal((await call('DELETE', '/api/device', { token: d.token, device: d.deviceId })).status, 401);
});

test('daily purge removes old send records and devices unseen for 180 days', async () => {
  const db = await mf.getD1Database('DB');
  const d = await register('old', '8.8.8.8');
  const keep = await register('recent', '8.8.8.8');
  const now = Date.now();
  await call('PUT', '/api/schedule', { body: { tz: TZ, rules: [daily('x', now + 120000)] }, token: d.token, device: d.deviceId });
  await db.prepare("INSERT INTO fired (device_id, rule_id, date, at) VALUES (?, 'x', '2026-01-01', ?)").bind(keep.deviceId, now - 5 * 86400000).run();
  await db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').bind(now - 181 * 86400000, d.deviceId).run();
  await db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').bind(now - 100 * 86400000, keep.deviceId).run();
  const at3 = new Date(now); at3.setUTCHours(3, 0, 0, 0);
  await cron(at3.getTime() + (at3.getTime() < now ? 86400000 : 0));
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM rules WHERE device_id = ?').bind(d.deviceId).first()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM devices WHERE id = ?').bind(d.deviceId).first()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM devices WHERE id = ?').bind(keep.deviceId).first()).n, 1, 'inactive 100 days: kept (no expiry from inactivity)');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM fired WHERE device_id = ?').bind(keep.deviceId).first()).n, 0);
});

test('register needs the register key, and only push-service endpoints are accepted', async () => {
  const sub = subscription('rk');
  assert.equal((await call('POST', '/api/register', { body: { subscription: sub }, key: null, headers: { 'CF-Connecting-IP': '3.3.3.3' } })).status, 403, 'no key');
  assert.equal((await call('POST', '/api/register', { body: { subscription: sub }, key: 'wrong', headers: { 'CF-Connecting-IP': '3.3.3.3' } })).status, 403, 'wrong key');
  // A spoofed Origin alone is not enough any more.
  assert.equal((await call('POST', '/api/register', { body: { subscription: sub }, key: null, origin: ORIGIN, headers: { 'CF-Connecting-IP': '3.3.3.4' } })).status, 403);
  const bad = async (endpoint, why) => {
    const s = { ...subscription('x'), endpoint };
    assert.equal((await call('POST', '/api/register', { body: { subscription: s }, headers: { 'CF-Connecting-IP': '4.4.4.' + Math.floor(Math.random() * 250) } })).status, 400, why);
  };
  await bad('https://evil.example/push', 'arbitrary host');
  await bad('http://fcm.googleapis.com/fcm/send/x', 'not https');
  await bad('https://fcm.googleapis.com:8443/fcm/send/x', 'port');
  await bad('https://user:pw@fcm.googleapis.com/fcm/send/x', 'userinfo');
  await bad('https://127.0.0.1/x', 'IP');
  await bad('https://[::1]/x', 'IPv6');
  await bad('https://fcm.googleapis.com.evil.example/x', 'suffix trick');
  await bad('https://evilpush.apple.com/x', 'no dot boundary');
  await bad('https://push.apple.com/x', 'bare suffix');
  const { isPushServiceUrl } = await import('../src/index.js');
  for (const ok of ['https://fcm.googleapis.com/fcm/send/a', 'https://updates.push.services.mozilla.com/wpush/v2/a', 'https://web.push.apple.com/Q', 'https://wns2-by3p.notify.windows.com/w/?token=a', 'https://autopush.push.services.mozilla.com/x']) assert.ok(isPushServiceUrl(ok), ok);
});

test('register is refused (503) when REGISTER_KEY is not set, and health says so', async () => {
  const mf2 = new Miniflare({
    modules: true, modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    scriptPath: new URL('../src/index.js', import.meta.url).pathname, compatibilityDate: '2026-07-01', d1Databases: ['DB'],
    bindings: { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: 'not-a-key', ALLOWED_ORIGINS: ORIGIN },
  });
  try {
    const res = await mf2.dispatchFetch('https://x/api/register', { method: 'POST', headers: { Origin: ORIGIN, 'X-Register-Key': 'anything' }, body: '{}' });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /not set up/);
    const h = await (await mf2.dispatchFetch('https://x/api/health')).json();
    assert.deepEqual([h.ok, h.registerKey, h.vapidPrivate, h.db], [false, false, false, false], 'no key, bad private key, no tables');
  } finally { await mf2.dispose(); }
});

test('device cap (MAX_DEVICES)', async () => {
  const mf3 = new Miniflare({
    modules: true, modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    scriptPath: new URL('../src/index.js', import.meta.url).pathname, compatibilityDate: '2026-07-01', d1Databases: ['DB'],
    bindings: { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, ALLOWED_ORIGINS: ORIGIN, REGISTER_KEY, MAX_DEVICES: '2' },
  });
  try {
    const db3 = await mf3.getD1Database('DB');
    for (const st of readFileSync(new URL('../schema.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean)) await db3.prepare(st).run();
    const reg = (i) => mf3.dispatchFetch('https://x/api/register', { method: 'POST', headers: { Origin: ORIGIN, 'X-Register-Key': REGISTER_KEY, 'CF-Connecting-IP': '5.5.5.' + i }, body: JSON.stringify({ subscription: subscription('cap' + i) }) });
    assert.equal((await reg(1)).status, 201);
    assert.equal((await reg(2)).status, 201);
    const third = await reg(3);
    assert.equal(third.status, 503);
    assert.match((await third.json()).error, /Device limit/);
  } finally { await mf3.dispose(); }
});

test('fair cron: 8 flooding devices × 500 rules cannot starve one real reminder', async () => {
  const db = await mf.getD1Database('DB');
  await db.prepare('DELETE FROM rules').run();
  const t0 = minute(Date.now()) + 3 * 60000;
  const attackers = [];
  for (let i = 0; i < 8; i++) attackers.push(await register('flood' + i, '10.0.0.' + i));
  for (const a of attackers) {
    const res = await call('PUT', '/api/schedule', { body: { tz: TZ, rules: Array.from({ length: 500 }, (_, j) => once('f' + j, t0 - 60000)) }, token: a.token, device: a.deviceId });
    assert.equal(res.status, 200);
  }
  const real = await register('owner', '10.0.1.1');
  await call('PUT', '/api/schedule', { body: { tz: TZ, rules: [once('dentist', t0)] }, token: real.token, device: real.deviceId });
  pushed.length = 0;
  await cron(t0);
  assert.ok(pushed.some((p) => p.payload.id === 'dentist'), 'the real reminder is sent on time');
  assert.ok(pushed.length <= 200, 'overall cap kept');
  const perDevice = new Map();
  for (const p of pushed) perDevice.set(p.url, (perDevice.get(p.url) || 0) + 1);
  assert.ok(Math.max(...perDevice.values()) <= 10, 'at most 10 per device per run');
  for (const a of attackers) await call('DELETE', '/api/device', { token: a.token, device: a.deviceId });
});

test('rate limits: register per IP', async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await call('POST', '/api/register', { body: { subscription: subscription('rl' + i) }, headers: { 'CF-Connecting-IP': '7.7.7.7' } });
  assert.equal(last.status, 429);
  assert.equal((await call('POST', '/api/register', { body: { subscription: subscription('rl-other') }, headers: { 'CF-Connecting-IP': '6.6.6.6' } })).status, 201);
});

test('encrypted reminder text: the server stores and sends only ciphertext; the 0003 migration wipes old plaintext', async () => {
  const db = await mf.getD1Database('DB');
  await db.prepare('DELETE FROM rules').run();
  const d = await register('enc1');
  const t0 = minute(Date.now()) + 2 * 60000;
  const secret = 'Dentist – Maria Gonzalez';
  // Plaintext from an old client is refused with a clear message, nothing is stored.
  let res = await call('PUT', '/api/schedule', { body: { tz: TZ, rules: [{ ...once('old', t0), enc: undefined, title: secret, body: 'x' }] }, token: d.token, device: d.deviceId });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /must be encrypted/);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM rules WHERE device_id = ?').bind(d.deviceId).first()).n, 0);
  // Ciphertext is accepted and stored verbatim; the stored definition holds no readable text fields.
  res = await call('PUT', '/api/schedule', { body: { tz: TZ, rules: [once('c1', t0), once('c2', t0)] }, token: d.token, device: d.deviceId });
  assert.equal(res.status, 200);
  const row = await db.prepare('SELECT def FROM rules WHERE device_id = ? AND rule_id = ?').bind(d.deviceId, 'c1').first();
  const def = JSON.parse(row.def);
  assert.equal(def.enc, encOf('c1'));
  assert.ok(!('title' in def) && !('body' in def), 'no title/body stored');
  // A row left over from before 1.18.0 (plaintext): the migration removes the text; it then fires a generic payload, never the old text.
  const old = { ...JSON.parse((await db.prepare('SELECT def FROM rules WHERE device_id = ? AND rule_id = ?').bind(d.deviceId, 'c2').first()).def), title: secret, body: 'Body' }; delete old.enc;
  await db.prepare('UPDATE rules SET def = ? WHERE device_id = ? AND rule_id = ?').bind(JSON.stringify(old), d.deviceId, 'c2').run();
  const sql = readFileSync(new URL('../migrations/0003_encrypted_reminders.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '').trim().replace(/;$/, '');
  await db.prepare(sql).run();
  const dump = JSON.stringify((await db.prepare('SELECT def FROM rules').all()).results);
  assert.ok(!dump.includes('Maria') && !dump.includes('Dentist'), 'no plaintext left in D1 after the migration');
  assert.equal(JSON.parse((await db.prepare('SELECT def FROM rules WHERE device_id = ? AND rule_id = ?').bind(d.deviceId, 'c1').first()).def).enc, encOf('c1'), 'encrypted rules untouched');
  pushed.length = 0;
  await cron(t0);
  const mine = pushed.filter((p) => ['c1', 'c2'].includes(p.payload?.id) || p.payload?.url?.includes('/c2/'));
  const c1 = pushed.find((p) => p.payload?.id === 'c1');
  assert.deepEqual(c1.payload, { enc: encOf('c1'), id: 'c1', url: `./#open/task/p/c1/${keyOf(t0)}`, tag: `p:t:c1:${keyOf(t0)}` }, 'push payload carries ciphertext, not text');
  const c2 = pushed.find((p) => p.payload?.url?.includes('/c2/'));
  assert.ok(c2 && !('enc' in c2.payload) && !('title' in c2.payload) && !JSON.stringify(c2.payload).includes('Dentist'), 'a rule without ciphertext sends no text at all (the app shows a generic reminder)');
  assert.ok(mine.length >= 1);
});
