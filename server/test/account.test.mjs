// Accounts and sync (SYNC.md) end to end in Miniflare (workerd + local D1): create / login /
// recover / password / logout / delete, sessions, rate limits, latest-wins push/pull with seq,
// limits, CORS, and WebAuthn with software ES256 and RS256 authenticators built on node:crypto.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';

const ORIGIN = 'https://app.example.org';
const RP_ID = 'app.example.org';
const REGISTER_KEY = 'test-register-key-0123456789';
const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean);
let mf, db;
let ipN = 0;
const freshIp = () => `20.${(ipN >> 8) & 255}.${ipN & 255}.${(ipN++ % 250) + 1}`;

async function start(extra = {}) {
  const bindings = { ALLOWED_ORIGINS: `${ORIGIN}, http://localhost:8080`, REGISTER_KEY, MAX_ACCOUNTS: '100', ...extra };
  for (const k of Object.keys(bindings)) if (bindings[k] === undefined) delete bindings[k];
  const m = new Miniflare({
    modules: true,
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    scriptPath: new URL('../src/index.js', import.meta.url).pathname,
    compatibilityDate: '2026-07-01',
    d1Databases: ['DB'],
    bindings,
  });
  const d = await m.getD1Database('DB');
  for (const stmt of SCHEMA) await d.prepare(stmt).run();
  return { m, d };
}
before(async () => { ({ m: mf, d: db } = await start()); });
after(async () => { await mf?.dispose(); });

const b64u = (b) => Buffer.from(b).toString('base64url');
const rnd = (n) => b64u(crypto.randomBytes(n));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

