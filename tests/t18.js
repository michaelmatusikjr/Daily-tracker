// v1.6.2: image habit icons (Genmoji / pasted / chosen images).
const { chromium } = require('playwright');
const path = require('path');
const URL = 'http://127.0.0.1:8080/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const habit = (id, name, o = {}) => ({ id, name, emoji: '💧', color: '#0ea5e9', goal: { type: 'check', target: 1, unit: '' }, schedule: { type: 'daily', days: [] }, timeOfDay: 'anytime', reminder: null, archived: false, order: 1, createdAt: '2026-01-01', ...o });
const seed = () => ({ version: 4, settings: { onboarded: true, theme: 'light', weekStart: 1, notifications: true, workoutHabit: { habitId: null, filter: 'any' } }, tasks: [], habits: [habit('h1', 'Water'), habit('h2', 'Stretch', { emoji: '🧘', reminder: '23:59' })], logs: { h2: { [today]: 1 } }, journal: {}, exercises: [], workouts: [] });

async function open(browser, { width = 390, dark = false, data = seed() } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 820 }, serviceWorkers: 'block', colorScheme: dark ? 'dark' : 'light' });
  data.settings.theme = dark ? 'dark' : 'light';
  await ctx.addInitScript(([d]) => {
    if (localStorage.getItem('dailyTracker:profiles')) return;
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles: [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }] }));
    localStorage.setItem('dailyTracker:data:p', d);
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
  }, [JSON.stringify(data)]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(URL); await p.waitForTimeout(400);
  return { ctx, p };
}
const go = (p, hash) => p.evaluate((x) => { location.hash = x; }, hash).then(() => p.waitForTimeout(300));
const stored = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('dailyTracker:data:p')));
/** A transparent PNG with an off-centre red disc (to check trimming + transparency). */
const makePng = (p, { w = 300, h = 200, noise = false, type = 'image/png' } = {}) => p.evaluate(async ([w, h, noise, type]) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  if (noise) { const id = x.createImageData(w, h); for (let i = 0; i < id.data.length; i++) id.data[i] = (Math.random() * 256) | 0; for (let i = 3; i < id.data.length; i += 4) id.data[i] = 255; x.putImageData(id, 0, 0); }
  else { x.fillStyle = '#e11'; x.beginPath(); x.arc(200, 120, 40, 0, Math.PI * 2); x.fill(); }
  return c.toDataURL(type, 0.95);
}, [w, h, noise, type]);
/** Inspect an icon data URL: size, transparency at a corner, opacity at the centre and edge midpoints. */
const inspect = (p, data) => p.evaluate(async (src) => {
  const img = new Image(); img.src = src; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  const a = (px, py) => x.getImageData(px, py, 1, 1).data[3];
  const s = img.width;
  return { w: img.width, h: img.height, corner: a(0, 0), center: a(s / 2, s / 2), left: a(1, s / 2), top: a(s / 2, 1), bytes: Math.floor((src.length - src.indexOf(',') - 1) * 3 / 4), png: src.startsWith('data:image/png') };
}, data);
const openForm = async (p, id) => {
  await p.evaluate(async (hid) => { const S = await import('./js/store.js'); const F = await import('./js/forms.js'); F.openHabitForm(S.getState().habits.find((x) => x.id === hid)); }, id);
  await p.waitForTimeout(300);
};

