// Encrypted task photos (SYNC.md › Phase 2: photos). The server stores opaque files per account:
// fid (an HMAC the client derives, 32 bytes base64url) → one AES-GCM ciphertext as base64url
// characters, split into chunks of CHUNK characters (a D1 value is limited to ~2 MB). Uploads are
// all-or-nothing: chunks belong to an upload (file_uploads) and only become a file (files) when the
// upload is committed with every chunk present, so a half upload is never visible. Files are
// immutable (an fid always means the same photo). Their size counts in accounts.bytes (the same
// 200 MB limit as records). Abandoned uploads are purged after a day (purgeFiles, daily cron).
import { HttpError, json, readObject, readBytes, rateLimit, randomId } from './util.js';
import { authSession } from './account.js';
import { SYNC_LIMITS } from './sync.js';

export const FILE_LIMITS = {
  chunkChars: 512 * 1024,            // base64url characters per chunk (the last one may be shorter)
  maxChars: 16 * 1024 * 1024,        // per file (32 chunks, about 12 MB of ciphertext)
  minChars: 38,                      // iv (12) + GCM tag (16) = 28 bytes
  pendingUploads: 8,                 // uploads in progress per account
  staleUploadMs: 3600000,            // an upload this old may be evicted when the account is at pendingUploads
  abandonMs: 86400000,               // incomplete uploads older than this are purged
  checkMax: 1000,                    // fids per check
  deleteMax: 200,                    // fids per delete
  listMax: 1000,                     // files per list page
  rate: { up: 4000, down: 8000, meta: 600 }, // per hour, per account (each chunk counts)
};
const F = FILE_LIMITS;
const bad = (m) => new HttpError(400, m);
const FID = /^[A-Za-z0-9_-]{43}$/;
const UPLOAD = /^[A-Za-z0-9_-]{22}$/;
const B64U = /^[A-Za-z0-9_-]+$/;
const chunksFor = (size) => Math.ceil(size / F.chunkChars);
/** Length chunk n of a file of `size` characters must have. */
const chunkLen = (size, n) => (n < chunksFor(size) - 1 ? F.chunkChars : size - (chunksFor(size) - 1) * F.chunkChars);

function fidList(v, max) {
  if (!Array.isArray(v)) throw bad('fids must be an array');
  if (v.length > max) throw bad(`At most ${max} fids`);
  v.forEach((x, i) => { if (typeof x !== 'string' || !FID.test(x)) throw bad(`fids[${i}]: invalid fid`); });
  return [...new Set(v)];
}

