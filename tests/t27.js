// v1.10.0: #9 Completed button on Calendar, #10 notification → profile switch + theme, #12 re-arm after
// moving a task later (app timers), #13 no encouragement text, #15 no zoom / no selecting UI,
// #16 profile photo cropper, #19 importFiles early stop, #20 habit photo icons fill the icon.
// (Push-server side of #12 is in server/test/worker.test.mjs.)
const { chromium } = require('playwright');
const path = require('path');
const URL = 'http://127.0.0.1:8080/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const NOW = new Date(2026, 10, 18, 10, 0); // Wed Nov 18 2026, 10:00 local
const TODAY = '2026-11-18';
const task = (id, title, o = {}) => ({ id, title, notes: '', date: TODAY, time: null, duration: null, priority: 0, category: null, reminder: null, recur: { type: 'none', days: [], interval: 2 }, done: false, doneDates: {}, exceptions: [], order: Number(id.replace(/\D/g, '')) || 1, createdAt: NOW.getTime(), ...o });
const habit = (id, name, o = {}) => ({ id, name, emoji: '💧', color: '#0ea5e9', goal: { type: 'check', target: 1, unit: '' }, schedule: { type: 'daily', days: [] }, timeOfDay: 'anytime', reminder: null, archived: false, order: 1, createdAt: '2026-01-01', ...o });
const base = (o = {}) => ({ version: 4, settings: { onboarded: true, theme: 'light', accent: 'indigo', weekStart: 1, timeFormat: '12' }, categories: [], tasks: [], habits: [], logs: {}, journal: {}, exercises: [], workouts: [], ...o });

async function open(browser, { width = 390, data = base(), second = null, hash = '', notif = false, clock = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 820 }, serviceWorkers: 'block', colorScheme: 'light' });
  await ctx.addInitScript(([d, q, n]) => {
    if (n) { window.__n = []; window.Notification = class { constructor(t, o) { window.__n.push(String(o?.body || t).split(' – ')[0]); } static get permission() { return 'granted'; } static requestPermission() { return Promise.resolve('granted'); } }; }
    if (localStorage.getItem('dailyTracker:profiles')) return;
    const profiles = [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }];
    if (q) { profiles.push({ id: 'q', name: 'Sam', avatar: { type: 'emoji', emoji: '', color: '#10b981' } }); localStorage.setItem('dailyTracker:data:q', q); }
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles }));
    localStorage.setItem('dailyTracker:data:p', d);
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
  }, [JSON.stringify(data), second && JSON.stringify(second), notif]);
  const p = await ctx.newPage();
  if (clock) await p.clock.install({ time: NOW });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(URL + hash); await p.waitForTimeout(500);
  return { ctx, p };
}
const go = (p, hash) => p.evaluate((x) => { location.hash = x; }, hash).then(() => p.waitForTimeout(350));
const stored = (p, id = 'p') => p.evaluate((i) => JSON.parse(localStorage.getItem('dailyTracker:data:' + i)), id);
const idx = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('dailyTracker:profiles')));
/** An image made in the page. kind: 'halves' (left red / right blue, 400×200), 'photo' (opaque), 'disc' (transparent sticker). Returns a Buffer. */
async function makeImage(p, kind = 'halves', type = 'image/png') {
  const b64 = await p.evaluate(async ([kind, type]) => {
    const c = document.createElement('canvas'); c.width = 400; c.height = 200; const x = c.getContext('2d');
    if (kind === 'disc') { x.fillStyle = '#e11'; x.beginPath(); x.arc(200, 100, 90, 0, 7); x.fill(); }
    else { x.fillStyle = '#f00'; x.fillRect(0, 0, 200, 200); x.fillStyle = '#00f'; x.fillRect(200, 0, 200, 200); }
    return (await new Promise((r) => c.toBlob(r, type, 0.95))).arrayBuffer().then((b) => btoa(String.fromCharCode(...new Uint8Array(b))));
  }, [kind, type]);
  return Buffer.from(b64, 'base64');
}
const pixel = (p, data, px, py) => p.evaluate(async ([d, x, y]) => {
  const img = await new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = d; });
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const [r, gg, b, a] = g.getImageData(x, y, 1, 1).data; return { r, g: gg, b, a, w: img.width, h: img.height };
}, [data, px, py]);
const isRed = (c) => c.r > 200 && c.b < 60, isBlue = (c) => c.b > 200 && c.r < 60;

