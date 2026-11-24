// Habit icons: an emoji (habit.emoji, always present as the text fallback) or an image
// (habit.icon = { type: 'image', data: 'data:image/png;base64,…' }), e.g. an iOS Genmoji,
// which isn't a Unicode emoji and can't live in a text field.
import { h } from './ui.js';

export const ICON_SIZE = 96;
export const ICON_MAX_BYTES = 40 * 1024;       // what the app produces
export const ICON_IMPORT_MAX_BYTES = 60 * 1024; // what import accepts
const DATA_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Decoded byte size of a base64 data URL. */
export const dataUrlBytes = (u) => Math.floor((u.length - u.indexOf(',') - 1) * 3 / 4);
/** A stored image icon, or null when it isn't one we accept (import/load validation). */
export function validIcon(icon) {
  if (!icon || icon.type !== 'image' || typeof icon.data !== 'string') return null;
  if (!DATA_RE.test(icon.data) || dataUrlBytes(icon.data) > ICON_IMPORT_MAX_BYTES) return null;
  return { type: 'image', data: icon.data };
}
export const hasImageIcon = (hb) => hb?.icon?.type === 'image' && !!hb.icon.data;

// Photo icons fill the whole icon (cover, centred); Genmoji/stickers with transparency stay fully visible.
// New photos are stored as opaque square JPEGs (see the cropper). Icons stored by older versions are
// PNGs trimmed to their visible box, so a photo has transparent bars; those are detected and filled at
// render time (the stored data is never changed). Results are cached per stored image.
const photoCache = new Map(); // stored data URL -> { photo: boolean, src?: string }
const isJpeg = (u) => u.startsWith('data:image/jpeg');

/**
 * Is this stored PNG a photo (an opaque rectangle inside transparent bars) rather than a sticker?
 * Photo: inside the visible bounding box (almost) every pixel is opaque. Returns { photo, src } where
 * src is the bars-free centred square (opaque JPEG data URL) for photos.
 */
export async function analyseStoredIcon(data) {
  const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('decode')); i.src = data; });
  const W = img.naturalWidth, H = img.naturalHeight;
  // A stored icon is at most ~60 KB, but its pixel size isn't validated: never decode a huge bitmap.
  if (!W || !H || W > 512 || H > 512) return { photo: false };
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  const px = x.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1, opaque = 0;
  for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) {
    const a = px[(y * W + xx) * 4 + 3];
    if (a > 8) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (a >= 250) opaque++;
  }
  if (x1 < 0) return { photo: false };
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  // Opaque pixels inside the box / box area (opaque pixels all lie inside the box).
  if (opaque / (bw * bh) < 0.97) return { photo: false };
  const side = Math.min(bw, bh);
  const out = document.createElement('canvas');
  out.width = out.height = ICON_SIZE;
  const o = out.getContext('2d');
  o.imageSmoothingQuality = 'high';
  o.drawImage(c, x0 + (bw - side) / 2, y0 + (bh - side) / 2, side, side, 0, 0, ICON_SIZE, ICON_SIZE);
  return { photo: true, src: out.toDataURL('image/jpeg', 0.9) };
}

function applyPhoto(img, r) {
  if (!r.photo) return;
  img.classList.add('photo');
  if (r.src) img.src = r.src;
}

/** Icon content for a bubble/heading: <img alt=""> or the emoji text. */
export function habitIcon(hb) {
  if (!hasImageIcon(hb)) return hb.emoji;
  const data = hb.icon.data;
  const img = h('img.habit-img', { src: data, alt: '', draggable: 'false' });
  // An image that can't be shown here (e.g. not on this device yet) falls back to the emoji / first letter.
  img.addEventListener('error', () => { if (img.isConnected) img.replaceWith(document.createTextNode(hb.emoji || [...String(hb.name || '?').trim()][0] || '?')); }, { once: true });
  if (isJpeg(data)) { img.classList.add('photo'); return img; }
  const hit = photoCache.get(data);
  if (hit) applyPhoto(img, hit);
  else {
    photoCache.set(data, { photo: false }); // placeholder while analysing (and on failure)
    analyseStoredIcon(data).then((r) => { photoCache.set(data, r); applyPhoto(img, r); document.querySelectorAll('img.habit-img').forEach((el) => { if (el !== img && el.getAttribute('src') === data) applyPhoto(el, r); }); }).catch(() => {});
  }
  return img;
}

