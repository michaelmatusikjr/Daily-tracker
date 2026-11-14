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
const vapid = webpush.generateVAPIDKeys();
const pushed = [];        // requests received by the fake push service
let pushStatus = 201;     // what the fake push service answers
let mf;

const receivers = new Map();
function subscription(name) {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const endpoint = `https://push.example.net/send/${name}`;
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
    bindings: { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:test@example.com', ALLOWED_ORIGINS: `${ORIGIN}, http://localhost:8080` },
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

const call = (method, path, { body, token, device, origin = ORIGIN, headers = {} } = {}) => mf.dispatchFetch('https://push.local' + path, {
  method,
  headers: {
    ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json',
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
const once = (id, at, extra = {}) => ({ id, kind: 'task', title: 'Title ' + id, body: 'Body', url: `./#open/task/p/${id}/{date}`, tag: `p:t:${id}:{date}`, time: hmOf(at), recur: { type: 'none' }, date: keyOf(at), ...extra });
const daily = (id, at, extra = {}) => ({ ...once(id, at), recur: { type: 'daily', start: keyOf(at) }, date: undefined, ...extra });
const minute = (ms) => Math.floor(ms / 60000) * 60000;

test('health, CORS and origin checks', async () => {
  const h = await call('GET', '/api/health', { origin: null });
  assert.equal(h.status, 200);
  assert.equal((await h.json()).ok, true);
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
  await bad([once('a', now, { title: '' })], 'empty title');
  await bad([once('a', now, { title: 'x'.repeat(121) })], 'long title');
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
  assert.deepEqual(pushed.map((p) => p.payload.title).sort(), ['Title b-daily', 'Title every']);
  const p = pushed.find((x) => x.payload.title === 'Title every');
  assert.deepEqual(p.payload, { title: 'Title every', body: 'Body', url: `./#open/task/p/every/${keyOf(t0)}`, tag: `p:t:every:${keyOf(t0)}` });
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
  assert.deepEqual(pushed.map((x) => x.payload.title), ['Title single'], 'missed cron within 15 min still fires');
  // A cron gap longer than 15 min: "later" is skipped (not sent late), and the rule is done.
  pushed.length = 0;
  await cron(t0 + 3600000 + 20 * 60000);
  assert.ok(!pushed.some((x) => x.payload.title === 'Title later'), 'late occurrence not sent');
  assert.equal((await db.prepare("SELECT next_at FROM rules WHERE rule_id = 'later'").first()).next_at, null);
  // Daily rule keeps firing weeks later with no new PUT (simulated time).
  pushed.length = 0;
  for (let day = 1; day <= 35; day++) await cron(t0 + day * 86400000);
  assert.equal(pushed.filter((x) => x.payload.title === 'Title every').length, 35, 'fires every day for 35 days without a new PUT');
  assert.equal(pushed.at(-1).payload.url, `./#open/task/p/every/${keyOf(t0 + 35 * 86400000)}`);
  // 410 from the push service removes the device and its rules.
  pushStatus = 410;
  await cron(t0 + 36 * 86400000);
  pushStatus = 201;
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM devices WHERE id IN (?, ?)').bind(a.deviceId, b.deviceId).first()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM rules').first()).n, 0);
});

test('cron sends at most one batch per run', async () => {
  const db = await mf.getD1Database('DB');
  await db.prepare('DELETE FROM rules').run();
  const d = await register('batch', '9.9.9.9');
  const t0 = minute(Date.now()) + 2 * 60000;
  await call('PUT', '/api/schedule', { body: { tz: TZ, rules: Array.from({ length: 250 }, (_, i) => once('b' + i, t0)) }, token: d.token, device: d.deviceId });
  pushed.length = 0;
  await cron(t0);
  assert.equal(pushed.length, 200);
  await cron(t0 + 60000);
  assert.equal(pushed.length, 250);
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

test('rate limits: register per IP', async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await call('POST', '/api/register', { body: { subscription: subscription('rl' + i) }, headers: { 'CF-Connecting-IP': '7.7.7.7' } });
  assert.equal(last.status, 429);
  assert.equal((await call('POST', '/api/register', { body: { subscription: subscription('rl-other') }, headers: { 'CF-Connecting-IP': '6.6.6.6' } })).status, 201);
});
