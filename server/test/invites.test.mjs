// Invite codes (backlog #35) in Miniflare: owner create/list/revoke, check, account creation with a code
// (single use, atomic, expiry, revocation), /api/register with an account session, rate limits, no leaks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';

const ORIGIN = 'https://app.example.org';
const KEY = 'test-register-key-0123456789';
const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean);
let mf, db, ipN = 0;
const freshIp = () => `30.${(ipN >> 8) & 255}.${ipN & 255}.${(ipN++ % 250) + 1}`;
before(async () => {
  mf = new Miniflare({
    modules: true, modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    scriptPath: new URL('../src/index.js', import.meta.url).pathname, compatibilityDate: '2026-07-01', d1Databases: ['DB'],
    bindings: { ALLOWED_ORIGINS: ORIGIN, REGISTER_KEY: KEY, MAX_ACCOUNTS: '100', MAX_DEVICES: '100' },
  });
  db = await mf.getD1Database('DB');
  for (const s of SCHEMA) await db.prepare(s).run();
});
after(async () => { await mf?.dispose(); });

const rnd = (n) => crypto.randomBytes(n).toString('base64url');
async function send(method, path, { body, key, invite, token, ip = freshIp(), origin = ORIGIN } = {}) {
  const r = await mf.dispatchFetch('https://push.local' + path, {
    method,
    headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...(key ? { 'X-Register-Key': key } : {}), ...(invite ? { 'X-Invite-Code': invite } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
let n = 0;
const newUser = () => ({ username: `friend${++n}`, authKey: rnd(32), recAuth: rnd(32), wrappedPw: rnd(60), wrappedRec: rnd(60), deviceName: 'iPhone' });
const mk = async (name) => (await send('POST', '/api/invites', { key: KEY, body: { name } })).body;
const create = (u, code) => send('POST', '/api/account/create', { body: u, invite: code });

test('owner: create needs the register key; code format, entropy, hash-only storage', async () => {
  assert.equal((await send('POST', '/api/invites', { body: {} })).status, 403);
  assert.equal((await send('POST', '/api/invites', { key: 'nope', body: {} })).status, 403);
  assert.equal((await send('POST', '/api/invites', { key: KEY, body: { name: 'x'.repeat(41) } })).status, 400);
  const r = await send('POST', '/api/invites', { key: KEY, body: { name: '  Sam ' } });
  assert.equal(r.status, 201);
  assert.match(r.body.code, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/, 'unambiguous alphabet, 8 symbols');
  assert.equal(r.body.name, 'Sam');
  assert.equal(r.body.expiresAt - r.body.createdAt, 30 * 86400000, '30-day expiry');
  assert.equal(typeof r.body.now, 'number');
  const rows = (await db.prepare('SELECT * FROM invites').all()).results;
  const row = rows.find((x) => x.id === r.body.id);
  assert.ok(row);
  assert.ok(!JSON.stringify(row).includes(r.body.code.replace('-', '')), 'the code is not stored');
  assert.match(row.code_hash, /^[0-9a-f]{64}$/);
  const codes = new Set();
  for (let i = 0; i < 20; i++) codes.add((await mk('')).code);
  assert.equal(codes.size, 20, 'codes are random');
});

test('owner: list shows status and username, never the code; revoke only unused', async () => {
  assert.equal((await send('GET', '/api/invites')).status, 403);
  const a = await mk('A'), b = await mk('B');
  const u = newUser();
  assert.equal((await create(u, a.code)).status, 201);
  const l = await send('GET', '/api/invites', { key: KEY });
  assert.equal(l.status, 200);
  assert.ok(!JSON.stringify(l.body).includes(a.code));
  const la = l.body.invites.find((x) => x.id === a.id), lb = l.body.invites.find((x) => x.id === b.id);
  assert.deepEqual([la.status, la.username, typeof la.usedAt], ['used', u.username, 'number']);
  assert.deepEqual([lb.status, lb.username, lb.name], ['unused', null, 'B']);
  assert.equal((await send('DELETE', '/api/invites/' + a.id)).status, 403, 'needs key');
  assert.equal((await send('DELETE', '/api/invites/' + a.id, { key: KEY })).status, 200, 'a used invite can be revoked (list only)');
  const la2 = (await send('GET', '/api/invites', { key: KEY })).body.invites.find((x) => x.id === a.id);
  assert.deepEqual([la2.status, la2.username, typeof la2.usedAt], ['revoked', u.username, 'number'], 'still shows who used it');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE username = ?').bind(u.username).first()).n, 1, 'the friend\'s account is untouched');
  assert.equal((await send('DELETE', '/api/invites/' + a.id, { key: KEY })).status, 200, 'revoking again is fine (idempotent)');
  assert.equal((await send('DELETE', '/api/invites/nosuchid', { key: KEY })).status, 404);
  assert.equal((await send('DELETE', '/api/invites/' + b.id, { key: KEY })).status, 200);
  assert.equal((await send('GET', '/api/invites', { key: KEY })).body.invites.find((x) => x.id === b.id).status, 'revoked');
  const r = await create(newUser(), b.code);
  assert.equal(r.status, 403, 'revoked code is unusable');
  assert.equal(r.body.error, 'Invalid or expired invite code');
});

test('create with a code: single use, normalisation, same error for every bad code, register key still works', async () => {
  const inv = await mk('C');
  const typed = inv.code.toLowerCase().replace('-', ' ');
  const u = newUser();
  const ok = await create(u, typed);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.ok(ok.body.token && ok.body.accountId);
  const row = await db.prepare('SELECT used_at, account_id FROM invites WHERE id = ?').bind(inv.id).first();
  assert.equal(row.account_id, ok.body.accountId);
  assert.ok(row.used_at);
  // the session works
  assert.equal((await send('GET', '/api/sync/pull?since=0', { token: ok.body.token })).status < 500, true);
  const again = await create(newUser(), inv.code);
  const unknown = await create(newUser(), 'ZZZZ-ZZZZ');
  const garbage = await create(newUser(), 'hello');
  for (const r of [again, unknown, garbage]) { assert.equal(r.status, 403); assert.equal(r.body.error, 'Invalid or expired invite code'); }
  assert.equal((await send('POST', '/api/account/create', { body: newUser(), key: KEY })).status, 201, 'register key path unchanged');
  assert.equal((await send('POST', '/api/account/create', { body: newUser() })).status, 403);
  const k2 = await mk('');
  assert.equal((await send('POST', '/api/account/create', { body: newUser(), key: 'wrong', invite: k2.code })).status, 403, 'a wrong key does not fall back to the code');
});

test('a failed creation never spends the code (taken username, bad body, account limit)', async () => {
  const taken = newUser();
  assert.equal((await send('POST', '/api/account/create', { body: taken, key: KEY })).status, 201);
  const inv = await mk('D');
  assert.equal((await create({ ...newUser(), username: taken.username }, inv.code)).status, 409);
  assert.equal((await create({ ...newUser(), authKey: 'short' }, inv.code)).status, 400);
  assert.equal((await db.prepare('SELECT used_at FROM invites WHERE id = ?').bind(inv.id).first()).used_at, null);
  assert.equal((await create(newUser(), inv.code)).status, 201, 'still usable afterwards');
});

test('concurrent use: one account, one winner; the loser leaves no account behind', async () => {
  const inv = await mk('Race');
  const users = [newUser(), newUser(), newUser(), newUser()];
  const rs = await Promise.all(users.map((u) => create(u, inv.code)));
  assert.equal(rs.filter((r) => r.status === 201).length, 1, JSON.stringify(rs.map((r) => r.status)));
  assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.status === 403));
  const made = (await db.prepare('SELECT username FROM accounts WHERE username IN (?, ?, ?, ?)').bind(...users.map((u) => u.username)).all()).results;
  assert.equal(made.length, 1);
  const sess = (await db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE account_id = (SELECT id FROM accounts WHERE username = ?)').bind(made[0].username).first()).c;
  assert.equal(sess, 1);
});

test('expiry: a code is refused after 30 days, and check says invalid', async () => {
  const inv = await mk('Old');
  await db.prepare('UPDATE invites SET expires_at = ? WHERE id = ?').bind(Date.now() - 1000, inv.id).run();
  assert.equal((await create(newUser(), inv.code)).status, 403);
  assert.deepEqual((await send('POST', '/api/invites/check', { body: { code: inv.code } })).body.valid, false);
  const l = await send('GET', '/api/invites', { key: KEY });
  assert.equal(l.body.invites.find((x) => x.id === inv.id).status, 'expired');
});

test('check: valid/invalid only, no key needed, does not use the code, rate limited per IP', async () => {
  const inv = await mk('E');
  const ip = freshIp();
  const ok = await send('POST', '/api/invites/check', { body: { code: inv.code }, ip });
  assert.deepEqual([ok.status, ok.body.valid], [200, true]);
  assert.deepEqual(Object.keys(ok.body).sort(), ['now', 'valid'], 'nothing else leaks');
  assert.equal((await send('POST', '/api/invites/check', { body: { code: inv.code }, ip })).body.valid, true, 'not consumed');
  for (const bad of ['ZZZZ-ZZZZ', '', 5, null, 'x'.repeat(100)]) {
    const r = await send('POST', '/api/invites/check', { body: { code: bad }, ip });
    assert.deepEqual([r.status, r.body.valid], [200, false]);
  }
  let last;
  for (let i = 0; i < 20; i++) last = await send('POST', '/api/invites/check', { body: { code: 'ZZZZ-ZZZZ' }, ip });
  assert.equal(last.status, 429);
});

test('owner calls: wrong keys are rate limited (10/hour/IP), even a right key is then refused', async () => {
  const ip = freshIp();
  for (let i = 0; i < 10; i++) assert.equal((await send('GET', '/api/invites', { key: 'wrong' + i, ip })).status, 403);
  assert.equal((await send('GET', '/api/invites', { key: KEY, ip })).status, 429);
});

test('open invites are capped at 50', async () => {
  await db.prepare('DELETE FROM invites').run();
  const ip = freshIp();
  for (let i = 0; i < 50; i++) assert.equal((await send('POST', '/api/invites', { key: KEY, body: {}, ip: freshIp() })).status, 201);
  assert.equal((await send('POST', '/api/invites', { key: KEY, body: {}, ip })).status, 409);
});

test('/api/register accepts a signed-in account session instead of the register key', async () => {
  const acc = (await send('POST', '/api/account/create', { body: newUser(), key: KEY })).body;
  const sub = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: {
      p256dh: Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)]).toString('base64url'), auth: rnd(16),
    },
  };
  assert.equal((await send('POST', '/api/register', { body: { subscription: sub } })).status, 403, 'nothing');
  assert.equal((await send('POST', '/api/register', { body: { subscription: sub }, token: rnd(32) })).status, 401, 'bad session');
  assert.equal((await send('POST', '/api/register', { body: { subscription: sub }, token: acc.token, key: 'wrong' })).status, 403, 'wrong key is not rescued by a session');
  const r = await send('POST', '/api/register', { body: { subscription: sub }, token: acc.token });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.deviceId && r.body.token);
  const r2 = await send('POST', '/api/register', { body: { subscription: sub }, key: KEY });
  assert.equal(r2.status, 201, 'register key path unchanged');
});