/** Does this image have real transparency (a sticker / Genmoji) rather than being an opaque photo? */
export async function hasTransparency(blob) {
  const img = await decode(blob);
  try {
    const k = Math.min(1, 128 / Math.max(img.w, img.h));
    const W = Math.max(1, Math.round(img.w * k)), H = Math.max(1, Math.round(img.h * k));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img.src, 0, 0, W, H);
    const px = x.getImageData(0, 0, W, H).data;
    let clear = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] < 250) clear++;
    return clear / (W * H) > 0.02;
  } finally { img.done(); }
}
/** Plain-text label (selects, notifications, toasts): image icons are left out. */
export const habitText = (hb) => (hasImageIcon(hb) ? hb.name : `${hb.emoji} ${hb.name}`);
/** Heading-style node: icon + name (menu titles). */
export const habitTitle = (hb) => (hasImageIcon(hb) ? h('span.habit-title', habitIcon(hb), ' ', hb.name) : `${hb.emoji} ${hb.name}`);

// ---------- Turning an image into an icon ----------
async function decode(blob) {
  if (!blob || !/^image\//.test(blob.type || '')) throw new Error('That isn’t an image.');
  if (blob.size > 25 * 1024 * 1024) throw new Error('That image is too large (max 25 MB).');
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    return { src: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close?.() };
  } catch {
    // Fallback (e.g. SVG): <img> applies EXIF orientation itself in current browsers.
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('decode'));
        i.src = url;
      });
      return { src: img, w: img.naturalWidth || 256, h: img.naturalHeight || 256, done: () => URL.revokeObjectURL(url) };
    } catch {
      URL.revokeObjectURL(url);
      throw new Error('That image couldn’t be read.');
    }
  }
}

/** Fetch an <img> src (data:, blob: or same-document URL) as a Blob. */
export async function blobFromSrc(src) {
  if (typeof src !== 'string' || !src) throw new Error('That image couldn’t be read.');
  const u = new URL(src, location.href);
  if (!['data:', 'blob:'].includes(u.protocol) && u.origin !== location.origin) throw new Error('That image couldn’t be read.');
  try {
    const res = await fetch(u.href);
    if (!res.ok) throw new Error('status');
    return await res.blob();
  } catch {
    throw new Error('That image couldn’t be read.');
  }
}

/**
 * Image (File/Blob, or an <img> src) → square PNG data URL with transparency kept:
 * trimmed to the visible pixels' bounding box, centred, 96×96, at most ~40 KB.
 */
export async function processIcon(input) {
  const blob = typeof input === 'string' ? await blobFromSrc(input) : input;
  const img = await decode(blob);
  try {
    if (!img.w || !img.h) throw new Error('That image couldn’t be read.');
    // Work at a bounded size so huge photos stay fast.
    const scale = Math.min(1, 512 / Math.max(img.w, img.h));
    const W = Math.max(1, Math.round(img.w * scale)), H = Math.max(1, Math.round(img.h * scale));
    const work = document.createElement('canvas');
    work.width = W; work.height = H;
    const wc = work.getContext('2d', { willReadFrequently: true });
    wc.drawImage(img.src, 0, 0, W, H);
    // Bounding box of non-transparent pixels.
    const px = wc.getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (px[(y * W + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    if (x1 < 0) throw new Error('That image is empty.');
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1, side = Math.max(bw, bh);
    const sx = x0 - (side - bw) / 2, sy = y0 - (side - bh) / 2;
    for (const size of [ICON_SIZE, 80, 64, 48, 32]) {
      const out = document.createElement('canvas');
      out.width = size; out.height = size;
      const oc = out.getContext('2d');
      oc.imageSmoothingQuality = 'high';
      oc.drawImage(work, sx, sy, side, side, 0, 0, size, size); // transparent background kept
      const data = out.toDataURL('image/png');
      if (!data.startsWith('data:image/png')) throw new Error('That image couldn’t be converted.');
      if (dataUrlBytes(data) <= ICON_MAX_BYTES) return data;
    }
    throw new Error('That image is too detailed to use as an icon.');
  } finally { img.done(); }
}
