// Encrypted photo files (SYNC.md › Phase 2: photos) end to end in Miniflare: chunked upload and
// download, chunk validation, all-or-nothing commit, quota (shared with records), auth, isolation
// between accounts, delete, account delete, and the purge of abandoned uploads.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';

const ORIGIN = 'https://app.example.org';
const REGISTER_KEY = 'test-register-key-0123456789';
const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean);
const CHUNK = 512 * 1024;
let mf, db;
let ipN = 0;
const freshIp = () => `30.${(ipN >> 8) & 255}.${ipN & 255}.${(ipN++ % 250) + 1}`;

before(async () => {
  mf = new Miniflare({
    modules: true,
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    scriptPath: new URL('../src/index.js', import.meta.url).pathname,
    compatibilityDate: '2026-07-01',
    d1Databases: ['DB'],
    bindings: { ALLOWED_ORIGINS: ORIGIN, REGISTER_KEY, MAX_ACCOUNTS: '100' },
  });
  db = await mf.getD1Database('DB');
  for (const stmt of SCHEMA) await db.prepare(stmt).run();
  // The schema is safe to run again on a live database.
  for (const stmt of SCHEMA) await db.prepare(stmt).run();
});
after(async () => { await mf?.dispose(); });

const b64u = (b) => Buffer.from(b).toString('base64url');
const rnd = (n) => b64u(crypto.randomBytes(n));
/** base64url text of exactly n characters (n % 4 !== 1). */
const chars = (n) => { const s = b64u(crypto.randomBytes(Math.ceil(n * 3 / 4) + 3)).slice(0, n); return s; };

