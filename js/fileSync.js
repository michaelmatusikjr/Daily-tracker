// Accounts and sync, phase 2: task photos (SYNC.md › Phase 2: photos).
// Each photo a synced profile's task refers to is stored in the account as one end-to-end encrypted
// file: fid = HMAC(macKey, "f:<pid>/<photo id>"), ciphertext = AES-GCM(encKey, payload, aad = fid).
// A background "pass" (after each successful record sync, never blocking it) uploads photos whose
// task record is in the account, downloads the ones this device doesn't have, and – rarely, under
// strict conditions – deletes files no record refers to any more.
//
// Data safety rules this file keeps:
//  - The work list is derived from the data each time (which photos are referenced, which are on this
//    device, which the server has), so it survives reloads, offline and crashes; the only stored
//    state (IndexedDB dailyTracker-sync › shadow › "files:<accountId>") is a cache plus retry times,
//    scoped to the account and cleared with the live shadows at sign-out / account switch.
//  - Nothing is deleted from the account because a local copy is missing. A file is deleted only when
//    no profile on this device refers to it, this device knows every record of the account and has
//    nothing left to upload (sync.gcReady), and that has been so for GC delay (7 days) – so Undo and
//    devices that were offline can't lose a photo. If in doubt, keep.
//  - Downloads only add files; a photo that can't be stored (device full) stops the downloads and is
//    tried again later. Everything the server returns is checked and decrypted with the fid as AAD.
import * as S from './sync.js';
import * as C from './syncCrypto.js';
import { getFile, putFile, fileIds } from './attachments.js';
import { getProfiles, readProfileState } from './store.js';

const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const FID_RE = /^[A-Za-z0-9_-]{43}$/;
const FILE_MAX_CHARS = 16 * 1024 * 1024; // the server's limit per file
const CHECK_BATCH = 1000, DELETE_BATCH = 200;
const BACKOFF = [30000, 120000, 600000, 3600000, 6 * 3600000];
const ACCOUNT_FULL_RETRY = 3600000;     // account storage full: try uploading again after this
const LARGE_RETRY = 7 * 86400000;
const RECHECK = 86400000;              // ask the server again whether it still has a photo this device has
// gcDelay: how long a file must have been unreferenced before it's deleted; gcEvery: how often the
// clean-up runs; fullRetry: device storage full – try downloading again after this.
let timing = { gcDelay: 7 * 86400000, gcEvery: 3600000, fullRetry: 15 * 60000 };
/** Tests: shorten the clean-up delay / interval / device-full retry. */
export function setFileTiming(t = {}) { timing = { ...timing, ...t }; }

// ---------- per-account state ----------
// { have: {fid: 1} (the server has it), chk: {fid: [checkedAt, record hash]} (when `have` was last confirmed),
//   seen: {fid: 1} (fids this client derived from a photo reference: the only ones clean-up may delete), tries: {fid: [n, nextAt, why]} (why: 'gone' | 'bad' | 'net' |
//   'full' (account storage full) | 'large'), unref: {fid: since} (seen unreferenced), gcAt, deviceFull: at }
const stateKey = (aid) => 'files:' + aid;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
async function loadState(aid) {
  const x = await C.idb('shadow', 'readonly', (s) => s.get(stateKey(aid))).catch(() => null);
  const o = isObj(x) ? x : {};
  return { have: isObj(o.have) ? o.have : {}, chk: isObj(o.chk) ? o.chk : {}, seen: isObj(o.seen) ? o.seen : {}, tries: isObj(o.tries) ? o.tries : {}, unref: isObj(o.unref) ? o.unref : {}, gcAt: Number(o.gcAt) || 0, deviceFull: Number(o.deviceFull) || 0 };
}
const saveState = (aid, st) => C.idb('shadow', 'readwrite', (s) => s.put(st, stateKey(aid))).catch(() => {});

// ---------- status for the UI ----------
let mem = null; // { accountId, status: Map "pid/id" → 'downloading' | 'elsewhere' | 'full', up, large, full, deviceFull }
const listeners = new Set();
/** Called when photos arrive or their status changes. Returns an unsubscribe function. */
export function onPhotosChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() {
  listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  S.notifySyncChange();
}

