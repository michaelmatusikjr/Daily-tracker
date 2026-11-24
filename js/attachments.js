// Photos attached to tasks. The image data lives in IndexedDB (database "dailyTracker-files",
// store "files"), never in localStorage; a task only keeps attachments: [{ id, w, h, type }].
import { uid } from './store.js';

export const MAX_PER_TASK = 6;
const LONG_EDGE = 1600;
const THUMB_EDGE = 240;
const IMPORT_MAX_BYTES = 8 * 1024 * 1024;
const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// ---------- IndexedDB ----------
let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open('dailyTracker-files', 1); } catch { reject(new Error('blocked')); return; }
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore('files', { keyPath: 'id' });
        store.createIndex('profileId', 'profileId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('blocked'));
      req.onblocked = () => reject(new Error('blocked'));
    }).catch((e) => { dbPromise = null; throw e; });
  }
  return dbPromise;
}

/** Plain-language message for a storage failure. */
export function storageMessage(e) {
  const n = e?.name || '';
  if (n === 'QuotaExceededError' || /quota/i.test(e?.message || '')) return 'Not enough space on this device to save this photo. Delete some photos or free up space.';
  return 'Photos can’t be saved in this browser right now (its storage is blocked or unavailable).';
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('files', mode);
    const store = t.objectStore('files');
    let out;
    Promise.resolve(fn(store)).then((v) => { out = v; }, reject);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  });
}
const reqP = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export const putFile = (rec) => tx('readwrite', (s) => { s.put(rec); });
export const getFile = (id) => tx('readonly', (s) => reqP(s.get(id)));
export const deleteFiles = (ids) => (ids.length ? tx('readwrite', (s) => { ids.forEach((id) => s.delete(id)); }) : Promise.resolve());
export const allFiles = () => tx('readonly', (s) => reqP(s.getAll()));
export const filesForProfile = (profileId) => tx('readonly', (s) => reqP(s.index('profileId').getAll(profileId)));
export async function deleteProfileFiles(profileId) {
  try { const f = await filesForProfile(profileId); await deleteFiles(f.map((x) => x.id)); } catch { /* GC catches leftovers */ }
}
/** Move a profile's files to another profile id (the profile got a new id, see reIdProfile). */
export async function reassignProfileFiles(fromId, toId) {
  const f = await filesForProfile(fromId);
  if (!f.length) return;
  await tx('readwrite', (s) => { for (const rec of f) s.put({ ...rec, profileId: toId }); });
}
/** { count, bytes } for one profile (originals + thumbnails). */
export async function profileUsage(profileId) {
  const f = await filesForProfile(profileId);
  return { count: f.length, bytes: f.reduce((n, x) => n + (x.blob?.size || 0) + (x.thumbBlob?.size || 0), 0) };
}
export const fmtBytes = (b) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

/** Point files at their (new) task after it's saved. */
export async function assignFiles(ids, taskId, profileId) {
  await tx('readwrite', async (s) => {
    for (const id of ids) {
      const rec = await reqP(s.get(id));
      if (rec) s.put({ ...rec, taskId, profileId });
    }
  });
}

/** Copy files under new ids (Duplicate). Returns the new attachment list. */
export async function copyFiles(attachments, taskId, profileId) {
  const out = [];
  for (const a of attachments) {
    const rec = await getFile(a.id);
    if (!rec) continue;
    const id = 'f' + uid();
    await putFile({ ...rec, id, taskId, profileId, createdAt: Date.now() });
    out.push({ ...a, id });
  }
  return out;
}

/** Remove files no task in any profile refers to (older than a day, so in-progress edits are safe). */
export async function collectGarbage(referencedIds, now = Date.now()) {
  const files = await allFiles();
  const stale = files.filter((f) => !referencedIds.has(f.id) && (f.createdAt || 0) < now - 86400000).map((f) => f.id);
  await deleteFiles(stale);
  return stale.length;
}

