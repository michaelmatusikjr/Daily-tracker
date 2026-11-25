// Invite codes (backlog #35): the owner hands a friend a single-use code instead of the register key.
// The code is only ever shown once, at creation; the server keeps HMAC-SHA-256(REGISTER_KEY, code), so a
// copy of the database can't be used to guess codes offline (rotating the register key voids open codes).
import { HttpError, json, readObject, sha256Hex, timingSafeEqual, randomId, rateLimit, rateBump, rateCheck } from './util.js';

export const INVITE_LIMITS = {
  ttlMs: 30 * 86400000,       // an unused code expires after 30 days
  maxOpen: 50,                // most unused, unexpired codes at once
  smallBody: 2 * 1024,
  codeChars: 8,               // 8 × 5 bits = 40 bits of entropy
  rate: { owner: 120, ownerFail: 10, check: 20 }, // per hour, per IP
};
const L = INVITE_LIMITS;
// 32 symbols, no 0/O/1/I, so a code can be read aloud or typed from a screenshot.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_RE = /^[2-9A-HJ-NP-Z]{8}$/;
const INVALID = 'Invalid or expired invite code';

/** A fresh random code like "7K3Q-X9PM" (rejection-free: 256 % 32 = 0). */
export function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(L.codeChars));
  const s = [...bytes].map((b) => ALPHABET[b & 31]).join('');
  return s.slice(0, 4) + '-' + s.slice(4);
}
/** Canonical form of what a person typed ("7k3q x9pm" → "7K3QX9PM"), or null if it can't be a code. */
export function normCode(v) {
  if (typeof v !== 'string' || v.length > 40) return null;
  const s = v.toUpperCase().replace(/[\s-]+/g, '');
  return CODE_RE.test(s) ? s : null;
}
export async function codeHash(env, norm) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(env.REGISTER_KEY)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('invite:' + norm));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The hash of a usable code, or 403 (one message for unknown, used, revoked and expired). */
export async function findInvite(env, raw, now) {
  const norm = normCode(raw);
  if (!norm) throw new HttpError(403, INVALID);
  const hash = await codeHash(env, norm);
  const row = await env.DB.prepare('SELECT 1 AS ok FROM invites WHERE code_hash = ?1 AND used_at IS NULL AND revoked = 0 AND expires_at > ?2').bind(hash, now).first();
  if (!row) throw new HttpError(403, INVALID);
  return hash;
}

/** Owner calls need X-Register-Key. Failures are counted separately (10/hour/IP) so the key can't be guessed. */
async function requireOwner(request, env, now, ip) {
  if (!env.REGISTER_KEY) throw new HttpError(503, 'Server not set up: REGISTER_KEY is missing');
  await rateCheck(env, 'invf:' + ip, L.rate.ownerFail, now);
  await rateLimit(env, 'invo:' + ip, L.rate.owner, now);
  const given = request.headers.get('X-Register-Key') || '';
  if (!timingSafeEqual(await sha256Hex(given), await sha256Hex(env.REGISTER_KEY))) {
    await rateBump(env, 'invf:' + ip, now);
    throw new HttpError(403, 'Wrong register key');
  }
}

const statusOf = (r, now) => (r.used_at ? 'used' : r.revoked ? 'revoked' : r.expires_at <= now ? 'expired' : 'unused');
const publicRow = (r, now) => ({
  id: r.id, name: r.name, createdAt: r.created_at, expiresAt: r.expires_at, usedAt: r.used_at || null,
  username: r.used_at ? r.username || null : null, status: statusOf(r, now),
});

/** /api/invites*. Returns a Response or null. */
export async function invitesRoute(request, env, now, path, ip) {
  const M = request.method;
  const ok = (data, status = 200) => json({ ...data, now }, status);

  // Is this code usable? Open to anyone (the wizard checks before account creation), rate limited, valid/invalid only.
  if (path === '/api/invites/check' && M === 'POST') {
    if (!env.REGISTER_KEY) throw new HttpError(503, 'Server not set up: REGISTER_KEY is missing');
    await rateLimit(env, 'invc:' + ip, L.rate.check, now);
    const b = await readObject(request, L.smallBody);
    try { await findInvite(env, b.code, now); } catch (e) { if (e.status === 403) return ok({ valid: false }); throw e; }
    return ok({ valid: true });
  }

  if (path === '/api/invites' && M === 'POST') {
    await requireOwner(request, env, now, ip);
    const b = await readObject(request, L.smallBody);
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) throw new HttpError(400, 'Name must be at most 40 characters');
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM invites WHERE used_at IS NULL AND revoked = 0 AND expires_at > ?1').bind(now).first();
    if (n >= L.maxOpen) throw new HttpError(409, 'Too many open invites: revoke some first');
    const id = randomId(12), code = newCode();
    await env.DB.prepare('INSERT INTO invites (id, code_hash, name, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(id, await codeHash(env, normCode(code)), name, now, now + L.ttlMs).run();
    return ok({ id, code, name, createdAt: now, expiresAt: now + L.ttlMs, usedAt: null, username: null, status: 'unused' }, 201);
  }

  if (path === '/api/invites' && M === 'GET') {
    await requireOwner(request, env, now, ip);
    const { results } = await env.DB.prepare(
      `SELECT i.*, a.username FROM invites i LEFT JOIN accounts a ON a.id = i.account_id ORDER BY i.created_at DESC LIMIT 200`,
    ).all();
    return ok({ invites: results.map((r) => publicRow(r, now)) });
  }

  const m = /^\/api\/invites\/([A-Za-z0-9_-]{1,40})$/.exec(path);
  if (m && M === 'DELETE') {
    await requireOwner(request, env, now, ip);
    // Only an unused code can be revoked; a used one stays as the record of who joined.
    const r = await env.DB.prepare('UPDATE invites SET revoked = 1 WHERE id = ?1 AND used_at IS NULL').bind(m[1]).run();
    if (!r.meta.changes) {
      const row = await env.DB.prepare('SELECT used_at FROM invites WHERE id = ?1').bind(m[1]).first();
      if (!row) throw new HttpError(404, 'No such invite');
      if (row.used_at) throw new HttpError(409, 'This invite was already used');
    }
    return ok({ ok: true });
  }
  return null;
}