/**
 * For a photo of profile pid that isn't on this device: 'downloading' (it is in the account and on
 * its way), 'full' (not enough space on this device), or 'elsewhere' (it can't be downloaded now:
 * not synced, offline, not in the account (yet), or deleted).
 */
export function photoStatus(pid, id) {
  if (!S.isSignedIn() || !S.isSynced(pid) || navigator.onLine === false) return 'elsewhere';
  const m = mem && mem.accountId === S.syncState().accountId ? mem.status.get(`${pid}/${id}`) : null;
  return m || 'downloading';
}
/** Plain words for photos that can't sync (null when all is well), for Settings › Account. */
export function photoNote() {
  if (!mem || mem.accountId !== S.syncState().accountId) return null;
  const n = (k, one, many) => `${k.toLocaleString()} photo${k === 1 ? one : many}`;
  const out = [];
  if (mem.full) out.push(`${n(mem.full, ' couldn’t', 's couldn’t')} be uploaded: your account’s storage is full.`);
  if (mem.large) out.push(`${n(mem.large, ' is', 's are')} too large to sync and ${mem.large === 1 ? 'stays' : 'stay'} on this device only.`);
  if (mem.deviceFull) out.push(`Not enough space on this device to download ${n(mem.deviceFull, '', 's')} – it tries again later.`);
  return out.length ? out.join(' ') : null;
}

// ---------- the pass ----------
class Stop extends Error {}
let chain = Promise.resolve(), queued = null, timer = null, stopped = false, ctl = null;
const fidCache = { keys: null, map: new Map() };
async function fidOf(keys, pid, id) {
  if (fidCache.keys !== keys) { fidCache.keys = keys; fidCache.map = new Map(); }
  const k = `${pid}/${id}`;
  let f = fidCache.map.get(k);
  if (!f) { f = await C.fileIdOf(keys.macKey, pid, id); fidCache.map.set(k, f); }
  return f;
}
const due = (st, fid, now) => !st.tries[fid] || !(st.tries[fid][1] > now);
function fail(st, fid, why, now, wait = null) {
  const n = Math.min((st.tries[fid]?.[0] || 0) + 1, 99);
  st.tries[fid] = [n, now + (wait ?? BACKOFF[Math.min(n - 1, BACKOFF.length - 1)]), why];
}

/** Ask for a pass soon (after record syncs, coming online, …). */
export function scheduleFilePass(delay = 0) {
  if (stopped) return;
  clearTimeout(timer);
  timer = setTimeout(() => { runFilePass().catch(() => {}); }, delay);
}
/**
 * Run a pass (one at a time; a call while one is waiting joins it). opts.uploadOnly: only upload
 * (before "Remove from this device"); opts.gc: run the account clean-up now (if it's safe).
 */
export function runFilePass(opts = {}) {
  if (stopped) return Promise.resolve(false);
  const special = !!(opts.gc || opts.uploadOnly);
  if (queued && !special && !queued.special) return queued; // a plain pass that hasn't started covers this
  const p = chain.then(() => {
    if (queued === p) queued = null;
    return withFileLock(() => pass(opts));
  }).catch((e) => { if (!(e instanceof Stop)) console.warn('Photo sync failed:', e?.message || e); return false; });
  p.special = special;
  queued = p; chain = p;
  return p;
}
function withFileLock(fn) {
  if (navigator.locks?.request) return navigator.locks.request('dailyTracker-files', fn);
  return fn(); // without locks two tabs may both transfer a photo: harmless (uploads are idempotent)
}
/** Stop transfers (sign-out / account switch) and wait for a running pass to end. */
export async function stopFiles() {
  stopped = true;
  clearTimeout(timer);
  try { ctl?.abort(); } catch { /* ignore */ }
  await chain.catch(() => {});
  mem = null;
  emit();
}
/** Signed in again: transfers may run. */
export function resumeFiles() { stopped = false; }

