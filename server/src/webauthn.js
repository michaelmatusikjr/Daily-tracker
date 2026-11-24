// Minimal WebAuthn verification for passkeys (no libraries): a small CBOR decoder, COSE → JWK
// for ES256 and RS256, DER → raw ECDSA signatures, and registration / assertion checks.
// Attestation is "none": attStmt is ignored (we trust the credential the user's browser made).
import { b64urlEncode, b64urlDecode, utf8, concat } from './b64.js';

export class WebAuthnError extends Error {}
const fail = (m) => { throw new WebAuthnError(m); };

// ---------- CBOR (RFC 8949), definite lengths only ----------
/** Decode one CBOR item at `pos`. Returns { value, end }. Maps become Map objects. */
export function cborDecode(bytes, pos = 0, depth = 0) {
  if (depth > 16) fail('CBOR too deep');
  if (pos >= bytes.length) fail('CBOR truncated');
  const ib = bytes[pos++];
  const major = ib >> 5, info = ib & 0x1f;
  const need = (n) => { if (pos + n > bytes.length) fail('CBOR truncated'); };
  let arg;
  if (info < 24) arg = info;
  else if (info === 24) { need(1); arg = bytes[pos]; pos += 1; }
  else if (info === 25) { need(2); arg = (bytes[pos] << 8) | bytes[pos + 1]; pos += 2; }
  else if (info === 26) { need(4); arg = ((bytes[pos] << 24) >>> 0) + (bytes[pos + 1] << 16) + (bytes[pos + 2] << 8) + bytes[pos + 3]; pos += 4; }
  else if (info === 27) {
    need(8);
    const hi = ((bytes[pos] << 24) >>> 0) + (bytes[pos + 1] << 16) + (bytes[pos + 2] << 8) + bytes[pos + 3];
    const lo = ((bytes[pos + 4] << 24) >>> 0) + (bytes[pos + 5] << 16) + (bytes[pos + 6] << 8) + bytes[pos + 7];
    if (hi > 0x1fffff) fail('CBOR integer too large');
    arg = hi * 0x100000000 + lo; pos += 8;
  } else fail('CBOR indefinite lengths are not supported');
  switch (major) {
    case 0: return { value: arg, end: pos };
    case 1: return { value: -1 - arg, end: pos };
    case 2: need(arg); return { value: bytes.slice(pos, pos + arg), end: pos + arg };
    case 3: need(arg); return { value: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(pos, pos + arg)), end: pos + arg };
    case 4: {
      if (arg > 1000) fail('CBOR array too long');
      const out = [];
      for (let i = 0; i < arg; i++) { const r = cborDecode(bytes, pos, depth + 1); out.push(r.value); pos = r.end; }
      return { value: out, end: pos };
    }
    case 5: {
      if (arg > 1000) fail('CBOR map too long');
      const out = new Map();
      for (let i = 0; i < arg; i++) {
        const k = cborDecode(bytes, pos, depth + 1);
        const v = cborDecode(bytes, k.end, depth + 1);
        out.set(k.value, v.value); pos = v.end;
      }
      return { value: out, end: pos };
    }
    case 6: return cborDecode(bytes, pos, depth + 1); // tag: ignore, take the content
    case 7:
      if (info === 20) return { value: false, end: pos };
      if (info === 21) return { value: true, end: pos };
      if (info === 22 || info === 23) return { value: null, end: pos };
      fail('CBOR simple/float values are not supported');
  }
  fail('CBOR bad item');
}

// ---------- COSE keys ----------
const isBytes = (v, n) => v instanceof Uint8Array && (n === undefined || v.length === n);
/** COSE_Key map → { alg, jwk }. Only ES256 (EC2 P-256) and RS256 (RSA ≥ 2048 bits). */
export function coseToJwk(m) {
  if (!(m instanceof Map)) fail('Bad public key');
  const kty = m.get(1), alg = m.get(3);
  if (alg === -7) {
    if (kty !== 2 || m.get(-1) !== 1 || !isBytes(m.get(-2), 32) || !isBytes(m.get(-3), 32)) fail('Bad ES256 key');
    return { alg, jwk: { kty: 'EC', crv: 'P-256', x: b64urlEncode(m.get(-2)), y: b64urlEncode(m.get(-3)) } };
  }
  if (alg === -257) {
    const n = m.get(-1), e = m.get(-2);
    if (kty !== 3 || !isBytes(n) || !isBytes(e) || e.length < 1 || e.length > 8) fail('Bad RS256 key');
    let nb = n; while (nb.length && nb[0] === 0) nb = nb.subarray(1);
    if (nb.length < 256 || nb.length > 1024) fail('RSA key must be 2048–8192 bits');
    return { alg, jwk: { kty: 'RSA', n: b64urlEncode(nb), e: b64urlEncode(e) } };
  }
  fail('Unsupported key algorithm (use ES256 or RS256)');
}

