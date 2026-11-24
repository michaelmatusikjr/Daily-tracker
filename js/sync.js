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
  updateProfileRemote, reorderProfiles, removeProfileLocal, reIdProfile, migrate, normalize, defaultState, defaultSettings,
  normalizers, hashStr, uid, ensureStored,
} from './store.js';
import { isValidKey } from './dates.js';
import * as C from './syncCrypto.js';
import { deleteProfileFiles, reassignProfileFiles } from './attachments.js';

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
//   deletes: {pid: t}, waitReadable: {pid: 1}, offset, lastOk, error, paused: {sv}, expired, locked, signingOut }
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
  return getProfiles().find((p) => p.id !== exceptId && ids.has(p.id) && nameKey(p.name) === k) || null;
}

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

/** A profile as records: Map k → v. order = position among the synced profiles. */
export function flatten(pid, meta, order, s) {
  const m = new Map();
  m.set(`${pid}/meta`, { name: meta.name, avatar: meta.avatar, order });
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
        return { ok: true, v: { name: v.name.trim().slice(0, 40), avatar: normalizers.avatar(v.avatar), order: Number.isFinite(v.order) ? v.order : 0 } };
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
const clearShadows = () => C.idb('shadow', 'readwrite', (s) => s.clear()).catch(() => {});
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
    attempt = 0; clearTimeout(retryTimer);
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
    if (readState().token === token) patchState({ error: offline ? null : plainError(e), offline, offset: clockOffset });
    console.warn('Sync failed:', e?.message || e);
    changed();
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => scheduleSync(0), BACKOFF[Math.min(attempt++, BACKOFF.length - 1)]);
    return false;
  }
}

/** Profiles that sync, readable or not: { pid, meta, order, data|null }. */
function syncedProfiles(s) {
  const ids = new Set(s.synced || []);
  const list = getProfiles().filter((p) => ids.has(p.id));
  return list.map((p, order) => ({ pid: p.id, meta: p, order, data: readProfileForSync(p.id) }));
}

async function runCycle(my, token, keys, dev) {
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
    shadows = await loadShadows(readState());
    checkAlive(my, token);
    // ---- synchronous: diff local edits, then apply remote ones (no await in between) ----
    const res = applyIncoming(incoming, full, dev, shadows, appliedOther);
    for (const pid of res.dirty) await saveShadow(pid, shadows.get(pid));
    for (const pid of res.dropped) await dropShadow(pid);
    checkAlive(my, token);
    // The cursor only moves on when everything that arrived was stored.
    if (res.cursorOk) patchState(res.needFull ? { full: true, ...(full ? {} : { cursor: seq }) } : { cursor: seq, full: false });
    if (!res.needFull || !res.cursorOk) break;
  }
  await pushPending(my, token, keys, dev, shadows);
  return { appliedOther: appliedOther.v };
}