async function pass(opts) {
  if (stopped) return false;
  const fc = await S.fileContext();
  if (!fc) return false;
  const my = new AbortController();
  ctl = my;
  const alive = () => { if (stopped || my.signal.aborted || !S.fileAlive(fc)) throw new Stop(); };
  const call = (method, path, body, o = {}) => S.fileCall(fc, method, path, body, { ...o, signal: my.signal });
  try {
    const st = await loadState(fc.accountId);
    alive();
    const refs = await S.photoRefs();
    alive();
    let local;
    try { local = await fileIds(); } catch { return false; } // photo storage unavailable here
    alive();
    for (const r of refs) r.fid = await fidOf(fc.keys, r.pid, r.id);
    alive();
    let now = Date.now();
    let offline = false;
    const stopOn = (e) => { if (e instanceof Stop) throw e; if (e?.status === 401) throw new Stop(); };

    // 1. Which referenced files does the server have? (Only those not known yet; missing ones again
    // once their retry time has come.)
    // A photo this device has is asked about only when its task record is in the account (otherwise it
    // can't be uploaded yet and the answer is useless), and again at least daily, whenever that record
    // changed, and always before "Remove from this device" – the server may have lost the file, and
    // this device is then the one to upload it again.
    for (const r of refs) st.seen[r.fid] = 1;
    const stale = (r) => { const c = st.chk[r.fid]; return opts.uploadOnly || !c || now - c[0] >= RECHECK || c[1] !== r.rec; };
    const recOf = new Map(refs.map((r) => [r.fid, r.rec]));
    const ask = [...new Set(refs.filter((r) => local.has(r.id)
      ? r.uploaded && (!st.have[r.fid] || stale(r))
      : !st.have[r.fid] && due(st, r.fid, now)).map((r) => r.fid))];
    for (let i = 0; i < ask.length && !offline; i += CHECK_BATCH) {
      const part = ask.slice(i, i + CHECK_BATCH);
      try {
        const res = await call('POST', '/api/files/check', { fids: part });
        alive();
        const have = new Set((Array.isArray(res.have) ? res.have : []).filter((f) => typeof f === 'string'));
        for (const f of part) {
          const rec = recOf.get(f) ?? '';
          if (have.has(f)) { st.have[f] = 1; st.chk[f] = [now, rec]; if (st.tries[f]?.[2] === 'gone') delete st.tries[f]; } else { delete st.have[f]; delete st.chk[f]; }
        }
        // Missing from the account and from this device: look again later (another device may upload it).
        const asked = new Set(part);
        for (const r of refs) if (asked.has(r.fid) && !have.has(r.fid) && !local.has(r.id) && due(st, r.fid, now)) fail(st, r.fid, 'gone', now);
      } catch (e) { stopOn(e); offline = true; }
    }

    // 2. Uploads: photos on this device whose task record is in the account, the server lacking them.
    let accountFull = false;
    for (const r of refs) {
      if (offline || accountFull) break;
      // Before "Remove from this device" (uploadOnly) a network failure is tried again right away.
      if (!r.uploaded || !local.has(r.id) || st.have[r.fid]) continue;
      if (!due(st, r.fid, Date.now()) && !(opts.uploadOnly && st.tries[r.fid]?.[2] === 'net')) continue;
      try {
        await uploadOne(r, fc, call, alive);
        st.have[r.fid] = 1; st.chk[r.fid] = [Date.now(), r.rec]; delete st.tries[r.fid];
      } catch (e) {
        stopOn(e);
        now = Date.now();
        if (e?.code === 'nofile') continue;
        if (e?.code === 'large') { fail(st, r.fid, 'large', now, LARGE_RETRY); continue; }
        if (e?.status === 413) { fail(st, r.fid, 'full', now, ACCOUNT_FULL_RETRY); accountFull = true; continue; }
        fail(st, r.fid, 'net', now);
        if (!e?.status || e.status === 429 || e.status >= 500) offline = true;
      }
      await saveState(fc.accountId, st);
      alive();
    }

    // 3. Downloads: referenced photos this device doesn't have and the server does.
    if (!opts.uploadOnly) {
      now = Date.now();
      const fullNow = st.deviceFull && now - st.deviceFull < timing.fullRetry;
      for (const r of refs) {
        if (offline || fullNow || (st.deviceFull && Date.now() - st.deviceFull < timing.fullRetry)) break;
        if (local.has(r.id) || !st.have[r.fid] || !due(st, r.fid, now)) continue;
        try {
          if (await downloadOne(r, fc, call, alive)) { emit(); }
          local.add(r.id); delete st.tries[r.fid]; st.deviceFull = 0;
        } catch (e) {
          stopOn(e);
          now = Date.now();
          if (e?.code === 'devicefull') { st.deviceFull = now; break; }
          if (e?.status === 404) { delete st.have[r.fid]; fail(st, r.fid, 'gone', now); continue; }
          if (e?.code === 'bad') { fail(st, r.fid, 'bad', now); continue; }
          fail(st, r.fid, 'net', now);
          if (!e?.status || e.status === 429 || e.status >= 500) offline = true;
        }
        await saveState(fc.accountId, st);
        alive();
      }
    }

    // 4. Clean-up in the account (rarely, and only when it's safe).
    if (!opts.uploadOnly && !offline && (opts.gc || Date.now() - st.gcAt >= timing.gcEvery)) await collect(fc, st, call, alive);

    alive();
    await saveState(fc.accountId, st);
    alive();
    setMem(fc, st, refs, local, offline);
    // Try again when the earliest retry is due (or the device has room again).
    now = Date.now();
    let next = Infinity;
    for (const r of refs) {
      if (local.has(r.id) && (st.have[r.fid] || !r.uploaded)) continue; // not uploaded: the next record sync starts a pass
      const t = st.tries[r.fid]?.[1];
      next = Math.min(next, t && t > now ? t : now + 30000);
    }
    if (st.deviceFull) next = Math.min(next, st.deviceFull + timing.fullRetry);
    if (refs.some((r) => local.has(r.id) && r.uploaded)) next = Math.min(next, now + 3600000); // daily re-check of `have`
    if (offline) next = Math.min(next, now + 60000);
    if (next < Infinity) scheduleFilePass(Math.min(Math.max(next - now, 5000), 3600000));
    return !offline;
  } finally {
    if (ctl === my) ctl = null;
  }
}