function importJwk(alg, jwk) {
  if (alg === -7) return crypto.subtle.importKey('jwk', { ...jwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  if (alg === -257) return crypto.subtle.importKey('jwk', { ...jwk, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  fail('Unsupported key algorithm');
}

/** ASN.1 DER ECDSA signature (SEQUENCE { INTEGER r, INTEGER s }) → raw r‖s (64 bytes for P-256). */
export function derToRaw(der, size = 32) {
  const bad = () => fail('Bad signature');
  if (!(der instanceof Uint8Array) || der.length < 8 || der[0] !== 0x30) bad();
  let p = 2;
  if (der[1] & 0x80) { if (der[1] !== 0x81) bad(); p = 3; if (der[2] !== der.length - 3) bad(); } else if (der[1] !== der.length - 2) bad();
  const int = () => {
    if (der[p] !== 0x02) bad();
    const len = der[p + 1];
    if (!len || p + 2 + len > der.length) bad();
    let v = der.subarray(p + 2, p + 2 + len);
    p += 2 + len;
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    if (v.length > size) bad();
    const out = new Uint8Array(size); out.set(v, size - v.length); return out;
  };
  const r = int(), s = int();
  if (p !== der.length) bad();
  return concat(r, s);
}

// ---------- authenticatorData ----------
const FLAG_UP = 0x01, FLAG_UV = 0x04, FLAG_AT = 0x40;
/** Parse authenticatorData. With AT set, also the attested credential (id + COSE key). */
export function parseAuthData(ad) {
  if (!(ad instanceof Uint8Array) || ad.length < 37) fail('Bad authenticator data');
  const out = { rpIdHash: ad.subarray(0, 32), flags: ad[32], signCount: ((ad[33] << 24) >>> 0) + (ad[34] << 16) + (ad[35] << 8) + ad[36] };
  if (out.flags & FLAG_AT) {
    if (ad.length < 37 + 18) fail('Bad attested credential data');
    const idLen = (ad[53] << 8) | ad[54];
    if (idLen < 1 || idLen > 1023 || 55 + idLen > ad.length) fail('Bad credential id');
    out.credentialId = ad.slice(55, 55 + idLen);
    const key = cborDecode(ad, 55 + idLen);
    out.publicKey = key.value;
  }
  return out;
}

const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
const eqBytes = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i]; return r === 0; };
const dec = (s, what, max) => {
  if (typeof s !== 'string' || s.length > max) fail(`Bad ${what}`);
  try { return b64urlDecode(s); } catch { fail(`Bad ${what}`); }
};

/** Check clientDataJSON: type, challenge (b64url string), origin (exact), not cross-origin. */
function checkClientData(bytes, type, challenge, origin) {
  let cd;
  try { cd = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('Bad client data'); }
  if (!cd || cd.type !== type) fail('Wrong client data type');
  if (typeof cd.challenge !== 'string' || cd.challenge.replace(/=+$/, '') !== challenge) fail('Wrong or expired challenge');
  if (cd.origin !== origin) fail('Wrong origin');
  if (cd.crossOrigin === true) fail('Cross-origin passkey use is not allowed');
}
async function checkAuthData(a, rpId, { attested }) {
  if (!eqBytes(a.rpIdHash, await sha256(utf8(rpId)))) fail('Wrong relying party');
  if (!(a.flags & FLAG_UP)) fail('User presence is required');
  if (!(a.flags & FLAG_UV)) fail('User verification is required');
  if (attested && !(a.flags & FLAG_AT)) fail('No credential in the response');
}

/**
 * Verify a registration (navigator.credentials.create) response.
 * cred = { id, rawId?, type, response: { clientDataJSON, attestationObject } } (b64url fields).
 * Returns { id, alg, jwk, signCount }.
 */
export async function verifyRegistration(cred, { challenge, origin, rpId }) {
  if (!cred || typeof cred !== 'object' || !cred.response || typeof cred.response !== 'object') fail('Bad credential');
  if (cred.type !== undefined && cred.type !== 'public-key') fail('Bad credential type');
  const cdj = dec(cred.response.clientDataJSON, 'client data', 4096);
  checkClientData(cdj, 'webauthn.create', challenge, origin);
  const att = dec(cred.response.attestationObject, 'attestation object', 12000);
  let obj;
  try { obj = cborDecode(att).value; } catch (e) { fail(e instanceof WebAuthnError ? e.message : 'Bad attestation object'); }
  if (!(obj instanceof Map) || typeof obj.get('fmt') !== 'string' || !isBytes(obj.get('authData'))) fail('Bad attestation object');
  const a = parseAuthData(obj.get('authData'));
  await checkAuthData(a, rpId, { attested: true });
  const id = b64urlEncode(a.credentialId);
  if (cred.id !== id || (cred.rawId !== undefined && cred.rawId !== id)) fail('Credential id mismatch');
  const { alg, jwk } = coseToJwk(a.publicKey);
  try { await importJwk(alg, jwk); } catch (e) { fail(e instanceof WebAuthnError ? e.message : 'Bad public key'); }
  return { id, alg, jwk, signCount: a.signCount };
}

/**
 * Verify an assertion (navigator.credentials.get) response against a stored passkey
 * { alg, jwk, signCount }. Returns { signCount } (the new count to store).
 */
export async function verifyAssertion(cred, stored, { challenge, origin, rpId }) {
  if (!cred || typeof cred !== 'object' || !cred.response || typeof cred.response !== 'object') fail('Bad credential');
  if (cred.type !== undefined && cred.type !== 'public-key') fail('Bad credential type');
  const cdj = dec(cred.response.clientDataJSON, 'client data', 4096);
  checkClientData(cdj, 'webauthn.get', challenge, origin);
  const ad = dec(cred.response.authenticatorData, 'authenticator data', 4096);
  const a = parseAuthData(ad);
  await checkAuthData(a, rpId, { attested: false });
  let sig = dec(cred.response.signature, 'signature', 2048);
  const key = await importJwk(stored.alg, stored.jwk);
  const signed = concat(ad, await sha256(cdj));
  let ok;
  if (stored.alg === -7) {
    sig = derToRaw(sig);
    ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, signed);
  } else {
    ok = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, sig, signed);
  }
  if (!ok) fail('Bad signature');
  // A counter that doesn't go up means a cloned authenticator (0 = the authenticator doesn't count).
  if ((a.signCount !== 0 || stored.signCount !== 0) && a.signCount <= stored.signCount) fail('Passkey sign count went backwards');
  return { signCount: a.signCount };
}
