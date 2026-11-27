// End-to-end encryption for sync (SYNC.md › Crypto). WebCrypto only.
// The password never leaves the device: PBKDF2 turns it into authKey (sent to the server instead)
// and kek (wraps the account's random dataKey). encKey/macKey are derived from dataKey and kept in
// IndexedDB as NON-extractable CryptoKeys; dataKey itself is only held in memory while needed.
const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => {
  if (!globalThis.crypto?.subtle) throw new Error('This browser can’t encrypt data here (it needs a secure https:// page).');
  return crypto.subtle;
};

export const PBKDF2_ITERATIONS = 600000;
const INFO = {
  recovery: 'daily-tracker/v1/recovery',
  prfKek: 'daily-tracker/v1/prf-kek',
  enc: 'daily-tracker/v1/enc',
  rid: 'daily-tracker/v1/rid',
};
export const PRF_INPUT = enc.encode('daily-tracker/v1/prf');

// ---------- encodings ----------
export function b64u(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('Not base64url');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** RFC 4648 base32, no padding. */
export function base32(bytes) {
  let out = '', bits = 0, val = 0;
  for (const b of bytes) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
export function unbase32(s) {
  const out = [];
  let bits = 0, val = 0;
  for (const ch of s) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Not base32');
    val = ((val << 5) | i) & 0xffff; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Uint8Array.from(out);
}

export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

// ---------- usernames ----------
/** Trimmed, lower-cased; null unless 3–40 of [a-z0-9._-]. */
export function normUsername(u) {
  const x = String(u || '').trim().toLowerCase();
  return /^[a-z0-9._-]{3,40}$/.test(x) ? x : null;
}
export async function usernameSalt(uname) {
  return new Uint8Array(await subtle().digest('SHA-256', enc.encode('daily-tracker/v1/' + uname)));
}

// ---------- key derivation ----------
async function hkdfBits(ikm, salt, info, bits) {
  const k = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) }, k, bits));
}
const aesKey = (raw, usages = ['encrypt', 'decrypt']) => subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, usages);

/** Password → { authKey (b64url, sent to the server), kek (CryptoKey) }. */
export async function fromPassword(uname, password, iterations = PBKDF2_ITERATIONS) {
  const salt = await usernameSalt(uname);
  const base = await subtle().importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 512));
  const out = { authKey: b64u(bits.slice(0, 32)), kek: await aesKey(bits.slice(32)) };
  bits.fill(0);
  return out;
}

/**
 * Household (Google) sign-in link: the same two halves as fromPassword, but the kek as raw bytes (b64url)
 * so the household server can hand it to the household's other devices. Never the password itself.
 */
export async function linkKeys(uname, password, iterations = PBKDF2_ITERATIONS) {
  const salt = await usernameSalt(uname);
  const base = await subtle().importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 512));
  const out = { authKey: b64u(bits.slice(0, 32)), kek: b64u(bits.slice(32)) };
  bits.fill(0);
  return out;
}
/** A linked kek (b64url, 32 bytes) → CryptoKey; null when malformed. */
export async function importKek(b64) {
  try { const raw = unb64u(b64); if (raw.length !== 32) return null; const k = await aesKey(raw); raw.fill(0); return k; } catch { return null; }
}

/** Recovery key bytes → { recAuth (b64url), recKek (CryptoKey) }. */
export async function fromRecovery(uname, recBytes) {
  const bits = await hkdfBits(recBytes, await usernameSalt(uname), INFO.recovery, 512);
  const out = { recAuth: b64u(bits.slice(0, 32)), recKek: await aesKey(bits.slice(32)) };
  bits.fill(0);
  return out;
}

/** Passkey PRF output → prfKek (CryptoKey). */
export async function fromPrf(uname, prfOutput) {
  const bits = await hkdfBits(new Uint8Array(prfOutput), await usernameSalt(uname), INFO.prfKek, 256);
  const k = await aesKey(bits);
  bits.fill(0);
  return k;
}

