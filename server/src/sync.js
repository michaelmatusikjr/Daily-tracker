// Encrypted record sync (SYNC.md › Records, Server API). The server stores opaque records
// { rid, t, dev, blob } per account. A write wins when its (t, dev) is greater than the stored one
// (compare t, then dev as a string). Every accepted write gets a new, higher account `seq`, so a
// device pulls "everything after the last seq I saw".
import { HttpError, json, readObject, rateLimit } from './util.js';
import { authSession } from './account.js';

export const SYNC_LIMITS = {
  pushRecords: 500,                  // records per push
  blobChars: 256 * 1024,             // base64url characters per blob
  pushBody: 4 * 1024 * 1024,
  pullDefault: 500, pullMax: 1000,   // records per pull page
  pullChars: 4 * 1024 * 1024,        // blob characters per pull page (at least one record)
  maxRecords: 200000,                // per account (tombstones included)
  maxBytes: 200 * 1024 * 1024,       // blob characters per account
  futureMs: 86400000,                // t may be at most 1 day ahead of the server clock
  chunkChars: 900 * 1024,            // records per SQL statement are passed as JSON chunks of this size
  rate: { push: 600, pull: 1200 },   // per hour, per account
};
const S = SYNC_LIMITS;
const bad = (m) => new HttpError(400, m);
const RID = /^[A-Za-z0-9_-]{43}$/;   // 32 bytes (HMAC-SHA-256)
const DEV = /^[A-Za-z0-9_-]{22}$/;   // 16 bytes
// Smallest blob: iv (12) + GCM tag (16) = 28 bytes = 38 characters.
const isBlob = (v) => typeof v === 'string' && v.length >= 38 && v.length <= S.blobChars && v.length % 4 !== 1 && /^[A-Za-z0-9_-]+$/.test(v);
/** Is (t1, d1) later than (t2, d2)? */
const newer = (t1, d1, t2, d2) => t1 > t2 || (t1 === t2 && d1 > d2);

/** Validate a push body. Returns the records with duplicates (same rid) reduced to the latest. */
export function validatePush(body, now) {
  if (!Array.isArray(body.records)) throw bad('records must be an array');
  if (body.records.length > S.pushRecords) throw bad(`At most ${S.pushRecords} records per push`);
  const byRid = new Map();
  body.records.forEach((r, i) => {
    const no = (m) => bad(`records[${i}]: ${m}`);
    if (!r || typeof r !== 'object') throw no('must be an object');
    if (typeof r.rid !== 'string' || !RID.test(r.rid)) throw no('invalid rid');
    if (!Number.isSafeInteger(r.t) || r.t < 0 || r.t > now + S.futureMs) throw no('t must be a time in ms, not in the future');
    if (typeof r.dev !== 'string' || !DEV.test(r.dev)) throw no('invalid dev');
    if (!isBlob(r.blob)) throw no(`blob must be base64url, at most ${S.blobChars} characters`);
    const prev = byRid.get(r.rid);
    if (!prev || newer(r.t, r.dev, prev.t, prev.dev)) byRid.set(r.rid, { rid: r.rid, t: r.t, dev: r.dev, blob: r.blob });
  });
  return [...byRid.values()];
}