/** Handle /api/files/*. Returns a Response, or null for an unknown route. */
export async function filesRoute(request, env, now, path, url) {
  const M = request.method;
  const ok = (data) => json({ ...data, now });
  if (!path.startsWith('/api/files/')) return null;
  const { account } = await authSession(request, env, now);
  const aid = account.id;
  const rest = path.slice('/api/files/'.length).split('/');

  // Which of these files does the account have (committed only)?
  if (path === '/api/files/check' && M === 'POST') {
    await rateLimit(env, 'fmeta:' + aid, F.rate.meta, now);
    const fids = fidList((await readObject(request, 64 * 1024)).fids, F.checkMax);
    if (!fids.length) return ok({ have: [] });
    const rows = (await env.DB.prepare('SELECT fid FROM files WHERE account_id = ?1 AND fid IN (SELECT value FROM json_each(?2))')
      .bind(aid, JSON.stringify(fids)).all()).results;
    return ok({ have: rows.map((r) => r.fid) });
  }

  // Every file of the account, in fid order (pages: after = the last fid seen).
  if (path === '/api/files/list' && M === 'GET') {
    await rateLimit(env, 'fmeta:' + aid, F.rate.meta, now);
    const after = url.searchParams.get('after') || '';
    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : F.listMax;
    if (after && !FID.test(after)) throw bad('invalid after');
    if (!Number.isInteger(limit) || limit < 1 || limit > F.listMax) throw bad(`limit must be 1–${F.listMax}`);
    const rows = (await env.DB.prepare('SELECT fid, size, created_at FROM files WHERE account_id = ?1 AND fid > ?2 ORDER BY fid LIMIT ?3')
      .bind(aid, after, limit + 1).all()).results;
    const more = rows.length > limit;
    return ok({ files: rows.slice(0, limit).map((r) => ({ fid: r.fid, size: r.size, createdAt: r.created_at })), more });
  }

  // Start an upload: { fid, size } → { have: true } (already stored) or { upload, chunks, chunkChars }.
  if (path === '/api/files/upload' && M === 'POST') {
    await rateLimit(env, 'fup:' + aid, F.rate.up, now);
    const b = await readObject(request, 4096);
    if (typeof b.fid !== 'string' || !FID.test(b.fid)) throw bad('invalid fid');
    if (!Number.isSafeInteger(b.size) || b.size < F.minChars || b.size > F.maxChars || b.size % 4 === 1) throw bad(`size must be ${F.minChars}–${F.maxChars} characters`);
    const [have, pend] = await env.DB.batch([
      env.DB.prepare('SELECT 1 AS x FROM files WHERE account_id = ?1 AND fid = ?2').bind(aid, b.fid),
      env.DB.prepare('SELECT upload, fid, size, created_at FROM file_uploads WHERE account_id = ?1 ORDER BY created_at').bind(aid),
    ]);
    if (have.results.length) return ok({ have: true });
    // An earlier, unfinished upload of the same file is replaced; when too many are in progress, the
    // oldest stale ones (an app that was closed mid-upload) make room.
    const drop = [];
    let pending = pend.results.filter((u) => { if (u.fid === b.fid) { drop.push(u.upload); return false; } return true; });
    while (pending.length >= F.pendingUploads && pending[0].created_at < now - F.staleUploadMs) drop.push(pending.shift().upload);
    if (pending.length >= F.pendingUploads) throw new HttpError(429, 'Too many uploads in progress, try again later');
    const pendingBytes = pending.reduce((n, u) => n + u.size, 0);
    if (account.bytes + pendingBytes + b.size > SYNC_LIMITS.maxBytes) throw new HttpError(413, 'Account storage is full');
    const upload = randomId(16);
    const stmts = [];
    for (const u of drop) {
      stmts.push(env.DB.prepare('DELETE FROM file_chunks WHERE account_id = ?1 AND upload = ?2').bind(aid, u));
      stmts.push(env.DB.prepare('DELETE FROM file_uploads WHERE account_id = ?1 AND upload = ?2').bind(aid, u));
    }
    stmts.push(env.DB.prepare('INSERT INTO file_uploads (account_id, upload, fid, size, chunks, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(aid, upload, b.fid, b.size, chunksFor(b.size), now));
    await env.DB.batch(stmts);
    return ok({ upload, chunks: chunksFor(b.size), chunkChars: F.chunkChars });
  }

  // One chunk (raw base64url text body). Sending the same chunk again replaces it.
  if (rest[0] === 'upload' && rest.length === 3 && M === 'PUT') {
    await rateLimit(env, 'fup:' + aid, F.rate.up, now);
    const upload = rest[1], n = Number(rest[2]);
    if (!UPLOAD.test(upload)) throw new HttpError(404, 'Upload not found');
    if (!/^\d{1,3}$/.test(rest[2])) throw bad('invalid chunk number');
    const u = await env.DB.prepare('SELECT size, chunks FROM file_uploads WHERE account_id = ?1 AND upload = ?2').bind(aid, upload).first();
    if (!u) throw new HttpError(404, 'Upload not found');
    if (n >= u.chunks) throw bad('invalid chunk number');
    const data = new TextDecoder().decode(await readBytes(request, F.chunkChars + 16));
    if (data.length !== chunkLen(u.size, n) || !B64U.test(data)) throw bad(`chunk ${n} must be ${chunkLen(u.size, n)} base64url characters`);
    await env.DB.prepare('INSERT INTO file_chunks (account_id, upload, n, data) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (account_id, upload, n) DO UPDATE SET data = excluded.data')
      .bind(aid, upload, n, data).run();
    return ok({ ok: true });
  }

  // Commit: only with every chunk present. One transaction: the file appears with its data, the
  // account's bytes grow, the upload is gone. A file another device committed first is kept as it is.
  if (rest[0] === 'upload' && rest.length === 3 && rest[2] === 'commit' && M === 'POST') {
    await rateLimit(env, 'fup:' + aid, F.rate.up, now);
    const upload = rest[1];
    if (!UPLOAD.test(upload)) throw new HttpError(404, 'Upload not found');
    const [ur, cr, fr] = await env.DB.batch([
      env.DB.prepare('SELECT fid, size, chunks FROM file_uploads WHERE account_id = ?1 AND upload = ?2').bind(aid, upload),
      env.DB.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(length(data)), 0) AS n FROM file_chunks WHERE account_id = ?1 AND upload = ?2').bind(aid, upload),
      env.DB.prepare('SELECT f.fid FROM files f JOIN file_uploads u ON u.account_id = f.account_id AND u.fid = f.fid WHERE u.account_id = ?1 AND u.upload = ?2').bind(aid, upload),
    ]);
    const u = ur.results[0];
    if (!u) throw new HttpError(404, 'Upload not found');
    const c = cr.results[0];
    if (c.c !== u.chunks || c.n !== u.size) throw new HttpError(409, 'Upload incomplete');
    const exists = fr.results.length > 0;
    if (!exists && account.bytes + u.size > SYNC_LIMITS.maxBytes) throw new HttpError(413, 'Account storage is full');
    const live = 'EXISTS (SELECT 1 FROM file_uploads WHERE account_id = ?1 AND upload = ?2)';
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO files (account_id, fid, upload, size, chunks, created_at) SELECT ?1, ?3, ?2, ?4, ?5, ?6 WHERE ${live} ON CONFLICT (account_id, fid) DO NOTHING`)
        .bind(aid, upload, u.fid, u.size, u.chunks, now),
      env.DB.prepare(`UPDATE accounts SET bytes = bytes + ?3, updated_at = ?4 WHERE id = ?1 AND ${live} AND EXISTS (SELECT 1 FROM files WHERE account_id = ?1 AND upload = ?2)`)
        .bind(aid, upload, u.size, now),
      env.DB.prepare('DELETE FROM file_chunks WHERE account_id = ?1 AND upload = ?2 AND NOT EXISTS (SELECT 1 FROM files WHERE account_id = ?1 AND upload = ?2)').bind(aid, upload),
      env.DB.prepare('DELETE FROM file_uploads WHERE account_id = ?1 AND upload = ?2').bind(aid, upload),
    ]);
    return ok({ ok: true, have: true });
  }

  // Delete files: { fids } → { deleted: [fid] }. One transaction (bytes, chunks, rows).
  if (path === '/api/files/delete' && M === 'POST') {
    await rateLimit(env, 'fmeta:' + aid, F.rate.meta, now);
    const fids = fidList((await readObject(request, 64 * 1024)).fids, F.deleteMax);
    if (!fids.length) return ok({ deleted: [] });
    const j = JSON.stringify(fids);
    const sel = 'SELECT upload FROM files WHERE account_id = ?1 AND fid IN (SELECT value FROM json_each(?2))';
    const res = await env.DB.batch([
      env.DB.prepare('UPDATE accounts SET bytes = MAX(0, bytes - COALESCE((SELECT SUM(size) FROM files WHERE account_id = ?1 AND fid IN (SELECT value FROM json_each(?2))), 0)), updated_at = ?3 WHERE id = ?1').bind(aid, j, now),
      env.DB.prepare(`DELETE FROM file_chunks WHERE account_id = ?1 AND upload IN (${sel})`).bind(aid, j),
      env.DB.prepare('DELETE FROM files WHERE account_id = ?1 AND fid IN (SELECT value FROM json_each(?2)) RETURNING fid').bind(aid, j),
    ]);
    return ok({ deleted: res[2].results.map((r) => r.fid) });
  }

  // Download chunk n: → { fid, n, chunks, size, data }.
  if (rest.length === 2 && FID.test(rest[0]) && /^\d{1,3}$/.test(rest[1]) && M === 'GET') {
    await rateLimit(env, 'fdown:' + aid, F.rate.down, now);
    const row = await env.DB.prepare(
      'SELECT f.size, f.chunks, c.data FROM files f JOIN file_chunks c ON c.account_id = f.account_id AND c.upload = f.upload AND c.n = ?3 WHERE f.account_id = ?1 AND f.fid = ?2',
    ).bind(aid, rest[0], Number(rest[1])).first();
    if (!row) throw new HttpError(404, 'File not found');
    return ok({ fid: rest[0], n: Number(rest[1]), chunks: row.chunks, size: row.size, data: row.data });
  }

  return null;
}

/** Daily purge: incomplete uploads older than a day, and chunks that belong to nothing. */
export async function purgeFiles(env, now) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM file_uploads WHERE created_at < ?1').bind(now - F.abandonMs),
    env.DB.prepare(`DELETE FROM file_chunks WHERE
      NOT EXISTS (SELECT 1 FROM files f WHERE f.account_id = file_chunks.account_id AND f.upload = file_chunks.upload)
      AND NOT EXISTS (SELECT 1 FROM file_uploads u WHERE u.account_id = file_chunks.account_id AND u.upload = file_chunks.upload)`),
  ]);
}