function setMem(fc, st, refs, local, offline) {
  const status = new Map();
  let up = 0, large = 0, full = 0, deviceFull = 0;
  const fullNow = st.deviceFull && Date.now() - st.deviceFull < timing.fullRetry;
  for (const r of refs) {
    const why = st.tries[r.fid]?.[2];
    if (local.has(r.id)) {
      if (st.have[r.fid]) continue;
      if (why === 'large') large++; else if (why === 'full') full++; else up++;
      continue;
    }
    const k = `${r.pid}/${r.id}`;
    if (!st.have[r.fid]) status.set(k, 'elsewhere'); // not in the account (yet), deleted, or the server can't be reached
    else if (fullNow) { status.set(k, 'full'); deviceFull++; }
    else status.set(k, offline || why === 'bad' ? 'elsewhere' : 'downloading');
  }
  mem = { accountId: fc.accountId, status, up, large, full, deviceFull };
  emit();
}

// ---------- one photo up / down ----------
const codeErr = (code) => Object.assign(new Error(code), { code });
/** payload = uint32 header length || header JSON || image || thumbnail. */
async function payloadOf(rec) {
  const blob = rec.blob, thumb = rec.thumbBlob || null;
  const type = OK_TYPES.includes(rec.type) ? rec.type : OK_TYPES.includes(blob.type) ? blob.type : 'image/jpeg';
  const tt = thumb ? (OK_TYPES.includes(thumb.type) ? thumb.type : type) : null;
  const header = new TextEncoder().encode(JSON.stringify({ v: 1, type, w: rec.w || 0, h: rec.h || 0, b: blob.size, tt, th: thumb ? thumb.size : 0 }));
  const out = new Uint8Array(4 + header.length + blob.size + (thumb ? thumb.size : 0));
  new DataView(out.buffer).setUint32(0, header.length);
  out.set(header, 4);
  out.set(new Uint8Array(await blob.arrayBuffer()), 4 + header.length);
  if (thumb) out.set(new Uint8Array(await thumb.arrayBuffer()), 4 + header.length + blob.size);
  return out;
}
function parsePayload(pt) {
  if (pt.length < 4) return null;
  const hl = new DataView(pt.buffer, pt.byteOffset, pt.byteLength).getUint32(0);
  if (hl > 4096 || 4 + hl > pt.length) return null;
  let h;
  try { h = JSON.parse(new TextDecoder().decode(pt.subarray(4, 4 + hl))); } catch { return null; }
  const int = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;
  if (!isObj(h) || h.v !== 1 || !OK_TYPES.includes(h.type) || !int(h.w, 10000) || !int(h.h, 10000) || !int(h.b, 1e8) || h.b < 1 || !int(h.th, 1e8)) return null;
  if (h.th ? !OK_TYPES.includes(h.tt) : h.tt !== null) return null;
  if (4 + hl + h.b + h.th !== pt.length) return null;
  const start = 4 + hl;
  return {
    type: h.type, w: h.w, h: h.h,
    blob: new Blob([pt.slice(start, start + h.b)], { type: h.type }),
    thumbBlob: h.th ? new Blob([pt.slice(start + h.b)], { type: h.tt }) : null,
  };
}

