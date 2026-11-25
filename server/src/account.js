// Accounts, sessions and passkeys for sync (SYNC.md). The server never sees a password: the app
// sends authKey (from PBKDF2 on the device) and the server keeps only a salted HMAC verifier of it.
// Wrapped keys are opaque ciphertext to the server.
import { b64urlDecode } from './b64.js';
import { HttpError, json, readObject, sha256Hex, timingSafeEqual, randomId, hex, rateLimit, rateBump, rateCheck } from './util.js';
import { findInvite } from './invites.js';
import { verifyRegistration, verifyAssertion, WebAuthnError } from './webauthn.js';

export const ACCOUNT_LIMITS = {
  sessionTtlMs: 400 * 86400000,      // a session unused for 400 days ends
  lastSeenEveryMs: 3600000,          // last_seen is written at most hourly
  challengeTtlMs: 5 * 60000,
  maxAccountsDefault: 10,            // override with the MAX_ACCOUNTS var
  maxPasskeys: 20,
  smallBody: 8 * 1024,
  passkeyBody: 32 * 1024,
  rate: {                            // per hour
    create: 5,                       // per IP
    failUser: 10, failIp: 30,        // failed password / recovery checks
    passkeyLogin: 30,                // per IP (options and sign-in each)
    passkeyRegister: 30,             // per account
    account: 600,                    // other account calls, per account
  },
};
const L = ACCOUNT_LIMITS;
const WRONG_LOGIN = 'Wrong username or password';

// ---------- Validation ----------
const bad = (m) => new HttpError(400, m);
/** Username: trimmed, lower-cased, 3–40 of [a-z0-9._-]. */
export function normUsername(v) {
  const u = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!/^[a-z0-9._-]{3,40}$/.test(u)) throw bad('Username must be 3–40 characters: letters, digits, . _ -');
  return u;
}
/** A base64url string (no padding) that decodes to exactly `n` bytes. */
export function b64Exact(v, n, name) {
  const len = Math.ceil((n * 4) / 3);
  if (typeof v !== 'string' || v.length !== len || !/^[A-Za-z0-9_-]+$/.test(v)) throw bad(`Invalid ${name}`);
  try { if (b64urlDecode(v).length !== n) throw new Error(); } catch { throw bad(`Invalid ${name}`); }
  return v;
}
const key32 = (v, name) => b64Exact(v, 32, name);
/** A wrapped data key: iv (12) + AES-GCM of a 32-byte key (32 + 16 tag) = 60 bytes. */
const wrapped = (v, name) => b64Exact(v, 60, name);
/** Device / passkey names: 1–60 characters, no control characters. */
function label(v, name) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > 60 || /[\u0000-\u001f\u007f]/.test(s)) throw bad(`${name} must be 1–60 characters`);
  return s;
}
const credId = (v) => {
  if (typeof v !== 'string' || !v || v.length > 1366 || !/^[A-Za-z0-9_-]+$/.test(v)) throw bad('Invalid passkey id');
  return v;
};

// ---------- Secrets ----------
// authKey and recAuth are 256-bit outputs of the client's PBKDF2 (600 000 iterations) / HKDF, so they
// can't be brute-forced: a fast keyed hash is enough (and fits the Workers free plan's CPU limit).
// Verifier = HMAC-SHA-256(key = random 16-byte per-account salt, message = the secret).
async function verifierHex(secretB64, saltB64) {
  const key = await crypto.subtle.importKey('raw', b64urlDecode(saltB64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, b64urlDecode(secretB64)));
}
async function makeVerifier(secretB64) {
  const salt = randomId(16);
  return { salt, hash: await verifierHex(secretB64, salt) };
}
const DUMMY_SALT = 'AAAAAAAAAAAAAAAAAAAAAA';
const DUMMY_HASH = '0'.repeat(64);
/** Check authKey / recAuth against an account row. Unknown accounts do the same work (same timing). */
async function checkSecret(row, kind, secretB64) {
  if (!row) { timingSafeEqual(await verifierHex(secretB64, DUMMY_SALT), DUMMY_HASH); return false; }
  const [salt, hash] = kind === 'rec' ? [row.rec_salt, row.rec_hash] : [row.auth_salt, row.auth_hash];
  return timingSafeEqual(await verifierHex(secretB64, salt), hash);
}
/** Failed password/recovery checks: 10/hour per username and 30/hour per IP, then 429. */
async function failGuard(env, username, ip, now) {
  await rateCheck(env, 'lfu:' + username, L.rate.failUser, now);
  await rateCheck(env, 'lfi:' + ip, L.rate.failIp, now);
}
async function failCount(env, username, ip, now) {
  await rateBump(env, 'lfu:' + username, now);
  await rateBump(env, 'lfi:' + ip, now);
}