// ---------- wrapping ----------
/** AES-256-GCM wrap of the 32-byte dataKey: b64url(iv12 || ciphertext+tag) = 60 bytes. */
export async function wrap(kek, dataKey) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, kek, dataKey));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return b64u(out);
}
/** Unwrap; null when the key is wrong (the GCM tag doesn't verify) or the input is malformed. */
export async function unwrap(kek, wrapped) {
  try {
    const b = unb64u(wrapped);
    if (b.length !== 60) return null;
    const pt = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, kek, b.slice(12)));
    return pt.length === 32 ? pt : null;
  } catch { return null; }
}

// ---------- recovery key ----------
/** 32 random bytes as 52 base32 characters in groups of 4. */
export function formatRecovery(bytes) {
  return base32(bytes).match(/.{1,4}/g).join(' ');
}
/** Parse what the user typed (spaces, dashes and case ignored). null when it isn't a recovery key. */
export function parseRecovery(text) {
  const s = String(text || '').toUpperCase().replace(/[\s-]+/g, '').replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B');
  if (!/^[A-Z2-7]{52}$/.test(s)) return null;
  try {
    const b = unbase32(s);
    return b.length === 32 ? b : null;
  } catch { return null; }
}

// ---------- data keys ----------
/** dataKey bytes → { encKey, macKey }, both non-extractable. */
export async function dataKeys(dataKey) {
  const base = await subtle().importKey('raw', dataKey, 'HKDF', false, ['deriveKey']);
  const salt = new Uint8Array(0);
  const encKey = await subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(INFO.enc) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const macKey = await subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(INFO.rid) }, base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
  return { encKey, macKey };
}

/** rid = b64url(HMAC-SHA-256(macKey, k)). */
export async function ridOf(macKey, k) {
  return b64u(await subtle().sign('HMAC', macKey, enc.encode(k)));
}

/** A fingerprint of the keys (HMAC of a constant), to check that an unwrapped dataKey is this account's. */
export const keyCheck = (macKey) => ridOf(macKey, 'daily-tracker/v1/key-check');

/** blob = b64url(iv12 || AES-GCM(encKey, JSON(record), aad = rid)). */
export async function encryptRecord(encKey, rid, rec) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(rid) }, encKey, enc.encode(JSON.stringify(rec))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return b64u(out);
}
/** The record inside a blob, or null when it can't be decrypted (wrong key, tampered, wrong rid). */
export async function decryptRecord(encKey, rid, blob) {
  try {
    const b = unb64u(blob);
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: b.slice(0, 12), additionalData: enc.encode(rid) }, encKey, b.slice(12));
    return JSON.parse(dec.decode(pt));
  } catch { return null; }
}

// ---------- photo files (SYNC.md › Phase 2: photos) ----------
/**
 * fid = b64url(HMAC-SHA-256(macKey, "f:" + pid + "/" + photoId)). Record keys never contain ':' in
 * their first segment, so an fid can never equal a rid. Bound to the profile, so two profiles that
 * refer to the same local photo id still have separate files in the account.
 */
export const fileIdOf = (macKey, pid, photoId) => ridOf(macKey, `f:${pid}/${photoId}`);
/** iv12 || AES-GCM(encKey, bytes, aad = UTF-8 fid). */
export async function encryptFile(encKey, fid, bytes) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(fid) }, encKey, bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return out;
}
/** The plaintext bytes, or null when it doesn't decrypt (wrong key, tampered, another fid's file). */
export async function decryptFile(encKey, fid, bytes) {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.length < 28) return null;
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: enc.encode(fid) }, encKey, bytes.slice(12)));
  } catch { return null; }
}

// ---------- key storage (IndexedDB dailyTracker-sync) ----------
const DB_NAME = 'dailyTracker-sync';
const STORES = ['keys', 'shadow'];
let dbp = null;
export function syncDb() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => { for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s); };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbp = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('IndexedDB unavailable'));
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}
export async function idb(store, mode, fn) {
  const db = await syncDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error || new Error('IndexedDB error'));
    t.onabort = () => reject(t.error || new Error('IndexedDB write was aborted (storage full?)'));
  });
}

/** { accountId, encKey, macKey, check, wrappedPw? } for the signed-in account. */
export const saveKeys = (rec) => idb('keys', 'readwrite', (s) => s.put(rec, 'current'));
export const loadKeys = () => idb('keys', 'readonly', (s) => s.get('current')).catch(() => null);
export const clearKeys = () => idb('keys', 'readwrite', (s) => s.delete('current'));
