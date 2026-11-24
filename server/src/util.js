// Shared Worker helpers: JSON responses, errors, body parsing, hashing, rate limiting.
import { b64urlEncode, utf8 } from './b64.js';

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

export const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
export const err = (status, message, headers, extra) => json({ error: message, ...(extra || {}) }, status, headers);

export async function readBytes(request, max) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > max) throw new HttpError(413, 'Request too large');
  const buf = await request.arrayBuffer();
  if (buf.byteLength > max) throw new HttpError(413, 'Request too large');
  return buf;
}
export async function readJson(request, max) {
  const buf = await readBytes(request, max);
  try { return JSON.parse(new TextDecoder().decode(buf)); } catch { throw new HttpError(400, 'Invalid JSON'); }
}
/** readJson, but the body must be a JSON object. */
export async function readObject(request, max) {
  const body = await readJson(request, max);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Body must be an object');
  return body;
}

export const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
export async function sha256Hex(str) {
  return hex(await crypto.subtle.digest('SHA-256', typeof str === 'string' ? utf8(str) : str));
}
/** Constant-time comparison of two strings (length is not secret). */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
export const randomId = (bytes) => b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
export const isStr = (v, max, min = 0) => typeof v === 'string' && v.length >= min && v.length <= max;

// ---------- Rate limiting (fixed one-hour windows in D1) ----------
/** Count one hit for `key`; 429 when the hour's count goes over `limit`. */
export async function rateLimit(env, key, limit, now) {
  const count = await rateBump(env, key, now);
  if (count > limit) throw new HttpError(429, 'Too many requests, try again later');
}
/** Count one hit for `key` and return the hour's count (no check). */
export async function rateBump(env, key, now) {
  const win = Math.floor(now / 3600000);
  const row = await env.DB.prepare(
    `INSERT INTO rate (key, win, count) VALUES (?1, ?2, 1)
     ON CONFLICT(key) DO UPDATE SET count = CASE WHEN rate.win = ?2 THEN rate.count + 1 ELSE 1 END, win = ?2
     RETURNING count`,
  ).bind(key, win).first();
  return row ? row.count : 1;
}
/** 429 if `key` already has `limit` hits this hour (does not count a hit). */
export async function rateCheck(env, key, limit, now) {
  const row = await env.DB.prepare('SELECT count FROM rate WHERE key = ?1 AND win = ?2').bind(key, Math.floor(now / 3600000)).first();
  if (row && row.count >= limit) throw new HttpError(429, 'Too many attempts, try again later');
}