async function uploadOne(r, fc, call, alive) {
  let rec;
  try { rec = await getFile(r.id); } catch { rec = null; }
  if (!rec?.blob) throw codeErr('nofile');
  const bytes = await payloadOf(rec);
  if (Math.ceil((bytes.length + 28) / 3) * 4 > FILE_MAX_CHARS) throw codeErr('large');
  const ct = await C.encryptFile(fc.keys.encKey, r.fid, bytes);
  const text = C.b64u(ct);
  alive();
  const start = await call('POST', '/api/files/upload', { fid: r.fid, size: text.length });
  alive();
  if (start.have === true) return;
  const size = Number(start.chunkChars);
  if (typeof start.upload !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(start.upload) || !Number.isInteger(size) || size < 1024 || size > 4 * 1024 * 1024) throw Object.assign(new Error('Bad answer from the server'), { status: 500 });
  const chunks = Math.ceil(text.length / size);
  for (let n = 0; n < chunks; n++) {
    await call('PUT', `/api/files/upload/${start.upload}/${n}`, undefined, { raw: text.slice(n * size, (n + 1) * size) });
    alive();
  }
  await call('POST', `/api/files/upload/${start.upload}/commit`, {});
}

/** Returns true when a file was stored. */
async function downloadOne(r, fc, call, alive) {
  const bad = () => codeErr('bad');
  const first = await call('GET', `/api/files/${r.fid}/0`);
  alive();
  const chunks = first?.chunks, size = first?.size;
  if (first?.fid !== r.fid || !Number.isInteger(chunks) || chunks < 1 || chunks > 64 || !Number.isInteger(size) || size < 38 || size > FILE_MAX_CHARS || typeof first.data !== 'string') throw bad();
  const parts = [first.data];
  for (let n = 1; n < chunks; n++) {
    const c = await call('GET', `/api/files/${r.fid}/${n}`);
    alive();
    if (c?.fid !== r.fid || c.n !== n || c.chunks !== chunks || c.size !== size || typeof c.data !== 'string') throw bad();
    parts.push(c.data);
  }
  const text = parts.join('');
  if (text.length !== size) throw bad();
  let bytes;
  try { bytes = C.unb64u(text); } catch { throw bad(); }
  const pt = await C.decryptFile(fc.keys.encKey, r.fid, bytes);
  if (!pt) throw bad();
  const p = parsePayload(pt);
  if (!p) throw bad();
  alive();
  if (await getFile(r.id).catch(() => null)) return false; // arrived meanwhile (another tab, an import)
  try {
    await putFile({ id: r.id, profileId: r.pid, taskId: r.taskId, blob: p.blob, thumbBlob: p.thumbBlob, type: p.type, w: p.w, h: p.h, size: p.blob.size, createdAt: Date.now() });
  } catch (e) {
    console.warn('Photo sync: a photo couldn’t be stored on this device');
    throw codeErr('devicefull');
  }
  return true;
}