// ---------- Image processing ----------
async function decode(blob) {
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); // EXIF orientation applied
    return { src: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close?.() };
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
      return { src: img, w: img.naturalWidth, h: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
    } catch {
      URL.revokeObjectURL(url);
      throw new Error('That image couldn’t be read.');
    }
  }
}
const toBlob = (canvas, type, q) => new Promise((resolve) => canvas.toBlob(resolve, type, q));
function draw(src, w, h, edge, opaque) {
  const scale = Math.min(1, edge / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
  const x = c.getContext('2d', { willReadFrequently: true });
  if (opaque) { x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); }
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
function hasAlpha(canvas) {
  const s = draw(canvas, canvas.width, canvas.height, 64, false);
  const d = s.getContext('2d').getImageData(0, 0, s.width, s.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}

/**
 * File → { blob, thumbBlob, type, w, h, size }: orientation fixed, ≤1600px long edge, JPEG ~0.82
 * (PNG kept only when it has transparency and stays small), plus a ~240px thumbnail.
 */
export async function processPhoto(file) {
  if (!file || !/^image\//.test(file.type || '')) throw new Error('That file isn’t an image.');
  if (/hei[cf]/i.test(file.type)) throw new Error('HEIC photos aren’t supported by this browser – choose a JPEG or PNG.');
  if (file.size > 40 * 1024 * 1024) throw new Error('That image is too large (max 40 MB).');
  const img = await decode(file);
  try {
    if (!img.w || !img.h) throw new Error('That image couldn’t be read.');
    let canvas = draw(img.src, img.w, img.h, LONG_EDGE, false);
    let type = 'image/jpeg', blob = null;
    if (file.type === 'image/png' && hasAlpha(canvas)) {
      const png = await toBlob(canvas, 'image/png');
      if (png && png.size <= 600 * 1024) { blob = png; type = 'image/png'; }
    }
    if (!blob) {
      canvas = draw(img.src, img.w, img.h, LONG_EDGE, true); // flatten onto white for JPEG
      blob = await toBlob(canvas, 'image/jpeg', 0.82);
    }
    if (!blob) throw new Error('That image couldn’t be converted.');
    const thumbCanvas = draw(canvas, canvas.width, canvas.height, THUMB_EDGE, type === 'image/jpeg');
    const thumbBlob = await toBlob(thumbCanvas, type === 'image/png' ? 'image/png' : 'image/jpeg', 0.75);
    return { blob, thumbBlob, type, w: canvas.width, h: canvas.height, size: blob.size };
  } finally { img.done(); }
}

/** Process + store one photo for a profile (taskId may be filled in on save). */
export async function addPhoto(file, profileId, taskId = null) {
  const p = await processPhoto(file);
  const id = 'f' + uid();
  try {
    await putFile({ id, profileId, taskId, blob: p.blob, thumbBlob: p.thumbBlob, type: p.type, w: p.w, h: p.h, size: p.size, createdAt: Date.now() });
  } catch (e) {
    throw new Error(storageMessage(e));
  }
  return { id, w: p.w, h: p.h, type: p.type };
}

/** Object URL for a stored file's thumbnail or original (null when missing). */
export async function fileUrl(id, which = 'thumb') {
  try {
    const rec = await getFile(id);
    const b = rec && (which === 'thumb' ? rec.thumbBlob || rec.blob : rec.blob);
    return b ? URL.createObjectURL(b) : null;
  } catch { return null; }
}

// ---------- Export / import ----------
const blobToDataUrl = (b) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(b); });
async function dataUrlToBlob(u) { return (await fetch(u)).blob(); }

/** Files referenced by these tasks, for a backup. */
export async function exportFiles(ids) {
  const out = [];
  for (const id of ids) {
    try {
      const f = await getFile(id);
      if (!f) continue;
      out.push({ id: f.id, profileId: f.profileId, taskId: f.taskId, type: f.type, w: f.w, h: f.h, createdAt: f.createdAt, data: await blobToDataUrl(f.blob), thumb: f.thumbBlob ? await blobToDataUrl(f.thumbBlob) : null });
    } catch { /* skip unreadable */ }
  }
  return out;
}
/** Approximate bytes a backup with photos adds (base64 is ~4/3 of the binary size). */
export async function exportSize(ids) {
  let n = 0;
  for (const id of ids) { try { const f = await getFile(id); if (f) n += (f.blob?.size || 0) + (f.thumbBlob?.size || 0); } catch { /* ignore */ } }
  return Math.round(n * 4 / 3);
}
const DATA_RE = /^data:(image\/(?:jpeg|png|webp));base64,[A-Za-z0-9+/]+={0,2}$/;
const b64Bytes = (u) => Math.floor((u.length - u.indexOf(',') - 1) * 3 / 4);
/**
 * Validate and store imported files (profileIdFor maps a backup profile id to its profile here).
 * An id already used by a file of a different profile is never overwritten or shared: the file
 * gets a new id instead. Returns { stored: Set of ids, renamed: Map(oldId → { id, profileId }) };
 * the caller rewrites task references for renamed ones (see rewriteRefs).
 */
export async function importFiles(list, profileIdFor) {
  const stored = new Set();
  const renamed = new Map();
  let error = null;
  if (!Array.isArray(list)) return Object.assign(stored, { stored, renamed, error });
  for (const f of list.slice(0, 5000)) {
    if (!f || typeof f.id !== 'string' || !/^[\w-]{1,60}$/.test(f.id) || typeof f.data !== 'string') continue;
    const m = DATA_RE.exec(f.data);
    if (!m || !OK_TYPES.includes(m[1]) || b64Bytes(f.data) > IMPORT_MAX_BYTES) continue;
    const thumbOk = typeof f.thumb === 'string' && DATA_RE.test(f.thumb) && b64Bytes(f.thumb) <= 1024 * 1024;
    try {
      const blob = await dataUrlToBlob(f.data);
      const thumbBlob = thumbOk ? await dataUrlToBlob(f.thumb) : null;
      const profileId = profileIdFor(f.profileId);
      let id = f.id;
      const existing = await getFile(id);
      let rename = null;
      if (existing && existing.profileId !== profileId) { id = 'f' + uid(); rename = { id, profileId }; }
      const dim = (v) => Math.min(10000, Math.max(0, Math.round(Number(v) || 0)));
      await putFile({ id, profileId, taskId: typeof f.taskId === 'string' ? f.taskId : null, blob, thumbBlob, type: m[1], w: dim(f.w), h: dim(f.h), size: blob.size, createdAt: Number(f.createdAt) || Date.now() });
      if (rename) renamed.set(f.id, rename); // only once the copy is really stored
      stored.add(id);
    } catch (e) {
      // Stop here, but still hand back what was renamed so far: the caller must repoint those tasks
      // (otherwise they would keep the old id, which belongs to another profile's photo).
      error = new Error(storageMessage(e));
      break;
    }
  }
  return Object.assign(stored, { stored, renamed, error });
}

/** Give a backup's photos fresh ids (for a profile that's being created or replaced). Mutates both. */
export function reIdPhotos(data, list) {
  if (!Array.isArray(list)) return list;
  const map = new Map();
  for (const t of data.tasks || []) for (const a of t.attachments || []) { if (!map.has(a.id)) map.set(a.id, 'f' + uid()); a.id = map.get(a.id); }
  return list.filter((f) => f && map.has(f.id)).map((f) => ({ ...f, id: map.get(f.id) }));
}