/** Split records into JSON chunks small enough for one SQL parameter each. */
function chunks(records) {
  const out = [];
  let cur = [], size = 2;
  for (const r of records) {
    const n = r.blob.length + 120;
    if (cur.length && size + n > S.chunkChars) { out.push(cur); cur = []; size = 2; }
    cur.push(r); size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Handle /api/sync/*. Returns a Response, or null for an unknown route. */
export async function syncRoute(request, env, now, path, url) {
  const M = request.method;
  const ok = (data) => json({ ...data, now });

  if (path === '/api/sync/pull' && M === 'GET') {
    const { account } = await authSession(request, env, now);
    await rateLimit(env, 'pull:' + account.id, S.rate.pull, now);
    const since = Number(url.searchParams.get('since') ?? 0);
    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : S.pullDefault;
    if (!Number.isSafeInteger(since) || since < 0) throw bad('since must be a sequence number');
    if (!Number.isInteger(limit) || limit < 1 || limit > S.pullMax) throw bad(`limit must be 1–${S.pullMax}`);
    // One consistent read: the account's seq, and the sizes of the next page of records.
    const [acc, sizes] = await env.DB.batch([
      env.DB.prepare('SELECT seq FROM accounts WHERE id = ?1').bind(account.id),
      env.DB.prepare('SELECT seq, length(blob) AS n FROM records WHERE account_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3').bind(account.id, since, limit),
    ]);
    const accSeq = acc.results[0] ? acc.results[0].seq : 0;
    const rows = sizes.results;
    let take = 0, chars = 0;
    while (take < rows.length && (take === 0 || chars + rows[take].n <= S.pullChars)) chars += rows[take++].n;
    const cutoff = take ? rows[take - 1].seq : since;
    const more = take < rows.length || (rows.length === limit && cutoff < accSeq);
    let records = [];
    if (take) {
      records = (await env.DB.prepare('SELECT rid, seq, t, dev, blob FROM records WHERE account_id = ?1 AND seq > ?2 AND seq <= ?3 ORDER BY seq')
        .bind(account.id, since, cutoff).all()).results;
    }
    // `seq` is the cursor for the next pull (`since`).
    return ok({ records, seq: more ? cutoff : Math.max(accSeq, cutoff), more });
  }

  if (path === '/api/sync/push' && M === 'POST') {
    const { account } = await authSession(request, env, now);
    await rateLimit(env, 'push:' + account.id, S.rate.push, now);
    const records = validatePush(await readObject(request, S.pushBody), now);
    const aid = account.id;
    if (!records.length) return ok({ seq: account.seq, accepted: 0, stale: [] });

    // Storage limits: what this push would add (rows that would really be written).
    const rids = JSON.stringify(records.map((r) => r.rid));
    const old = new Map((await env.DB.prepare(
      'SELECT rid, t, dev, length(blob) AS n FROM records WHERE account_id = ?1 AND rid IN (SELECT value FROM json_each(?2))',
    ).bind(aid, rids).all()).results.map((r) => [r.rid, r]));
    let addRecords = 0, addBytes = 0;
    for (const r of records) {
      const o = old.get(r.rid);
      if (!o) { addRecords++; addBytes += r.blob.length; } else if (newer(r.t, r.dev, o.t, o.dev)) addBytes += r.blob.length - o.n;
    }
    if ((addRecords > 0 && account.records + addRecords > S.maxRecords) || (addBytes > 0 && account.bytes + addBytes > S.maxBytes)) {
      throw new HttpError(413, 'Account storage is full');
    }

    // One transaction (D1 batch): per chunk, update the counters, then upsert the records that win;
    // each record gets seq = (account seq before the push) + its position + 1; then move the account seq on.
    const stmts = [];
    let offset = 0;
    for (const part of chunks(records)) {
      const data = JSON.stringify(part.map((r) => ({ rid: r.rid, t: r.t, dev: r.dev, blob: r.blob })));
      stmts.push(env.DB.prepare(
        `WITH j AS (SELECT json_extract(value, '$.rid') AS rid, json_extract(value, '$.t') AS t, json_extract(value, '$.dev') AS dev,
                           length(json_extract(value, '$.blob')) AS n FROM json_each(?2)),
              x AS (SELECT j.t, j.dev, j.n, r.t AS ot, r.dev AS odev, length(r.blob) AS olen
                      FROM j LEFT JOIN records r ON r.account_id = ?1 AND r.rid = j.rid)
         UPDATE accounts SET
           records = records + (SELECT COUNT(*) FROM x WHERE ot IS NULL),
           bytes = bytes + (SELECT COALESCE(SUM(n - COALESCE(olen, 0)), 0) FROM x WHERE ot IS NULL OR t > ot OR (t = ot AND dev > odev))
         WHERE id = ?1`,
      ).bind(aid, data));
      stmts.push(env.DB.prepare(
        `INSERT INTO records (account_id, rid, seq, t, dev, blob)
         SELECT ?1, json_extract(value, '$.rid'), (SELECT seq FROM accounts WHERE id = ?1) + ?3 + key + 1,
                json_extract(value, '$.t'), json_extract(value, '$.dev'), json_extract(value, '$.blob')
           FROM json_each(?2) WHERE true
         ON CONFLICT (account_id, rid) DO UPDATE SET seq = excluded.seq, t = excluded.t, dev = excluded.dev, blob = excluded.blob
           WHERE excluded.t > records.t OR (excluded.t = records.t AND excluded.dev > records.dev)
         RETURNING rid`,
      ).bind(aid, data, offset));
      offset += part.length;
    }
    stmts.push(env.DB.prepare('UPDATE accounts SET seq = seq + ?2, updated_at = ?3 WHERE id = ?1 RETURNING seq').bind(aid, offset, now));
    const results = await env.DB.batch(stmts);
    const accepted = new Set();
    for (let i = 1; i < results.length - 1; i += 2) for (const r of results[i].results) accepted.add(r.rid);
    const seq = results[results.length - 1].results[0]?.seq ?? account.seq;
    return ok({ seq, accepted: accepted.size, stale: records.filter((r) => !accepted.has(r.rid)).map((r) => r.rid) });
  }

  return null;
}
