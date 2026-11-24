// Accounts and sync, phase 1 (SYNC.md). One household account holds any number of profiles; each
// synced profile is flattened into small records ("<pid>/task/<id>", …) that are encrypted on the
// device and pushed to the Worker. Latest edit wins per record ((t, dev) compared).
//
// Data safety rules this file keeps:
//  - Nothing is ever deleted because it is missing: only explicit tombstones (a record with v = null)
//    delete, and a profile disappears only through a remote "<pid>/meta" tombstone.
//  - A profile whose data can't be read (or whose data key is missing) is never diffed, so it can
//    never produce tombstones; remote changes for it wait (full re-pull once it is readable again).
//  - Remote values are validated with the store's normalizers; a record that fails is skipped.
//  - Applying remote data saves first; when the save fails nothing else (shadow, cursor) moves on.
//  - Local edits are diffed (synchronously) right before remote records are applied, so an edit is
//    never folded into the shadow without being queued for upload.
import { PUSH_SERVER_URL } from './pushConfig.js';
import { pushConfig, scheduleSync as schedulePush } from './push.js';
import { reschedule } from './notify.js';
import {
  SCHEMA_VERSION, getProfiles, getActiveProfile, subscribe, readProfileForSync, applyRemoteProfile, addRemoteProfile,
  updateProfileRemote, removeProfileLocal, reIdProfile, migrate, normalize, defaultState, defaultSettings,
  normalizers, hashStr, uid, ensureStored, readProfileState, mutateProfileData,
} from './store.js';
import { isValidKey } from './dates.js';
import * as C from './syncCrypto.js';
import { deleteProfileFiles, copyProfileFiles, deleteFiles } from './attachments.js';

const STATE_KEY = 'dailyTracker:sync';
const DEBOUNCE_MS = 1500;
const EVERY_MS = 60000;
const BACKOFF = [5000, 30000, 120000, 600000];
const PUSH_MAX = 500;
const PUSH_BYTES = 3.5 * 1024 * 1024;
const BLOB_MAX = 262144;
const FETCH_TIMEOUT = 30000;
// Top-level settings that belong to this device, not the profile (never synced).
export const DEVICE_ONLY_SETTINGS = new Set(['notifications', 'onboarded']);

// ---------- persisted state (localStorage, shared by tabs) ----------
// { dev, accountId, username, token, sessionId, serverUrl, synced: [pid], cursor, full, fresh: {pid: 1},
//   deletes: {pid: t}, waitReadable: {pid: 1}, merge: {pid: 1}, offset, lastOk, error, paused: {sv}, expired,
//   locked, signingOut, pulled (a full pull completed for this account), known: {pid: name | null}
//   (profiles the account has a meta record for; null = deleted), kept: {pid: accountId} (copies kept
//   at sign-out, each with its preserved shadow in IndexedDB under "kept:<pid>"; kept across sign-outs),
//   keptDeletes: {pid: {a: accountId, t}} (profile deletes still to push when signing in to that account
//   again), refusedDeletes: {pid: 1} (profile deletes the server refused twice: still pending),
//   cantSync: {tooLarge, refused, deletes} (counts of what can't be uploaded, for Settings › Account),
//   resumed: {pid: 1} (kept copies resumed at sign-in whose first full pull hasn't been applied yet: an
//   account delete of one leaves it here as device-only instead of deleting it) }
function readState() { try { const s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); return s && typeof s === 'object' ? s : {}; } catch { return {}; } }
function writeState(s) { try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); return true; } catch { return false; } }
/** Read-modify-write (another tab may have written in between). */
function patchState(patch) { const s = { ...readState(), ...(typeof patch === 'function' ? patch(readState()) : patch) }; writeState(s); return s; }
export const syncState = readState;

function deviceId() {
  let s = readState();
  if (!/^[A-Za-z0-9_-]{22}$/.test(s.dev || '')) s = patchState({ dev: C.b64u(C.randomBytes(16)) });
  return s.dev;
}

const listeners = new Set();
export function onSyncChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const changed = () => listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });

// ---------- who is signed in / what syncs ----------
export function serverUrl() {
  try { return pushConfig().serverUrl; } catch { return String(PUSH_SERVER_URL || '').replace(/\/+$/, ''); }
}
/** Accounts need a server (the reminders one). Without one the app stays fully local and says nothing. */
export const accountsAvailable = () => !!serverUrl();
export const isSignedIn = () => !!readState().token;
/** Signed in to an account on this device (also while the session expired or keys are locked). */
export const hasAccount = () => !!readState().accountId;
export const isSynced = (pid) => hasAccount() && (readState().synced || []).includes(pid);
/** Shown as "On this device only": every profile that isn't synced (also before anyone signed in). */
export const isDeviceOnly = (pid) => accountsAvailable() && !isSynced(pid);
export const syncedIds = () => (hasAccount() ? (readState().synced || []).filter((id) => getProfiles().some((p) => p.id === id)) : []);

const nameKey = (n) => String(n || '').trim().toLowerCase();
/** The synced profile (other than exceptId) whose name matches, or null. Names are unique in an account. */
export function accountNameClash(name, exceptId = null) {
  const k = nameKey(name);
  const ids = new Set(syncedIds());
  const local = getProfiles().find((p) => p.id !== exceptId && ids.has(p.id) && nameKey(p.name) === k);
  if (local) return local;
  // Account profiles that aren't on this device (e.g. couldn't be stored here).
  for (const [pid, n] of Object.entries(readState().known || {})) {
    if (pid !== exceptId && !ids.has(pid) && typeof n === 'string' && nameKey(n) === k) return { id: pid, name: n };
  }
  return null;
}
/** Device profiles can be added to the account only once the account was downloaded completely. */
export const canSyncProfiles = () => { const s = readState(); return !!s.token && !s.locked && !s.paused && !!s.pulled; };

// ---------- server calls ----------
export class SyncError extends Error { constructor(status, message) { super(message); this.status = status; } }
let clockOffset = Number(readState().offset) || 0;
const serverNow = () => Date.now() + clockOffset;
function noteNow(now) {
  if (!Number.isFinite(now)) return;
  const o = now - Date.now();
  clockOffset = Math.abs(o - clockOffset) > 300000 ? o : Math.round(clockOffset * 0.7 + o * 0.3);
}

async function api(method, path, body, { token = null, headers = {}, url = null } = {}) {
  const base = url || readState().serverUrl || serverUrl();
  if (!base) throw new SyncError(0, 'No server is set up');
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = 'Bearer ' + token;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), FETCH_TIMEOUT) : null;
  let res;
  try {
    res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), mode: 'cors', credentials: 'omit', signal: ctl?.signal });
  } catch {
    throw new SyncError(0, navigator.onLine === false ? 'offline' : 'network');
  } finally { clearTimeout(timer); }
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (data && Number.isFinite(data.now)) noteNow(data.now);
  if (!res.ok) throw new SyncError(res.status, data?.error || `HTTP ${res.status}`);
  return data || {};
}
/** Signed-in call; a 401 means the session is gone: signed out, local data kept. */
async function authed(method, path, body) {
  const s = readState();
  if (!s.token) throw new SyncError(401, 'Not signed in');
  try { return await api(method, path, body, { token: s.token }); } catch (e) {
    if (e.status === 401 && readState().token === s.token) sessionEnded();
    throw e;
  }
}

/** Plain words for errors shown in the Account UI. */
export function plainError(e) {
  const m = String(e?.message || e || '');
  if (e?.status === 0) return m === 'offline' ? 'You’re offline' : 'Can’t reach the server';
  if (/Origin not allowed/.test(m)) return `The server doesn’t allow this app’s address (${location.origin})`;
  if (/Too many/.test(m)) return 'Too many attempts – try again later';
  if (e?.status >= 500 && !/Account limit|REGISTER_KEY/.test(m)) return 'The server had a problem – try again shortly';
  return m || 'Something went wrong';
}