(async () => {
  const browser = await chromium.launch();
  const { ctx, p } = await open(browser);
  const disc = await makePng(p);

  // ===== 1. Genmoji-style <img> inserted into the box =====
  await openForm(p, 'h2');
  assert(await p.locator('.icon-image-panel').isHidden(), 'F0 image panel starts collapsed');
  await p.click('button:has-text("Use image / Genmoji")');
  assert(await p.locator('.genmoji-box').isVisible() && (await p.getAttribute('.genmoji-box', 'aria-label')).startsWith('Tap here, then pick a Genmoji'), 'F1 paste/Genmoji target visible and labelled');
  await p.evaluate((src) => { const b = document.querySelector('.genmoji-box'); b.innerHTML = `<img src="${src}" alt="genmoji">`; b.dispatchEvent(new InputEvent('input', { bubbles: true })); }, disc);
  await p.waitForTimeout(500);
  assert(await p.locator('.emoji-preview img.habit-img').count() === 1 && (await p.textContent('.icon-status')).includes('Genmoji set') && (await p.innerHTML('.genmoji-box')) === '', 'F2 inserted <img> → icon set, box cleared');
  await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(300);
  let ic = (await stored(p)).habits.find((x) => x.id === 'h2').icon;
  let info = await inspect(p, ic.data);
  assert(ic.type === 'image' && info.png && info.w === 96 && info.h === 96, 'F3 stored as a 96×96 PNG data URL');
  assert(info.corner === 0 && info.center === 255, 'F3 transparency kept (corner clear, centre opaque)');
  assert(info.left > 200 && info.top > 200, 'F3 trimmed to the visible pixels (disc touches the edges)');
  assert((await stored(p)).habits.find((x) => x.id === 'h2').emoji === '🧘', 'F3 emoji kept as the text fallback');

  // ===== 2. Paste an image file =====
  await openForm(p, 'h1');
  await p.click('button:has-text("Use image / Genmoji")');
  await p.evaluate(async (src) => {
    const blob = await (await fetch(src)).blob();
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'x.png', { type: 'image/png' }));
    document.querySelector('.genmoji-box').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, disc);
  await p.waitForTimeout(500);
  assert((await p.textContent('.icon-status')).includes('Pasted image set'), 'P1 pasted image file → icon');
  // Typing a normal emoji in the box picks that emoji instead
  await p.evaluate(() => { const b = document.querySelector('.genmoji-box'); b.textContent = '🦊'; b.dispatchEvent(new InputEvent('input', { bubbles: true })); });
  await p.waitForTimeout(200);
  assert((await p.textContent('.emoji-preview')).trim() === '🦊' && await p.locator('.emoji-preview img').count() === 0, 'P2 a normal emoji typed in the box is used as an emoji icon');
  await p.evaluate(() => { const b = document.querySelector('.genmoji-box'); b.textContent = 'hello'; b.dispatchEvent(new InputEvent('input', { bubbles: true })); });
  await p.waitForTimeout(200);
  assert((await p.textContent('.icon-status')).includes('Only an emoji, Genmoji or image') && (await p.innerHTML('.genmoji-box')) === '', 'P3 plain text is ignored with a hint');

  // ===== 3. File picker (+ size cap, non-image) =====
  const big = await makePng(p, { w: 1600, h: 1200, noise: true, type: 'image/jpeg' });
  await p.setInputFiles('.icon-image-panel input[type=file]', { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(big.split(',')[1], 'base64') });
  await p.waitForSelector('.cropper-sheet .cropper-save'); await p.click('.cropper-sheet .cropper-save'); // photos get the crop step (t27)
  await p.waitForTimeout(800);
  assert((await p.textContent('.icon-status')).includes('Image set'), 'C1 “Choose image…” file picker → icon');
  await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(300);
  ic = (await stored(p)).habits.find((x) => x.id === 'h1').icon;
  info = await inspect(p, ic.data);
  assert(ic.data.startsWith('data:image/jpeg') && info.bytes <= 40 * 1024 && info.w === 160, `C2 noisy photo cropped to a 160px square JPEG, ${info.bytes} bytes (≤ 40 KB)`);
  await openForm(p, 'h1');
  await p.setInputFiles('.icon-image-panel input[type=file]', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await p.waitForTimeout(300);
  assert((await p.textContent('.icon-status')).includes('isn’t an image'), 'C3 non-image rejected gracefully');
  await p.setInputFiles('.icon-image-panel input[type=file]', { name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not really a png') });
  await p.waitForTimeout(400);
  assert((await p.textContent('.icon-status')).includes('couldn’t be read'), 'C4 corrupt image rejected gracefully');
  // Remove image → back to the emoji
  await p.click('.icon-image-row button:has-text("Remove image")');
  await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(300);
  assert(!(await stored(p)).habits.find((x) => x.id === 'h1').icon && (await stored(p)).habits.find((x) => x.id === 'h1').emoji === '🦊', 'C5 removing the image goes back to the emoji (🦊 picked earlier)');

  // ===== 4. Rendering everywhere =====
  await go(p, '#today');
  assert(await p.locator('.habit-row[data-id="h2"] .emoji-bubble img.habit-img[alt=""]').count() === 1, 'R1 Today row shows the image (alt="")');
  assert((await p.textContent('.habit-row[data-id="h1"] .emoji-bubble')).trim() === '🦊', 'R2 emoji habit renders as text');
  assert((await p.getAttribute('.habit-row[data-id="h2"] .habit-row-main', 'aria-label')) === 'Stretch details', 'R3 accessible label is the habit name');
  await p.click('.habit-row[data-id="h2"] .habit-row-main', { button: 'right' }); await p.waitForTimeout(300);
  assert(await p.locator('.sheet.action-menu .sheet-title img.habit-img').count() === 1 && (await p.getAttribute('.menu-list', 'aria-label')) === 'Stretch', 'R4 long-press menu title shows the image; menu label is text');
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await go(p, '#habits');
  assert(await p.locator('.habit-card:has-text("Stretch") .emoji-bubble img').count() === 1, 'R5 Habits card');
  await go(p, '#habit/h2');
  assert(await p.locator('.title-emoji img.habit-img').count() === 1, 'R6 habit detail heading');
  await go(p, '#stats');
  assert(await p.locator('.rate-row:has-text("Stretch") img.habit-img').count() === 1 && await p.locator('.stat-sub img.habit-img').count() === 1, 'R7 Stats list and longest-streak tile');
  await go(p, '#settings');
  const opts = await p.$$eval('select[aria-label="Habit to check off when you log a workout"] option', (o) => o.map((x) => x.textContent));
  assert(opts.includes('Stretch') && opts.includes('🦊 Water'), 'R8 workout-link select: text only (image icons left out)');
  const titles = await p.evaluate(async () => {
    const N = await import('./js/notify.js'); const P = await import('./js/push.js');
    const occ = N.reminderOccurrences(Date.now() - 86400000, Date.now() + 3 * 86400000).filter((o) => o.key.includes(':h:h2:')).map((o) => o.title);
    const rules = P.buildRules({ hideText: false }).rules.filter((r) => r.id.includes(':h:h2')).map((r) => JSON.stringify(r));
    return { occ, rules };
  });
  assert(titles.occ.length && titles.occ.every((t) => t === 'Stretch') && titles.rules.every((r) => r.includes('"title":"Stretch"') && !r.includes('data:image')), 'R9 notifications/push: text title only, no image in payloads');

  // ===== 5. Export / import =====
  const exp = await p.evaluate(async () => JSON.stringify((await import('./js/store.js')).exportPayload()));
  assert(exp.includes('"icon":{"type":"image","data":"data:image/png;base64,'), 'X1 export includes image icons');
  const imp = await p.evaluate(async (good) => {
    const S = await import('./js/store.js');
    const big = 'data:image/png;base64,' + 'A'.repeat(Math.ceil(61 * 1024 * 4 / 3));
    const mk = (id, icon) => ({ id, name: id, emoji: '🎯', icon });
    const r = S.validateImport({ version: 4, tasks: [], habits: [
      mk('ok', { type: 'image', data: good }), mk('jpeg', { type: 'image', data: 'data:image/jpeg;base64,/9j/4AAQ' }),
      mk('toobig', { type: 'image', data: big }), mk('svg', { type: 'image', data: 'data:image/svg+xml;base64,PHN2Zz4=' }),
      mk('gif', { type: 'image', data: 'data:image/gif;base64,R0lGOD' }), mk('junk', { type: 'image', data: 'javascript:alert(1)' }),
      { id: 'noemoji', name: 'n', icon: { type: 'image', data: 'nope' } },
    ] });
    return r.data.habits.map((x) => [x.id, x.icon ? x.icon.data.slice(0, 15) : null, x.emoji]);
  }, disc);
  assert(JSON.stringify(imp) === JSON.stringify([['ok', 'data:image/png;', '🎯'], ['jpeg', 'data:image/jpeg', '🎯'], ['toobig', null, '🎯'], ['svg', null, '🎯'], ['gif', null, '🎯'], ['junk', null, '🎯'], ['noemoji', null, '✅']]), 'X2 import: PNG/JPEG ≤ 60 KB kept; too big / SVG / GIF / junk → default emoji: ' + JSON.stringify(imp));
  await ctx.close();

  // ===== 6. Layout 320 light/dark =====
  for (const dark of [false, true]) {
    const data = seed();
    data.habits[1].icon = { type: 'image', data: disc.length < 80000 ? disc : disc };
    const { ctx: c2, p: q } = await open(browser, { width: 320, dark, data });
    const iconData = await q.evaluate(async (src) => (await import('./js/habitIcon.js')).processIcon(src), disc);
    await q.evaluate(async (d) => { const A = await import('./js/actions.js'); const S = await import('./js/store.js'); const hb = S.getState().habits.find((x) => x.id === 'h2'); A.saveHabit({ ...hb, icon: { type: 'image', data: d } }); }, iconData);
    await q.waitForTimeout(300);
    assert(await q.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `L 320 ${dark ? 'dark' : 'light'}: Today fits`);
    await q.screenshot({ path: path.join(__dirname, `l18-today-${dark ? 'dark' : 'light'}.png`) });
    assert((await q.textContent('.habit-row[data-id="h1"] .emoji-bubble')).trim() === '💧' && (await stored(q)).habits.find((x) => x.id === 'h1').icon === undefined, `L old emoji habit unchanged (${dark ? 'dark' : 'light'})`);
    await openForm(q, 'h2');
    if (await q.locator('.icon-image-panel').isHidden()) await q.click('button:has-text("Use image / Genmoji")');
    await q.locator('.icon-image-panel').scrollIntoViewIfNeeded();
    const fits = await q.evaluate(() => { const s = document.querySelector('.sheet'); return s.scrollWidth <= s.clientWidth + 1; });
    assert(fits, `L 320 ${dark ? 'dark' : 'light'}: form fits`);
    await q.screenshot({ path: path.join(__dirname, `l18-form-${dark ? 'dark' : 'light'}.png`) });
    await c2.close();
  }

  console.log(errs.join('\n') || 'no console errors');
  await browser.close();
})();
