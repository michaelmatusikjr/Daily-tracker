// Reusable photo crop step: a sheet with a live preview (round or rounded-square mask), drag to
// position, pinch / mouse wheel / slider to zoom, a rotate-90° button, and Save / Cancel.
// Resolves with a square JPEG data URL (or null when cancelled). Used for profile photos and
// habit photo icons. No brightness or other adjustments.
import { h, openSheet } from './ui.js';
import { icon } from './icons.js';

const MAX_SOURCE = 2048; // longest side kept while editing (keeps big photos fast)
const MAX_ZOOM = 5;

/** Decode an image File/Blob (EXIF orientation applied) into a canvas of at most MAX_SOURCE px. */
async function decodeToCanvas(blob) {
  if (!blob || !/^image\//.test(blob.type || '')) throw new Error('That file isn’t an image.');
  if (blob.size > 25 * 1024 * 1024) throw new Error('That image is too large (max 25 MB).');
  let src, w, hgt, done = () => {};
  try {
    src = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    w = src.width; hgt = src.height; done = () => src.close?.();
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      src = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('decode')); i.src = url; });
    } catch { URL.revokeObjectURL(url); throw new Error('That image couldn’t be read.'); }
    w = src.naturalWidth; hgt = src.naturalHeight; done = () => URL.revokeObjectURL(url);
  }
  try {
    if (!w || !hgt) throw new Error('That image couldn’t be read.');
    const k = Math.min(1, MAX_SOURCE / Math.max(w, hgt));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(hgt * k));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return c;
  } finally { done(); }
}

const rotated = (c) => {
  const r = document.createElement('canvas');
  r.width = c.height; r.height = c.width;
  const x = r.getContext('2d');
  x.translate(r.width, 0); x.rotate(Math.PI / 2); // 90° clockwise
  x.drawImage(c, 0, 0);
  return r;
};

/**
 * Open the crop sheet for `file`.
 * options: { size = 192 output px, quality = .8, title, shape = 'round' | 'square', maxBytes }
 * Returns Promise<string | null>. Rejects (before opening) when the file can't be read.
 */