function deviceName() {
  const ua = navigator.userAgent || '';
  const dev = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${dev} · ${br}`;
}

// ---------- flatten ----------
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
const hashOf = (v) => hashStr(canon(v));

/**
 * A profile as records: Map k → v. The meta record holds only the name and avatar: the profile list's
 * order is per device (cosmetic), so reordering never writes a meta record – a meta record with a newer
 * time than a profile delete therefore always means a real edit (rename/avatar), see SYNC.md.
 */
export function flatten(pid, meta, s) {
  const m = new Map();
  m.set(`${pid}/meta`, { name: meta.name, avatar: meta.avatar });
  for (const t of s.tasks) m.set(`${pid}/task/${t.id}`, t);
  for (const x of s.habits) m.set(`${pid}/habit/${x.id}`, x);
  s.categories.forEach((c, i) => m.set(`${pid}/cat/${c.id}`, { id: c.id, name: c.name, color: c.color, order: i }));
  for (const e of s.exercises) m.set(`${pid}/ex/${e.id}`, e);
  for (const w of s.workouts) m.set(`${pid}/wo/${w.id}`, w);
  for (const [hid, days] of Object.entries(s.logs || {})) for (const [d, v] of Object.entries(days || {})) m.set(`${pid}/log/${hid}/${d}`, v);
  for (const [hid, days] of Object.entries(s.autoHabit || {})) for (const d of Object.keys(days || {})) m.set(`${pid}/auto/${hid}/${d}`, true);
  for (const [d, e] of Object.entries(s.journal || {})) m.set(`${pid}/journal/${d}`, e);
  for (const [k, v] of Object.entries(s.settings || {})) if (!DEVICE_ONLY_SETTINGS.has(k) && v !== undefined) m.set(`${pid}/set/${k}`, v);
  return m;
}

const KEY_RE = /^([A-Za-z0-9_-]{1,40})\/(meta|task|habit|cat|ex|wo|log|auto|journal|set)(?:\/(.+))?$/;
const DATED_RE = /^(.+)\/(\d{4}-\d{2}-\d{2})$/;
/** k → { pid, kind, id, date } or null. */
export function parseKey(k) {
  const m = typeof k === 'string' ? KEY_RE.exec(k) : null;
  if (!m) return null;
  const [, pid, kind, rest] = m;
  if (kind === 'meta') return rest === undefined ? { pid, kind } : null;
  if (!rest) return null;
  if (kind === 'log' || kind === 'auto') {
    const d = DATED_RE.exec(rest);
    return d && isValidKey(d[2]) ? { pid, kind, id: d[1], date: d[2] } : null;
  }
  if (kind === 'journal') return isValidKey(rest) ? { pid, kind, date: rest } : null;
  return { pid, kind, id: rest };
}

const COLL = { task: 'tasks', habit: 'habits', ex: 'exercises', wo: 'workouts' };
/**
 * Validate a remote value with the import normalizers. Values written by an older schema are
 * migrated first. Returns { ok, v } (v = null for a tombstone).
 */
export function validateValue(p, v, sv) {
  if (v === null) return { ok: true, v: null };
  const version = Number.isInteger(sv) && sv >= 1 ? sv : SCHEMA_VERSION;
  try {
    switch (p.kind) {
      case 'meta': {
        if (!isObj(v) || typeof v.name !== 'string' || !v.name.trim()) return { ok: false };
        return { ok: true, v: { name: v.name.trim().slice(0, 40), avatar: normalizers.avatar(v.avatar) } }; // an older record's `order` is ignored
      }
      case 'task': case 'habit': case 'ex': case 'wo': {
        if (!isObj(v) || v.id !== p.id) return { ok: false };
        const coll = COLL[p.kind];
        const data = { version, [coll]: [v] };
        if (p.kind === 'wo') data.exercises = [{ id: v.exerciseId, name: 'x', type: 'strength' }];
        const out = migrate(data)[coll].find((x) => x.id === p.id);
        return out ? { ok: true, v: out } : { ok: false };
      }
      case 'cat': {
        if (!isObj(v) || v.id !== p.id || typeof v.name !== 'string' || !v.name.trim()) return { ok: false };
        return { ok: true, v: { id: p.id, name: v.name.trim().slice(0, 40), color: /^#[0-9a-f]{6}$/i.test(v.color) ? v.color : '#64748b', order: Number.isFinite(v.order) ? v.order : 0 } };
      }
      case 'log': return Number.isFinite(v) && v > 0 ? { ok: true, v: Math.min(v, 9999) } : { ok: false };
      case 'auto': return v === true ? { ok: true, v: true } : { ok: false };
      case 'journal': {
        const j = migrate({ version, journal: { [p.date]: v } }).journal[p.date];
        return j ? { ok: true, v: j } : { ok: false };
      }
      case 'set': {
        if (DEVICE_ONLY_SETTINGS.has(p.id) || !(p.id in defaultSettings())) return { ok: false };
        const s = migrate({ version, settings: { [p.id]: v } }).settings[p.id];
        return s === undefined ? { ok: false } : { ok: true, v: s };
      }
      default: return { ok: false };
    }
  } catch { return { ok: false }; }
}

/** A fresh base for a profile rebuilt from the account: no example categories, onboarded. */
function emptyBase() {
  const s = defaultState();
  s.categories = [];
  s.settings.onboarded = true;
  return s;
}

/** Apply validated records ({ p, v }) to a copy of state s. Returns the normalized result. */
function applyRecords(s, recs) {
  const next = JSON.parse(JSON.stringify(s));
  const maps = {};
  const mapOf = (coll) => maps[coll] || (maps[coll] = new Map(next[coll].map((x, i) => [x.id, { x, i }])));
  const catOrder = new Map();
  for (const { p, v } of recs) {
    if (COLL[p.kind] || p.kind === 'cat') {
      const coll = COLL[p.kind] || 'categories';
      const m = mapOf(coll);
      if (v === null) m.delete(p.id);
      else {
        const cur = m.get(p.id);
        const val = p.kind === 'cat' ? { id: v.id, name: v.name, color: v.color } : v;
        if (p.kind === 'cat') catOrder.set(p.id, v.order);
        m.set(p.id, { x: val, i: cur ? cur.i : Infinity });
      }
    } else if (p.kind === 'log' || p.kind === 'auto') {
      const field = p.kind === 'log' ? 'logs' : 'autoHabit';
      const days = next[field][p.id] || (next[field][p.id] = {});
      if (v === null) { delete days[p.date]; if (!Object.keys(days).length && p.kind === 'auto') delete next[field][p.id]; }
      else days[p.date] = v;
    } else if (p.kind === 'journal') {
      if (v === null) delete next.journal[p.date]; else next.journal[p.date] = v;
    } else if (p.kind === 'set') {
      if (v === null) next.settings[p.id] = defaultSettings()[p.id]; else next.settings[p.id] = v;
    }
  }
  for (const [coll, m] of Object.entries(maps)) {
    const list = [...m.values()].map((e, n) => ({ ...e, n }));
    list.sort((a, b) => (a.i === b.i ? a.n - b.n : a.i - b.i));
    next[coll] = list.map((e) => e.x);
  }
  if (catOrder.size) {
    const ord = (c, i) => (catOrder.has(c.id) ? catOrder.get(c.id) : i);
    next.categories = next.categories.map((c, i) => ({ c, o: ord(c, i), i })).sort((a, b) => a.o - b.o || a.i - b.i).map((x) => x.c);
  }
  return normalize(next);
}

// ---------- shadows (IndexedDB dailyTracker-sync › shadow, one entry per profile) ----------
// { [k]: [hash | null, t, dev, pending 0/1] }
const loadShadow = (pid) => C.idb('shadow', 'readonly', (s) => s.get(pid)).then((x) => (isObj(x) ? x : {}));
const saveShadow = (pid, sh) => C.idb('shadow', 'readwrite', (s) => s.put(sh, pid));
const dropShadow = (pid) => C.idb('shadow', 'readwrite', (s) => s.delete(pid)).catch(() => {});
// Shadows preserved at a "Keep copies" sign-out live in the same store under "kept:<pid>" (pids never
// contain ':'): { accountId, shadow, merge?, wait? }. Clearing the live shadows never touches them.
const KEPT = 'kept:';
const loadKept = (pid) => C.idb('shadow', 'readonly', (s) => s.get(KEPT + pid)).then((x) => (isObj(x) ? x : null)).catch(() => null);
const saveKept = (pid, rec) => C.idb('shadow', 'readwrite', (s) => s.put(rec, KEPT + pid));
const dropKept = (pid) => C.idb('shadow', 'readwrite', (s) => s.delete(KEPT + pid)).catch(() => {});
const clearShadows = () => C.idb('shadow', 'readwrite', (s) => {
  s.delete(IDBKeyRange.upperBound(KEPT, true)); // every key before "kept:"
  return s.delete(IDBKeyRange.lowerBound('kept;')); // …and after "kept:\uffff"
}).catch(() => {});
const newer = (t1, d1, t2, d2) => t1 > t2 || (t1 === t2 && String(d1) > String(d2));

// rid cache (k ↔ rid) for this page and these keys.
let ridCache = { keysRef: null, byK: new Map(), byRid: new Map() };
async function ridFor(keys, k) {
  if (ridCache.keysRef !== keys) ridCache = { keysRef: keys, byK: new Map(), byRid: new Map() };
  let r = ridCache.byK.get(k);
  if (!r) { r = await C.ridOf(keys.macKey, k); ridCache.byK.set(k, r); ridCache.byRid.set(r, k); }
  return r;
}

// ---------- the sync cycle ----------
let epoch = 0;
let running = null;
let again = false;
let debounceTimer = null, retryTimer = null, attempt = 0;
let keysMem = null; // { accountId, encKey, macKey, check, wrappedPw }
let progress = null; // { phase, n } while downloading/uploading
let lastError = null; // plain words for the last failed cycle (also offline), for sign-in
const triedRefused = new Set(); // refused records (k) / profile deletes (pid) already tried again since the app started
class Aborted extends Error {}

async function getKeys() {
  const s = readState();
  if (keysMem && keysMem.accountId === s.accountId) return keysMem;
  const k = await C.loadKeys();
  keysMem = k && k.accountId === s.accountId ? k : null;
  return keysMem;
}

/** Run fn while holding the cross-tab sync lock (navigator.locks, else a localStorage lease). */
async function withLock(fn) {
  if (navigator.locks?.request) return navigator.locks.request('dailyTracker-sync', fn);
  const LEASE = 'dailyTracker:sync:lease';
  const me = uid();
  for (let i = 0; i < 120; i++) {
    let l = null;
    try { l = JSON.parse(localStorage.getItem(LEASE) || 'null'); } catch { /* ignore */ }
    if (!l || l.until < Date.now() || l.id === me) {
      try { localStorage.setItem(LEASE, JSON.stringify({ id: me, until: Date.now() + 90000 })); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 50));
      try { l = JSON.parse(localStorage.getItem(LEASE) || 'null'); } catch { l = null; }
      if (l?.id === me) {
        try { return await fn(); } finally { try { if (JSON.parse(localStorage.getItem(LEASE) || 'null')?.id === me) localStorage.removeItem(LEASE); } catch { /* ignore */ } }
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new SyncError(0, 'Another window is syncing');
}

/** Ask for a sync soon (debounced). */
export function scheduleSync(delay = DEBOUNCE_MS) {
  if (!isSignedIn()) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { syncNow().catch(() => {}); }, delay);
}

/** Sync now (pull, then push). Resolves true when everything is up to date. */
export async function syncNow() {
  if (!isSignedIn()) return false;
  clearTimeout(debounceTimer);
  if (running) { again = true; return running; }
  running = (async () => {
    let ok = false;
    try {
      do { again = false; ok = await withLock(() => cycle()); } while (again && isSignedIn());
    } finally { running = null; }
    return ok;
  })();
  return running;
}

function checkAlive(my, token) {
  const s = readState();
  if (my !== epoch || s.token !== token || s.signingOut) throw new Aborted();
}

async function cycle() {
  const my = epoch;
  let s = readState();
  if (!s.token || s.signingOut) return false;
  const token = s.token;
  if (s.paused) {
    if (s.paused.sv <= SCHEMA_VERSION) s = patchState({ paused: null });
    else { changed(); return false; }
  }
  const keys = await getKeys();
  checkAlive(my, token);
  if (!keys) { if (!s.locked) patchState({ locked: true }); changed(); return false; }
  const dev = deviceId();
  try {
    const result = await runCycle(my, token, keys, dev);
    checkAlive(my, token);
    attempt = 0; clearTimeout(retryTimer); lastError = null;
    patchState({ lastOk: Date.now(), error: null, offset: clockOffset });
    progress = null; changed();
    if (result.appliedOther) { schedulePush(); reschedule(); }
    return true;
  } catch (e) {
    progress = null;
    if (e instanceof Aborted) return false;
    if (e?.paused) { changed(); return false; }
    if (e?.status === 401) { changed(); return false; }
    const offline = e?.status === 0;
    lastError = plainError(e);
    if (readState().token === token) patchState({ error: offline ? null : plainError(e), offline, offset: clockOffset });
    console.warn('Sync failed:', e?.message || e);
    changed();
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => scheduleSync(0), BACKOFF[Math.min(attempt++, BACKOFF.length - 1)]);
    return false;
  }
}

/** Profiles that sync, readable or not: { pid, meta, data|null }. */
function syncedProfiles(s) {
  const ids = new Set(s.synced || []);
  const list = getProfiles().filter((p) => ids.has(p.id));
  return list.map((p) => ({ pid: p.id, meta: p, data: readProfileForSync(p.id) }));
}

async function runCycle(my, token, keys, dev) {
  // Copies kept at a sign-out from this same account carry on with their preserved shadows.
  await resumeKept(my, token);
  let s = readState();
  const appliedOther = { v: false };
  // Synced profiles that vanished from this device without an explicit delete are downloaded again.
  const local = new Set(getProfiles().map((p) => p.id));
  const missing = (s.synced || []).filter((id) => !local.has(id) && !(s.deletes || {})[id]);
  if (missing.length) s = patchState((x) => ({ fresh: { ...(x.fresh || {}), ...Object.fromEntries(missing.map((id) => [id, 1])) }, full: true }));
  // A profile that was unreadable while remote changes arrived and is readable again: what's on this
  // device now is unknown (not what the shadow describes), so never diff it against the old shadow
  // (that could tombstone the account's data). Merge instead: empty shadow, full pull, remote wins
  // where both have a record, records only here are uploaded, nothing is deleted.
  // "Start fresh" on a synced profile (older versions marked it `fresh`): what's on this device now
  // (possibly new edits) is merged with the account's copy, never replaced by it.
  const freshHere = Object.keys(s.fresh || {}).filter((id) => local.has(id));
  if (freshHere.length) {
    for (const id of freshHere) await dropShadow(id);
    s = patchState((x) => ({ full: true, merge: { ...(x.merge || {}), ...Object.fromEntries(freshHere.map((id) => [id, 1])) }, fresh: Object.fromEntries(Object.entries(x.fresh || {}).filter(([id]) => !freshHere.includes(id))) }));
  }
  const nowReadable = Object.keys(s.waitReadable || {}).filter((id) => readProfileForSync(id));
  if (nowReadable.length) {
    for (const id of nowReadable) await dropShadow(id);
    s = patchState((x) => ({ full: true, merge: { ...(x.merge || {}), ...Object.fromEntries(nowReadable.map((id) => [id, 1])) }, waitReadable: Object.fromEntries(Object.entries(x.waitReadable || {}).filter(([id]) => !nowReadable.includes(id))) }));
  }

  // ---- timestamp local edits first, before any network call: an edit made offline keeps (about) its
  // edit time instead of the time the device came back online ----
  let shadows = await loadShadows(readState());
  checkAlive(my, token);
  const touched = diffAll(readState(), shadows, dev);
  for (const pid of touched) await saveShadow(pid, shadows.get(pid));
  checkAlive(my, token);
  // ---- pull (all pages), then apply; a partial pull that finds new profiles is followed by a full one ----
  for (let round = 0; round < 3; round++) {
    s = readState();
    const full = !!s.full || !(s.cursor > 0);
    const { records, seq } = await pullAll(my, token, full ? 0 : s.cursor);
    checkAlive(my, token);
    const incoming = await decryptAll(my, token, keys, records, full);
    checkAlive(my, token);
    if (full) await moveClashingProfiles(my, token, incoming);
    shadows = await loadShadows(readState());
    checkAlive(my, token);
    // ---- synchronous: diff local edits, then apply remote ones (no await in between) ----
    const res = applyIncoming(incoming, full, dev, shadows, appliedOther);
    for (const pid of res.dropped) await dropShadow(pid);
    for (const pid of res.dirty) await saveShadow(pid, shadows.get(pid));
    for (const pid of res.keptGone) await dropKept(pid);
    checkAlive(my, token);
    // The cursor only moves on when everything that arrived was stored.
    if (res.cursorOk) patchState(res.needFull ? { full: true, ...(full ? {} : { cursor: seq }) } : { cursor: seq, full: false });
    // A complete download: from now on this device's own profiles may be added to the account.
    if (full && res.cursorOk) patchState({ pulled: true });
    if (!res.needFull || !res.cursorOk) break;
  }
  await pushPending(my, token, keys, dev, shadows);
  return { appliedOther: appliedOther.v };
}

/**
 * Signing in to an account again: each copy kept at sign-out from this account resumes with the shadow
 * preserved then (so edits made while signed out are diffed normally and pending ones are uploaded;
 * latest edit wins against the account, never "account wins"). A kept marker without a preserved shadow
 * (older data) is dropped: if the account has that profile id, the copy then stays here under a new id
 * (see moveClashingProfiles), so nothing is lost. Profile deletes still pending at sign-out are restored.
 */
const pick = (o, ids) => Object.fromEntries(Object.entries(o).filter(([id]) => ids.includes(id)));
async function resumeKept(my, token) {
  const s = readState();
  const acc = s.accountId;
  const kept = s.kept || {}, kd = s.keptDeletes || {};
  const mine = Object.keys(kept).filter((pid) => kept[pid] === acc);
  const myDel = Object.keys(kd).filter((pid) => kd[pid] && kd[pid].a === acc);
  if (!acc || (!mine.length && !myDel.length)) return;
  const local = new Set(getProfiles().map((p) => p.id));
  const synced = new Set(s.synced || []);
  const add = [], merge = {}, wait = {}, dels = {};
  for (const pid of mine) {
    const rec = await loadKept(pid);
    if (!rec || rec.accountId !== acc || !isObj(rec.shadow) || !local.has(pid) || synced.has(pid)) continue;
    await saveShadow(pid, rec.shadow);
    add.push(pid);
    if (rec.merge) merge[pid] = 1;
    if (rec.wait) wait[pid] = 1;
  }
  for (const pid of myDel) {
    if (local.has(pid) || synced.has(pid)) continue;
    const rec = await loadKept(pid);
    if (rec && rec.accountId === acc && isObj(rec.shadow)) await saveShadow(pid, rec.shadow);
    dels[pid] = kd[pid].t;
  }
  checkAlive(my, token);
  let live = add;
  patchState((x) => {
    // A Reset / Start fresh / delete (forgetKept) may have landed during the awaits above: only resume
    // copies whose marker still exists, so an emptied copy can never tombstone the account.
    live = add.filter((pid) => (x.kept || {})[pid] === acc);
    const k = { ...(x.kept || {}) }, d = { ...(x.keptDeletes || {}) };
    for (const pid of mine) if (k[pid] === acc) delete k[pid];
    for (const pid of myDel) if (d[pid]?.a === acc) delete d[pid];
    return {
      kept: k, keptDeletes: d, full: true,
      synced: [...new Set([...(x.synced || []), ...live])],
      // Until a full pull has been applied: a delete from the account doesn't delete these copies here.
      resumed: { ...(x.resumed || {}), ...Object.fromEntries(live.map((pid) => [pid, 1])) },
      merge: { ...(x.merge || {}), ...pick(merge, live) }, waitReadable: { ...(x.waitReadable || {}), ...pick(wait, live) },
      deletes: { ...dels, ...(x.deletes || {}) },
    };
  });
  for (const pid of add) if (!live.includes(pid)) await dropShadow(pid);
  for (const pid of [...mine, ...myDel]) await dropKept(pid);
}

/**
 * Before leaving an account (Keep copies sign-out, or signing in to another account while this one's
 * session ended): preserve each synced profile's shadow (with its pending outbox) and the pending
 * profile deletes, marked with this account's id. Returns { kept, keptDeletes } for the state; a
 * profile whose shadow couldn't be preserved gets no marker (it is then never merged, only copied).
 */
async function preserveForAccount(s) {
  const kept = {}, keptDeletes = {};
  if (!s.accountId) return { kept, keptDeletes };
  const local = new Set(getProfiles().map((p) => p.id));
  const merge = s.merge || {}, fresh = s.fresh || {}, wait = s.waitReadable || {};
  for (const pid of s.synced || []) {
    if (!local.has(pid)) continue;
    try {
      const shadow = await loadShadow(pid);
      await saveKept(pid, { accountId: s.accountId, shadow, ...(merge[pid] || fresh[pid] ? { merge: 1 } : {}), ...(wait[pid] ? { wait: 1 } : {}) });
      kept[pid] = s.accountId;
    } catch { /* no marker: never merged later */ }
  }
  for (const [pid, t] of Object.entries(s.deletes || {})) {
    if (local.has(pid)) continue;
    try {
      const shadow = await loadShadow(pid).catch(() => ({}));
      await saveKept(pid, { accountId: s.accountId, shadow });
    } catch { /* the tombstone time falls back to the delete time */ }
    keptDeletes[pid] = { a: s.accountId, t };
  }
  return { kept, keptDeletes };
}

/**
 * Edit time: (offset-corrected) now, or 1 more than the record's previous time, so a new edit always
 * wins over the previous one – even when that one has a time ahead of now (e.g. a device whose clock
 * was fast) – up to 23 hours ahead (the server refuses times more than a day ahead). Only when the
 * previous time is beyond that does the edit get now (it may then lose to that record).
 */
const FUTURE_CAP = 23 * 3600000;
function nextT(e) {
  const now = Math.round(serverNow());
  const after = (e ? e[1] : 0) + 1;
  return after > now + FUTURE_CAP ? now : Math.max(now, after);
}
/** Record local edits of one profile in its shadow (new/changed → pending, gone → pending tombstone). */
function diffProfile(pid, meta, data, sh, dev) {
  const pre = flatten(pid, meta, data);
  let changedHere = false;
  for (const [k, v] of pre) {
    const h = hashOf(v), e = sh[k];
    if (!e || e[0] !== h) { sh[k] = [h, nextT(e), dev, 1]; changedHere = true; }
  }
  for (const k of Object.keys(sh)) if (!pre.has(k) && sh[k][0] !== null) { sh[k] = [null, nextT(sh[k]), dev, 1]; changedHere = true; }
  return changedHere;
}
/** Diff every readable synced profile (never an unreadable or to-be-downloaded one). Returns the pids changed. */
function diffAll(s, shadows, dev) {
  const out = new Set();
  const fresh = s.fresh || {}, merge = s.merge || {};
  for (const prof of syncedProfiles(s)) {
    if (!prof.data || fresh[prof.pid] || merge[prof.pid]) continue;
    const sh = shadows.get(prof.pid) || {};
    shadows.set(prof.pid, sh);
    if (diffProfile(prof.pid, prof.meta, prof.data, sh, dev)) out.add(prof.pid);
  }
  return out;
}

/**
 * Before applying a full pull: a device-only profile with the id of an account profile (copies kept
 * from this same account were resumed before, see resumeKept) stays on this device under a new id. Its photos are copied (not moved),
 * so the account's copy keeps them too.
 */
async function moveClashingProfiles(my, token, incoming) {
  const s = readState();
  const synced = new Set(s.synced || []), deletes = s.deletes || {};
  for (const r of incoming.values()) {
    if (r.p.kind !== 'meta' || r.v === null) continue;
    const pid = r.p.pid;
    if (synced.has(pid) || deletes[pid] || !getProfiles().some((p) => p.id === pid)) continue;
    await reIdWithPhotos(pid);
    checkAlive(my, token);
  }
}
/** Give a device profile a new id; its photos are copied to the new id. Returns the new id or null. */
async function reIdWithPhotos(pid) {
  const nid = 'p' + uid();
  const data = readProfileState(pid);
  let map = new Map();
  try { map = await copyProfileFiles(data, nid); } catch { map = new Map(); }
  if (!reIdProfile(pid, nid)) { deleteFiles([...map.values()]).catch(() => {}); return null; }
  if (map.size && !mutateProfileData(nid, (st) => { for (const t of st.tasks) for (const a of t.attachments || []) if (map.has(a.id)) a.id = map.get(a.id); })) {
    deleteFiles([...map.values()]).catch(() => {}); // the copy keeps pointing at the original files
  }
  patchState((x) => { const k = { ...(x.kept || {}) }; delete k[pid]; return { kept: k }; });
  await dropKept(pid);
  return nid;
}

async function loadShadows(s) {
  const m = new Map();
  for (const pid of s.synced || []) m.set(pid, await loadShadow(pid));
  return m;
}

async function pullAll(my, token, since) {
  const all = [];
  let seq = since;
  for (let page = 0; page < 10000; page++) {
    const r = await authed('GET', `/api/sync/pull?since=${seq}&limit=1000`);
    checkAlive(my, token);
    const recs = Array.isArray(r.records) ? r.records : [];
    all.push(...recs);
    if (recs.length) { progress = { phase: 'down', n: all.length }; changed(); }
    if (!Number.isSafeInteger(r.seq) || r.seq < seq) throw new SyncError(500, 'Bad answer from the server');
    seq = r.seq;
    if (!r.more) break;
  }
  return { records: all, seq };
}

/** Decrypt what's needed. Returns Map k → { p, v, t, dev } (latest per key), or throws { paused }. */
async function decryptAll(my, token, keys, records, full) {
  const s = readState();
  const fresh = s.fresh || {};
  const shadowCache = new Map();
  const shadowFor = async (pid) => { if (!shadowCache.has(pid)) shadowCache.set(pid, await loadShadow(pid).catch(() => ({}))); return shadowCache.get(pid); };
  const out = new Map();
  let maxSv = 0;
  for (const r of records) {
    if (!r || typeof r.rid !== 'string' || typeof r.blob !== 'string') continue;
    // Known key and not newer than what we have: skip without decrypting (our own echoes, mostly).
    const known = ridCache.keysRef === keys ? ridCache.byRid.get(r.rid) : null;
    if (known && !full) {
      const pk = parseKey(known);
      const e = pk && !fresh[pk.pid] ? (await shadowFor(pk.pid))[known] : null;
      if (e && !newer(r.t, r.dev, e[1], e[2])) continue;
    }
    const rec = await C.decryptRecord(keys.encKey, r.rid, r.blob);
    if (!rec || typeof rec.k !== 'string' || rec.t !== r.t || rec.dev !== r.dev || (await ridFor(keys, rec.k)) !== r.rid) {
      console.warn('Sync: skipped a record that could not be read');
      continue;
    }
    if (Number.isInteger(rec.sv) && rec.sv > SCHEMA_VERSION) { maxSv = Math.max(maxSv, rec.sv); continue; }
    const p = parseKey(rec.k);
    if (!p) { console.warn('Sync: skipped a record with an unknown key'); continue; }
    const val = validateValue(p, rec.v === undefined ? null : rec.v, rec.sv);
    if (!val.ok) { console.warn('Sync: skipped a record that failed validation', p.kind); continue; }
    const prev = out.get(rec.k);
    if (!prev || newer(rec.t, rec.dev, prev.t, prev.dev)) out.set(rec.k, { p, v: val.v, t: rec.t, dev: rec.dev });
    if (out.size % 500 === 0) checkAlive(my, token);
  }
  if (maxSv) {
    // Written by a newer app version: stop syncing until this app is updated (nothing applied).
    patchState({ paused: { sv: maxSv } });
    const err = new Error('paused'); err.paused = true; throw err;
  }
  return out;
}

/**
 * The synchronous part of a cycle: diff local edits into the shadows, then apply remote records that
 * are newer. Returns { needFull, cursorOk, dirty: Set pid, dropped: Set pid }.
 */
function applyIncoming(incoming, full, dev, shadows, appliedOther) {
  const s = readState();
  const synced = new Set(s.synced || []);
  const fresh = { ...(s.fresh || {}) };
  const deletes = s.deletes || {};
  const waitReadable = { ...(s.waitReadable || {}) };
  const merge = { ...(s.merge || {}) };
  const kept = { ...(s.kept || {}) };
  const resumed = { ...(s.resumed || {}) };
  const known = full ? {} : { ...(s.known || {}) };
  for (const r of incoming.values()) if (r.p.kind === 'meta') known[r.p.pid] = r.v ? r.v.name : null;
  const dirty = new Set(), dropped = new Set(), keptGone = new Set();
  let needFull = false, cursorOk = true;
  const byPid = new Map();
  for (const [k, r] of incoming) {
    const e = { ...r, k };
    if (!byPid.has(r.p.pid)) byPid.set(r.p.pid, []);
    byPid.get(r.p.pid).push(e);
  }
  const localIds = () => new Set(getProfiles().map((p) => p.id));
  const forget = (pid) => { synced.delete(pid); delete fresh[pid]; delete waitReadable[pid]; shadows.delete(pid); dropped.add(pid); dirty.delete(pid); };

  /** Shadow after applying: applied keys take the remote (t, dev); normalization drift is never pushed. */
  const settle = (sh, post, applied) => {
    for (const [k, v] of post) {
      const h = hashOf(v), a = applied.get(k), e = sh[k];
      if (a) sh[k] = [h, a.t, a.dev, 0];
      else if (!e) sh[k] = [h, 0, '', 0];
      else if (e[0] !== h) sh[k] = [h, e[1], e[2], e[3]];
    }
    for (const k of Object.keys(sh)) if (!post.has(k) && (applied.has(k) || sh[k][0] !== null)) delete sh[k];
  };
  const dataOf = (recs) => recs.filter((r) => r.p.kind !== 'meta');

  /** Create (or rebuild) a profile from the account's records. Only on a full pull, so nothing is missing. */
  const build = (pid, recs, meta) => {
    const data = applyRecords(emptyBase(), dataOf(recs));
    const exists = localIds().has(pid);
    const ok = exists ? applyRemoteProfile(pid, data) && (!meta || updateProfileRemote(pid, meta.v)) : addRemoteProfile({ id: pid, name: meta.v.name, avatar: meta.v.avatar, data });
    if (!ok) { cursorOk = false; return false; }
    synced.add(pid); delete fresh[pid];
    if (kept[pid]) { delete kept[pid]; keptGone.add(pid); } // syncs to this account now
    const sh = {};
    const applied = new Map(recs.map((r) => [r.k, r]));
    const prof = getProfiles().find((p) => p.id === pid);
    settle(sh, flatten(pid, prof, data), applied);
    shadows.set(pid, sh); dirty.add(pid);
    appliedOther.v = true;
    return true;
  };

  // 1. Profiles to rebuild from the account (they went missing here, or their data was reset).
  for (const pid of Object.keys(fresh)) {
    if (!synced.has(pid)) { delete fresh[pid]; continue; }
    if (!full) { needFull = true; continue; }
    const recs = byPid.get(pid) || [];
    const meta = recs.find((r) => r.p.kind === 'meta');
    if (meta && meta.v === null) {
      const unreadable = localIds().has(pid) && !readProfileForSync(pid);
      if (localIds().has(pid) && !removeProfileLocal(pid, { keepBackups: unreadable })) { cursorOk = false; continue; }
      if (!unreadable) deleteProfileFiles(pid);
      forget(pid); appliedOther.v = true; continue;
    }
    if (!meta && !localIds().has(pid)) { forget(pid); continue; } // not in the account: nothing to download
    if (localIds().has(pid)) { merge[pid] = 1; delete fresh[pid]; dropped.add(pid); shadows.set(pid, {}); continue; } // merged in step 3
    build(pid, recs, meta);
  }

  // 2. Account profiles this device doesn't sync yet: download them.
  for (const [pid, recs] of byPid) {
    if (synced.has(pid) || deletes[pid]) continue;
    const meta = recs.find((r) => r.p.kind === 'meta');
    if (!meta || meta.v === null) continue; // deleted, or data without a profile: nothing to create
    if (!full) { needFull = true; continue; }
    if (localIds().has(pid)) {
      // A device-only profile with the same id (a copy kept from another account, a kept copy without
      // a preserved shadow, or the same backup imported on two devices) stays here under a new id
      // (normally done before, with its photos copied). Kept copies are never merged account-wins.
      const nid = 'p' + uid();
      if (!reIdProfile(pid, nid)) { cursorOk = false; continue; }
      delete kept[pid]; keptGone.add(pid);
    }
    build(pid, recs, meta);
  }

  // 3. Synced profiles: local edits first, then newer remote records.
  for (const pid of [...synced]) {
    if (fresh[pid] || dirty.has(pid)) continue;
    if (!localIds().has(pid)) continue; // handled next cycle (downloaded again)
    const recs = byPid.get(pid) || [];
    const sh = shadows.get(pid) || {};
    shadows.set(pid, sh);
    const metaRec = recs.find((r) => r.p.kind === 'meta');
    if (metaRec && metaRec.v === null && (!sh[metaRec.k] || newer(metaRec.t, metaRec.dev, sh[metaRec.k][1], sh[metaRec.k][2]))) {
      if (resumed[pid]) {
        // A copy the user chose to keep at sign-out, deleted from the account (on another device) while
        // signed out: it may hold edits made since, so it stays here as a device-only profile (with its
        // photos) and stops syncing. Synced again later, it gets a new id (the account deleted this one).
        forget(pid);
        continue;
      }
      // Deleted in the account (on another device): delete it here too, with its photos. Unreadable
      // data keeps its raw backup (it can't be known what it holds).
      const unreadable = !readProfileForSync(pid);
      if (!removeProfileLocal(pid, { keepBackups: unreadable })) { cursorOk = false; continue; }
      if (!unreadable) deleteProfileFiles(pid);
      forget(pid);
      appliedOther.v = true;
      continue;
    }
    const data = readProfileForSync(pid);
    if (!data) { if (recs.length) waitReadable[pid] = 1; continue; } // unreadable: never diffed, never applied
    const prof = getProfiles().find((p) => p.id === pid);
    if (merge[pid]) {
      // Readable again (see runCycle): apply everything the account has, then upload what's only here.
      if (!full) { needFull = true; continue; }
      const dataRecs = dataOf(recs);
      const next = dataRecs.length ? applyRecords(data, dataRecs) : data;
      if (dataRecs.length && !applyRemoteProfile(pid, next)) { cursorOk = false; continue; }
      const metaR = recs.find((r) => r.p.kind === 'meta' && r.v);
      if (metaR) updateProfileRemote(pid, metaR.v);
      const post = flatten(pid, getProfiles().find((p) => p.id === pid), next);
      for (const r of recs) if (post.has(r.k)) sh[r.k] = [hashOf(post.get(r.k)), r.t, r.dev, 0];
      diffProfile(pid, getProfiles().find((p) => p.id === pid), next, sh, dev);
      delete merge[pid];
      dirty.add(pid);
      if (pid !== getActiveProfile()?.id) appliedOther.v = true;
      continue;
    }
    // Edits made while the pull was in flight are recorded before anything remote is applied.
    const changedHere = diffProfile(pid, prof, data, sh, dev);
    const win = recs.filter((r) => { const e = sh[r.k]; return !e || newer(r.t, r.dev, e[1], e[2]); });
    if (changedHere) dirty.add(pid);
    if (!win.length) continue;
    let next = data;
    const applied = new Map();
    const dataWin = dataOf(win);
    if (dataWin.length) {
      next = applyRecords(data, dataWin);
      if (!applyRemoteProfile(pid, next)) { cursorOk = false; continue; } // storage full: try again later
      dataWin.forEach((r) => applied.set(r.k, r));
      if (pid !== getActiveProfile()?.id) appliedOther.v = true;
    }
    const metaWin = win.find((r) => r.p.kind === 'meta');
    if (metaWin) {
      if (updateProfileRemote(pid, metaWin.v)) applied.set(metaWin.k, metaWin); else cursorOk = false;
    }
    settle(sh, flatten(pid, getProfiles().find((p) => p.id === pid), next), applied);
    dirty.add(pid);
  }

  for (const id of Object.keys(merge)) if (!synced.has(id)) delete merge[id];
  for (const id of Object.keys(kept)) if (!localIds().has(id) || synced.has(id)) { delete kept[id]; keptGone.add(id); }
  // Resumed copies are ordinary synced profiles once a full pull was applied to them.
  for (const id of Object.keys(resumed)) if (!synced.has(id) || (full && cursorOk)) delete resumed[id];
  patchState({ synced: [...synced], fresh, waitReadable, merge, kept, known, resumed });
  return { needFull, cursorOk, dirty, dropped, keptGone };
}

/** Upload every pending record (in batches). Shadows are updated as batches are accepted. */
async function pushPending(my, token, keys, dev, shadows) {
  const s = readState();
  const items = [];
  for (const prof of syncedProfiles(s)) {
    if (!prof.data) continue; // unreadable: its pending edits wait
    const sh = shadows.get(prof.pid) || await loadShadow(prof.pid);
    shadows.set(prof.pid, sh);
    const flat = flatten(prof.pid, prof.meta, prof.data);
    for (const [k, e] of Object.entries(sh)) {
      // Refused twice before (pending = 3): tried again once per app start, otherwise set aside.
      if (e[3] === 3 && !triedRefused.has(k)) triedRefused.add(k);
      else if (e[3] !== 1) continue;
      const v = e[0] === null ? null : flat.get(k);
      if (e[0] !== null && (v === undefined || hashOf(v) !== e[0])) continue; // edited again: next cycle
      items.push({ pid: prof.pid, k, v, t: e[1], dev: e[2] });
    }
  }
  const refusedDel = s.refusedDeletes || {};
  for (const [pid, t0] of Object.entries(s.deletes || {})) {
    // Refused twice before: still pending (shown in Settings › Account); tried again once per app start.
    if (refusedDel[pid]) { if (triedRefused.has(pid)) continue; triedRefused.add(pid); }
    // The tombstone must be newer than the last meta record this device knew (its shadow is kept
    // until the delete is uploaded): t = max(now, meta t + 1).
    const mt = (await loadShadow(pid).catch(() => ({})))[`${pid}/meta`]?.[1] || 0;
    let t = t0;
    if (t <= mt) {
      t = mt + 1;
      patchState((x) => ((x.deletes || {})[pid] === t0 ? { deletes: { ...x.deletes, [pid]: t } } : {}));
    }
    items.push({ pid, k: `${pid}/meta`, v: null, t, dev, del: true });
  }
  if (!items.length) { noteCantSync(shadows); return; }
  progress = { phase: 'up', n: 0, of: items.length }; changed();
  let batch = [], bytes = 0, done = 0;
  const encode = async (it) => {
    const rid = await ridFor(keys, it.k);
    const blob = await C.encryptRecord(keys.encKey, rid, { k: it.k, v: it.v, t: it.t, dev: it.dev, sv: SCHEMA_VERSION });
    return { rid, t: it.t, dev: it.dev, blob };
  };
  /**
   * The server refused records[i] (e.g. a time too far ahead): give it a new time once, else set it
   * aside – a record as "can't sync" (pending = 3, like too large: kept here, counted, shown), a profile
   * delete stays pending (refusedDeletes) and is shown, never silently dropped.
   */
  const fixRefused = async (i, retried) => {
    const b = batch[i];
    const sh = shadows.get(b.pid);
    if (retried.has(i)) {
      console.warn('Sync: the server refused a record; it stays on this device', b.k.split('/')[1]);
      if (b.del) patchState((x) => ({ refusedDeletes: { ...(x.refusedDeletes || {}), [b.pid]: 1 } }));
      else if (sh?.[b.k] && sh[b.k][1] === b.t) { sh[b.k][3] = 3; await saveShadow(b.pid, sh); }
      batch.splice(i, 1);
      const r = new Map();
      for (const j of retried) if (j !== i) r.set(j > i ? j - 1 : j, true);
      retried.clear(); for (const j of r.keys()) retried.add(j);
      return;
    }
    retried.add(i);
    const t = Math.round(serverNow());
    if (b.del) patchState((x) => ((x.deletes || {})[b.pid] === b.t ? { deletes: { ...x.deletes, [b.pid]: t } } : {}));
    else if (sh?.[b.k] && sh[b.k][1] === b.t && sh[b.k][2] === b.dev) { sh[b.k] = [sh[b.k][0], t, dev, sh[b.k][3]]; await saveShadow(b.pid, sh); }
    else { batch.splice(i, 1); retried.delete(i); return; } // changed meanwhile: next cycle
    const it = { ...b, t, dev };
    batch[i] = { ...it, rec: await encode(it) };
  };
  const flush = async () => {
    if (!batch.length) return;
    const retried = new Set();
    let res;
    for (;;) {
      if (!batch.length) return;
      try { res = await authed('POST', '/api/sync/push', { records: batch.map((b) => b.rec) }); break; } catch (e) {
        const m = e?.status === 400 && /records\[(\d+)\]/.exec(e.message || '');
        const i = m ? Number(m[1]) : -1;
        if (!(i >= 0 && i < batch.length)) throw e;
        checkAlive(my, token);
        await fixRefused(i, retried);
        checkAlive(my, token);
      }
    }
    checkAlive(my, token);
    void res;
    const touched = new Set();
    const st = readState();
    const dels = { ...(st.deletes || {}) };
    const refusedD = { ...(st.refusedDeletes || {}) };
    for (const b of batch) {
      if (b.del) { delete refusedD[b.pid]; if (dels[b.pid] === b.t) { delete dels[b.pid]; if (!(st.synced || []).includes(b.pid)) await dropShadow(b.pid); } continue; }
      const sh = shadows.get(b.pid);
      const e = sh?.[b.k];
      // Accepted or stale (the server kept a newer copy, which the next pull brings): no longer pending.
      if (e && e[1] === b.t && e[2] === b.dev) { if (e[0] === null) delete sh[b.k]; else e[3] = 0; touched.add(b.pid); }
    }
    for (const pid of touched) await saveShadow(pid, shadows.get(pid));
    checkAlive(my, token);
    patchState({ deletes: dels, refusedDeletes: refusedD });
    done += batch.length;
    progress = { phase: 'up', n: done, of: items.length }; changed();
    batch = []; bytes = 0;
  };
  for (const it of items) {
    const rec = await encode(it);
    const { blob } = rec;
    if (blob.length > BLOB_MAX) {
      console.warn('Sync: a record is too large to upload and stays on this device', it.k.split('/')[1]);
      const e = shadows.get(it.pid)?.[it.k];
      if (e) { e[3] = 2; await saveShadow(it.pid, shadows.get(it.pid)); }
      continue;
    }
    const n = blob.length + 120;
    if (batch.length >= PUSH_MAX || (batch.length && bytes + n > PUSH_BYTES)) await flush();
    batch.push({ ...it, rec });
    bytes += n;
  }
  await flush();
  noteCantSync(shadows);
}

/** Count what can't be uploaded (too large, refused twice) for Settings › Account. */
function noteCantSync(shadows) {
  const s = readState();
  const out = { tooLarge: 0, refused: 0, deletes: Object.keys(s.refusedDeletes || {}).filter((pid) => (s.deletes || {})[pid]).length };
  for (const pid of s.synced || []) {
    for (const e of Object.values(shadows.get(pid) || {})) { if (e[3] === 2) out.tooLarge++; else if (e[3] === 3) out.refused++; }
  }
  const prev = s.cantSync || {};
  if (prev.tooLarge !== out.tooLarge || prev.refused !== out.refused || prev.deletes !== out.deletes) { patchState({ cantSync: out }); changed(); }
}
/** Plain words for what can't be uploaded (null when everything can). */
export function cantSyncNote() {
  const c = { ...(readState().cantSync || {}) };
  const parts = [];
  c.tooLarge = c.tooLarge || 0; c.refused = c.refused || 0;
  if (c.tooLarge) parts.push(`${c.tooLarge.toLocaleString()} item${c.tooLarge === 1 ? ' is' : 's are'} too large to sync`);
  if (c.refused) parts.push(`${c.refused.toLocaleString()} item${c.refused === 1 ? ' was' : 's were'} refused by the server`);
  if (c.deletes) parts.push(`${c.deletes === 1 ? 'a profile deletion was' : `${c.deletes} profile deletions were`} refused by the server`);
  if (!parts.length) return null;
  const tail = [];
  if (c.tooLarge) tail.push(`Too-large items stay on this device only (editing one tries again).`);
  if (c.refused || c.deletes) tail.push(`What the server refused is kept here and tried again when the app starts.`);
  return `Couldn’t sync: ${parts.join(', ')}. ${tail.join(' ')}`;
}
// ---------- state changes from the UI ----------
/**
 * Start syncing these device profiles. Only after the account was downloaded completely (so it is
 * known which profiles it has). A profile whose id the account already has is merged (the account's
 * records win, records only here are uploaded); one whose id the account deleted gets a new id first.
 * Anything else starts from an empty shadow: everything is uploaded. Returns false when refused.
 */
export async function syncProfiles(ids) {
  let s = readState();
  if (!s.accountId || !canSyncProfiles()) return false;
  const add = [], merged = [];
  for (const id0 of ids) {
    let id = id0;
    if (!getProfiles().some((p) => p.id === id) || (readState().synced || []).includes(id)) continue;
    const known = s.known || {};
    if (Object.prototype.hasOwnProperty.call(known, id)) {
      if (known[id] === null) { id = await reIdWithPhotos(id); if (!id) continue; } // deleted in the account: a new profile
      else { merged.push(id); continue; }
    }
    add.push(id);
  }
  add.forEach(ensureStored);
  for (const id of [...add, ...merged]) { await dropShadow(id); await dropKept(id); } // start from an empty shadow
  const now = [...add, ...merged];
  s = patchState((x) => ({
    // It syncs to this account now: a marker (and shadow) kept from another account no longer applies.
    kept: Object.fromEntries(Object.entries(x.kept || {}).filter(([id]) => !now.includes(id))),
    synced: [...new Set([...(x.synced || []), ...add, ...merged])],
    ...(merged.length ? { full: true, merge: { ...(x.merge || {}), ...Object.fromEntries(merged.map((id) => [id, 1])) } } : {}),
  }));
  changed();
  scheduleSync(0);
  return true;
}

/**
 * These device profiles' data was replaced or cleared wholesale (an import, "Reset data" or "Start
 * fresh" while signed out, or the profile was deleted): a copy kept from an account no longer matches
 * its preserved shadow, so it is never resumed (on signing in again it stays here under a new id beside
 * the account's copy – nothing in the account is reverted or tombstoned).
 */
export async function forgetKept(ids) {
  const s = readState();
  const hit = ids.filter((id) => (s.kept || {})[id]);
  if (!hit.length) return;
  patchState((x) => ({ kept: Object.fromEntries(Object.entries(x.kept || {}).filter(([id]) => !hit.includes(id))) }));
  for (const id of hit) await dropKept(id);
}

/** The user deleted a synced profile: delete it from the account (and so every device). */
export function profileDeleted(pid) {
  const s = readState();
  if (!(s.synced || []).includes(pid)) return;
  // The shadow stays until the tombstone is uploaded (its meta time makes the tombstone newer).
  patchState((x) => ({ synced: (x.synced || []).filter((id) => id !== pid), deletes: { ...(x.deletes || {}), [pid]: Math.round(serverNow()) }, fresh: Object.fromEntries(Object.entries(x.fresh || {}).filter(([k]) => k !== pid)), merge: Object.fromEntries(Object.entries(x.merge || {}).filter(([k]) => k !== pid)) }));
  changed();
  scheduleSync(0);
}

/**
 * A synced profile's unreadable data was reset on this device ("Start fresh"): merge the account's
 * copy into it (account wins, new edits made here are uploaded) instead of uploading the empty data.
 */
export function profileReset(pid) {
  if (!isSynced(pid)) return false;
  patchState((x) => ({ merge: { ...(x.merge || {}), [pid]: 1 }, full: true, waitReadable: Object.fromEntries(Object.entries(x.waitReadable || {}).filter(([k]) => k !== pid)) }));
  dropShadow(pid);
  scheduleSync(0);
  return true;
}

// ---------- status ----------
export function syncProgress() { return progress; }

/** { kind, text } for Settings › Account (null when signed out). */
export function syncStatus() {
  const s = readState();
  if (!s.accountId) return null;
  if (s.paused) return { kind: 'update', text: 'Update the app to keep syncing. Another device uses a newer version.' };
  if (s.expired || !s.token) return { kind: 'expired', text: 'You were signed out of your account. Sign in again to keep syncing – everything is still on this device.' };
  if (s.locked) return { kind: 'locked', text: 'Enter your password or recovery key to finish signing in on this device.' };
  if (progress?.phase === 'down') return { kind: 'busy', text: `Downloading… ${progress.n.toLocaleString()} item${progress.n === 1 ? '' : 's'}` };
  if (progress?.phase === 'up') return { kind: 'busy', text: `Uploading… ${progress.n.toLocaleString()} of ${progress.of.toLocaleString()}` };
  if (navigator.onLine === false || s.offline) return { kind: 'offline', text: 'Offline – changes will sync' };
  if (s.error) return { kind: 'error', text: `Couldn’t sync: ${s.error}. Retrying automatically.` };
  if (!s.lastOk) return { kind: 'busy', text: 'Syncing…' };
  return { kind: 'ok', text: syncedAgo(s.lastOk) };
}
function syncedAgo(at) {
  const d = Date.now() - at;
  if (d < 90000) return 'Synced just now';
  if (d < 3600000) return `Synced ${Math.round(d / 60000)} min ago`;
  const dt = new Date(at);
  const today = new Date().toDateString() === dt.toDateString();
  const time = dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return today ? `Synced at ${time}` : `Synced ${dt.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

// ---------- signing in / out ----------
let flowKey = null, flowTimer = null; // dataKey bytes, only for the minutes right after signing in
function holdKey(dk) {
  flowKey = dk;
  clearTimeout(flowTimer);
  flowTimer = setTimeout(() => { flowKey?.fill(0); flowKey = null; }, 15 * 60000);
}
export const hasFlowKey = () => !!flowKey;

async function storeKeys(accountId, dataKey, wrappedPw) {
  const { encKey, macKey } = await C.dataKeys(dataKey);
  const check = await C.keyCheck(macKey);
  const rec = { accountId, encKey, macKey, check, ...(wrappedPw ? { wrappedPw } : {}) };
  await C.saveKeys(rec);
  keysMem = rec;
  holdKey(dataKey);
}

/** Before signing in to an account: leave the previous one's sync state behind (data stays). */
async function resetForAccount(accountId) {
  const s = readState();
  if (s.accountId && s.accountId !== accountId) {
    // The previous account's profiles stay here as copies kept from it (with their shadows), exactly
    // like "Keep copies": signing in to it again later carries on where it stopped.
    const pres = await preserveForAccount(s);
    await clearShadows();
    await C.clearKeys().catch(() => {});
    keysMem = null;
    const local = new Set(getProfiles().map((p) => p.id));
    const kept = { ...Object.fromEntries(Object.entries(s.kept || {}).filter(([id]) => local.has(id))), ...pres.kept };
    writeState({ dev: s.dev || deviceId(), kept, keptDeletes: { ...(s.keptDeletes || {}), ...pres.keptDeletes } });
    return;
  }
  if (s.accountId && s.accountId === accountId) return; // same account again: carry on where it stopped
}

function startSession(r, username, { created = false } = {}) {
  const prev = readState();
  const same = prev.accountId === r.accountId;
  patchState({
    accountId: r.accountId, username: r.username || username, token: r.token, sessionId: r.sessionId,
    serverUrl: serverUrl(), expired: false, locked: false, error: null, signingOut: false, paused: null,
    // The same account again (e.g. after the session ended): carry on where it stopped.
    // A brand-new account is empty: nothing to download before profiles can be added.
    ...(same ? {} : { synced: [], cursor: 0, full: true, fresh: {}, merge: {}, deletes: {}, waitReadable: {}, lastOk: null, pulled: created, known: {}, refusedDeletes: {}, cantSync: null, resumed: {} }),
  });
  epoch++;
  changed();
}

/** Create an account. Returns { recovery } (the recovery key text, shown once). */
export async function createAccount({ username, password, registerKey }) {
  const uname = C.normUsername(username);
  if (!uname) throw new Error('Username: 3–40 letters, digits, dots, dashes or underscores.');
  if (String(password).length < 10) throw new Error('The password needs at least 10 characters.');
  const dataKey = C.randomBytes(32), rec = C.randomBytes(32);
  const { authKey, kek } = await C.fromPassword(uname, password);
  const { recAuth, recKek } = await C.fromRecovery(uname, rec);
  const wrappedPw = await C.wrap(kek, dataKey), wrappedRec = await C.wrap(recKek, dataKey);
  let r;
  try {
    r = await api('POST', '/api/account/create', { username: uname, authKey, wrappedPw, wrappedRec, recAuth, deviceName: deviceName() }, { headers: { 'X-Register-Key': String(registerKey || '').trim() } });
  } catch (e) {
    if (e.status === 403) throw new Error('The register key doesn’t match the server’s.');
    if (e.status === 409) throw new Error('That username is taken.');
    if (/Account limit/.test(e.message)) throw new Error('The server has its maximum number of accounts.');
    throw new Error(plainError(e));
  }
  await resetForAccount(r.accountId);
  await storeKeys(r.accountId, dataKey, wrappedPw);
  startSession(r, uname, { created: true });
  const text = C.formatRecovery(rec);
  rec.fill(0);
  return { recovery: text };
}

/** Sign in with username + password. Downloads the account's profiles (onProgress gets counts). */
export async function signIn({ username, password }) {
  const uname = C.normUsername(username);
  if (!uname) throw new Error('Wrong username or password');
  const { authKey, kek } = await C.fromPassword(uname, password);
  let r;
  try { r = await api('POST', '/api/account/login', { username: uname, authKey, deviceName: deviceName() }); } catch (e) {
    throw new Error(e.status === 401 ? 'Wrong username or password' : plainError(e));
  }
  const dk = await C.unwrap(kek, r.wrappedPw);
  if (!dk) throw new Error('Couldn’t unlock your data with that password.');
  await resetForAccount(r.accountId);
  await storeKeys(r.accountId, dk, r.wrappedPw);
  startSession(r, uname);
  return firstSync();
}

/** Recovery key + new password (signs every other device out). */
export async function recoverAccount({ username, recovery, newPassword }) {
  const uname = C.normUsername(username);
  const recBytes = C.parseRecovery(recovery);
  if (!uname) throw new Error('Wrong username or recovery key');
  if (!recBytes) throw new Error('That doesn’t look like a recovery key (52 letters and digits).');
  if (String(newPassword).length < 10) throw new Error('The new password needs at least 10 characters.');
  const { recAuth, recKek } = await C.fromRecovery(uname, recBytes);
  let start;
  try { start = await api('POST', '/api/account/recover/start', { username: uname, recAuth }); } catch (e) {
    throw new Error(e.status === 401 ? 'Wrong username or recovery key' : plainError(e));
  }
  const dk = await C.unwrap(recKek, start.wrappedRec);
  if (!dk) throw new Error('Couldn’t unlock your data with that recovery key.');
  const { authKey: newAuthKey, kek } = await C.fromPassword(uname, newPassword);
  const newWrappedPw = await C.wrap(kek, dk);
  let r;
  try { r = await api('POST', '/api/account/recover/finish', { username: uname, recAuth, newAuthKey, newWrappedPw, deviceName: deviceName() }); } catch (e) {
    throw new Error(e.status === 401 ? 'Wrong username or recovery key' : plainError(e));
  }
  await resetForAccount(r.accountId);
  await storeKeys(r.accountId, dk, newWrappedPw);
  startSession(r, uname);
  return firstSync();
}

/**
 * After signing in: download everything. Resolves { ok, pulled, error } – error is a plain reason when
 * the download didn't finish (this device's profiles can't be added to the account until it has).
 */
async function firstSync() {
  const ok = await syncNow();
  const s = readState();
  return { ok, pulled: !!s.pulled, error: ok && s.pulled ? null : lastError || s.error || (s.paused ? 'another device uses a newer app version' : 'the download didn’t finish') };
}
/** Try the download again (Retry after a failed sign-in sync). */
export const retryFirstSync = () => firstSync();

// ---------- passkeys ----------
export const passkeysSupported = () => !!(window.PublicKeyCredential && navigator.credentials?.create && navigator.credentials?.get);

/** JSON for the server: base64url fields only, and never the PRF output (it must stay on the device). */
function credJSON(cred) {
  const r = cred.response;
  const out = { id: cred.id, rawId: C.b64u(cred.rawId), type: cred.type, response: { clientDataJSON: C.b64u(r.clientDataJSON) } };
  if (r.attestationObject) out.response.attestationObject = C.b64u(r.attestationObject);
  if (r.authenticatorData) out.response.authenticatorData = C.b64u(r.authenticatorData);
  if (r.signature) out.response.signature = C.b64u(r.signature);
  if (r.userHandle && r.userHandle.byteLength) out.response.userHandle = C.b64u(r.userHandle);
  if (typeof r.getTransports === 'function') { try { out.response.transports = r.getTransports(); } catch { /* ignore */ } }
  return out;
}
const prfOut = (cred) => { try { const p = cred.getClientExtensionResults?.()?.prf; return p?.results?.first ? new Uint8Array(p.results.first) : null; } catch { return null; } };
const prfEnabled = (cred) => { try { return !!cred.getClientExtensionResults?.()?.prf?.enabled; } catch { return false; } };

let pendingUnlock = null; // { accountId, username, wrappedPw } after a passkey sign-in without PRF

/** Sign in with a passkey. Resolves { ok } or { needsUnlock: true, username } (no PRF: ask for the password once). */
export async function passkeySignIn() {
  if (!passkeysSupported()) throw new Error('This browser doesn’t support passkeys.');
  let o;
  try { o = await api('POST', '/api/passkey/login/options', {}); } catch (e) { throw new Error(plainError(e)); }
  let cred;
  try {
    cred = await navigator.credentials.get({ publicKey: {
      challenge: C.unb64u(o.options.challenge), rpId: o.options.rpId, allowCredentials: [], userVerification: 'required', timeout: o.options.timeout,
      extensions: { prf: { eval: { first: C.PRF_INPUT } } },
    } });
  } catch (e) { throw new Error(e?.name === 'NotAllowedError' ? 'Passkey sign-in was cancelled.' : 'Couldn’t use a passkey here.'); }
  if (!cred) throw new Error('Passkey sign-in was cancelled.');
  let r;
  try { r = await api('POST', '/api/passkey/login', { challengeId: o.challengeId, credential: credJSON(cred), deviceName: deviceName() }); } catch (e) {
    throw new Error(e.status === 401 ? 'That passkey isn’t linked to an account on this server.' : plainError(e));
  }
  const uname = r.username;
  await resetForAccount(r.accountId);
  // Already unlocked on this device (same account): nothing more to ask.
  const have = await C.loadKeys();
  const prf = prfOut(cred);
  let dk = null;
  if (prf && r.wrappedPrf) dk = await C.unwrap(await C.fromPrf(uname, prf), r.wrappedPrf);
  if (dk) { await storeKeys(r.accountId, dk, r.wrappedPw); startSession(r, uname); return firstSync(); }
  if (have && have.accountId === r.accountId) { keysMem = have; startSession(r, uname); return firstSync(); }
  pendingUnlock = { accountId: r.accountId, username: uname, wrappedPw: r.wrappedPw, credId: cred.id, prf };
  startSession(r, uname);
  patchState({ locked: true });
  changed();
  return { needsUnlock: true, username: uname };
}

/** Finish a passkey sign-in with the password (or the recovery key). */
export async function unlock({ password = null, recovery = null }) {
  const s = readState();
  const uname = s.username;
  let dk = null, wrappedPw = pendingUnlock?.accountId === s.accountId ? pendingUnlock.wrappedPw : null;
  if (password !== null) {
    if (!wrappedPw) {
      // e.g. after a reload: fetch it with a short sign-in.
      return relogin(password);
    }
    const { kek } = await C.fromPassword(uname, password);
    dk = await C.unwrap(kek, wrappedPw);
    if (!dk) throw new Error('Wrong password');
  } else {
    const recBytes = C.parseRecovery(recovery);
    if (!recBytes) throw new Error('That doesn’t look like a recovery key (52 letters and digits).');
    const { recAuth, recKek } = await C.fromRecovery(uname, recBytes);
    let start;
    try { start = await api('POST', '/api/account/recover/start', { username: uname, recAuth }); } catch (e) { throw new Error(e.status === 401 ? 'Wrong recovery key' : plainError(e)); }
    dk = await C.unwrap(recKek, start.wrappedRec);
    if (!dk) throw new Error('Wrong recovery key');
  }
  await storeKeys(s.accountId, dk, wrappedPw);
  // This passkey can unlock by itself next time, when it supports PRF.
  const pu = pendingUnlock;
  pendingUnlock = null;
  if (pu?.prf && pu.credId) { try { await authed('POST', '/api/passkey/prf', { id: pu.credId, wrappedPrf: await C.wrap(await C.fromPrf(uname, pu.prf), dk) }); } catch { /* optional */ } }
  patchState({ locked: false });
  changed();
  return firstSync();
}
async function relogin(password) {
  const s = readState();
  const { authKey, kek } = await C.fromPassword(s.username, password);
  let r;
  try { r = await api('POST', '/api/account/login', { username: s.username, authKey, deviceName: deviceName() }); } catch (e) { throw new Error(e.status === 401 ? 'Wrong password' : plainError(e)); }
  const dk = await C.unwrap(kek, r.wrappedPw);
  if (!dk || r.accountId !== s.accountId) throw new Error('Wrong password');
  // Keep the new session, end the passkey one.
  const old = s.token;
  await storeKeys(r.accountId, dk, r.wrappedPw);
  startSession(r, s.username);
  api('POST', '/api/account/logout', {}, { token: old }).catch(() => {});
  return firstSync();
}

/** The dataKey for wrapping (adding a passkey / changing the password), checked against this device's keys. */
async function dataKeyFromPassword(password) {
  const s = readState();
  const keys = await getKeys();
  const { authKey, kek } = await C.fromPassword(s.username, password);
  let dk = keys?.wrappedPw ? await C.unwrap(kek, keys.wrappedPw) : null;
  if (!dk) {
    // The password may have been changed on another device: get the current wrap with a short sign-in.
    let r;
    try { r = await api('POST', '/api/account/login', { username: s.username, authKey, deviceName: deviceName() }); } catch (e) { throw new Error(e.status === 401 ? 'Wrong password' : plainError(e)); }
    api('POST', '/api/account/logout', {}, { token: r.token }).catch(() => {});
    dk = await C.unwrap(kek, r.wrappedPw);
    if (!dk) throw new Error('Wrong password');
    if (keys) { keys.wrappedPw = r.wrappedPw; await C.saveKeys(keys).catch(() => {}); }
  }
  if (keys) {
    const { macKey } = await C.dataKeys(dk);
    if ((await C.keyCheck(macKey)) !== keys.check) throw new Error('That password unlocks a different key than this device uses.');
  }
  return { dk, authKey };
}

/** Add a passkey for this account. password: needed only when the key isn't in memory (for PRF). */
export async function addPasskey({ name = deviceName(), password = null } = {}) {
  if (!passkeysSupported()) throw new Error('This browser doesn’t support passkeys.');
  let dk = flowKey;
  if (!dk && password) dk = (await dataKeyFromPassword(password)).dk;
  let o;
  try { o = await authed('POST', '/api/passkey/register/options', {}); } catch (e) { throw new Error(plainError(e)); }
  const op = o.options;
  let cred;
  try {
    cred = await navigator.credentials.create({ publicKey: {
      ...op, challenge: C.unb64u(op.challenge), user: { ...op.user, id: C.unb64u(op.user.id) },
      excludeCredentials: (op.excludeCredentials || []).map((c) => ({ ...c, id: C.unb64u(c.id) })),
      extensions: { prf: { eval: { first: C.PRF_INPUT } } },
    } });
  } catch (e) {
    if (e?.name === 'InvalidStateError') throw new Error('This device already has a passkey for your account.');
    throw new Error(e?.name === 'NotAllowedError' ? 'Adding the passkey was cancelled.' : 'Couldn’t create a passkey here.');
  }
  const uname = readState().username;
  let prf = prfOut(cred);
  let wrappedPrf = prf && dk ? await C.wrap(await C.fromPrf(uname, prf), dk) : undefined;
  let r;
  try { r = await authed('POST', '/api/passkey/register', { challengeId: o.challengeId, credential: credJSON(cred), name: String(name).slice(0, 60), ...(wrappedPrf ? { wrappedPrf } : {}) }); } catch (e) { throw new Error(plainError(e)); }
  let usesPrf = !!wrappedPrf;
  // Some authenticators only give PRF output when signing in: ask once more to set it up.
  if (!usesPrf && dk && prfEnabled(cred)) {
    try {
      const a = await navigator.credentials.get({ publicKey: {
        challenge: C.randomBytes(32), rpId: op.rp.id, allowCredentials: [{ type: 'public-key', id: cred.rawId }], userVerification: 'required',
        extensions: { prf: { eval: { first: C.PRF_INPUT } } },
      } });
      prf = a && prfOut(a);
      if (prf) { await authed('POST', '/api/passkey/prf', { id: r.id || cred.id, wrappedPrf: await C.wrap(await C.fromPrf(uname, prf), dk) }); usesPrf = true; }
    } catch { /* fine: the password unlocks new devices instead */ }
  }
  return { ok: true, prf: usesPrf };
}
export async function removePasskey(id) {
  try { await authed('DELETE', '/api/passkey/' + encodeURIComponent(id)); } catch (e) { throw new Error(plainError(e)); }
}

// ---------- account management ----------
export async function accountInfo() {
  try { return await authed('GET', '/api/account'); } catch (e) { throw new Error(plainError(e)); }
}
export async function signOutDevice(id) {
  try { return await authed('DELETE', '/api/account/session/' + encodeURIComponent(id)); } catch (e) { throw new Error(plainError(e)); }
}
export async function changePassword({ current, next }) {
  if (String(next).length < 10) throw new Error('The new password needs at least 10 characters.');
  const s = readState();
  const { dk, authKey } = await dataKeyFromPassword(current);
  const n = await C.fromPassword(s.username, next);
  const newWrappedPw = await C.wrap(n.kek, dk);
  try { await authed('POST', '/api/account/password', { authKey, newAuthKey: n.authKey, newWrappedPw }); } catch (e) {
    throw new Error(e.status === 403 ? 'Wrong password' : plainError(e));
  }
  const keys = await getKeys();
  if (keys) { keys.wrappedPw = newWrappedPw; await C.saveKeys(keys).catch(() => {}); }
}

/** The session is gone (401): signed out, everything kept so signing in again carries on. */
function sessionEnded() {
  patchState({ token: null, expired: true });
  epoch++;
  changed();
}

/**
 * What on this device isn't in the account yet: { pending, tooLarge, unreadable: [names], deletes }.
 * Compares every synced profile with its shadow (so edits not yet diffed count too).
 */
async function unsyncedReport() {
  const s = readState();
  const refusedDel = s.refusedDeletes || {};
  const out = { pending: 0, tooLarge: 0, refused: 0, unreadable: [], deletes: Object.keys(s.deletes || {}).filter((pid) => !refusedDel[pid]).length, refusedDeletes: Object.keys(s.deletes || {}).filter((pid) => refusedDel[pid]).length };
  for (const prof of syncedProfiles(s)) {
    if (!prof.data) { out.unreadable.push(prof.meta.name); continue; }
    if ((s.merge || {})[prof.pid] || (s.waitReadable || {})[prof.pid] || (s.fresh || {})[prof.pid]) { out.pending++; continue; }
    const sh = await loadShadow(prof.pid);
    const flat = flatten(prof.pid, prof.meta, prof.data);
    for (const [k, v] of flat) {
      const e = sh[k];
      if (!e || e[0] !== hashOf(v) || e[3] === 1) out.pending++;
      else if (e[3] === 2) out.tooLarge++;
      else if (e[3] === 3) out.refused++;
    }
    for (const [k, e] of Object.entries(sh)) {
      if (flat.has(k)) continue;
      if (e[0] !== null || e[3] === 1) out.pending++;
      else if (e[3] === 2) out.tooLarge++;
      else if (e[3] === 3) out.refused++;
    }
  }
  return out;
}
/** Why the account's profiles can't be removed from this device right now (null: they can). */
async function removeBlocker() {
  const s = readState();
  if (!s.token) return 'You were signed out of your account, so this device can’t make sure everything was uploaded. Sign in again first, or keep the copies on this device.';
  if (s.locked) return 'This device can’t sync until you finish signing in, so it can’t make sure everything was uploaded. Keep the copies on this device instead.';
  const r = await unsyncedReport();
  const n = r.pending + r.deletes;
  if (r.unreadable.length) return `${r.unreadable.join(', ')} can’t be read on this device, so it isn’t known what would be lost. Keep the copies on this device instead.`;
  if (n) return `${n.toLocaleString()} change${n === 1 ? '' : 's'} on this device ${n === 1 ? 'hasn’t' : 'haven’t'} been uploaded yet${s.offline || navigator.onLine === false ? ' (you’re offline)' : ''}. Removing now would lose ${n === 1 ? 'it' : 'them'}. Try again once everything has synced, or keep the copies on this device.`;
  const stuck = [];
  if (r.tooLarge) stuck.push(`${r.tooLarge.toLocaleString()} item${r.tooLarge === 1 ? ' is' : 's are'} too large to sync`);
  if (r.refused) stuck.push(`${r.refused.toLocaleString()} item${r.refused === 1 ? ' was' : 's were'} refused by the server`);
  if (r.refusedDeletes) stuck.push(`${r.refusedDeletes === 1 ? 'a profile deletion was' : `${r.refusedDeletes} profile deletions were`} refused by the server`);
  if (stuck.length) {
    const one = r.tooLarge + r.refused + r.refusedDeletes === 1;
    const text = `${stuck.join(', ')}. ${one ? 'It isn’t' : 'They aren’t'} in the account, so removing now would lose ${one ? 'it' : 'them'}. Keep the copies on this device instead.`;
    return text[0].toUpperCase() + text.slice(1);
  }
  return null;
}
/** Before "Remove from this device": sync, then report what would be lost. Resolves null (safe) or a reason. */
export async function checkRemove() {
  if (isSignedIn()) await syncNow().catch(() => false);
  return removeBlocker();
}

/**
 * Sign out. remove = false: the account's profiles stay here as device-only profiles; each one's shadow
 * (with its pending outbox) and pending profile deletes are preserved for this account, so signing in
 * to it again resumes them (normal diff and latest edit wins; see resumeKept).
 * remove = true: they're removed from this device – only when everything is uploaded, otherwise
 * nothing happens and { ok: false, reason } comes back. Account data is never touched.
 */
export async function signOut({ remove = false } = {}) {
  if (remove) {
    const why = await checkRemove();
    if (why) return { ok: false, reason: why };
  }
  const s = patchState({ signingOut: true });
  epoch++;
  clearTimeout(debounceTimer); clearTimeout(retryTimer);
  const ids = [...(s.synced || [])];
  let blocked = null;
  const finish = async () => {
    // Checked again while holding the lock: an edit may have landed since.
    if (remove) { blocked = await removeBlocker(); if (blocked) return; }
    if (s.token) await api('POST', '/api/account/logout', {}, { token: s.token }).catch(() => {});
    if (!remove) pres = await preserveForAccount(readState());
    await clearShadows();
    await C.clearKeys().catch(() => {});
  };
  let pres = { kept: {}, keptDeletes: {} };
  try { await withLock(finish); } catch {
    if (remove) blocked = 'Another window is syncing. Try again in a moment.';
    else { pres = await preserveForAccount(readState()); await clearShadows(); await C.clearKeys().catch(() => {}); }
  }
  if (blocked) { patchState({ signingOut: false }); epoch++; changed(); scheduleSync(0); return { ok: false, reason: blocked }; }
  keysMem = null; flowKey = null; pendingUnlock = null;
  ridCache = { keysRef: null, byK: new Map(), byRid: new Map() };
  const local = new Set(getProfiles().map((p) => p.id));
  const st = readState();
  // Keep: each synced profile is remembered as kept from this account, with its preserved shadow.
  const kept = { ...Object.fromEntries(Object.entries(st.kept || {}).filter(([id]) => local.has(id) && !ids.includes(id))), ...pres.kept };
  writeState({ dev: s.dev || deviceId(), kept, keptDeletes: { ...(st.keptDeletes || {}), ...pres.keptDeletes } });
  if (remove) for (const id of ids) { dropKept(id); if (removeProfileLocal(id)) deleteProfileFiles(id); }
  changed();
  return { ok: true };
}

/** Delete the account (needs the password). Local copies stay as device-only profiles. */
export async function deleteAccount(password) {
  const s = readState();
  const { authKey } = await C.fromPassword(s.username, password);
  try { await authed('DELETE', '/api/account', { authKey }); } catch (e) { throw new Error(e.status === 403 ? 'Wrong password' : plainError(e)); }
  await signOut({ remove: false });
  // The account is gone: its copies are plain device-only profiles (nothing to resume).
  const st = readState();
  const gone = Object.keys(st.kept || {}).filter((id) => st.kept[id] === s.accountId);
  const goneDel = Object.keys(st.keptDeletes || {}).filter((id) => st.keptDeletes[id]?.a === s.accountId);
  patchState({ kept: Object.fromEntries(Object.entries(st.kept || {}).filter(([id]) => !gone.includes(id))), keptDeletes: Object.fromEntries(Object.entries(st.keptDeletes || {}).filter(([id]) => !goneDel.includes(id))) });
  for (const id of [...gone, ...goneDel]) await dropKept(id);
}

// ---------- wiring ----------
let started = false;
export function initSync() {
  if (started) return;
  started = true;
  deviceId();
  const s = readState();
  if (s.paused && s.paused.sv <= SCHEMA_VERSION) patchState({ paused: null });
  if (s.signingOut) signOut({ remove: false }); // a sign-out interrupted by a reload: finish it
  subscribe((st, info = {}) => { if (!info.remote) scheduleSync(); });
  window.addEventListener('online', () => { patchState({ offline: false }); scheduleSync(0); });
  window.addEventListener('offline', () => changed());
  // Shown: sync. Hidden: sync now too, so edits are timestamped (and sent) before the app may be closed.
  document.addEventListener('visibilitychange', () => { if (isSignedIn()) syncNow().catch(() => {}); });
  window.addEventListener('storage', (e) => { if (e.key === STATE_KEY) { keysMem = null; changed(); } });
  setInterval(() => { if (document.visibilityState === 'visible') scheduleSync(0); }, EVERY_MS);
  scheduleSync(300);
}