const nextT = (e) => Math.max(Math.round(serverNow()), (e ? e[1] : 0) + 1);
/** Record local edits of one profile in its shadow (new/changed → pending, gone → pending tombstone). */
function diffProfile(pid, meta, order, data, sh, dev) {
  const pre = flatten(pid, meta, order, data);
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
    if (diffProfile(prof.pid, prof.meta, prof.order, prof.data, sh, dev)) out.add(prof.pid);
  }
  return out;
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
  const dirty = new Set(), dropped = new Set();
  let needFull = false, cursorOk = true;
  const byPid = new Map();
  for (const [k, r] of incoming) {
    const e = { ...r, k };
    if (!byPid.has(r.p.pid)) byPid.set(r.p.pid, []);
    byPid.get(r.p.pid).push(e);
  }
  const localIds = () => new Set(getProfiles().map((p) => p.id));
  const remoteOrder = new Map();
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
  const orderOf = (pid) => [...synced].filter((id) => localIds().has(id)).sort((a, b) => getProfiles().findIndex((p) => p.id === a) - getProfiles().findIndex((p) => p.id === b)).indexOf(pid);

  /** Create (or rebuild) a profile from the account's records. Only on a full pull, so nothing is missing. */
  const build = (pid, recs, meta) => {
    const data = applyRecords(emptyBase(), dataOf(recs));
    const exists = localIds().has(pid);
    const ok = exists ? applyRemoteProfile(pid, data) && (!meta || updateProfileRemote(pid, meta.v)) : addRemoteProfile({ id: pid, name: meta.v.name, avatar: meta.v.avatar, data });
    if (!ok) { cursorOk = false; return false; }
    synced.add(pid); delete fresh[pid];
    const sh = {};
    const applied = new Map(recs.map((r) => [r.k, r]));
    const prof = getProfiles().find((p) => p.id === pid);
    settle(sh, flatten(pid, prof, Math.max(0, orderOf(pid)), data), applied);
    if (meta && sh[meta.k]) sh[meta.k][0] = hashOf(meta.v); // the order may differ until re-sorted below
    shadows.set(pid, sh); dirty.add(pid);
    if (meta) remoteOrder.set(pid, meta.v.order);
    appliedOther.v = true;
    return true;
  };

  // 1. Profiles to rebuild from the account (they went missing here, or their data was reset).
  for (const pid of Object.keys(fresh)) {
    if (!synced.has(pid)) { delete fresh[pid]; continue; }
    if (!full) { needFull = true; continue; }
    const recs = byPid.get(pid) || [];
    const meta = recs.find((r) => r.p.kind === 'meta');
    if (meta && meta.v === null) { if (localIds().has(pid) && !removeProfileLocal(pid)) { cursorOk = false; continue; } deleteProfileFiles(pid); forget(pid); appliedOther.v = true; continue; }
    if (!meta && !localIds().has(pid)) { forget(pid); continue; } // not in the account: nothing to download
    if (localIds().has(pid) && !readProfileForSync(pid)) continue; // still unreadable: wait
    build(pid, recs, meta);
  }

  // 2. Account profiles this device doesn't sync yet: download them.
  for (const [pid, recs] of byPid) {
    if (synced.has(pid) || deletes[pid]) continue;
    const meta = recs.find((r) => r.p.kind === 'meta');
    if (!meta || meta.v === null) continue; // deleted, or data without a profile: nothing to create
    if (!full) { needFull = true; continue; }
    if (localIds().has(pid)) {
      // A device-only profile with the same id (e.g. kept at sign-out, or the same backup imported on
      // two devices) stays on this device under a new id; the account's copy is downloaded beside it.
      const nid = 'p' + uid();
      if (!reIdProfile(pid, nid)) { cursorOk = false; continue; }
      reassignProfileFiles(pid, nid).catch(() => {});
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
      // Deleted in the account (on another device): delete it here too, with its photos.
      if (!removeProfileLocal(pid)) { cursorOk = false; continue; }
      deleteProfileFiles(pid);
      forget(pid);
      appliedOther.v = true;
      continue;
    }
    const data = readProfileForSync(pid);
    if (!data) { if (recs.length) waitReadable[pid] = 1; continue; } // unreadable: never diffed, never applied
    const prof = getProfiles().find((p) => p.id === pid);
    const order = orderOf(pid);
    if (merge[pid]) {
      // Readable again (see runCycle): apply everything the account has, then upload what's only here.
      if (!full) { needFull = true; continue; }
      const dataRecs = dataOf(recs);
      const next = dataRecs.length ? applyRecords(data, dataRecs) : data;
      if (dataRecs.length && !applyRemoteProfile(pid, next)) { cursorOk = false; continue; }
      const metaR = recs.find((r) => r.p.kind === 'meta' && r.v);
      if (metaR) updateProfileRemote(pid, metaR.v);
      const post = flatten(pid, getProfiles().find((p) => p.id === pid), order, next);
      for (const r of recs) if (post.has(r.k)) sh[r.k] = [hashOf(post.get(r.k)), r.t, r.dev, 0];
      diffProfile(pid, getProfiles().find((p) => p.id === pid), order, next, sh, dev);
      delete merge[pid];
      dirty.add(pid);
      if (pid !== getActiveProfile()?.id) appliedOther.v = true;
      continue;
    }
    // Edits made while the pull was in flight are recorded before anything remote is applied.
    const changedHere = diffProfile(pid, prof, order, data, sh, dev);
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
      if (updateProfileRemote(pid, metaWin.v)) { applied.set(metaWin.k, metaWin); remoteOrder.set(pid, metaWin.v.order); } else cursorOk = false;
    }
    settle(sh, flatten(pid, getProfiles().find((p) => p.id === pid), order, next), applied);
    if (metaWin && applied.has(metaWin.k)) sh[metaWin.k][0] = hashOf(metaWin.v); // order may differ until re-sorted below
    dirty.add(pid);
  }

  // Profile order from the account (only among synced profiles; device-only ones keep their place).
  if (remoteOrder.size) {
    const ids = getProfiles().map((p) => p.id).filter((id) => synced.has(id));
    const pos = (id, i) => (remoteOrder.has(id) ? remoteOrder.get(id) : i);
    const want = ids.map((id, i) => ({ id, o: pos(id, i), i })).sort((a, b) => a.o - b.o || a.i - b.i).map((x) => x.id);
    reorderProfiles(want);
  }

  for (const id of Object.keys(merge)) if (!synced.has(id)) delete merge[id];
  patchState({ synced: [...synced], fresh, waitReadable, merge });
  return { needFull, cursorOk, dirty, dropped };
}