async function call(method, path, { body, raw, token, origin = ORIGIN, headers = {} } = {}) {
  const r = await mf.dispatchFetch('https://push.local' + path, {
    method,
    headers: {
      ...(origin ? { Origin: origin } : {}), 'CF-Connecting-IP': freshIp(),
      ...(raw !== undefined ? { 'Content-Type': 'text/plain' } : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers,
    },
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
let userN = 0;
async function account() {
  const u = { username: `files${++userN}`, authKey: rnd(32), recAuth: rnd(32), wrappedPw: rnd(60), wrappedRec: rnd(60), deviceName: 'iPhone' };
  const r = await call('POST', '/api/account/create', { body: u, headers: { 'X-Register-Key': REGISTER_KEY } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
const bytesOf = async (aid) => (await db.prepare('SELECT bytes FROM accounts WHERE id = ?1').bind(aid).first()).bytes;

/** Upload `data` as file fid in chunks; returns the commit response. */
async function upload(token, fid, data, { skip = [], commit = true } = {}) {
  const s = await call('POST', '/api/files/upload', { token, body: { fid, size: data.length } });
  if (s.status !== 200 || s.body.have) return s;
  for (let n = 0; n < s.body.chunks; n++) {
    if (skip.includes(n)) continue;
    const r = await call('PUT', `/api/files/upload/${s.body.upload}/${n}`, { token, raw: data.slice(n * CHUNK, (n + 1) * CHUNK) });
    assert.equal(r.status, 200, `chunk ${n}: ${JSON.stringify(r.body)}`);
  }
  if (!commit) return s;
  return { ...(await call('POST', `/api/files/upload/${s.body.upload}/commit`, { token })), upload: s.body.upload };
}
async function download(token, fid) {
  const first = await call('GET', `/api/files/${fid}/0`, { token });
  if (first.status !== 200) return first;
  let data = first.body.data;
  for (let n = 1; n < first.body.chunks; n++) data += (await call('GET', `/api/files/${fid}/${n}`, { token })).body.data;
  return { status: 200, data, size: first.body.size };
}

test('upload / download round trip in chunks; check, list; now in every response; bytes counted', async () => {
  const a = await account();
  const fid = rnd(32);
  const data = chars(CHUNK * 2 + 1234);
  const before = await bytesOf(a.accountId);
  const st = await call('POST', '/api/files/upload', { token: a.token, body: { fid, size: data.length } });
  assert.equal(st.status, 200);
  assert.equal(st.body.chunks, 3);
  assert.equal(typeof st.body.now, 'number');
  // Not visible before the commit.
  for (let n = 0; n < 3; n++) assert.equal((await call('PUT', `/api/files/upload/${st.body.upload}/${n}`, { token: a.token, raw: data.slice(n * CHUNK, (n + 1) * CHUNK) })).status, 200);
  assert.deepEqual((await call('POST', '/api/files/check', { token: a.token, body: { fids: [fid] } })).body.have, [], 'not visible before commit');
  assert.equal((await call('GET', `/api/files/${fid}/0`, { token: a.token })).status, 404);
  const c = await call('POST', `/api/files/upload/${st.body.upload}/commit`, { token: a.token });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(typeof c.body.now, 'number');
  const d = await download(a.token, fid);
  assert.equal(d.data, data, 'round trip');
  assert.equal(await bytesOf(a.accountId), before + data.length, 'file size counted in account bytes');
  const chk = await call('POST', '/api/files/check', { token: a.token, body: { fids: [fid, rnd(32)] } });
  assert.deepEqual(chk.body.have, [fid]);
  const list = await call('GET', '/api/files/list', { token: a.token });
  assert.equal(list.body.files.length, 1);
  assert.equal(list.body.files[0].fid, fid);
  assert.equal(list.body.more, false);
  // Starting again for a stored file: nothing to upload.
  assert.equal((await call('POST', '/api/files/upload', { token: a.token, body: { fid, size: data.length } })).body.have, true);
  const info = await call('GET', '/api/account', { token: a.token });
  assert.equal(info.body.files, 1);
  // Uploads and chunks of the committed file are tidy.
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM file_uploads WHERE account_id = ?1').bind(a.accountId).first()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM file_chunks WHERE account_id = ?1').bind(a.accountId).first()).n, 3);
});

test('validation: fid, size, chunk numbers and exact chunk lengths, base64url only', async () => {
  const a = await account();
  const t = a.token;
  const bad = async (body, why) => assert.equal((await call('POST', '/api/files/upload', { token: t, body })).status, 400, why);
  await bad({ fid: 'short', size: 100 }, 'bad fid');
  await bad({ fid: rnd(32) + '=', size: 100 }, 'padded fid');
  await bad({ fid: rnd(32), size: 10 }, 'too small');
  await bad({ fid: rnd(32), size: 16 * 1024 * 1024 + 4 }, 'too large');
  await bad({ fid: rnd(32), size: 101 }, 'impossible base64 length');
  await bad({ fid: rnd(32), size: '100' }, 'size not a number');
  const data = chars(CHUNK + 100);
  const st = await call('POST', '/api/files/upload', { token: t, body: { fid: rnd(32), size: data.length } });
  const u = st.body.upload;
  assert.equal((await call('PUT', `/api/files/upload/${u}/2`, { token: t, raw: data.slice(0, 100) })).status, 400, 'chunk beyond the file');
  assert.equal((await call('PUT', `/api/files/upload/${u}/0`, { token: t, raw: data.slice(0, CHUNK - 4) })).status, 400, 'short middle chunk');
  assert.equal((await call('PUT', `/api/files/upload/${u}/1`, { token: t, raw: data.slice(CHUNK) + 'AAAA' })).status, 400, 'last chunk too long');
  assert.equal((await call('PUT', `/api/files/upload/${u}/1`, { token: t, raw: data.slice(CHUNK, CHUNK + 99) + '+' })).status, 400, 'not base64url');
  assert.equal((await call('PUT', `/api/files/upload/${u}/0`, { token: t, raw: data.slice(0, CHUNK) + 'A'.repeat(100) })).status, 413, 'an oversized chunk body is refused');
  assert.equal((await call('PUT', `/api/files/upload/${rnd(16)}/0`, { token: t, raw: data.slice(0, CHUNK) })).status, 404, 'unknown upload');
  assert.equal((await call('POST', '/api/files/check', { token: t, body: { fids: ['x'] } })).status, 400, 'check validates fids');
  assert.equal((await call('POST', '/api/files/check', { token: t, body: { fids: Array.from({ length: 1001 }, () => rnd(32)) } })).status, 400, 'check max 1000');
  assert.equal((await call('POST', '/api/files/delete', { token: t, body: { fids: Array.from({ length: 201 }, () => rnd(32)) } })).status, 400, 'delete max 200');
  assert.equal((await call('GET', '/api/files/list?limit=0', { token: t })).status, 400, 'list limit');
  assert.equal((await call('GET', '/api/files/list?after=zz', { token: t })).status, 400, 'list after');
});

test('all-or-nothing: commit refuses a missing chunk; a replaced or abandoned upload never shows', async () => {
  const a = await account();
  const fid = rnd(32);
  const data = chars(CHUNK * 2 + 8);
  const half = await upload(a.token, fid, data, { skip: [1] });
  assert.equal(half.status, 409, 'commit with a missing chunk is refused');
  assert.deepEqual((await call('POST', '/api/files/check', { token: a.token, body: { fids: [fid] } })).body.have, []);
  assert.equal((await call('GET', `/api/files/${fid}/0`, { token: a.token })).status, 404, 'nothing visible');
  const b0 = await bytesOf(a.accountId);
  // Starting the same file again replaces the unfinished upload (its chunks go).
  const full = await upload(a.token, fid, data);
  assert.equal(full.status, 200);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM file_uploads WHERE account_id = ?1').bind(a.accountId).first()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM file_chunks WHERE account_id = ?1').bind(a.accountId).first()).n, 3, 'only the committed chunks remain');
  assert.equal((await download(a.token, fid)).data, data);
  assert.equal(await bytesOf(a.accountId), b0 + data.length);
  // Committing the same upload twice counts once.
  assert.equal((await call('POST', `/api/files/upload/${full.upload}/commit`, { token: a.token })).status, 404);
  assert.equal(await bytesOf(a.accountId), b0 + data.length);
  // Two devices upload the same file at once: one copy, counted once.
  const fid2 = rnd(32), d2 = chars(5000);
  const s1 = await call('POST', '/api/files/upload', { token: a.token, body: { fid: fid2, size: d2.length } });
  const s2b = await call('POST', '/api/files/upload', { token: a.token, body: { fid: fid2, size: d2.length } });
  assert.equal((await call('PUT', `/api/files/upload/${s1.body.upload}/0`, { token: a.token, raw: d2 })).status, 404, 'the first upload was replaced by the second start');
  assert.equal((await call('PUT', `/api/files/upload/${s2b.body.upload}/0`, { token: a.token, raw: d2 })).status, 200);
  const b1 = await bytesOf(a.accountId);
  assert.equal((await call('POST', `/api/files/upload/${s2b.body.upload}/commit`, { token: a.token })).status, 200);
  assert.equal(await bytesOf(a.accountId), b1 + d2.length);
});

test('too many uploads in progress; stale ones make room', async () => {
  const a = await account();
  const ups = [];
  for (let i = 0; i < 8; i++) ups.push((await call('POST', '/api/files/upload', { token: a.token, body: { fid: rnd(32), size: 100 } })).body.upload);
  assert.equal((await call('POST', '/api/files/upload', { token: a.token, body: { fid: rnd(32), size: 100 } })).status, 429);
  await db.prepare('UPDATE file_uploads SET created_at = created_at - 7200000 WHERE account_id = ?1 AND upload = ?2').bind(a.accountId, ups[0]).run();
  assert.equal((await call('POST', '/api/files/upload', { token: a.token, body: { fid: rnd(32), size: 100 } })).status, 200, 'the stale upload is evicted');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM file_uploads WHERE account_id = ?1 AND upload = ?2').bind(a.accountId, ups[0]).first()).n, 0);
});

test('quota: files and records share the 200 MB limit (413), pending uploads count, deletes free space', async () => {
  const a = await account();
  const MAX = 200 * 1024 * 1024;
  await db.prepare('UPDATE accounts SET bytes = ?2 WHERE id = ?1').bind(a.accountId, MAX - 10000).run();
  const big = await call('POST', '/api/files/upload', { token: a.token, body: { fid: rnd(32), size: 10004 } });
  assert.equal(big.status, 413, 'beyond the limit at start');
  assert.equal(big.body.error, 'Account storage is full');
  const f1 = rnd(32), d1 = chars(6000);
  const s1 = await call('POST', '/api/files/upload', { token: a.token, body: { fid: f1, size: d1.length } });
  assert.equal(s1.status, 200);
  assert.equal((await call('POST', '/api/files/upload', { token: a.token, body: { fid: rnd(32), size: 6000 } })).status, 413, 'a pending upload counts');
  await call('PUT', `/api/files/upload/${s1.body.upload}/0`, { token: a.token, raw: d1 });
  // Records filled the rest meanwhile: the commit is refused, nothing appears.
  await db.prepare('UPDATE accounts SET bytes = ?2 WHERE id = ?1').bind(a.accountId, MAX - 100).run();
  assert.equal((await call('POST', `/api/files/upload/${s1.body.upload}/commit`, { token: a.token })).status, 413);
  assert.deepEqual((await call('POST', '/api/files/check', { token: a.token, body: { fids: [f1] } })).body.have, []);
  await db.prepare('UPDATE accounts SET bytes = ?2 WHERE id = ?1').bind(a.accountId, MAX - 10000).run();
  assert.equal((await call('POST', `/api/files/upload/${s1.body.upload}/commit`, { token: a.token })).status, 200, 'commit works once there is room');
  assert.equal(await bytesOf(a.accountId), MAX - 10000 + 6000);
  // A records push that grows the account is refused now too.
  const del = await call('POST', '/api/files/delete', { token: a.token, body: { fids: [f1, rnd(32)] } });
  assert.deepEqual(del.body.deleted, [f1]);
  assert.equal(await bytesOf(a.accountId), MAX - 10000, 'delete frees the space');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM file_chunks WHERE account_id = ?1').bind(a.accountId).first()).n, 0, 'chunks deleted');
  assert.equal((await call('GET', `/api/files/${f1}/0`, { token: a.token })).status, 404);
});

test('auth and isolation: no session → 401; another account can’t see, read, finish or delete a file', async () => {
  const a = await account(), b = await account();
  const fid = rnd(32), data = chars(3000);
  assert.equal((await call('POST', '/api/files/upload', { body: { fid, size: 3000 } })).status, 401);
  assert.equal((await call('GET', `/api/files/${fid}/0`, { token: rnd(32) })).status, 401);
  assert.equal((await call('POST', '/api/files/check', { body: { fids: [] } })).status, 401);
  const st = await call('POST', '/api/files/upload', { token: a.token, body: { fid, size: data.length } });
  assert.equal((await call('PUT', `/api/files/upload/${st.body.upload}/0`, { token: b.token, raw: data })).status, 404, 'B can’t add chunks to A’s upload');
  assert.equal((await call('PUT', `/api/files/upload/${st.body.upload}/0`, { token: a.token, raw: data })).status, 200);
  assert.equal((await call('POST', `/api/files/upload/${st.body.upload}/commit`, { token: b.token })).status, 404, 'B can’t commit it');
  assert.equal((await call('POST', `/api/files/upload/${st.body.upload}/commit`, { token: a.token })).status, 200);
  assert.deepEqual((await call('POST', '/api/files/check', { token: b.token, body: { fids: [fid] } })).body.have, [], 'B doesn’t have it');
  assert.equal((await call('GET', `/api/files/${fid}/0`, { token: b.token })).status, 404, 'B can’t read it');
  assert.equal((await call('GET', '/api/files/list', { token: b.token })).body.files.length, 0);
  assert.deepEqual((await call('POST', '/api/files/delete', { token: b.token, body: { fids: [fid] } })).body.deleted, [], 'B can’t delete it');
  assert.equal((await download(a.token, fid)).data, data, 'A still has it');
  // B stores the same fid: separate copies.
  const other = chars(3000);
  assert.equal((await upload(b.token, fid, other)).status, 200);
  assert.equal((await download(b.token, fid)).data, other);
  assert.equal((await download(a.token, fid)).data, data);
  // Wrong origin.
  assert.equal((await call('GET', `/api/files/${fid}/0`, { token: a.token, origin: 'https://evil.example' })).status, 403);
});

test('list pages', async () => {
  const a = await account();
  const fids = [];
  for (let i = 0; i < 5; i++) { const f = rnd(32); fids.push(f); assert.equal((await upload(a.token, f, chars(100))).status, 200); }
  fids.sort();
  const p1 = await call('GET', '/api/files/list?limit=3', { token: a.token });
  assert.equal(p1.body.files.length, 3); assert.equal(p1.body.more, true);
  const p2 = await call('GET', `/api/files/list?limit=3&after=${p1.body.files[2].fid}`, { token: a.token });
  assert.equal(p2.body.files.length, 2); assert.equal(p2.body.more, false);
  assert.deepEqual([...p1.body.files, ...p2.body.files].map((f) => f.fid), fids);
});

test('rate limit: downloads per account per hour', async () => {
  const a = await account();
  const win = Math.floor(Date.now() / 3600000);
  await db.prepare('INSERT INTO rate (key, win, count) VALUES (?1, ?2, 8000)').bind('fdown:' + a.accountId, win).run();
  const r = await call('GET', `/api/files/${rnd(32)}/0`, { token: a.token });
  assert.equal(r.status, 429);
  assert.equal(typeof r.body.now, 'number');
});

test('account delete with the right password removes files, uploads and chunks', async () => {
  const u = { username: `filesdel${++userN}`, authKey: rnd(32), recAuth: rnd(32), wrappedPw: rnd(60), wrappedRec: rnd(60), deviceName: 'iPhone' };
  const a = (await call('POST', '/api/account/create', { body: u, headers: { 'X-Register-Key': REGISTER_KEY } })).body;
  assert.equal((await upload(a.token, rnd(32), chars(CHUNK + 10))).status, 200);
  assert.equal((await call('POST', '/api/files/upload', { token: a.token, body: { fid: rnd(32), size: 100 } })).status, 200);
  assert.equal((await call('DELETE', '/api/account', { token: a.token, body: { authKey: u.authKey } })).status, 200);
  for (const t of ['files', 'file_uploads', 'file_chunks']) {
    assert.equal((await db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE account_id = ?1`).bind(a.accountId).first()).n, 0, t);
  }
});

test('purge removes uploads abandoned for a day (and their chunks), keeps files and recent uploads', async () => {
  const a = await account();
  const kept = rnd(32);
  assert.equal((await upload(a.token, kept, chars(2000))).status, 200);
  const old = await upload(a.token, rnd(32), chars(CHUNK + 20), { commit: false });
  const recent = await upload(a.token, rnd(32), chars(400), { commit: false });
  await db.prepare('UPDATE file_uploads SET created_at = created_at - 2 * 86400000 WHERE account_id = ?1 AND upload = ?2').bind(a.accountId, old.body.upload).run();
  // An orphan chunk (e.g. left by a failed write) goes too.
  await db.prepare("INSERT INTO file_chunks (account_id, upload, n, data) VALUES (?1, 'orphanorphanorphan0000', 0, 'AAAA')").bind(a.accountId).run();
  // The cron's daily purge runs at 03:00 UTC: the next one (within a day of now).
  const d = new Date(); d.setUTCHours(3, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setUTCDate(d.getUTCDate() + 1);
  await (await mf.getWorker()).scheduled({ scheduledTime: d, cron: '* * * * *' });
  const ups = (await db.prepare('SELECT upload FROM file_uploads WHERE account_id = ?1').bind(a.accountId).all()).results.map((r) => r.upload);
  assert.deepEqual(ups, [recent.body.upload], 'only the recent upload stays');
  const chunkUploads = new Set((await db.prepare('SELECT upload FROM file_chunks WHERE account_id = ?1').bind(a.accountId).all()).results.map((r) => r.upload));
  assert.ok(!chunkUploads.has(old.body.upload) && !chunkUploads.has('orphanorphanorphan0000'), 'abandoned and orphan chunks purged');
  assert.ok(chunkUploads.has(recent.body.upload));
  assert.equal((await download(a.token, kept)).status, 200, 'committed files stay');
});