// ---------- clean-up in the account ----------
/** fids every profile on this device refers to (synced or not), or null when one can't be read. */
async function referencedHere(keys) {
  const out = new Set();
  for (const p of getProfiles()) {
    const st = readProfileState(p.id);
    if (!st) return null;
    for (const t of st.tasks || []) for (const a of t.attachments || []) out.add(await fidOf(keys, p.id, a.id));
  }
  return out;
}
async function collect(fc, st, call, alive) {
  if (!(await S.gcReady())) return;
  alive();
  const server = new Map();
  let after = '';
  for (let page = 0; page < 1000; page++) {
    const res = await call('GET', `/api/files/list?limit=1000${after ? '&after=' + after : ''}`);
    alive();
    const files = Array.isArray(res.files) ? res.files : [];
    for (const f of files) if (f && typeof f.fid === 'string' && FID_RE.test(f.fid)) server.set(f.fid, f);
    if (!res.more || !files.length) break;
    after = files[files.length - 1].fid;
    if (!FID_RE.test(after)) break;
  }
  const refs = await referencedHere(fc.keys);
  alive();
  if (!refs || !(await S.gcReady())) return;
  alive();
  const now = Date.now();
  for (const fid of Object.keys(st.unref)) if (!server.has(fid) || refs.has(fid)) delete st.unref[fid];
  for (const fid of Object.keys(st.have)) if (!server.has(fid)) { delete st.have[fid]; delete st.chk[fid]; }
  for (const fid of Object.keys(st.seen)) if (!server.has(fid) && !refs.has(fid)) delete st.seen[fid];
  const doomed = [];
  for (const fid of server.keys()) {
    // Only files this client derived itself from a photo reference are ever deleted: anything else
    // (a file kind a newer app added) is not ours to judge.
    if (refs.has(fid) || !st.seen[fid]) continue;
    if (!st.unref[fid]) st.unref[fid] = now;
    else if (now - st.unref[fid] >= timing.gcDelay) doomed.push(fid);
  }
  st.gcAt = now;
  if (!doomed.length) return;
  // Last look right before deleting: an edit, Undo or pull may have landed during the awaits above.
  const again = await referencedHere(fc.keys);
  alive();
  if (!again || !(await S.gcReady())) return;
  alive();
  const go = doomed.filter((f) => !again.has(f));
  for (let i = 0; i < go.length; i += DELETE_BATCH) {
    const res = await call('POST', '/api/files/delete', { fids: go.slice(i, i + DELETE_BATCH) });
    alive();
    for (const f of Array.isArray(res.deleted) ? res.deleted : []) { delete st.have[f]; delete st.chk[f]; delete st.seen[f]; delete st.unref[f]; delete st.tries[f]; }
  }
}

// ---------- before "Remove from this device" ----------
/**
 * Photos of the synced profiles' tasks that are on this device but not confirmed in the account:
 * { pending, tooLarge, full }. Asks the server each time; when it can't, every one counts as pending.
 */
export async function unsyncedPhotos() {
  const out = { pending: 0, tooLarge: 0, full: 0 };
  const fc = await S.fileContext();
  const refs = await S.photoRefs().catch(() => []);
  if (!refs.length) return out;
  let local;
  try { local = await fileIds(); } catch { out.pending = new Set(refs.map((r) => r.id)).size; return out; }
  const mine = refs.filter((r) => local.has(r.id));
  if (!mine.length) return out;
  if (!fc) { out.pending = mine.length; return out; }
  for (const r of mine) r.fid = await fidOf(fc.keys, r.pid, r.id);
  const st = await loadState(fc.accountId);
  const fids = [...new Set(mine.map((r) => r.fid))];
  const have = new Set();
  try {
    for (let i = 0; i < fids.length; i += CHECK_BATCH) {
      const res = await S.fileCall(fc, 'POST', '/api/files/check', { fids: fids.slice(i, i + CHECK_BATCH) });
      for (const f of Array.isArray(res.have) ? res.have : []) have.add(f);
    }
  } catch { out.pending = fids.length; return out; }
  for (const f of fids) {
    if (have.has(f)) continue;
    const why = st.tries[f]?.[2];
    if (why === 'large') out.tooLarge++; else if (why === 'full') out.full++; else out.pending++;
  }
  return out;
}