/** Upload every pending record (in batches). Shadows are updated as batches are accepted. */
async function pushPending(my, token, keys, dev, shadows) {
  const s = readState();
  const items = [];
  for (const prof of syncedProfiles(s)) {
    if (!prof.data) continue; // unreadable: its pending edits wait
    const sh = shadows.get(prof.pid) || await loadShadow(prof.pid);
    shadows.set(prof.pid, sh);
    const flat = flatten(prof.pid, prof.meta, prof.order, prof.data);
    for (const [k, e] of Object.entries(sh)) {
      if (e[3] !== 1) continue;
      const v = e[0] === null ? null : flat.get(k);
      if (e[0] !== null && (v === undefined || hashOf(v) !== e[0])) continue; // edited again: next cycle
      items.push({ pid: prof.pid, k, v, t: e[1], dev: e[2] });
    }
  }
  for (const [pid, t] of Object.entries(s.deletes || {})) items.push({ pid, k: `${pid}/meta`, v: null, t, dev, del: true });
  if (!items.length) return;
  progress = { phase: 'up', n: 0, of: items.length }; changed();
  let batch = [], bytes = 0, done = 0;
  const flush = async () => {
    if (!batch.length) return;
    const res = await authed('POST', '/api/sync/push', { records: batch.map((b) => b.rec) });
    checkAlive(my, token);
    void res;
    const touched = new Set();
    const st = readState();
    const dels = { ...(st.deletes || {}) };
    for (const b of batch) {
      if (b.del) { if (dels[b.pid] === b.t) delete dels[b.pid]; continue; }
      const sh = shadows.get(b.pid);
      const e = sh?.[b.k];
      // Accepted or stale (the server kept a newer copy, which the next pull brings): no longer pending.
      if (e && e[1] === b.t && e[2] === b.dev) { if (e[0] === null) delete sh[b.k]; else e[3] = 0; touched.add(b.pid); }
    }
    for (const pid of touched) await saveShadow(pid, shadows.get(pid));
    checkAlive(my, token);
    patchState({ deletes: dels });
    done += batch.length;
    progress = { phase: 'up', n: done, of: items.length }; changed();
    batch = []; bytes = 0;
  };
  for (const it of items) {
    const rid = await ridFor(keys, it.k);
    const blob = await C.encryptRecord(keys.encKey, rid, { k: it.k, v: it.v, t: it.t, dev: it.dev, sv: SCHEMA_VERSION });
    if (blob.length > BLOB_MAX) {
      console.warn('Sync: a record is too large to upload and stays on this device', it.k.split('/')[1]);
      const e = shadows.get(it.pid)?.[it.k];
      if (e) { e[3] = 2; await saveShadow(it.pid, shadows.get(it.pid)); }
      continue;
    }
    const n = blob.length + 120;
    if (batch.length >= PUSH_MAX || (batch.length && bytes + n > PUSH_BYTES)) await flush();
    batch.push({ ...it, rec: { rid, t: it.t, dev: it.dev, blob } });
    bytes += n;
  }
  await flush();
}