(async () => {
  const browser = await chromium.launch();

  // ===== #13 / #9 / #15 on the main screens =====
  {
    const data = base({ tasks: [task('t1', 'One', { done: true, doneDates: { [TODAY]: 1 } }), task('t2', 'Two', { done: true, doneDates: { [TODAY]: 1 } }), task('t3', 'Three')] });
    const { ctx, p } = await open(browser, { data });
    assert(await p.locator('.progress-card .progress-big').textContent() === '2 of 3 done', 'N1 progress card still shows counts');
    assert(await p.locator('.progress-card .progress-sub').count() === 0 && !/halfway|keep going|nice start|fresh start|plan something|enjoy/i.test(await p.textContent('.progress-card')), 'N1 no encouragement text on Today’s progress card (2 of 3 done)');
    assert(await p.locator('.progress-card .completed-link, a[href="#completed"]').count() === 0, 'N2 no “Completed ›” link on Today');
    await go(p, '#calendar');
    assert(await p.locator('.cal-completed-btn').count() === 0, 'N3 Calendar no longer has a “Completed tasks” button (v1.14: it lives in the avatar menu)');
    await p.click('.avatar-btn'); await p.waitForTimeout(300); await p.click('.menu-item:has-text("Completed tasks")'); await p.waitForTimeout(400);
    assert(await p.evaluate(() => location.hash) === '#completed' && (await p.textContent('.page-title')).includes('Completed'), 'N3 avatar-menu entry opens the Completed view');
    await go(p, '#stats');
    assert(await p.locator('.completed-link').count() === 0 && await p.locator('a[href="#stats"]').count() === 0 && (await p.textContent('.page-title')).includes('Nov'), 'N4 Stats tab is gone (old #stats falls back to Today, no Completed link there)');
    // ---- #15 no zoom / no selecting UI ----
    await go(p, '#today');
    const css = await p.evaluate(() => {
      const cs = (el) => getComputedStyle(el);
      const btn = document.querySelector('button'); const lab = document.querySelector('.progress-big'); const li = document.querySelector('.task');
      const inp = document.createElement('input'); document.body.append(inp); const ta = document.createElement('textarea'); document.body.append(ta);
      const ce = document.createElement('div'); ce.contentEditable = 'true'; ce.textContent = 'x'; document.body.append(ce);
      const sel = (e) => cs(e).userSelect || cs(e).webkitUserSelect;
      const out = { html: cs(document.documentElement).touchAction, btn: sel(btn), lab: sel(lab), li: sel(li), inp: sel(inp), ta: sel(ta), ce: sel(ce), callout: cs(lab).webkitTouchCallout };
      inp.remove(); ta.remove(); ce.remove(); return out;
    });
    assert(css.html === 'manipulation', 'Z1 double-tap zoom off via touch-action: ' + css.html);
    assert(css.btn === 'none' && css.lab === 'none' && css.li === 'none', `Z2 buttons, labels and list rows unselectable (${css.btn}/${css.lab}/${css.li})`);
    assert(css.inp === 'text' && css.ta === 'text' && css.ce === 'text', `Z2 inputs, textareas, contenteditable stay selectable (${css.inp}/${css.ta}/${css.ce})`);
    const g = await p.evaluate(() => {
      const ev = (type, el, init = {}) => { const e = new Event(type, { bubbles: true, cancelable: true }); Object.assign(e, init); el.dispatchEvent(e); return e.defaultPrevented; };
      const touchMove = (el, n) => { const mk = (i) => new Touch({ identifier: i, target: el, clientX: 10 + i, clientY: 10 }); const e = new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: Array.from({ length: n }, (_, i) => mk(i)), targetTouches: [], changedTouches: [] }); el.dispatchEvent(e); return e.defaultPrevented; };
      const touchEnd = (el) => { const e = new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], changedTouches: [] }); el.dispatchEvent(e); return e.defaultPrevented; };
      const blank = document.querySelector('.view-today'); const btn = document.querySelector('.week-strip button');
      const viewer = document.createElement('div'); viewer.className = 'photo-viewer'; const vimg = document.createElement('img'); viewer.append(vimg); document.body.append(viewer);
      const r = {
        gesture: ev('gesturestart', blank), gestureViewer: ev('gesturestart', vimg),
        pinch: touchMove(blank, 2), onefinger: touchMove(blank, 1), pinchViewer: touchMove(vimg, 2),
        wheel: ev('wheel', blank, { ctrlKey: true }), wheelPlain: ev('wheel', blank, { ctrlKey: false }), wheelViewer: ev('wheel', vimg, { ctrlKey: true }),
      };
      touchEnd(blank); r.dbl = touchEnd(blank);                 // two quick taps on blank space
      touchEnd(btn); r.dblBtn = touchEnd(btn);                  // buttons keep both taps
      touchEnd(vimg); r.dblViewer = touchEnd(vimg);
      viewer.remove();
      return r;
    });
    assert(g.gesture && g.pinch && g.wheel, `Z3 pinch gestures blocked (gesturestart ${g.gesture}, two-finger touchmove ${g.pinch}, ctrl+wheel ${g.wheel})`);
    assert(!g.onefinger && !g.wheelPlain, 'Z3 one-finger scroll and normal wheel untouched');
    assert(!g.gestureViewer && !g.pinchViewer && !g.wheelViewer && !g.dblViewer, 'Z4 the photo viewer stays zoomable');
    assert(g.dbl && !g.dblBtn, 'Z5 double-tap on blank space blocked; buttons keep both taps');
    await ctx.close();
  }
  // #13 other states
  for (const [done, label] of [[0, 'none done'], [3, 'all done']]) {
    const tasks = [1, 2, 3].map((i) => task('t' + i, 'T' + i, i <= done ? { done: true, doneDates: { [TODAY]: 1 } } : {}));
    const { ctx, p } = await open(browser, { data: base({ tasks }) });
    assert(await p.locator('.progress-card .progress-sub').count() === 0, `N1 no encouragement text (${label})`);
    await ctx.close();
  }
  { const { ctx, p } = await open(browser); assert(await p.locator('.progress-card .progress-sub').count() === 0, 'N1 no text on an empty day'); await ctx.close(); }

  // ===== #10 notification → switch profile + theme =====
  {
    const sam = base({ settings: { onboarded: true, theme: 'dark', accent: 'rose', weekStart: 1 }, tasks: [task('s1', 'Sam’s dentist')] });
    const me = base({ settings: { onboarded: true, theme: 'light', accent: 'teal', weekStart: 1 }, tasks: [task('m1', 'My task')] });
    const theme = (p) => p.evaluate(() => [document.documentElement.dataset.theme || null, document.documentElement.dataset.accent]);
    // Cold launch from the notification (URL hash)
    {
      const { ctx, p } = await open(browser, { data: me, second: sam, hash: '#open/task/q/s1/2026-11-18' });
      assert((await idx(p)).activeId === 'q', 'C1 cold launch for another profile switches to it');
      assert(JSON.stringify(await theme(p)) === '["dark","rose"]', 'C1 cold launch applies that profile’s theme and accent: ' + JSON.stringify(await theme(p)));
      assert(await p.locator('.sheet-title').first().textContent() === 'Sam’s dentist', 'C1 and opens the task');
      await ctx.close();
    }
    // App already open: message from the service worker, then another one (even the very same link twice)
    {
      const { ctx, p } = await open(browser, { data: me, second: sam });
      assert(JSON.stringify(await theme(p)) === '["light","teal"]', 'C2 starts on Me (light/teal)');
      const msg = (url) => p.evaluate((u) => { navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'OPEN_URL', url: location.origin + '/' + u } })); }, url);
      await msg('#open/task/q/s1/2026-11-18'); await p.waitForTimeout(900);
      assert((await idx(p)).activeId === 'q' && JSON.stringify(await theme(p)) === '["dark","rose"]', 'C2 open app: switches to Sam with Sam’s theme + accent: ' + JSON.stringify(await theme(p)));
      await p.keyboard.press('Escape'); await p.waitForTimeout(400);
      await msg('#open/task/p/m1/2026-11-18'); await p.waitForTimeout(900);
      assert((await idx(p)).activeId === 'p' && JSON.stringify(await theme(p)) === '["light","teal"]', 'C3 and back to Me with Me’s theme + accent: ' + JSON.stringify(await theme(p)));
      await p.keyboard.press('Escape'); await p.waitForTimeout(400);
      await msg('#open/task/q/s1/2026-11-18'); await p.waitForTimeout(900);
      await p.keyboard.press('Escape'); await p.waitForTimeout(400);
      await msg('#open/task/q/s1/2026-11-18'); await p.waitForTimeout(900);
      assert(await p.locator('.sheet-title').first().textContent() === 'Sam’s dentist', 'C4 tapping the same notification again still opens it');
      assert(await p.evaluate(() => document.querySelector('meta[name="theme-color"]').content) !== '', 'C4 theme-color meta present');
      await ctx.close();
    }
  }

  // ===== #12 reminder re-arms after the task is moved later (app timers) =====
  {
    const data = base({ settings: { onboarded: true, theme: 'light', accent: 'indigo', weekStart: 1, notifications: true }, tasks: [task('r1', 'Call dentist', { time: '10:05', reminder: 0 })] });
    const { ctx, p } = await open(browser, { data, notif: true });
    await p.clock.runFor(6 * 60000); await p.waitForTimeout(200);
    assert(JSON.stringify(await p.evaluate(() => window.__n)) === '["Call dentist"]', 'R1 reminder fires at 10:05');
    await p.evaluate(async () => { const S = await import('./js/store.js'); S.update((s) => { s.tasks[0].time = '10:20'; }); });
    await p.clock.runFor(1000); await p.waitForTimeout(100);
    await p.clock.runFor(16 * 60000); await p.waitForTimeout(200);
    assert(JSON.stringify(await p.evaluate(() => window.__n)) === '["Call dentist","Call dentist"]', 'R2 moved to 10:20 → reminds again at the new time: ' + JSON.stringify(await p.evaluate(() => window.__n)));
    await p.clock.runFor(30 * 60000); await p.waitForTimeout(200);
    assert((await p.evaluate(() => window.__n)).length === 2, 'R3 and only once more');
    await ctx.close();
  }

  // ===== #16 profile photo cropper =====
  {
    const { ctx, p } = await open(browser);
    const halves = await makeImage(p, 'halves');
    const openEditor = async () => { await p.click('.avatar-btn'); await p.click('.menu-item:has-text("Edit Me")'); await p.waitForTimeout(300); };
    await openEditor();
    await p.setInputFiles('.sheet input[type=file]', { name: 'h.png', mimeType: 'image/png', buffer: halves });
    await p.waitForSelector('.cropper-sheet .cropper-stage');
    await p.waitForTimeout(300);
    assert(await p.locator('.cropper-mask.round').count() === 1 && await p.locator('input.cropper-zoom').count() === 1 && await p.locator('.cropper-rotate').count() === 1 && await p.locator('.cropper-save').count() === 1 && await p.locator('.cropper-cancel').count() === 1, 'K1 crop sheet: round preview, zoom slider, rotate, Save, Cancel');
    assert(await p.locator('.cropper-sheet input[type=range]').getAttribute('min') === '1', 'K1 slider starts at fit (1×)');
    // Cancel keeps the avatar
    await p.click('.cropper-cancel'); await p.waitForTimeout(400);
    assert(await p.locator('.cropper-sheet').count() === 0 && (await idx(p)).profiles[0].avatar.type === 'emoji', 'K2 Cancel closes the crop sheet and sets nothing');
    // Default position (centred): left red, right blue; output is a 192 px square JPEG
    await p.setInputFiles('.sheet input[type=file]', { name: 'h.png', mimeType: 'image/png', buffer: halves });
    await p.waitForSelector('.cropper-stage'); await p.waitForTimeout(300);
    const box = await p.locator('.cropper-stage').boundingBox();
    assert(Math.abs(box.width - box.height) < 1 && box.width > 200, 'K3 preview is square: ' + box.width);
    await p.click('.cropper-save'); await p.waitForTimeout(500);
    let av = null;
    await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(400);
    av = (await idx(p)).profiles[0].avatar;
    let l = await pixel(p, av.data, 10, 96), r = await pixel(p, av.data, 182, 96);
    assert(av.type === 'photo' && av.data.startsWith('data:image/jpeg;base64,') && l.w === 192 && l.h === 192, `K3 saved a 192×192 square JPEG (${l.w}×${l.h})`);
    assert(isRed(l) && isBlue(r), 'K3 centred crop: left red, right blue');
    // Drag to position: drag the photo left → shows the right (blue) half
    await openEditor();
    await p.setInputFiles('.sheet input[type=file]', { name: 'h.png', mimeType: 'image/png', buffer: halves });
    await p.waitForSelector('.cropper-stage'); await p.waitForTimeout(300);
    const b = await p.locator('.cropper-stage').boundingBox();
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await p.mouse.down(); await p.mouse.move(b.x + b.width / 2 - b.width, b.y + b.height / 2, { steps: 6 }); await p.mouse.up();
    await p.click('.cropper-save'); await p.waitForTimeout(400); await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(400);
    av = (await idx(p)).profiles[0].avatar;
    l = await pixel(p, av.data, 10, 96); r = await pixel(p, av.data, 182, 96);
    assert(isBlue(l) && isBlue(r), 'K4 dragging repositions the crop (all blue after dragging fully left)');
    // Zoom (slider) into the centre seam, then rotate
    await openEditor();
    await p.setInputFiles('.sheet input[type=file]', { name: 'h.png', mimeType: 'image/png', buffer: halves });
    await p.waitForSelector('.cropper-stage'); await p.waitForTimeout(300);
    await p.locator('input.cropper-zoom').evaluate((el) => { el.value = '4'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await p.waitForTimeout(100);
    await p.click('.cropper-save'); await p.waitForTimeout(400); await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(400);
    av = (await idx(p)).profiles[0].avatar;
    l = await pixel(p, av.data, 4, 96); r = await pixel(p, av.data, 188, 96);
    const mid = await pixel(p, av.data, 96, 96);
    assert(isRed(l) && isBlue(r) && (mid.r > 60 || mid.b > 60), 'K5 zoom slider zooms into the centre (seam still centred)');
    await openEditor();
    await p.setInputFiles('.sheet input[type=file]', { name: 'h.png', mimeType: 'image/png', buffer: halves });
    await p.waitForSelector('.cropper-stage'); await p.waitForTimeout(300);
    await p.click('.cropper-rotate'); await p.waitForTimeout(150);
    await p.click('.cropper-save'); await p.waitForTimeout(400); await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(400);
    av = (await idx(p)).profiles[0].avatar;
    const top = await pixel(p, av.data, 96, 10), bot = await pixel(p, av.data, 96, 182);
    assert(isRed(top) && isBlue(bot), 'K6 rotate 90° clockwise: the left half is now on top');
    // Pinch (two pointers) zooms
    await openEditor();
    await p.setInputFiles('.sheet input[type=file]', { name: 'h.png', mimeType: 'image/png', buffer: halves });
    await p.waitForSelector('.cropper-stage'); await p.waitForTimeout(300);
    await p.evaluate(() => {
      const st = document.querySelector('.cropper-stage'); const r = st.getBoundingClientRect(); const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      const ev = (type, id, x) => st.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: id, clientX: x, clientY: cy, pointerType: 'touch', isPrimary: id === 1 }));
      ev('pointerdown', 1, cx - 40); ev('pointerdown', 2, cx + 40); ev('pointermove', 1, cx - 80); ev('pointermove', 2, cx + 80); ev('pointerup', 1, cx - 80); ev('pointerup', 2, cx + 80);
    });
    const zv = Number(await p.locator('input.cropper-zoom').inputValue());
    assert(zv > 1.8 && zv < 2.2, 'K7 pinching out doubles the zoom: ' + zv);
    await p.click('.cropper-cancel'); await p.waitForTimeout(300);
    // Non-image still rejected with a message (no crop sheet)
    await p.setInputFiles('.sheet input[type=file]', { name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') }); await p.waitForTimeout(300);
    assert(await p.locator('.cropper-sheet').count() === 0 && (await p.textContent('.sheet .form-error')).includes('isn’t an image'), 'K8 non-image rejected without the crop sheet');
    await ctx.close();
  }

  // ===== #20 habit photo icons =====
  {
    const { ctx, p } = await open(browser, { data: base({ habits: [habit('h1', 'Read')] }) });
    const photo = await makeImage(p, 'halves', 'image/jpeg');
    const disc = await makeImage(p, 'disc', 'image/png');
    const openForm = async () => { await p.evaluate(async () => { const S = await import('./js/store.js'); (await import('./js/forms.js')).openHabitForm(S.getState().habits[0]); }); await p.waitForTimeout(300); if (await p.locator('.icon-image-panel').isHidden()) await p.click('button:has-text("Use image / Genmoji")'); };
    await openForm();
    // A new photo goes through the cropper, then fills the icon
    await p.setInputFiles('.icon-image-panel input[type=file]', { name: 'p.jpg', mimeType: 'image/jpeg', buffer: photo });
    await p.waitForSelector('.cropper-sheet .cropper-stage'); await p.waitForTimeout(300);
    assert(await p.locator('.cropper-mask.square').count() === 1, 'H1 a new photo icon opens the crop step');
    await p.click('.cropper-save'); await p.waitForTimeout(500);
    assert((await p.textContent('.icon-status')).includes('Image set'), 'H1 saved from the cropper');
    await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(400);
    const ic = (await stored(p)).habits[0].icon;
    const sq = await pixel(p, ic.data, 2, 2);
    assert(ic.data.startsWith('data:image/jpeg') && sq.w === sq.h && sq.a === 255, `H2 stored as an opaque square (${sq.w}×${sq.h}), no transparent bars`);
    const fill = await p.evaluate(() => { const i = document.querySelector('.habit-row[data-id="h1"] .emoji-bubble .habit-img'); const b = i.parentElement.getBoundingClientRect(); const r = i.getBoundingClientRect(); return { cls: i.className, cover: getComputedStyle(i).objectFit, fills: Math.abs(r.width - b.width) < 1 && Math.abs(r.height - b.height) < 1 }; });
    assert(fill.cls.includes('photo') && fill.cover === 'cover' && fill.fills, 'H3 photo icon fills the whole bubble (object-fit: cover): ' + JSON.stringify(fill));
    // Genmoji/sticker with transparency: not cropped, stays fully visible
    await openForm();
    await p.setInputFiles('.icon-image-panel input[type=file]', { name: 's.png', mimeType: 'image/png', buffer: disc });
    await p.waitForTimeout(700);
    assert(await p.locator('.cropper-sheet').count() === 0 && (await p.textContent('.icon-status')).includes('Image set'), 'H4 transparent image skips the crop step');
    await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(400);
    const ic2 = (await stored(p)).habits[0].icon;
    const c2 = await pixel(p, ic2.data, 1, 1), m2 = await pixel(p, ic2.data, 48, 48);
    assert(ic2.data.startsWith('data:image/png') && c2.a === 0 && m2.a === 255, 'H4 sticker stored as a transparent PNG');
    const sticker = await p.evaluate(() => { const i = document.querySelector('.habit-row[data-id="h1"] .emoji-bubble .habit-img'); return { cls: i.className, cover: getComputedStyle(i).objectFit, w: i.getBoundingClientRect().width, bw: i.parentElement.getBoundingClientRect().width }; });
    assert(!sticker.cls.includes('photo') && sticker.cover === 'contain' && sticker.w < sticker.bw, 'H4 sticker stays fully visible (contain, inset): ' + JSON.stringify(sticker));
    // Existing stored photo icon (old format: opaque 96×72 photo centred in transparent bars)
    const old = await p.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = c.height = 96; const x = c.getContext('2d');
      x.fillStyle = '#f00'; x.fillRect(0, 12, 48, 72); x.fillStyle = '#00f'; x.fillRect(48, 12, 48, 72);
      return c.toDataURL('image/png');
    });
    await p.evaluate(async (d) => { const S = await import('./js/store.js'); (await import('./js/actions.js')).saveHabit({ ...S.getState().habits[0], icon: { type: 'image', data: d } }); }, old);
    await p.waitForTimeout(600);
    const shown = await p.evaluate(async () => {
      const i = document.querySelector('.habit-row[data-id="h1"] .emoji-bubble .habit-img');
      const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight; const g = c.getContext('2d'); g.drawImage(i, 0, 0);
      const px = (x, y) => g.getImageData(x, y, 1, 1).data[3];
      return { cls: i.className, w: i.naturalWidth, h: i.naturalHeight, tl: px(0, 0), br: px(c.width - 1, c.height - 1), bl: px(0, c.height - 1) };
    });
    assert(shown.cls.includes('photo') && shown.tl === 255 && shown.br === 255 && shown.bl === 255, 'H5 old photo icon: bars trimmed and the square filled: ' + JSON.stringify(shown));
    assert((await stored(p)).habits[0].icon.data === old, 'H5 the stored original is untouched');
    // …and survives a reload (render-time, nothing stored changed)
    await p.reload(); await p.waitForTimeout(700);
    assert(await p.locator('.habit-row[data-id="h1"] .habit-img.photo').count() === 1 || await p.evaluate(() => !!document.querySelector('.habit-img.photo')), 'H5 still filled after a reload');
    await ctx.close();
  }

  // ===== #19 importFiles stops early but still reports renames =====
  {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const { ctx, p } = await open(browser);
    const r = await p.evaluate(async (png) => {
      const A = await import('./js/attachments.js');
      // Another profile ('q') owns file "dup".
      await A.putFile({ id: 'dup', profileId: 'q', taskId: null, blob: await (await fetch(png)).blob(), thumbBlob: null, type: 'image/png', w: 1, h: 1, size: 70, createdAt: 1 });
      // Storage "fills up" for the second photo.
      const orig = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (v, k) { if (v && v.id === 'second') throw new DOMException('full', 'QuotaExceededError'); return orig.call(this, v, k); };
      let out;
      try { out = await A.importFiles([{ id: 'dup', profileId: 'p', data: png }, { id: 'second', profileId: 'p', data: png }], () => 'p'); }
      finally { IDBObjectStore.prototype.put = orig; }
      return { renamed: [...out.renamed], stored: [...out.stored], error: out.error && out.error.message, dupOwner: (await A.getFile('dup')).profileId, newOwner: out.renamed.size ? (await A.getFile([...out.renamed.values()][0].id))?.profileId : null };
    }, png);
    assert(r.renamed.length === 1 && r.renamed[0][0] === 'dup' && r.stored.length === 1 && !!r.error, 'I1 importFiles returns the rename list and the error when it stops early: ' + JSON.stringify(r));
    assert(r.dupOwner === 'q' && r.newOwner === 'p', 'I1 the other profile’s photo is untouched; the copy belongs to this profile');
    // End to end: a multi-profile backup whose photo clashes, then storage fills: the task must not keep the old id.
    const backup = { app: 'daily-tracker', version: 4, kind: 'multi', activeId: 'p', profiles: [
      { id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' }, data: base({ tasks: [task('a1', 'With photos', { attachments: [{ id: 'dup2', w: 1, h: 1, type: 'image/png' }, { id: 'second', w: 1, h: 1, type: 'image/png' }] })] }) },
      { id: 'q', name: 'Sam', avatar: { type: 'emoji', emoji: '', color: '#10b981' }, data: base() }],
      attachments: [{ id: 'dup2', profileId: 'p', data: png }, { id: 'second', profileId: 'p', data: png }] };
    await p.evaluate(async (png) => {
      const A = await import('./js/attachments.js');
      await A.putFile({ id: 'dup2', profileId: 'q', taskId: null, blob: await (await fetch(png)).blob(), thumbBlob: null, type: 'image/png', w: 1, h: 1, size: 70, createdAt: 1 });
      window.__orig = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (v, k) { if (v && v.id === 'second') throw new DOMException('full', 'QuotaExceededError'); return window.__orig.call(this, v, k); };
    }, png);
    require('fs').writeFileSync(path.join(require('os').tmpdir(), 't27-backup.json'), JSON.stringify(backup));
    await go(p, '#settings');
    await p.setInputFiles('input[type=file][accept^="application/json"]', path.join(require('os').tmpdir(), 't27-backup.json')); await p.waitForTimeout(400);
    if (await p.locator('.sheet.dialog .btn.danger').count()) { await p.click('.sheet.dialog .btn.danger'); await p.waitForTimeout(1500); }
    const refs = (await stored(p, 'p')).tasks[0]?.attachments?.map((a) => a.id);
    const toast = await p.textContent('#toasts').catch(() => '');
    assert(refs && refs[0] !== 'dup2' && refs[0].startsWith('f'), 'I2 import: the renamed photo’s task reference is rewritten even though a later photo failed: ' + JSON.stringify(refs));
    assert(/couldn’t be restored/.test(toast), 'I2 and the error is still reported: ' + toast.trim());
    await p.evaluate(() => { IDBObjectStore.prototype.put = window.__orig; });
    await ctx.close();
  }

  console.log(errs.join('\n') || 'no console errors');
  await browser.close();
})();