// ---------- Sessions ----------
async function newSession(env, accountId, deviceName, now) {
  const token = randomId(32), id = randomId(16);
  const stmt = env.DB.prepare('INSERT INTO sessions (token_hash, id, account_id, device_name, created_at, last_seen) VALUES (?1, ?2, ?3, ?4, ?5, ?5)')
    .bind(await sha256Hex(token), id, accountId, deviceName, now);
  return { token, id, stmt };
}

/** The signed-in session for `Authorization: Bearer <token>`, with its account row. 401 otherwise. */
export async function authSession(request, env, now) {
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization') || '');
  if (!m) throw new HttpError(401, 'Not signed in');
  const tokenHash = await sha256Hex(m[1]);
  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, s.last_seen, a.* FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?1`,
  ).bind(tokenHash).first();
  if (!row) throw new HttpError(401, 'Not signed in');
  if (row.last_seen < now - L.sessionTtlMs) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(tokenHash).run();
    throw new HttpError(401, 'Not signed in');
  }
  if (now - row.last_seen >= L.lastSeenEveryMs) await env.DB.prepare('UPDATE sessions SET last_seen = ?2 WHERE token_hash = ?1').bind(tokenHash, now).run();
  return { tokenHash, sessionId: row.session_id, account: row };
}

/** Request Origin (already checked against ALLOWED_ORIGINS) and its hostname as the WebAuthn rpId. */
function rpOf(request) {
  const origin = (request.headers.get('Origin') || '').replace(/\/+$/, '');
  let rpId;
  try { rpId = new URL(origin).hostname; } catch { throw new HttpError(403, 'Origin not allowed'); }
  return { origin, rpId };
}
async function newChallenge(env, purpose, accountId, now) {
  const id = randomId(16), challenge = randomId(32);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM challenges WHERE expires_at < ?1').bind(now),
    env.DB.prepare('INSERT INTO challenges (id, challenge, purpose, account_id, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(id, challenge, purpose, accountId, now + L.challengeTtlMs),
  ]);
  return { id, challenge };
}
/** Use up a challenge (single use: deleted whether or not the response then verifies). */
async function takeChallenge(env, id, purpose, accountId, now) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(id)) throw bad('Wrong or expired challenge');
  const row = await env.DB.prepare('DELETE FROM challenges WHERE id = ?1 AND purpose = ?2 AND (account_id IS ?3) RETURNING challenge, expires_at')
    .bind(id, purpose, accountId).first();
  if (!row || row.expires_at < now) throw bad('Wrong or expired challenge');
  return row.challenge;
}

// ---------- Routes ----------
/** Handle /api/account*, /api/passkey/*. Returns a Response, or null for an unknown route. */
export async function accountRoute(request, env, now, path, ip) {
  const M = request.method;
  const ok = (data, status = 200) => json({ ...data, now }, status);

  if (path === '/api/account/create' && M === 'POST') {
    // Authorised by the register key (the server owner's) or by a single-use invite code (X-Invite-Code).
    if (!env.REGISTER_KEY) throw new HttpError(503, 'Server not set up: REGISTER_KEY is missing');
    await rateLimit(env, 'acr:' + ip, L.rate.create, now);
    const givenKey = request.headers.get('X-Register-Key') || '';
    const givenInvite = request.headers.get('X-Invite-Code') || '';
    let inviteHash = null;
    if (givenKey || !givenInvite) {
      if (!timingSafeEqual(await sha256Hex(givenKey), await sha256Hex(env.REGISTER_KEY))) throw new HttpError(403, 'Wrong register key');
    } else {
      inviteHash = await findInvite(env, givenInvite, now);
    }
    const b = await readObject(request, L.smallBody);
    const username = normUsername(b.username);
    const authKey = key32(b.authKey, 'authKey'), recAuth = key32(b.recAuth, 'recAuth');
    const wrappedPw = wrapped(b.wrappedPw, 'wrappedPw'), wrappedRec = wrapped(b.wrappedRec, 'wrappedRec');
    const deviceName = label(b.deviceName, 'deviceName');
    const max = Number(env.MAX_ACCOUNTS) > 0 ? Number(env.MAX_ACCOUNTS) : L.maxAccountsDefault;
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM accounts').first();
    if (n >= max) throw new HttpError(503, 'Account limit reached');
    if (await env.DB.prepare('SELECT 1 FROM accounts WHERE username = ?1').bind(username).first()) throw new HttpError(409, 'Username is taken');
    const auth = await makeVerifier(authKey), rec = await makeVerifier(recAuth);
    const accountId = randomId(16);
    const s = await newSession(env, accountId, deviceName, now);
    const insertAccount = 'INSERT INTO accounts (id, username, auth_salt, auth_hash, rec_salt, rec_hash, wrapped_pw, wrapped_rec, created_at, updated_at, invited)';
    const accountArgs = [accountId, username, auth.salt, auth.hash, rec.salt, rec.hash, wrappedPw, wrappedRec, now];
    try {
      if (!inviteHash) {
        await env.DB.batch([env.DB.prepare(`${insertAccount} VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, 0)`).bind(...accountArgs), s.stmt]);
      } else {
        // One atomic batch: the conditional UPDATE spends the code (only if still unused, unrevoked and
        // unexpired); the account and session are only inserted when this request won it. Any failure
        // (e.g. a username race) rolls the whole batch back, so a code is never used up without an account.
        const res = await env.DB.batch([
          env.DB.prepare('UPDATE invites SET used_at = ?2, account_id = ?3 WHERE code_hash = ?1 AND used_at IS NULL AND revoked = 0 AND expires_at > ?2')
            .bind(inviteHash, now, accountId),
          env.DB.prepare(`${insertAccount} SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, 1 WHERE EXISTS (SELECT 1 FROM invites WHERE code_hash = ?10 AND account_id = ?1)`)
            .bind(...accountArgs, inviteHash),
          env.DB.prepare('INSERT INTO sessions (token_hash, id, account_id, device_name, created_at, last_seen) SELECT ?1, ?2, ?3, ?4, ?5, ?5 WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ?3)')
            .bind(await sha256Hex(s.token), s.id, accountId, deviceName, now),
        ]);
        if (res[0].meta.changes !== 1) throw new HttpError(403, 'Invalid or expired invite code');
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (/UNIQUE/i.test(String(e?.message))) throw new HttpError(409, 'Username is taken');
      throw e;
    }
    return ok({ accountId, username, token: s.token, sessionId: s.id, invited: !!inviteHash }, 201);
  }

  if (path === '/api/account/login' && M === 'POST') {
    const b = await readObject(request, L.smallBody);
    const username = normUsername(b.username);
    const authKey = key32(b.authKey, 'authKey');
    const deviceName = label(b.deviceName, 'deviceName');
    await failGuard(env, username, ip, now);
    const row = await env.DB.prepare('SELECT * FROM accounts WHERE username = ?1').bind(username).first();
    if (!(await checkSecret(row, 'auth', authKey))) { await failCount(env, username, ip, now); throw new HttpError(401, WRONG_LOGIN); }
    const s = await newSession(env, row.id, deviceName, now);
    await s.stmt.run();
    return ok({ accountId: row.id, username: row.username, token: s.token, sessionId: s.id, wrappedPw: row.wrapped_pw, invited: !!row.invited });
  }

  if ((path === '/api/account/recover/start' || path === '/api/account/recover/finish') && M === 'POST') {
    const finish = path.endsWith('/finish');
    const b = await readObject(request, L.smallBody);
    const username = normUsername(b.username);
    const recAuth = key32(b.recAuth, 'recAuth');
    let newAuthKey, newWrappedPw, deviceName;
    if (finish) {
      newAuthKey = key32(b.newAuthKey, 'newAuthKey');
      newWrappedPw = wrapped(b.newWrappedPw, 'newWrappedPw');
      deviceName = label(b.deviceName, 'deviceName');
    }
    await failGuard(env, username, ip, now);
    const row = await env.DB.prepare('SELECT * FROM accounts WHERE username = ?1').bind(username).first();
    if (!(await checkSecret(row, 'rec', recAuth))) { await failCount(env, username, ip, now); throw new HttpError(401, 'Wrong username or recovery key'); }
    if (!finish) return ok({ wrappedRec: row.wrapped_rec });
    // New password; every other device is signed out.
    const auth = await makeVerifier(newAuthKey);
    const s = await newSession(env, row.id, deviceName, now);
    await env.DB.batch([
      env.DB.prepare('UPDATE accounts SET auth_salt = ?2, auth_hash = ?3, wrapped_pw = ?4, updated_at = ?5 WHERE id = ?1').bind(row.id, auth.salt, auth.hash, newWrappedPw, now),
      env.DB.prepare('DELETE FROM sessions WHERE account_id = ?1').bind(row.id),
      s.stmt,
    ]);
    return ok({ accountId: row.id, username: row.username, token: s.token, sessionId: s.id, invited: !!row.invited });
  }

  if (path === '/api/passkey/login/options' && M === 'POST') {
    await rateLimit(env, 'pko:' + ip, L.rate.passkeyLogin, now);
    const { rpId } = rpOf(request);
    const c = await newChallenge(env, 'login', null, now);
    return ok({ challengeId: c.id, options: { challenge: c.challenge, rpId, allowCredentials: [], userVerification: 'required', timeout: L.challengeTtlMs } });
  }

  if (path === '/api/passkey/login' && M === 'POST') {
    await rateLimit(env, 'pkl:' + ip, L.rate.passkeyLogin, now);
    const b = await readObject(request, L.passkeyBody);
    const deviceName = label(b.deviceName, 'deviceName');
    const cred = b.credential;
    if (!cred || typeof cred !== 'object') throw bad('credential is required');
    const id = credId(cred.id);
    const { origin, rpId } = rpOf(request);
    const challenge = await takeChallenge(env, b.challengeId, 'login', null, now);
    const pk = await env.DB.prepare(
      'SELECT p.alg, p.jwk, p.sign_count, p.wrapped_prf, a.id AS account_id, a.username, a.wrapped_pw, a.invited FROM passkeys p JOIN accounts a ON a.id = p.account_id WHERE p.id = ?1',
    ).bind(id).first();
    if (!pk) throw new HttpError(401, 'Unknown passkey');
    const uh = cred.response && cred.response.userHandle;
    if (uh !== undefined && uh !== null && uh !== pk.account_id) throw new HttpError(401, 'Passkey does not match the account');
    let res;
    try {
      res = await verifyAssertion(cred, { alg: pk.alg, jwk: JSON.parse(pk.jwk), signCount: pk.sign_count }, { challenge, origin, rpId });
    } catch (e) {
      if (e instanceof WebAuthnError) throw new HttpError(401, e.message);
      throw e;
    }
    const s = await newSession(env, pk.account_id, deviceName, now);
    await env.DB.batch([
      env.DB.prepare('UPDATE passkeys SET sign_count = ?2, last_used = ?3 WHERE id = ?1').bind(id, res.signCount, now),
      s.stmt,
    ]);
    return ok({ accountId: pk.account_id, username: pk.username, token: s.token, sessionId: s.id, wrappedPw: pk.wrapped_pw, wrappedPrf: pk.wrapped_prf || null, invited: !!pk.invited });
  }

  // ----- Everything below needs a session -----
  const isAuthed = path === '/api/account' || path.startsWith('/api/account/') || path.startsWith('/api/passkey/');
  if (!isAuthed) return null;
  const { tokenHash, sessionId, account } = await authSession(request, env, now);
  const aid = account.id;

  if (path === '/api/passkey/register/options' && M === 'POST') {
    await rateLimit(env, 'pkr:' + aid, L.rate.passkeyRegister, now);
    const { rpId } = rpOf(request);
    const existing = (await env.DB.prepare('SELECT id FROM passkeys WHERE account_id = ?1').bind(aid).all()).results;
    if (existing.length >= L.maxPasskeys) throw new HttpError(409, `At most ${L.maxPasskeys} passkeys`);
    const c = await newChallenge(env, 'register', aid, now);
    return ok({
      challengeId: c.id,
      options: {
        challenge: c.challenge,
        rp: { id: rpId, name: 'Daily Tracker' },
        user: { id: aid, name: account.username, displayName: account.username }, // id: the account id's bytes (base64url)
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        timeout: L.challengeTtlMs,
        attestation: 'none',
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        excludeCredentials: existing.map((r) => ({ type: 'public-key', id: r.id })),
      },
    });
  }

  if (path === '/api/passkey/register' && M === 'POST') {
    await rateLimit(env, 'pkr:' + aid, L.rate.passkeyRegister, now);
    const b = await readObject(request, L.passkeyBody);
    const name = label(b.name, 'name');
    const wrappedPrf = b.wrappedPrf === undefined || b.wrappedPrf === null ? null : wrapped(b.wrappedPrf, 'wrappedPrf');
    if (!b.credential || typeof b.credential !== 'object') throw bad('credential is required');
    const { origin, rpId } = rpOf(request);
    const challenge = await takeChallenge(env, b.challengeId, 'register', aid, now);
    let reg;
    try { reg = await verifyRegistration(b.credential, { challenge, origin, rpId }); } catch (e) {
      if (e instanceof WebAuthnError) throw bad(e.message);
      throw e;
    }
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE account_id = ?1').bind(aid).first();
    if (n >= L.maxPasskeys) throw new HttpError(409, `At most ${L.maxPasskeys} passkeys`);
    const r = await env.DB.prepare(`INSERT INTO passkeys (id, account_id, alg, jwk, sign_count, wrapped_prf, name, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(id) DO NOTHING`)
      .bind(reg.id, aid, reg.alg, JSON.stringify(reg.jwk), reg.signCount, wrappedPrf, name, now).run();
    if (!r.meta.changes) throw new HttpError(409, 'This passkey is already registered');
    return ok({ ok: true, id: reg.id });
  }

  await rateLimit(env, 'acc:' + aid, L.rate.account, now);

  if (path === '/api/passkey/prf' && M === 'POST') {
    const b = await readObject(request, L.smallBody);
    const id = credId(b.id), wrappedPrf = wrapped(b.wrappedPrf, 'wrappedPrf');
    const r = await env.DB.prepare('UPDATE passkeys SET wrapped_prf = ?3 WHERE id = ?1 AND account_id = ?2').bind(id, aid, wrappedPrf).run();
    if (!r.meta.changes) throw new HttpError(404, 'Passkey not found');
    return ok({ ok: true });
  }

  if (path.startsWith('/api/passkey/') && M === 'DELETE') {
    const id = credId(path.slice('/api/passkey/'.length));
    const r = await env.DB.prepare('DELETE FROM passkeys WHERE id = ?1 AND account_id = ?2').bind(id, aid).run();
    if (!r.meta.changes) throw new HttpError(404, 'Passkey not found');
    return ok({ ok: true });
  }

  if (path === '/api/account' && M === 'GET') {
    const [pks, sess, files] = await env.DB.batch([
      env.DB.prepare('SELECT id, name, created_at, last_used, wrapped_prf IS NOT NULL AS prf FROM passkeys WHERE account_id = ?1 ORDER BY created_at').bind(aid),
      env.DB.prepare('SELECT id, device_name, created_at, last_seen FROM sessions WHERE account_id = ?1 ORDER BY last_seen DESC').bind(aid),
      env.DB.prepare('SELECT COUNT(*) AS n FROM files WHERE account_id = ?1').bind(aid),
    ]);
    return ok({
      accountId: aid, username: account.username, invited: !!account.invited, records: account.records, bytes: account.bytes, files: files.results[0]?.n ?? 0,
      passkeys: pks.results.map((p) => ({ id: p.id, name: p.name, createdAt: p.created_at, lastUsed: p.last_used ?? null, prf: !!p.prf })),
      sessions: sess.results.map((s) => ({ id: s.id, deviceName: s.device_name, createdAt: s.created_at, lastSeen: s.last_seen, current: s.id === sessionId })),
    });
  }

  if (path === '/api/account/logout' && M === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(tokenHash).run();
    return ok({ ok: true });
  }

  if (path.startsWith('/api/account/session/') && M === 'DELETE') {
    const id = path.slice('/api/account/session/'.length);
    if (!/^[A-Za-z0-9_-]{22}$/.test(id)) throw new HttpError(404, 'Session not found');
    const r = await env.DB.prepare('DELETE FROM sessions WHERE id = ?1 AND account_id = ?2').bind(id, aid).run();
    if (!r.meta.changes) throw new HttpError(404, 'Session not found');
    return ok({ ok: true, current: id === sessionId });
  }

  // Password-confirmed changes. A wrong password is 403 (the session itself is still fine).
  const confirm = async (b) => {
    const authKey = key32(b.authKey, 'authKey');
    await failGuard(env, account.username, ip, now);
    if (!(await checkSecret(account, 'auth', authKey))) { await failCount(env, account.username, ip, now); throw new HttpError(403, 'Wrong password'); }
  };

  if (path === '/api/account/password' && M === 'POST') {
    const b = await readObject(request, L.smallBody);
    const newAuthKey = key32(b.newAuthKey, 'newAuthKey'), newWrappedPw = wrapped(b.newWrappedPw, 'newWrappedPw');
    await confirm(b);
    const auth = await makeVerifier(newAuthKey);
    // Every other device is signed out (this session stays).
    await env.DB.batch([
      env.DB.prepare('UPDATE accounts SET auth_salt = ?2, auth_hash = ?3, wrapped_pw = ?4, updated_at = ?5 WHERE id = ?1')
        .bind(aid, auth.salt, auth.hash, newWrappedPw, now),
      env.DB.prepare('DELETE FROM sessions WHERE account_id = ?1 AND token_hash != ?2').bind(aid, tokenHash),
    ]);
    return ok({ ok: true });
  }

  if (path === '/api/account' && M === 'DELETE') {
    await confirm(await readObject(request, L.smallBody));
    await env.DB.batch([
      // The devices this account added for notifications go with it (register-key devices have account_id NULL).
      env.DB.prepare('DELETE FROM rules WHERE device_id IN (SELECT id FROM devices WHERE account_id = ?1)').bind(aid),
      env.DB.prepare('DELETE FROM fired WHERE device_id IN (SELECT id FROM devices WHERE account_id = ?1)').bind(aid),
      env.DB.prepare('DELETE FROM devices WHERE account_id = ?1').bind(aid),
      env.DB.prepare('DELETE FROM records WHERE account_id = ?1').bind(aid),
      env.DB.prepare('DELETE FROM file_chunks WHERE account_id = ?1').bind(aid),
      env.DB.prepare('DELETE FROM file_uploads WHERE account_id = ?1').bind(aid),
      env.DB.prepare('DELETE FROM files WHERE account_id = ?1').bind(aid),
      env.DB.prepare('DELETE FROM passkeys WHERE account_id = ?1').bind(aid),
      env.DB.prepare('DELETE FROM challenges WHERE account_id = ?1').bind(aid),
      env.DB.prepare('DELETE FROM sessions WHERE account_id = ?1').bind(aid),
      env.DB.prepare('DELETE FROM accounts WHERE id = ?1').bind(aid),
    ]);
    return ok({ ok: true });
  }

  return null;
}

/** Daily purge: expired challenges, sessions unused for 400 days. */
export async function purgeAccounts(env, now) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM challenges WHERE expires_at < ?1').bind(now),
    env.DB.prepare('DELETE FROM sessions WHERE last_seen < ?1').bind(now - L.sessionTtlMs),
  ]);
}