export async function openCropper(file, { size = 192, quality = 0.8, title = 'Adjust photo', shape = 'round', maxBytes = null } = {}) {
  let base = await decodeToCanvas(file);
  return new Promise((resolve) => {
    let finished = false;
    const finish = (v) => { if (finished) return; finished = true; resolve(v); };
    // View state: (cx, cy) = centre of the crop in image pixels; z = zoom (1 = the photo just covers the frame).
    let cx = base.width / 2, cy = base.height / 2, z = 1;

    const canvas = h('canvas.cropper-canvas', { 'aria-hidden': 'true' });
    const mask = h(`div.cropper-mask.${shape === 'square' ? 'square' : 'round'}`, { 'aria-hidden': 'true' });
    const stage = h('div.cropper-stage', { tabindex: '0', role: 'img', 'aria-label': 'Photo preview. Drag to move, pinch or use the slider to zoom.', 'data-shape': shape }, canvas, mask);
    const zoom = h('input.cropper-zoom', { type: 'range', min: '1', max: String(MAX_ZOOM), step: '0.01', value: '1', 'aria-label': 'Zoom' });
    const rotate = h('button.btn.secondary.small.cropper-rotate', { type: 'button' }, icon('rotate', { size: 16 }), 'Rotate');
    const err = h('p.form-error', { role: 'alert' });

    const view = () => stage.clientWidth || 280;
    const scale = () => (view() / Math.min(base.width, base.height)) * z;
    const clamp = () => {
      const half = view() / 2 / scale();
      cx = Math.min(base.width - half, Math.max(half, cx));
      cy = Math.min(base.height - half, Math.max(half, cy));
    };
    const draw = () => {
      const V = view();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(V * dpr)) { canvas.width = canvas.height = Math.round(V * dpr); }
      clamp();
      const ctx = canvas.getContext('2d');
      const s = scale() * dpr;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(base, canvas.width / 2 - cx * s, canvas.height / 2 - cy * s, base.width * s, base.height * s);
      zoom.value = String(z);
    };
    const setZoom = (nz, fx = 0.5, fy = 0.5) => {
      // Keep the point under (fx, fy) (fractions of the frame) fixed while zooming.
      const V = view(), before = scale();
      const px = cx + (fx - 0.5) * V / before, py = cy + (fy - 0.5) * V / before;
      z = Math.min(MAX_ZOOM, Math.max(1, nz));
      const after = scale();
      cx = px - (fx - 0.5) * V / after; cy = py - (fy - 0.5) * V / after;
      draw();
    };

    // Pointer gestures: one pointer drags, two pinch.
    const ptrs = new Map();
    let pinch = null;
    stage.addEventListener('pointerdown', (e) => {
      try { stage.setPointerCapture?.(e.pointerId); } catch { /* synthetic or already released pointer */ }
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z }; }
    });
    stage.addEventListener('pointermove', (e) => {
      const p = ptrs.get(e.pointerId);
      if (!p) return;
      if (ptrs.size === 1) {
        const s = scale();
        cx -= (e.clientX - p.x) / s; cy -= (e.clientY - p.y) / s;
        p.x = e.clientX; p.y = e.clientY;
        draw();
      } else if (ptrs.size === 2 && pinch) {
        p.x = e.clientX; p.y = e.clientY;
        const [a, b] = [...ptrs.values()];
        setZoom(pinch.z * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
      }
    });
    const up = (e) => { ptrs.delete(e.pointerId); pinch = null; const r = [...ptrs.values()][0]; if (r) { /* continue dragging with the remaining finger */ } };
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    stage.addEventListener('wheel', (e) => { e.preventDefault(); setZoom(z * Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
    stage.addEventListener('keydown', (e) => {
      const step = 12 / scale();
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (d) { e.preventDefault(); cx += d[0]; cy += d[1]; draw(); }
    });
    zoom.addEventListener('input', () => setZoom(Number(zoom.value)));
    rotate.addEventListener('click', () => {
      base = rotated(base);
      cx = base.width / 2; cy = base.height / 2; // re-centre after a turn
      draw();
    });

    /** The current crop as a square JPEG data URL. */
    const render = () => {
      clamp();
      const out = document.createElement('canvas');
      out.width = out.height = size;
      const c = out.getContext('2d');
      c.fillStyle = '#fff'; c.fillRect(0, 0, size, size);
      c.imageSmoothingQuality = 'high';
      const side = view() / scale();
      c.drawImage(base, cx - side / 2, cy - side / 2, side, side, 0, 0, size, size);
      let q = quality;
      let data = out.toDataURL('image/jpeg', q);
      while (maxBytes && Math.floor((data.length - data.indexOf(',') - 1) * 3 / 4) > maxBytes && q > 0.4) { q -= 0.1; data = out.toDataURL('image/jpeg', q); }
      if (!data.startsWith('data:image/jpeg')) throw new Error('That image couldn’t be converted.');
      return data;
    };
    const save = () => {
      try { const data = render(); finish(data); sheet.close(); } catch (e) { err.textContent = e.message || 'That image couldn’t be used.'; }
    };

    const content = h('div.cropper',
      stage,
      h('div.cropper-controls',
        h('span.cropper-zoom-icon', { 'aria-hidden': 'true' }, '−'), zoom, h('span.cropper-zoom-icon', { 'aria-hidden': 'true' }, '+'),
        rotate),
      h('p.field-hint', 'Drag to position. Pinch or use the slider to zoom.'),
      err);
    const footer = [
      h('button.btn.ghost.cropper-cancel', { type: 'button', onclick: () => sheet.close() }, 'Cancel'),
      h('button.btn.primary.cropper-save', { type: 'button', onclick: save }, 'Save'),
    ];
    const sheet = openSheet({ title, content, footer, cls: 'cropper-sheet', onClose: () => finish(null) });
    requestAnimationFrame(() => { draw(); requestAnimationFrame(draw); });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => draw()).observe(stage);
  });
}