// ---------- state changes from the UI ----------
/** Start syncing these device profiles (their whole data is uploaded on the next sync). */
export async function syncProfiles(ids) {
  const s = readState();
  if (!s.accountId) return;
  const add = ids.filter((id) => getProfiles().some((p) => p.id === id) && !(s.synced || []).includes(id));
  add.forEach(ensureStored);
  for (const id of add) await dropShadow(id); // start from an empty shadow: everything is new
  patchState((x) => ({ synced: [...new Set([...(x.synced || []), ...add])] }));
  changed();
  scheduleSync(0);
}

/** The user deleted a synced profile: delete it from the account (and so every device). */
export function profileDeleted(pid) {
  const s = readState();
  if (!(s.synced || []).includes(pid)) return;
  patchState((x) => ({ synced: (x.synced || []).filter((id) => id !== pid), deletes: { ...(x.deletes || {}), [pid]: Math.round(serverNow()) }, fresh: Object.fromEntries(Object.entries(x.fresh || {}).filter(([k]) => k !== pid)) }));
  dropShadow(pid);
  changed();
  scheduleSync(0);
}

/** A synced profile's unreadable data was reset on this device: download it again instead of uploading. */
export function profileReset(pid) {
  if (!isSynced(pid)) return false;
  patchState((x) => ({ fresh: { ...(x.fresh || {}), [pid]: 1 }, full: true, waitReadable: Object.fromEntries(Object.entries(x.waitReadable || {}).filter(([k]) => k !== pid)) }));
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
    await clearShadows();
    await C.clearKeys().catch(() => {});
    keysMem = null;
    writeState({ dev: s.dev || deviceId() });
    return;
  }
  if (s.accountId && s.accountId === accountId) return; // same account again: carry on where it stopped
}

function startSession(r, username) {
  const prev = readState();
  const same = prev.accountId === r.accountId;
  patchState({
    accountId: r.accountId, username: r.username || username, token: r.token, sessionId: r.sessionId,
    serverUrl: serverUrl(), expired: false, locked: false, error: null, signingOut: false, paused: null,
    // The same account again (e.g. after the session ended): carry on where it stopped.
    ...(same ? {} : { synced: [], cursor: 0, full: true, fresh: {}, deletes: {}, waitReadable: {}, lastOk: null }),
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
  startSession(r, uname);
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

/** After signing in: download everything. Resolves { ok, error? }. */
async function firstSync() {
  const ok = await syncNow();
  return { ok, error: ok ? null : readState().error };
}

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
 * Sign out. remove = false: the account's profiles stay here as device-only profiles (shadows cleared).
 * remove = true: they're removed from this device. Account data is never touched.
 */
export async function signOut({ remove = false } = {}) {
  const s = patchState({ signingOut: true });
  epoch++;
  clearTimeout(debounceTimer); clearTimeout(retryTimer);
  const ids = [...(s.synced || [])];
  await withLock(async () => {
    if (s.token) await api('POST', '/api/account/logout', {}, { token: s.token }).catch(() => {});
    await clearShadows();
    await C.clearKeys().catch(() => {});
  }).catch(async () => { await clearShadows(); await C.clearKeys().catch(() => {}); });
  keysMem = null; flowKey = null; pendingUnlock = null;
  ridCache = { keysRef: null, byK: new Map(), byRid: new Map() };
  writeState({ dev: s.dev || deviceId() });
  if (remove) for (const id of ids) { if (removeProfileLocal(id)) deleteProfileFiles(id); }
  changed();
}

/** Delete the account (needs the password). Local copies stay as device-only profiles. */
export async function deleteAccount(password) {
  const s = readState();
  const { authKey } = await C.fromPassword(s.username, password);
  try { await authed('DELETE', '/api/account', { authKey }); } catch (e) { throw new Error(e.status === 403 ? 'Wrong password' : plainError(e)); }
  await signOut({ remove: false });
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