test('CORS: invites calls need an allowed origin; X-Invite-Code is an allowed header', async () => {
  assert.equal((await send('POST', '/api/invites/check', { body: { code: 'x' }, origin: 'https://evil.example' })).status, 403);
  const pre = await mf.dispatchFetch('https://push.local/api/account/create', { method: 'OPTIONS', headers: { Origin: ORIGIN } });
  assert.match(pre.headers.get('Access-Control-Allow-Headers'), /X-Invite-Code/);
});

const subFor = (i) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/cap${i}-${rnd(6)}`, keys: { p256dh: Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)]).toString('base64url'), auth: rnd(16) } });

test('invited flag on create/login/GET; per-account device cap of 5; account delete removes its devices', async () => {
  await db.prepare('DELETE FROM invites WHERE used_at IS NULL').run(); // earlier tests left open codes (limit 50)
  const inv = await mk('Cap');
  const u = newUser();
  const c = await create(u, inv.code);
  assert.equal(c.status, 201, JSON.stringify([inv, c.body]));
  assert.equal(c.body.invited, true);
  const lg = await send('POST', '/api/account/login', { body: { username: u.username, authKey: u.authKey, deviceName: 'x' } });
  assert.equal(lg.body.invited, true);
  assert.equal((await send('GET', '/api/account', { token: lg.body.token })).body.invited, true);
  const owner = newUser();
  const oc = await send('POST', '/api/account/create', { body: owner, key: KEY });
  assert.equal(oc.body.invited, false, 'register-key account is not invited');
  assert.equal((await send('GET', '/api/account', { token: oc.body.token })).body.invited, false);

  for (let i = 0; i < 5; i++) assert.equal((await send('POST', '/api/register', { body: { subscription: subFor(i) }, token: c.body.token })).status, 201);
  const sixth = await send('POST', '/api/register', { body: { subscription: subFor(9) }, token: c.body.token });
  assert.equal(sixth.status, 409);
  assert.match(sixth.body.error, /5 devices/);
  // Another account and the register-key path are unaffected.
  assert.equal((await send('POST', '/api/register', { body: { subscription: subFor(10) }, token: oc.body.token })).status, 201);
  assert.equal((await send('POST', '/api/register', { body: { subscription: subFor(11) }, key: KEY })).status, 201);
  const before = await db.prepare('SELECT COUNT(*) n FROM devices WHERE account_id = ?').bind(c.body.accountId).first();
  assert.equal(before.n, 5);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM devices WHERE account_id IS NULL').first()).n >= 1, true);

  const del = await send('DELETE', '/api/account', { token: c.body.token, body: { authKey: u.authKey } });
  assert.equal(del.status, 200);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM devices WHERE account_id = ?').bind(c.body.accountId).first()).n, 0, 'its devices are gone');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM devices WHERE account_id = ?').bind(oc.body.accountId).first()).n, 1, 'other accounts keep theirs');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM devices WHERE account_id IS NULL').first()).n >= 1, true, 'owner devices stay');
});

test('daily purge survives a database without the invites table', async () => {
  const { purge } = await import('../src/index.js');
  const mf2 = new Miniflare({ modules: true, script: 'export default {}', compatibilityDate: '2026-07-01', d1Databases: ['DB'] });
  const db2 = await mf2.getD1Database('DB');
  for (const s of SCHEMA.filter((q) => !/invites/.test(q))) await db2.prepare(s).run();
  await purge({ DB: db2 }, Date.now());
  await mf2.dispose();
});

test('owner: purge deletes a revoked invite for good; anything not revoked is refused', async () => {
  const unused = await mk('U'), used = await mk('Used'), gone = await mk('Gone');
  assert.equal((await create(newUser(), used.code)).status, 201);
  assert.equal((await send('DELETE', '/api/invites/' + gone.id + '?purge=1')).status, 403, 'needs the register key');
  assert.equal((await send('DELETE', '/api/invites/' + unused.id + '?purge=1', { key: KEY })).status, 409, 'unused: revoke it first');
  assert.equal((await send('DELETE', '/api/invites/' + used.id + '?purge=1', { key: KEY })).status, 409, 'used but not revoked: revoke it first');
  const exp = await mk('Exp'); await db.prepare('UPDATE invites SET expires_at = 1 WHERE id = ?').bind(exp.id).run();
  assert.equal((await send('DELETE', '/api/invites/' + exp.id + '?purge=1', { key: KEY })).status, 409, 'expired but not revoked: revoke it first');
  assert.equal((await send('DELETE', '/api/invites/' + exp.id, { key: KEY })).status, 200, 'an expired invite can be revoked');
  assert.equal((await send('DELETE', '/api/invites/' + used.id, { key: KEY })).status, 200, 'a used invite can be revoked');
  assert.equal((await send('DELETE', '/api/invites/' + used.id + '?purge=1', { key: KEY })).status, 200, 'once revoked, a used invite can be deleted from the list');
  assert.equal((await send('DELETE', '/api/invites/nosuchid?purge=1', { key: KEY })).status, 404);
  assert.equal((await send('DELETE', '/api/invites/' + gone.id, { key: KEY })).status, 200, 'revoke');
  assert.equal((await send('DELETE', '/api/invites/' + gone.id + '?purge=1', { key: KEY })).status, 200, 'purge');
  const ids = (await send('GET', '/api/invites', { key: KEY })).body.invites.map((x) => x.id);
  assert.ok(!ids.includes(gone.id) && ids.includes(unused.id) && !ids.includes(used.id), 'revoked rows are gone, the unused one stays');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM invites WHERE id = ?').bind(gone.id).first()).n, 0, 'removed from the database');
  assert.equal((await send('DELETE', '/api/invites/' + gone.id + '?purge=1', { key: KEY })).status, 404, 'already gone');
});