function call(method, path, { body, token, origin = ORIGIN, ip, headers = {}, key, raw, m = mf } = {}) {
  return m.dispatchFetch('https://push.local' + path, {
    method,
    headers: {
      ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json', 'CF-Connecting-IP': ip || freshIp(),
      ...(key ? { 'X-Register-Key': key } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers,
    },
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
}
const send = async (...a) => { const r = await call(...a); return { status: r.status, body: await r.json(), headers: r.headers }; };

let userN = 0;
function newUser(name) {
  return { username: name || `user${++userN}`, authKey: rnd(32), recAuth: rnd(32), wrappedPw: rnd(60), wrappedRec: rnd(60), deviceName: 'iPhone' };
}
async function createAccount(u = newUser(), opts = {}) {
  const r = await send('POST', '/api/account/create', { body: u, key: REGISTER_KEY, ...opts });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...u, ...r.body };
}

test('create: register key, validation, verifier only, duplicate username, CORS and now', async () => {
  const u = newUser('Alice.Smith');
  assert.equal((await send('POST', '/api/account/create', { body: u })).status, 403, 'no register key');
  assert.equal((await send('POST', '/api/account/create', { body: u, key: 'wrong' })).status, 403, 'wrong register key');
  const bad = async (patch, why) => {
    const r = await send('POST', '/api/account/create', { body: { ...u, ...patch }, key: REGISTER_KEY });
    assert.equal(r.status, 400, why);
    assert.equal(typeof r.body.now, 'number', 'errors carry now');
  };
  await bad({ username: 'ab' }, 'short username');
  await bad({ username: 'a'.repeat(41) }, 'long username');
  await bad({ username: 'bad name' }, 'space in username');
  await bad({ username: 'émile' }, 'non-ascii username');
  await bad({ authKey: rnd(31) }, 'authKey 31 bytes');
  await bad({ authKey: rnd(32) + '=' }, 'authKey with padding');
  await bad({ authKey: rnd(32).replace(/.$/, '+') }, 'authKey not base64url');
  await bad({ recAuth: 'x' }, 'bad recAuth');
  await bad({ wrappedPw: rnd(61) }, 'wrappedPw 61 bytes');
  await bad({ wrappedRec: rnd(59) }, 'wrappedRec 59 bytes');
  await bad({ deviceName: 'x'.repeat(61) }, 'long deviceName');
  await bad({ deviceName: '' }, 'empty deviceName');
  await bad({ deviceName: 'a\nb' }, 'control character in deviceName');
  assert.equal((await send('POST', '/api/account/create', { raw: '{bad', key: REGISTER_KEY })).status, 400, 'bad JSON');
  assert.equal((await send('POST', '/api/account/create', { body: { ...u, pad: 'x'.repeat(9000) }, key: REGISTER_KEY })).status, 413, 'too large');

  const r = await send('POST', '/api/account/create', { body: u, key: REGISTER_KEY });
  assert.equal(r.status, 201);
  assert.match(r.body.accountId, /^[A-Za-z0-9_-]{22}$/);
  assert.match(r.body.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(r.body.username, 'alice.smith', 'stored lower-case');
  assert.ok(Math.abs(r.body.now - Date.now()) < 60000, 'now in the response');
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const row = await db.prepare('SELECT * FROM accounts WHERE id = ?').bind(r.body.accountId).first();
  assert.equal(row.username, 'alice.smith');
  const expect = crypto.createHmac('sha256', Buffer.from(row.auth_salt, 'base64url')).update(Buffer.from(u.authKey, 'base64url')).digest('hex');
  assert.equal(row.auth_hash, expect, 'HMAC-SHA-256(salt, authKey) verifier');
  const expectRec = crypto.createHmac('sha256', Buffer.from(row.rec_salt, 'base64url')).update(Buffer.from(u.recAuth, 'base64url')).digest('hex');
  assert.equal(row.rec_hash, expectRec, 'HMAC-SHA-256(salt, recAuth) verifier');
  assert.notEqual(row.auth_salt, row.rec_salt, 'separate salts');
  assert.equal(Buffer.from(row.auth_salt, 'base64url').length, 16, 'random 16-byte salt');
  assert.ok(!JSON.stringify(row).includes(u.authKey) && !JSON.stringify(row).includes(u.recAuth), 'secrets not stored');
  const sess = await db.prepare('SELECT * FROM sessions WHERE account_id = ?').bind(r.body.accountId).first();
  assert.equal(sess.token_hash, sha256(r.body.token).toString('hex'), 'only the token hash is stored');
  const dup = await send('POST', '/api/account/create', { body: { ...newUser(' ALICE.smith '), }, key: REGISTER_KEY });
  assert.equal(dup.status, 409, 'username taken (case-insensitive)');
  assert.equal(dup.body.error, 'Username is taken');

  // CORS
  const pre = await call('OPTIONS', '/api/account/create');
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  assert.match(pre.headers.get('Access-Control-Allow-Headers'), /X-Register-Key/);
  assert.match(pre.headers.get('Access-Control-Allow-Methods'), /DELETE/);
  const evil = await send('POST', '/api/account/login', { origin: 'https://evil.example', body: {} });
  assert.equal(evil.status, 403);
  assert.equal(typeof evil.body.now, 'number');
  assert.equal((await send('GET', '/api/account', { origin: null })).status, 403, 'no Origin');
});

test('login: same 401 for unknown user and wrong key; success returns wrappedPw and a session', async () => {
  const a = await createAccount();
  const wrong = await send('POST', '/api/account/login', { body: { username: a.username, authKey: rnd(32), deviceName: 'Mac' } });
  const unknown = await send('POST', '/api/account/login', { body: { username: 'nobody-here', authKey: rnd(32), deviceName: 'Mac' } });
  assert.deepEqual([wrong.status, unknown.status], [401, 401]);
  assert.equal(wrong.body.error, 'Wrong username or password');
  assert.equal(unknown.body.error, wrong.body.error);
  assert.equal((await send('POST', '/api/account/login', { body: { username: a.username, authKey: a.authKey } })).status, 400, 'deviceName required');
  const ok = await send('POST', '/api/account/login', { body: { username: a.username.toUpperCase(), authKey: a.authKey, deviceName: 'Mac' } });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.accountId, ok.body.username, ok.body.wrappedPw], [a.accountId, a.username, a.wrappedPw]);
  assert.notEqual(ok.body.token, a.token);
  const acc = await send('GET', '/api/account', { token: ok.body.token });
  assert.equal(acc.status, 200);
  assert.equal(acc.body.sessions.length, 2);
  assert.deepEqual(acc.body.sessions.find((s) => s.current).deviceName, 'Mac');
  assert.equal(typeof acc.body.now, 'number');
  assert.equal((await send('GET', '/api/account', { token: rnd(32) })).status, 401, 'unknown token');
  assert.equal((await send('GET', '/api/account')).status, 401, 'no token');
});

test('rate limits: 10 failures per username, 30 per IP, 5 creates per IP', async () => {
  const a = await createAccount();
  for (let i = 0; i < 10; i++) {
    assert.equal((await send('POST', '/api/account/login', { body: { username: a.username, authKey: rnd(32), deviceName: 'x' } })).status, 401);
  }
  const locked = await send('POST', '/api/account/login', { body: { username: a.username, authKey: a.authKey, deviceName: 'x' } });
  assert.equal(locked.status, 429, 'even the right key is refused once the username is over the limit');
  assert.equal((await send('POST', '/api/account/recover/start', { body: { username: a.username, recAuth: a.recAuth } })).status, 429, 'recovery shares the budget');
  // Per IP: 30 failures on different usernames from one IP.
  const ip = '30.30.30.30';
  for (let i = 0; i < 30; i++) await send('POST', '/api/account/login', { ip, body: { username: 'ghost' + i, authKey: rnd(32), deviceName: 'x' } });
  const b = await createAccount();
  assert.equal((await send('POST', '/api/account/login', { ip, body: { username: b.username, authKey: b.authKey, deviceName: 'x' } })).status, 429);
  assert.equal((await send('POST', '/api/account/login', { body: { username: b.username, authKey: b.authKey, deviceName: 'x' } })).status, 200, 'other IP fine');
  // Successes don't count.
  const c = await createAccount();
  for (let i = 0; i < 12; i++) assert.equal((await send('POST', '/api/account/login', { body: { username: c.username, authKey: c.authKey, deviceName: 'x' } })).status, 200);
  // Create: 5/hour per IP (every attempt counts).
  const cip = '40.40.40.40';
  for (let i = 0; i < 5; i++) assert.notEqual((await send('POST', '/api/account/create', { ip: cip, body: { ...newUser(), username: 'x' }, key: REGISTER_KEY })).status, 429);
  assert.equal((await send('POST', '/api/account/create', { ip: cip, body: newUser(), key: REGISTER_KEY })).status, 429);
});

test('recover: start returns wrappedRec, finish sets the password and signs every other device out', async () => {
  const a = await createAccount();
  const other = (await send('POST', '/api/account/login', { body: { username: a.username, authKey: a.authKey, deviceName: 'iPad' } })).body.token;
  const wrong = await send('POST', '/api/account/recover/start', { body: { username: a.username, recAuth: rnd(32) } });
  assert.equal(wrong.status, 401);
  assert.equal((await send('POST', '/api/account/recover/start', { body: { username: 'nobody-x', recAuth: rnd(32) } })).body.error, wrong.body.error, 'same error for unknown user');
  const st = await send('POST', '/api/account/recover/start', { body: { username: a.username, recAuth: a.recAuth } });
  assert.equal(st.status, 200);
  assert.equal(st.body.wrappedRec, a.wrappedRec);
  assert.equal(typeof st.body.now, 'number');
  const newAuthKey = rnd(32), newWrappedPw = rnd(60);
  assert.equal((await send('POST', '/api/account/recover/finish', { body: { username: a.username, recAuth: rnd(32), newAuthKey, newWrappedPw, deviceName: 'Mac' } })).status, 401);
  assert.equal((await send('POST', '/api/account/recover/finish', { body: { username: a.username, recAuth: a.recAuth, newAuthKey, deviceName: 'Mac' } })).status, 400, 'newWrappedPw required');
  const fin = await send('POST', '/api/account/recover/finish', { body: { username: a.username, recAuth: a.recAuth, newAuthKey, newWrappedPw, deviceName: 'Mac' } });
  assert.equal(fin.status, 200);
  assert.equal(fin.body.accountId, a.accountId);
  assert.equal((await send('GET', '/api/account', { token: a.token })).status, 401, 'old session ended');
  assert.equal((await send('GET', '/api/account', { token: other })).status, 401, 'other session ended');
  const me = await send('GET', '/api/account', { token: fin.body.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.sessions.length, 1);
  assert.equal((await send('POST', '/api/account/login', { body: { username: a.username, authKey: a.authKey, deviceName: 'x' } })).status, 401, 'old password no longer works');
  const li = await send('POST', '/api/account/login', { body: { username: a.username, authKey: newAuthKey, deviceName: 'x' } });
  assert.equal(li.status, 200);
  assert.equal(li.body.wrappedPw, newWrappedPw);
});

test('password change, logout, sign out another device, session expiry', async () => {
  const a = await createAccount();
  const newAuthKey = rnd(32), newWrappedPw = rnd(60);
  const other1 = await send('POST', '/api/account/login', { body: { username: a.username, authKey: a.authKey, deviceName: 'Old tablet' } });
  assert.equal(other1.status, 200);
  const w = await send('POST', '/api/account/password', { token: a.token, body: { authKey: rnd(32), newAuthKey, newWrappedPw } });
  assert.equal(w.status, 403, 'wrong current password is 403 (session still valid)');
  assert.equal(w.body.error, 'Wrong password');
  assert.equal((await send('POST', '/api/account/password', { token: a.token, body: { authKey: a.authKey, newAuthKey: 'x', newWrappedPw } })).status, 400);
  assert.equal((await send('POST', '/api/account/password', { body: { authKey: a.authKey, newAuthKey, newWrappedPw } })).status, 401, 'needs a session');
  const ok = await send('POST', '/api/account/password', { token: a.token, body: { authKey: a.authKey, newAuthKey, newWrappedPw } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal((await send('GET', '/api/account', { token: other1.body.token })).status, 401, 'a password change ends every other session');
  assert.equal((await send('GET', '/api/account', { token: a.token })).status, 200, 'this session stays');
  assert.equal((await send('POST', '/api/account/login', { body: { username: a.username, authKey: a.authKey, deviceName: 'x' } })).status, 401);
  const b = await send('POST', '/api/account/login', { body: { username: a.username, authKey: newAuthKey, deviceName: 'Laptop' } });
  assert.equal(b.body.wrappedPw, newWrappedPw);

  // Sign out another device by its session id.
  const list = (await send('GET', '/api/account', { token: a.token })).body.sessions;
  const laptop = list.find((s) => s.deviceName === 'Laptop');
  assert.equal(list.find((s) => s.current).deviceName, 'iPhone');
  assert.ok(list.every((s) => !('token' in s) && !('tokenHash' in s)));
  assert.equal((await send('DELETE', '/api/account/session/' + rnd(16), { token: a.token })).status, 404);
  const other = await createAccount();
  assert.equal((await send('DELETE', '/api/account/session/' + laptop.id, { token: other.token })).status, 404, 'cannot touch another account');
  const del = await send('DELETE', '/api/account/session/' + laptop.id, { token: a.token });
  assert.equal(del.status, 200);
  assert.equal((await send('GET', '/api/account', { token: b.body.token })).status, 401);
  // Logout ends this session.
  assert.equal((await send('POST', '/api/account/logout', { token: a.token })).status, 200);
  assert.equal((await send('GET', '/api/account', { token: a.token })).status, 401);

  // Expiry: unused for 400 days; last_seen is written at most hourly.
  const c = await createAccount();
  const h = sha256(c.token).toString('hex');
  await db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').bind(Date.now() - 30 * 60000, h).run();
  await send('GET', '/api/account', { token: c.token });
  assert.ok((await db.prepare('SELECT last_seen FROM sessions WHERE token_hash = ?').bind(h).first()).last_seen < Date.now() - 20 * 60000, 'not rewritten within the hour');
  await db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').bind(Date.now() - 2 * 3600000, h).run();
  await send('GET', '/api/account', { token: c.token });
  assert.ok((await db.prepare('SELECT last_seen FROM sessions WHERE token_hash = ?').bind(h).first()).last_seen > Date.now() - 60000, 'refreshed after an hour');
  await db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').bind(Date.now() - 401 * 86400000, h).run();
  assert.equal((await send('GET', '/api/account', { token: c.token })).status, 401, 'expired after 400 days');
  assert.equal(await db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').bind(h).first(), null, 'expired session removed');
});

// ---------- Sync ----------
const rec = (rid, t, dev, size = 64) => ({ rid, t, dev, blob: rnd(size) });

test('sync: latest (t, dev) wins, seq increases, pull since/limit/more', async () => {
  const a = await createAccount();
  const push = (records, token = a.token) => send('POST', '/api/sync/push', { token, body: { records } });
  const pull = (q, token = a.token) => send('GET', '/api/sync/pull' + q, { token });
  assert.equal((await send('POST', '/api/sync/push', { body: { records: [] } })).status, 401);
  assert.equal((await send('GET', '/api/sync/pull?since=0')).status, 401);
  const empty = await pull('?since=0');
  assert.deepEqual([empty.status, empty.body.records, empty.body.seq, empty.body.more], [200, [], 0, false]);
  assert.equal(typeof empty.body.now, 'number');

  const A = rnd(32), B = rnd(32), C = rnd(32);
  const devX = 'A' + rnd(16).slice(1), devY = 'B' + rnd(16).slice(1); // devY > devX as strings
  const t0 = Date.now() - 10000;
  const r1 = rec(A, t0, devX), r2 = rec(B, t0, devX);
  let p = await push([r1, r2]);
  assert.equal(p.status, 200);
  assert.deepEqual([p.body.accepted, p.body.stale], [2, []]);
  assert.equal(typeof p.body.now, 'number');
  const seq1 = p.body.seq;
  assert.ok(seq1 >= 2);

  // Older edit: stale. Same (t, dev): stale. Same t, greater dev: wins. Newer t: wins.
  p = await push([rec(A, t0 - 1, devY), rec(B, t0, devX)]);
  assert.deepEqual([p.body.accepted, p.body.stale.sort()], [0, [A, B].sort()]);
  const rA = rec(A, t0, devY), rB = rec(B, t0 + 5, devX);
  p = await push([rA, rB, rec(C, t0, devX)]);
  assert.equal(p.body.accepted, 3);
  // Duplicates within one push: the latest one is kept.
  const rC = rec(C, t0 + 9, devX);
  p = await push([rec(C, t0 + 2, devX), rC, rec(C, t0 + 3, devY)]);
  assert.equal(p.body.accepted, 1);

  const all = await pull('?since=0');
  assert.equal(all.body.records.length, 3);
  const byRid = Object.fromEntries(all.body.records.map((r) => [r.rid, r]));
  assert.deepEqual([byRid[A].blob, byRid[A].dev, byRid[A].t], [rA.blob, devY, t0]);
  assert.equal(byRid[B].blob, rB.blob);
  assert.equal(byRid[C].blob, rC.blob);
  const seqs = all.body.records.map((r) => r.seq);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), 'ordered by seq');
  assert.equal(new Set(seqs).size, 3, 'unique seq per record');
  assert.equal(all.body.seq, p.body.seq, 'cursor = account seq');
  assert.equal(all.body.more, false);
  assert.ok(byRid[C].seq > byRid[A].seq, 'the later write has the higher seq');

  const none = await pull('?since=' + all.body.seq);
  assert.deepEqual([none.body.records.length, none.body.seq, none.body.more], [0, all.body.seq, false]);
  const after = await pull('?since=' + byRid[A].seq);
  assert.ok(after.body.records.every((r) => r.seq > byRid[A].seq) && after.body.records.length === 2);

  // Paging.
  const page1 = await pull('?since=0&limit=2');
  assert.deepEqual([page1.body.records.length, page1.body.more], [2, true]);
  const page2 = await pull(`?since=${page1.body.seq}&limit=2`);
  assert.deepEqual([page2.body.records.length, page2.body.more], [1, false]);
  assert.deepEqual([...page1.body.records, ...page2.body.records].map((r) => r.rid).sort(), [A, B, C].sort());

  // Accounts are isolated.
  const other = await createAccount();
  assert.equal((await pull('?since=0', other.token)).body.records.length, 0);
  const op = await push([rec(A, t0 + 100, devX)], other.token);
  assert.equal(op.body.accepted, 1, 'same rid in another account is a separate record');
  assert.equal((await pull('?since=0')).body.records.find((r) => r.rid === A).blob, rA.blob);

  // Validation.
  const bad = async (records, why) => assert.equal((await push(records)).status, 400, why);
  await bad([rec('short', t0, devX)], 'bad rid');
  await bad([rec(rnd(31), t0, devX)], 'rid 31 bytes');
  await bad([rec(A, t0, 'x')], 'bad dev');
  await bad([rec(A, Date.now() + 2 * 86400000, devX)], 't more than a day ahead');
  await bad([rec(A, -1, devX)], 'negative t');
  await bad([rec(A, 1.5, devX)], 'fractional t');
  await bad([{ ...rec(A, t0, devX), blob: 'not base64!' }], 'bad blob');
  await bad([{ ...rec(A, t0, devX), blob: 'AAAA' }], 'blob too short');
  await bad([{ ...rec(A, t0, devX), blob: 'A'.repeat(256 * 1024 + 4) }], 'blob too large');
  await bad(Array.from({ length: 501 }, () => rec(rnd(32), t0, devX, 30)), 'too many records');
  assert.equal((await send('POST', '/api/sync/push', { token: a.token, body: { records: 'x' } })).status, 400);
  assert.equal((await send('POST', '/api/sync/push', { token: a.token, raw: JSON.stringify({ records: [], pad: 'x'.repeat(4 * 1024 * 1024) }) })).status, 413, 'body over 4 MB');
  assert.equal((await pull('?since=-1')).status, 400);
  assert.equal((await pull('?since=abc')).status, 400);
  assert.equal((await pull('?since=0&limit=1001')).status, 400);
  assert.equal((await pull('?since=0&limit=0')).status, 400);
  assert.ok((await push(Array.from({ length: 500 }, () => rec(rnd(32), t0, devX, 30)))).body.accepted === 500, '500 records accepted');
  const counted = await db.prepare('SELECT records, bytes FROM accounts WHERE id = ?').bind(a.accountId).first();
  const real = await db.prepare('SELECT COUNT(*) AS n, SUM(length(blob)) AS b FROM records WHERE account_id = ?').bind(a.accountId).first();
  assert.deepEqual([counted.records, counted.bytes], [real.n, real.b], 'record and byte counters match the table');
});

test('sync: big pages are split by size; storage limits give 413 but shrinking writes still go through', async () => {
  const a = await createAccount();
  const dev = rnd(16);
  const t = Date.now();
  const big = () => Array.from({ length: 8 }, () => rec(rnd(32), t, dev, 190000)); // ~253k chars each
  for (let i = 0; i < 3; i++) assert.equal((await send('POST', '/api/sync/push', { token: a.token, body: { records: big() } })).body.accepted, 8);
  let since = 0, pages = 0, got = 0, more = true;
  while (more) {
    const r = await send('GET', '/api/sync/pull?since=' + since, { token: a.token });
    assert.ok(r.body.records.reduce((n, x) => n + x.blob.length, 0) <= 4 * 1024 * 1024, 'page within 4 MB of blobs');
    got += r.body.records.length; since = r.body.seq; more = r.body.more; pages++;
  }
  assert.equal(got, 24);
  assert.ok(pages >= 2, 'split into pages');

  // Limits: records count and bytes (counters set close to the limit).
  const b = await createAccount();
  const R = rnd(32);
  assert.equal((await send('POST', '/api/sync/push', { token: b.token, body: { records: [rec(R, t, dev, 1000)] } })).body.accepted, 1);
  await db.prepare('UPDATE accounts SET records = 200000 WHERE id = ?').bind(b.accountId).run();
  const full = await send('POST', '/api/sync/push', { token: b.token, body: { records: [rec(rnd(32), t, dev)] } });
  assert.equal(full.status, 413);
  assert.equal(full.body.error, 'Account storage is full');
  assert.equal((await send('POST', '/api/sync/push', { token: b.token, body: { records: [rec(R, t + 1, dev, 100)] } })).body.accepted, 1, 'updating an existing record (smaller) still works');
  await db.prepare('UPDATE accounts SET records = 1, bytes = ? WHERE id = ?').bind(200 * 1024 * 1024 - 50, b.accountId).run();
  assert.equal((await send('POST', '/api/sync/push', { token: b.token, body: { records: [rec(R, t + 2, dev, 200)] } })).status, 413, 'bytes limit');
  assert.equal((await send('POST', '/api/sync/push', { token: b.token, body: { records: [rec(R, t + 3, dev, 60)] } })).body.accepted, 1, 'a smaller (tombstone) write still goes through');
});

test('sync: concurrent pushes from two devices keep seqs unique and counters exact', async () => {
  const a = await createAccount();
  const b = (await send('POST', '/api/account/login', { body: { username: a.username, authKey: a.authKey, deviceName: 'iPad' } })).body;
  const shared = Array.from({ length: 20 }, () => rnd(32));
  const t = Date.now();
  const mk = (dev, dt) => shared.map((rid) => rec(rid, t + dt, dev)).concat(Array.from({ length: 30 }, () => rec(rnd(32), t, dev)));
  const devA = 'A' + rnd(16).slice(1), devB = 'B' + rnd(16).slice(1);
  const [pa, pb] = await Promise.all([
    send('POST', '/api/sync/push', { token: a.token, body: { records: mk(devA, 0) } }),
    send('POST', '/api/sync/push', { token: b.token, body: { records: mk(devB, 0) } }),
  ]);
  assert.deepEqual([pa.status, pb.status], [200, 200]);
  const all = (await send('GET', '/api/sync/pull?since=0&limit=1000', { token: a.token })).body.records;
  assert.equal(all.length, 80);
  assert.equal(new Set(all.map((r) => r.seq)).size, 80, 'unique seqs');
  assert.ok(all.filter((r) => shared.includes(r.rid)).every((r) => r.dev === devB), 'same t: the greater dev wins whatever the order');
  const counted = await db.prepare('SELECT records, bytes FROM accounts WHERE id = ?').bind(a.accountId).first();
  const real = await db.prepare('SELECT COUNT(*) AS n, SUM(length(blob)) AS b FROM records WHERE account_id = ?').bind(a.accountId).first();
  assert.deepEqual([counted.records, counted.bytes], [real.n, real.b]);
});

test('sync: rate limits per account (push 600/h, pull 1200/h)', async () => {
  const a = await createAccount();
  const win = Math.floor(Date.now() / 3600000);
  await db.prepare('INSERT OR REPLACE INTO rate (key, win, count) VALUES (?, ?, 600)').bind('push:' + a.accountId, win).run();
  await db.prepare('INSERT OR REPLACE INTO rate (key, win, count) VALUES (?, ?, 1200)').bind('pull:' + a.accountId, win).run();
  assert.equal((await send('POST', '/api/sync/push', { token: a.token, body: { records: [] } })).status, 429);
  const r = await send('GET', '/api/sync/pull?since=0', { token: a.token });
  assert.equal(r.status, 429);
  assert.equal(typeof r.body.now, 'number');
});

test('delete account: needs the password; removes records, passkeys, sessions', async () => {
  const a = await createAccount();
  await send('POST', '/api/sync/push', { token: a.token, body: { records: [rec(rnd(32), Date.now(), rnd(16))] } });
  await db.prepare("INSERT INTO passkeys (id, account_id, alg, jwk, name, created_at) VALUES (?, ?, -7, '{}', 'x', 0)").bind(rnd(16), a.accountId).run();
  assert.equal((await send('DELETE', '/api/account', { token: a.token, body: { authKey: rnd(32) } })).status, 403);
  assert.equal((await send('DELETE', '/api/account', { token: a.token, body: {} })).status, 400);
  const ok = await send('DELETE', '/api/account', { token: a.token, body: { authKey: a.authKey } });
  assert.equal(ok.status, 200);
  for (const [t, col] of [['accounts', 'id'], ['sessions', 'account_id'], ['passkeys', 'account_id'], ['records', 'account_id']]) {
    assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?`).bind(a.accountId).first()).n, 0, t);
  }
  assert.equal((await send('GET', '/api/account', { token: a.token })).status, 401);
  assert.equal((await send('POST', '/api/account/login', { body: { username: a.username, authKey: a.authKey, deviceName: 'x' } })).status, 401);
  // The username is free again.
  await createAccount({ ...newUser(a.username) });
});

// ---------- WebAuthn (software authenticators) ----------
function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const s = Buffer.from(v); return Buffer.concat([head(3, s.length), s]); }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const entries = v instanceof Map ? [...v] : Object.entries(v);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

class SoftAuthenticator {
  constructor(alg) {
    this.alg = alg;
    this.credId = crypto.randomBytes(20);
    this.id = b64u(this.credId);
    this.counter = 0;
    if (alg === -7) {
      this.keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const j = this.keys.publicKey.export({ format: 'jwk' });
      this.cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(j.x, 'base64url')], [-3, Buffer.from(j.y, 'base64url')]]);
    } else {
      this.keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const j = this.keys.publicKey.export({ format: 'jwk' });
      this.cose = new Map([[1, 3], [3, -257], [-1, Buffer.from(j.n, 'base64url')], [-2, Buffer.from(j.e, 'base64url')]]);
    }
  }
  authData({ rpId = RP_ID, flags, attested }) {
    const cnt = Buffer.alloc(4); cnt.writeUInt32BE(this.counter);
    const parts = [sha256(rpId), Buffer.from([flags]), cnt];
    if (attested) { const len = Buffer.alloc(2); len.writeUInt16BE(this.credId.length); parts.push(Buffer.alloc(16), len, this.credId, cbor(this.cose)); }
    return Buffer.concat(parts);
  }
  clientData(type, challenge, origin) { return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })); }
  /** navigator.credentials.create() result, JSON-serialised. */
  create(options, { origin = ORIGIN, rpId = options.rp.id, flags = 0x45, type = 'webauthn.create', challenge = options.challenge } = {}) {
    const ad = this.authData({ rpId, flags, attested: true });
    return {
      id: this.id, rawId: this.id, type: 'public-key',
      response: { clientDataJSON: b64u(this.clientData(type, challenge, origin)), attestationObject: b64u(cbor({ fmt: 'none', attStmt: {}, authData: ad })) },
    };
  }
  /** navigator.credentials.get() result, JSON-serialised. */
  get(options, { origin = ORIGIN, rpId = options.rpId, flags = 0x05, step = 1, tamper = false, userHandle, challenge = options.challenge } = {}) {
    this.counter += step;
    const ad = this.authData({ rpId, flags });
    const cdj = this.clientData('webauthn.get', challenge, origin);
    let sig = crypto.sign('sha256', Buffer.concat([ad, sha256(cdj)]), this.keys.privateKey); // EC: DER, RSA: PKCS#1 v1.5
    if (tamper) { sig = Buffer.from(sig); sig[sig.length - 5] ^= 1; }
    return { id: this.id, rawId: this.id, type: 'public-key', response: { clientDataJSON: b64u(cdj), authenticatorData: b64u(ad), signature: b64u(sig), userHandle } };
  }
}

async function registerPasskey(a, auth, { wrappedPrf, name = 'iPhone passkey', origin = ORIGIN } = {}) {
  const o = await send('POST', '/api/passkey/register/options', { token: a.token, origin });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  return { o, r: await send('POST', '/api/passkey/register', { token: a.token, origin, body: { challengeId: o.body.challengeId, credential: auth.create(o.body.options, { origin }), name, wrappedPrf } }) };
}
async function passkeyLogin(auth, opts = {}, { origin = ORIGIN, deviceName = 'Phone' } = {}) {
  const o = await send('POST', '/api/passkey/login/options', { origin });
  assert.equal(o.status, 200);
  return send('POST', '/api/passkey/login', { origin, body: { challengeId: o.body.challengeId, credential: auth.get(o.body.options, { origin, ...opts }), deviceName } });
}

for (const [label, alg] of [['ES256', -7], ['RS256', -257]]) {
  test(`passkeys (${label}): register options, register with PRF wrap, sign in, attach PRF, remove`, async () => {
    const a = await createAccount();
    const auth = new SoftAuthenticator(alg);
    const wrappedPrf = rnd(60);
    const { o, r } = await registerPasskey(a, auth, { wrappedPrf });
    const opt = o.body.options;
    assert.equal(typeof o.body.now, 'number');
    assert.deepEqual(opt.rp, { id: RP_ID, name: 'Daily Tracker' });
    assert.equal(opt.user.id, a.accountId);
    assert.equal(opt.user.name, a.username);
    assert.deepEqual(opt.pubKeyCredParams.map((p) => p.alg), [-7, -257]);
    assert.equal(opt.attestation, 'none');
    assert.deepEqual([opt.authenticatorSelection.residentKey, opt.authenticatorSelection.userVerification], ['required', 'required']);
    assert.deepEqual(opt.excludeCredentials, []);
    assert.equal(Buffer.from(opt.challenge, 'base64url').length, 32);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.ok, r.body.id], [true, auth.id]);
    const row = await db.prepare('SELECT * FROM passkeys WHERE id = ?').bind(auth.id).first();
    assert.equal(row.alg, alg);
    assert.equal(row.wrapped_prf, wrappedPrf);
    const acc = (await send('GET', '/api/account', { token: a.token })).body;
    assert.deepEqual(acc.passkeys.map((p) => [p.id, p.name, p.prf]), [[auth.id, 'iPhone passkey', true]]);

    // Replay of the same registration (challenge used up) and a second registration of the same credential.
    const again = await send('POST', '/api/passkey/register', { token: a.token, body: { challengeId: o.body.challengeId, credential: auth.create(opt), name: 'x' } });
    assert.equal(again.status, 400);
    assert.equal(again.body.error, 'Wrong or expired challenge');
    const o2 = await send('POST', '/api/passkey/register/options', { token: a.token });
    assert.deepEqual(o2.body.options.excludeCredentials, [{ type: 'public-key', id: auth.id }]);
    const dup = await send('POST', '/api/passkey/register', { token: a.token, body: { challengeId: o2.body.challengeId, credential: auth.create(o2.body.options), name: 'x' } });
    assert.equal(dup.status, 409);

    // Sign in.
    const li = await passkeyLogin(auth, { userHandle: a.accountId });
    assert.equal(li.status, 200, JSON.stringify(li.body));
    assert.deepEqual([li.body.accountId, li.body.username, li.body.wrappedPrf, li.body.wrappedPw], [a.accountId, a.username, wrappedPrf, a.wrappedPw]);
    assert.equal(typeof li.body.now, 'number');
    assert.equal((await send('GET', '/api/account', { token: li.body.token })).status, 200, 'a working session');
    assert.equal((await db.prepare('SELECT sign_count FROM passkeys WHERE id = ?').bind(auth.id).first()).sign_count, auth.counter);

    // Login options shape.
    const lo = await send('POST', '/api/passkey/login/options');
    assert.deepEqual([lo.body.options.rpId, lo.body.options.allowCredentials, lo.body.options.userVerification], [RP_ID, [], 'required']);

    // PRF attach / passkey without PRF.
    const auth2 = new SoftAuthenticator(alg);
    assert.equal((await registerPasskey(a, auth2, { name: 'Mac' })).r.status, 200);
    const li2 = await passkeyLogin(auth2);
    assert.equal(li2.body.wrappedPrf, null, 'no PRF wrap yet');
    const w2 = rnd(60);
    assert.equal((await send('POST', '/api/passkey/prf', { token: a.token, body: { id: auth2.id, wrappedPrf: w2 } })).status, 200);
    assert.equal((await passkeyLogin(auth2)).body.wrappedPrf, w2);
    assert.equal((await send('POST', '/api/passkey/prf', { token: a.token, body: { id: auth2.id, wrappedPrf: rnd(61) } })).status, 400);
    const stranger = await createAccount();
    assert.equal((await send('POST', '/api/passkey/prf', { token: stranger.token, body: { id: auth2.id, wrappedPrf: w2 } })).status, 404, "can't touch another account's passkey");
    assert.equal((await send('DELETE', '/api/passkey/' + auth2.id, { token: stranger.token })).status, 404);

    // Remove.
    assert.equal((await send('DELETE', '/api/passkey/' + auth2.id, { token: a.token })).status, 200);
    const gone = await passkeyLogin(auth2);
    assert.equal(gone.status, 401);
    assert.equal(gone.body.error, 'Unknown passkey');
  });

  test(`passkeys (${label}): replayed challenge, wrong origin, wrong rpIdHash, missing UV, bad signature, sign-count regression`, async () => {
    const a = await createAccount();
    const auth = new SoftAuthenticator(alg);
    assert.equal((await registerPasskey(a, auth)).r.status, 200);
    const expectFail = async (res, status, re, why) => { const r = await res; assert.equal(r.status, status, why + ': ' + JSON.stringify(r.body)); if (re) assert.match(r.body.error, re, why); };

    // Registration checks.
    const regTry = async (opts, why, re) => {
      const o = await send('POST', '/api/passkey/register/options', { token: a.token });
      const other = new SoftAuthenticator(alg);
      await expectFail(send('POST', '/api/passkey/register', { token: a.token, body: { challengeId: o.body.challengeId, credential: other.create(o.body.options, opts), name: 'x' } }), 400, re, why);
    };
    await regTry({ origin: 'https://evil.example' }, 'register: wrong origin', /origin/i);
    await regTry({ rpId: 'evil.example' }, 'register: wrong rpIdHash', /relying party/);
    await regTry({ flags: 0x41 }, 'register: missing UV', /verification/);
    await regTry({ flags: 0x44 }, 'register: missing UP', /presence/);
    await regTry({ type: 'webauthn.get' }, 'register: wrong type', /type/);
    await regTry({ challenge: rnd(32) }, 'register: wrong challenge', /challenge/);
    {
      // A login challenge can't be used to register; a register challenge is bound to its account.
      const lo = await send('POST', '/api/passkey/login/options');
      await expectFail(send('POST', '/api/passkey/register', { token: a.token, body: { challengeId: lo.body.challengeId, credential: new SoftAuthenticator(alg).create({ ...lo.body.options, rp: { id: RP_ID } }), name: 'x' } }), 400, /challenge/, 'login challenge used to register');
      const b = await createAccount();
      const o = await send('POST', '/api/passkey/register/options', { token: b.token });
      await expectFail(send('POST', '/api/passkey/register', { token: a.token, body: { challengeId: o.body.challengeId, credential: new SoftAuthenticator(alg).create(o.body.options), name: 'x' } }), 400, /challenge/, "another account's challenge");
      // Expired challenge.
      const o3 = await send('POST', '/api/passkey/register/options', { token: a.token });
      await db.prepare('UPDATE challenges SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, o3.body.challengeId).run();
      await expectFail(send('POST', '/api/passkey/register', { token: a.token, body: { challengeId: o3.body.challengeId, credential: new SoftAuthenticator(alg).create(o3.body.options), name: 'x' } }), 400, /expired/, 'expired challenge');
      assert.equal((await send('POST', '/api/passkey/register/options')).status, 401, 'register needs a session');
    }

    // Sign-in checks.
    await expectFail(passkeyLogin(auth, { origin: 'https://evil.example' }), 401, /origin/i, 'login: wrong origin in client data');
    await expectFail(passkeyLogin(auth, { rpId: 'evil.example' }), 401, /relying party/, 'login: wrong rpIdHash');
    await expectFail(passkeyLogin(auth, { flags: 0x01 }), 401, /verification/, 'login: missing UV');
    await expectFail(passkeyLogin(auth, { tamper: true }), 401, /signature/i, 'login: bad signature');
    await expectFail(passkeyLogin(auth, { challenge: rnd(32) }), 401, /challenge/, 'login: wrong challenge');
    await expectFail(passkeyLogin(auth, { userHandle: rnd(16) }), 401, null, 'login: userHandle of another account');
    // Replay: the same assertion twice.
    const o = await send('POST', '/api/passkey/login/options');
    const cred = auth.get(o.body.options);
    assert.equal((await send('POST', '/api/passkey/login', { body: { challengeId: o.body.challengeId, credential: cred, deviceName: 'x' } })).status, 200);
    await expectFail(send('POST', '/api/passkey/login', { body: { challengeId: o.body.challengeId, credential: cred, deviceName: 'x' } }), 400, /challenge/, 'replayed challenge');
    // Sign count regression (a cloned authenticator): count goes down / stays equal.
    assert.equal((await passkeyLogin(auth, { step: 5 })).status, 200);
    await expectFail(passkeyLogin(auth, { step: -3 }), 401, /sign count/, 'sign count went down');
    auth.counter += 2; // back to the stored value - 1, next get adds 1 → equal
    await expectFail(passkeyLogin(auth, { step: 1 }), 401, /sign count/, 'sign count did not increase');
    assert.equal((await passkeyLogin(auth, { step: 1 })).status, 200, 'an increasing count is fine again');
    // An authenticator that always reports 0 is fine.
    const zero = new SoftAuthenticator(alg);
    assert.equal((await registerPasskey(a, zero)).r.status, 200);
    assert.equal((await passkeyLogin(zero, { step: 0 })).status, 200);
    assert.equal((await passkeyLogin(zero, { step: 0 })).status, 200);
    // Another allowed origin gets its own rpId; a credential made for one rpId doesn't work on the other.
    const local = new SoftAuthenticator(alg);
    const reg = await registerPasskey(a, local, { origin: 'http://localhost:8080' });
    assert.equal(reg.o.body.options.rp.id, 'localhost');
    assert.equal(reg.r.status, 200, JSON.stringify(reg.r.body));
    assert.equal((await passkeyLogin(local, {}, { origin: 'http://localhost:8080' })).status, 200);
    await expectFail(passkeyLogin(local, { origin: ORIGIN, rpId: 'localhost' }, { origin: ORIGIN }), 401, /relying party/, 'rpId of another origin');
  });
}

test('passkey login options are rate limited per IP', async () => {
  const ip = '50.50.50.50';
  for (let i = 0; i < 30; i++) assert.equal((await send('POST', '/api/passkey/login/options', { ip })).status, 200);
  assert.equal((await send('POST', '/api/passkey/login/options', { ip })).status, 429);
});

test('webauthn helpers: CBOR, DER → raw, COSE checks', async () => {
  const { cborDecode, derToRaw, coseToJwk } = await import('../src/webauthn.js');
  const v = cborDecode(new Uint8Array(cbor({ a: [1, -2, 'x', new Uint8Array([9])], b: 70000 }))).value;
  assert.deepEqual(v.get('a').slice(0, 3), [1, -2, 'x']);
  assert.equal(v.get('b'), 70000);
  assert.throws(() => cborDecode(new Uint8Array([0x5f])), /indefinite/);
  assert.throws(() => cborDecode(new Uint8Array([0x45, 1, 2])), /truncated/);
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  for (let i = 0; i < 20; i++) {
    const der = crypto.sign('sha256', Buffer.from('m' + i), privateKey);
    const raw = derToRaw(new Uint8Array(der));
    const p1363 = crypto.sign('sha256', Buffer.from('m' + i), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    assert.equal(raw.length, 64);
    assert.ok(crypto.verify('sha256', Buffer.from('m' + i), { key: privateKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(raw)), 'raw signature verifies');
    assert.equal(p1363.length, 64);
  }
  assert.throws(() => derToRaw(new Uint8Array([0x30, 2, 2, 0])), /signature/);
  assert.throws(() => coseToJwk(new Map([[1, 2], [3, -8]])), /Unsupported/);
  assert.throws(() => coseToJwk(new Map([[1, 3], [3, -257], [-1, new Uint8Array(128)], [-2, new Uint8Array([1, 0, 1])]])), /2048/);
});

test('purge removes expired challenges and sessions unused for 400 days', async () => {
  const a = await createAccount();
  await send('POST', '/api/passkey/login/options');
  const h = sha256(a.token).toString('hex');
  const at = new Date(Date.now() + 2 * 86400000); at.setUTCHours(3, 0, 0, 0);
  await db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').bind(at.getTime() - 401 * 86400000, h).run();
  const w = await mf.getWorker();
  await w.scheduled({ scheduledTime: at, cron: '* * * * *' });
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM challenges WHERE expires_at < ?').bind(at.getTime()).first()).n, 0);
  assert.equal(await db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').bind(h).first(), null);
});

test('MAX_ACCOUNTS cap and missing REGISTER_KEY', async () => {
  const { m } = await start({ MAX_ACCOUNTS: '2' });
  try {
    for (let i = 0; i < 2; i++) assert.equal((await call('POST', '/api/account/create', { m, body: newUser(), key: REGISTER_KEY })).status, 201);
    const r = await call('POST', '/api/account/create', { m, body: newUser(), key: REGISTER_KEY });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, 'Account limit reached');
  } finally { await m.dispose(); }
  const { m: m2 } = await start({ REGISTER_KEY: undefined });
  try {
    const r = await call('POST', '/api/account/create', { m: m2, body: newUser(), key: 'x' });
    assert.equal(r.status, 503);
  } finally { await m2.dispose(); }
});
