// v1.9.0: #6 task photos, #7 Completed history, #8 focus after delete (reminder-note states are in t24).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const URL = 'http://127.0.0.1:8080/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const NOW = new Date(2026, 10, 18, 10, 0); // Wed Nov 18 2026
const TODAY = '2026-11-18';
const task = (id, title, o = {}) => ({ id, title, notes: '', date: TODAY, time: null, duration: null, priority: 0, category: null, reminder: null, recur: { type: 'none', days: [], interval: 2 }, done: false, doneDates: {}, exceptions: [], order: Number(id.replace(/\D/g, '')) || 1, createdAt: 1, ...o });
const base = (o = {}) => ({ version: 4, settings: { onboarded: true, theme: 'light', weekStart: 1 }, categories: [{ id: 'c1', name: 'Work', color: '#3b82f6' }, { id: 'c2', name: 'Home', color: '#10b981' }], tasks: [], habits: [], logs: {}, journal: {}, exercises: [], workouts: [], ...o });

async function open(browser, { width = 390, dark = false, data = base(), second = null, clock = true, ctxIn = null } = {}) {
  const ctx = ctxIn || await browser.newContext({ viewport: { width, height: 820 }, serviceWorkers: 'block', colorScheme: dark ? 'dark' : 'light', acceptDownloads: true });
  data.settings.theme = dark ? 'dark' : 'light';
  if (!ctxIn) await ctx.addInitScript(([d, q]) => {
    if (localStorage.getItem('dailyTracker:profiles')) return;
    const profiles = [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }];
    if (q) { profiles.push({ id: 'q', name: 'Sam', avatar: { type: 'emoji', emoji: '', color: '#10b981' } }); localStorage.setItem('dailyTracker:data:q', q); }
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles }));
    localStorage.setItem('dailyTracker:data:p', d);
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
  }, [JSON.stringify(data), second && JSON.stringify(second)]);
  const p = await ctx.newPage();
  if (clock) await p.clock.install({ time: NOW });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(URL); await p.waitForTimeout(400);
  return { ctx, p };
}
const go = (p, hash) => p.evaluate((x) => { location.hash = x; }, hash).then(() => p.waitForTimeout(350));
const stored = (p, id = 'p') => p.evaluate((i) => JSON.parse(localStorage.getItem('dailyTracker:data:' + i)), id);
const idb = (p) => p.evaluate(async () => { const A = await import('./js/attachments.js'); return (await A.allFiles()).map((f) => ({ id: f.id, profileId: f.profileId, taskId: f.taskId, type: f.type, w: f.w, h: f.h, size: f.blob.size, thumb: f.thumbBlob?.size || 0, createdAt: f.createdAt })); });
/** Make an image in the page; returns a Buffer. */
async function makeImage(p, { w = 3000, h = 2000, type = 'image/jpeg', transparent = false } = {}) {
  const b64 = await p.evaluate(async ([w, h, type, transparent]) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
    if (!transparent) { const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#f43'); g.addColorStop(1, '#39f'); x.fillStyle = g; x.fillRect(0, 0, w, h); }
    x.fillStyle = '#123'; x.beginPath(); x.arc(w / 2, h / 2, Math.min(w, h) / 3, 0, 7); x.fill();
    const blob = await new Promise((r) => c.toBlob(r, type, 0.95));
    const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, [w, h, type, transparent]);
  return Buffer.from(b64, 'base64');
}
const editForm = async (p, title) => { await p.click(`.task:has-text("${title}") .task-main`); await p.waitForTimeout(400); await p.click('.tv-actions .tv-edit'); await p.waitForTimeout(400); };
const formSave = async (p) => { await p.click('.sheet-root:last-child .sheet-foot .btn.primary'); await p.waitForTimeout(500); };
const esc = async (p) => { await p.keyboard.press('Escape'); await p.waitForTimeout(400); };

(async () => {
  const browser = await chromium.launch();

  // ===================== #6 Photos =====================
  {
    const { ctx, p } = await open(browser, { data: base({ tasks: [task('t1', 'Fix the sink'), task('t2', 'Next task'), task('t3', 'Third task')] }), second: base({ tasks: [task('s1', 'Sam task')] }) });
    const jpg = await makeImage(p);
    const png = await makeImage(p, { w: 300, h: 200, type: 'image/png', transparent: true });
    await editForm(p, 'Fix the sink');
    await p.setInputFiles('.sheet-root:last-child .photo-field input[type=file]', [{ name: 'big.jpg', mimeType: 'image/jpeg', buffer: jpg }, { name: 'clear.png', mimeType: 'image/png', buffer: png }]);
    await p.waitForTimeout(2500);
    assert(await p.locator('.sheet-root:last-child .photo-grid .photo-item').count() === 2 && (await p.textContent('.sheet-root:last-child .photo-status')).includes('2 photos added'), 'P1 Add photo: two images processed with progress/status');
    await p.setInputFiles('.sheet-root:last-child .photo-field input[type=file]', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
    await p.waitForTimeout(300);
    assert((await p.textContent('.sheet-root:last-child .photo-status')).includes('isn’t an image'), 'P2 non-image rejected gracefully');
    // Paste an image onto the form
    await p.evaluate(async (b64) => {
      const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const dt = new DataTransfer(); dt.items.add(new File([u], 'pasted.png', { type: 'image/png' }));
      document.querySelector('.sheet-root:last-child form').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, png.toString('base64'));
    await p.waitForTimeout(1200);
    assert(await p.locator('.sheet-root:last-child .photo-grid .photo-item').count() === 3, 'P3 paste an image onto the form');
    await formSave(p);
    let st = await stored(p);
    let att = st.tasks.find((x) => x.id === 't1').attachments;
    let files = await idb(p);
    const big = files.find((f) => f.id === att[0].id), clear = files.find((f) => f.id === att[1].id);
    assert(att.length === 3 && att.every((a) => Object.keys(a).sort().join() === 'h,id,type,w'), 'P4 task stores only {id, w, h, type}');
    assert(big.type === 'image/jpeg' && Math.max(big.w, big.h) === 1600 && big.thumb > 0 && big.thumb < big.size && big.taskId === 't1' && big.profileId === 'p', `P5 JPEG resized to 1600 px long edge (${big.w}×${big.h}, ${big.size} B) with a thumbnail, linked to task/profile`);
    assert(clear.type === 'image/png', 'P6 small transparent PNG stays PNG');
    assert(!(localStorage = await p.evaluate(() => JSON.stringify(localStorage))).includes('base64'), 'P7 no image data in localStorage');
    // View: thumbnails + viewer (Save returned us to the View sheet)
    await p.waitForTimeout(300);
    assert(await p.locator('.tv-photos .photo-item img[src^="blob:"]').count() === 3, 'V1 View task shows the thumbnails');
    await p.click('.tv-photos .photo-open >> nth=0'); await p.waitForTimeout(500);
    assert(await p.locator('.photo-viewer[role=dialog]').count() === 1 && (await p.textContent('.pv-count')) === '1 / 3' && (await p.getAttribute('.pv-img', 'alt')) === 'Fix the sink – photo 1 of 3', 'V2 full-screen viewer, labelled, alt from title + index');
    await p.keyboard.press('ArrowRight'); await p.waitForTimeout(300);
    assert((await p.textContent('.pv-count')) === '2 / 3', 'V3 arrow keys move');
    await p.click('.pv-prev'); await p.waitForTimeout(300);
    assert((await p.textContent('.pv-count')) === '1 / 3', 'V3 buttons move');
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    assert(await p.locator('.photo-viewer').count() === 0 && await p.locator('.task-view-sheet').count() === 1 && await p.evaluate(() => document.activeElement?.classList.contains('photo-open')), 'V4 Esc closes the viewer only; focus back on the thumbnail');
    // Remove × then Cancel keeps; remove then Save deletes
    await p.click('.tv-actions .tv-edit'); await p.waitForTimeout(400);
    await p.click('.sheet-root:last-child .photo-remove >> nth=2'); await p.waitForTimeout(200);
    await esc(p);
    assert((await stored(p)).tasks.find((x) => x.id === 't1').attachments.length === 3 && (await idb(p)).length === 3, 'R1 remove then Cancel: photo kept');
    await p.click('.tv-actions .tv-edit'); await p.waitForTimeout(400);
    await p.click('.sheet-root:last-child .photo-remove >> nth=2'); await p.waitForTimeout(200);
    await formSave(p);
    assert((await stored(p)).tasks.find((x) => x.id === 't1').attachments.length === 2 && (await idb(p)).length === 2, 'R2 remove then Save: photo and file gone');
    // Max 6
    await p.click('.tv-actions .tv-edit'); await p.waitForTimeout(400);
    const small = await makeImage(p, { w: 200, h: 150 });
    await p.setInputFiles('.sheet-root:last-child .photo-field input[type=file]', Array.from({ length: 6 }, (_, i) => ({ name: `s${i}.jpg`, mimeType: 'image/jpeg', buffer: small })));
    await p.waitForTimeout(2500);
    assert(await p.locator('.sheet-root:last-child .photo-item').count() === 6 && (await p.textContent('.sheet-root:last-child .photo-status')).includes('up to 6') && await p.locator('.sheet-root:last-child .photo-field button:has-text("Add photo")').isDisabled(), 'M1 max 6 per task');
    await esc(p); // cancel: the 4 just added are discarded
    await p.waitForTimeout(300);
    assert((await idb(p)).length === 2, 'M2 Cancel discards photos added in that session');
    await esc(p);
    // 📎 on the row
    assert((await p.textContent('.task:has-text("Fix the sink") .clip')).includes('2'), 'L1 row shows 📎 2');
    // Duplicate copies files
    await p.click('.task:has-text("Fix the sink") .task-main', { button: 'right' }); await p.waitForTimeout(300);
    await p.click('.sheet.action-menu .menu-item:has-text("Duplicate")'); await p.waitForTimeout(800);
    st = await stored(p);
    const copies = st.tasks.filter((x) => x.title === 'Fix the sink');
    files = await idb(p);
    assert(copies.length === 2 && copies.every((c) => c.attachments?.length === 2) && copies[0].attachments[0].id !== copies[1].attachments[0].id && files.length === 4, 'D1 Duplicate copies the photos under new ids');
    const copy = copies.find((c) => c.id !== 't1');
    // Delete + Undo keeps; delete and wait → files gone
    await p.evaluate(async (id) => { const A = await import('./js/actions.js'); await A.deleteTask(id, '2026-11-18'); }, copy.id);
    await p.click('#toasts .toast-action'); await p.waitForTimeout(9000);
    assert((await stored(p)).tasks.some((x) => x.id === copy.id) && (await idb(p)).length === 4, 'D2 Delete + Undo: task and photos back, files kept');
    await p.evaluate(async (id) => { const A = await import('./js/actions.js'); await A.deleteTask(id, '2026-11-18'); }, copy.id);
    await p.waitForTimeout(500);
    assert((await idb(p)).length === 4, 'D3 files kept during the Undo window');
    await p.waitForTimeout(8500);
    assert((await idb(p)).length === 2, 'D4 files deleted after the Undo window');
    // No photo data in push rules
    const rules = await p.evaluate(async () => JSON.stringify((await import('./js/push.js')).buildRules({ hideText: false })));
    assert(!/attachments|image\/|blob/.test(rules), 'N1 no attachment data in push rules');
    // #8 focus after deleting from View task
    await p.click('.task:has-text("Next task") .task-main'); await p.waitForTimeout(400);
    await p.click('.tv-actions button:has-text("More")'); await p.waitForTimeout(300);
    await p.click('.sheet.action-menu .menu-item:has-text("Delete")'); await p.waitForTimeout(700);
    const foc = await p.evaluate(() => document.activeElement?.closest('.task')?.textContent || document.activeElement?.tagName);
    assert(foc.includes('Third task'), '#8 F1 after deleting from View task, focus moves to the next row: ' + foc);
    await p.click('#toasts .toast-action'); await p.waitForTimeout(300);
    // Usage in Settings (per profile) + isolation
    await go(p, '#settings');
    assert((await p.textContent('.photo-usage')).includes('Photos (Me): 2'), 'S1 Settings › Data shows this profile’s photo usage');
    await p.evaluate(async () => { const S = await import('./js/store.js'); S.switchProfile('q'); }); await p.waitForTimeout(300); await go(p, '#settings');
    assert((await p.textContent('.photo-usage')).includes('Photos (Sam): none'), 'S2 isolation: Sam has none');
    await go(p, '#today');
    await p.evaluate(async () => { const S = await import('./js/store.js'); S.switchProfile('p'); }); await p.waitForTimeout(300);
    // Quota error → plain message
    await editForm(p, 'Third task');
    await p.evaluate(() => { const orig = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function () { throw new DOMException('full', 'QuotaExceededError'); }; window.__restorePut = () => { IDBObjectStore.prototype.put = orig; }; });
    await p.setInputFiles('.sheet-root:last-child .photo-field input[type=file]', { name: 'q.jpg', mimeType: 'image/jpeg', buffer: small });
    await p.waitForTimeout(1200);
    assert((await p.textContent('.sheet-root:last-child .photo-status')).includes('Not enough space on this device'), 'Q1 quota error → plain message');
    await p.evaluate(() => window.__restorePut());
    await esc(p); await esc(p);
    // Export with photos → import into a fresh device
    await go(p, '#settings');
    assert((await p.textContent('.set-check')).includes('Include photos') && /adds about \d/.test(await p.textContent('.set-check')), 'E1 “Include photos” with approximate size');
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('button:has-text("Export JSON")')]);
    const file = path.join(__dirname, 'b19-photos.json'); await dl.saveAs(file);
    const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(Array.isArray(backup.attachments) && backup.attachments.length === 2 && backup.attachments[0].data.startsWith('data:image/'), 'E2 backup includes the photos');
    await p.uncheck('.set-check input');
    const [dl2] = await Promise.all([p.waitForEvent('download'), p.click('button:has-text("Export JSON")')]);
    const file2 = path.join(__dirname, 'b19-nophotos.json'); await dl2.saveAs(file2);
    assert(!JSON.parse(fs.readFileSync(file2, 'utf8')).attachments, 'E3 unchecked → no photos in the backup');
    // GC: an old orphan goes, a recent orphan stays
    await p.evaluate(async () => { const A = await import('./js/attachments.js'); const b = new Blob(['x'], { type: 'image/jpeg' }); await A.putFile({ id: 'orphanOld', profileId: 'p', blob: b, type: 'image/jpeg', createdAt: Date.now() - 3 * 86400000 }); await A.putFile({ id: 'orphanNew', profileId: 'p', blob: b, type: 'image/jpeg', createdAt: Date.now() }); });
    await p.reload(); await p.waitForTimeout(4000);
    files = await idb(p);
    assert(!files.some((f) => f.id === 'orphanOld') && files.some((f) => f.id === 'orphanNew') && files.length === 3, 'G1 start-up clean-up removes old orphans only');
    // Reset profile deletes its photos
    await go(p, '#settings');
    await p.click('button:has-text("Reset Me")'); await p.waitForTimeout(300);
    await p.click('.sheet.dialog .btn.danger'); await p.waitForTimeout(300);
    await p.click('.sheet.dialog .btn.danger'); await p.waitForTimeout(800);
    assert((await idb(p)).filter((f) => f.profileId === 'p').length === 0, 'Z1 Reset this profile deletes its photos');
    await ctx.close();

    // Import into a fresh device: photos restored and viewable, also offline
    const { ctx: c2, p: q } = await open(browser, { data: base() });
    await go(q, '#settings');
    await q.setInputFiles('input[type=file][accept^="application/json"]', file); await q.waitForTimeout(400);
    await q.click('.sheet.dialog .btn.danger'); await q.waitForTimeout(1500);
    const f2 = await idb(q);
    assert(f2.length === 2 && f2.every((f) => f.profileId === 'p' && f.size > 0), 'I1 import restores the photos into IndexedDB');
    await go(q, '#today');
    await c2.setOffline(true);
    await q.click('.task:has-text("Fix the sink") .task-main'); await q.waitForTimeout(500);
    assert(await q.locator('.tv-photos img[src^="blob:"]').count() === 2, 'I2 photos show after import, offline too');
    await c2.setOffline(false);
    // Validation: bad MIME / oversized / heic skipped; an old backup without photos still imports
    const bad = await q.evaluate(async () => {
      const A = await import('./js/attachments.js');
      const s = await A.importFiles([{ id: 'x1', data: 'data:image/heic;base64,AAAA' }, { id: 'x2', data: 'data:text/html;base64,PGI+' }, { id: 'x3', data: 'data:image/png;base64,' + 'A'.repeat(12 * 1024 * 1024) }, { id: '../x', data: 'data:image/png;base64,iVBORw0KGgo=' }], () => 'p');
      return s.size;
    });
    assert(bad === 0, 'I3 import validation: heic, html, oversized and bad ids rejected');
    await c2.close();
    // Profile delete removes that profile's photos
    const { ctx: c3, p: r } = await open(browser, { data: base(), second: base() });
    await r.evaluate(async () => { const A = await import('./js/attachments.js'); const b = new Blob(['x'], { type: 'image/jpeg' }); await A.putFile({ id: 'samPhoto', profileId: 'q', blob: b, type: 'image/jpeg', createdAt: Date.now() }); await A.putFile({ id: 'mePhoto', profileId: 'p', blob: b, type: 'image/jpeg', createdAt: Date.now() }); const S = await import('./js/store.js'); S.switchProfile('q'); });
    await r.waitForTimeout(300);
    await r.click('.avatar-btn'); await r.waitForTimeout(300);
    await r.click('.sheet button:has-text("Delete Sam")'); await r.waitForTimeout(300);
    await r.click('.sheet.dialog .btn.danger'); await r.waitForTimeout(300);
    await r.click('.sheet.dialog .btn.danger'); await r.waitForTimeout(800);
    const f3 = await idb(r);
    assert(!f3.some((f) => f.id === 'samPhoto') && f3.some((f) => f.id === 'mePhoto'), 'Z2 deleting a profile deletes only its photos');
    await c3.close();
  }

  // ===================== #7 Completed =====================
  {
    const ts = (k, h = 12) => new Date(`${k}T${String(h).padStart(2, '0')}:00:00`).getTime();
    const data = base({ tasks: [
      task('a1', 'Café crème order', { done: true, completedAt: ts('2026-11-18', 9), category: 'c1', priority: 3, notes: 'Ask about naïve beans' }),
      task('a2', 'Old done, no timestamp', { date: '2026-10-02', done: true }),
      task('a3', 'Water plants', { date: '2026-11-01', recur: { type: 'daily', days: [], interval: 2 }, doneDates: { '2026-11-16': true, '2026-11-17': true, '2026-11-18': true }, doneAt: { '2026-11-18': ts('2026-11-18', 8) }, category: 'c2' }),
      task('a4', 'Not done yet'),
      task('a5', 'Photo task', { done: true, completedAt: ts('2026-11-12'), attachments: [{ id: 'fx', w: 10, h: 10, type: 'image/jpeg' }] }),
      task('a6', 'Last year', { date: '2025-12-30', done: true }),
    ] });
    const { ctx, p } = await open(browser, { data });
    assert(await p.locator('.progress-card .completed-link').count() === 0, 'H1a no Completed link on Today’s progress card');
    await go(p, '#calendar'); await p.click('.avatar-btn'); await p.waitForTimeout(300); await p.click('.menu-item:has-text("Completed tasks")'); await p.waitForTimeout(400);
    assert(await p.evaluate(() => location.hash) === '#completed', 'H1 reachable from Calendar');
    const count = () => p.textContent('.completed-count');
    const titles = () => p.$$eval('.completed-title', (e) => e.map((x) => x.textContent));
    assert((await count()) === '7 completed', 'H2 one row per completed occurrence (3 repeating + 4 one-off): ' + await count());
    const t0 = await titles();
    assert(t0[0] === 'Café crème order' && t0[1] === 'Water plants' && t0.filter((x) => x === 'Water plants').length === 3 && !t0.includes('Not done yet'), 'H3 newest first, recurring occurrences as rows: ' + t0.join(' | '));
    assert((await p.$$eval('.completed-day-head', (e) => e.map((x) => x.textContent)))[0].startsWith('Today'), 'H4 grouped by completion date');
    // Search: accents + notes, debounced
    await p.fill('.completed-search', 'cafe'); await p.waitForTimeout(400);
    assert((await count()) === '1 completed' && (await titles())[0] === 'Café crème order', 'S1 search is accent-insensitive');
    await p.fill('.completed-search', 'NAIVE'); await p.waitForTimeout(400);
    assert((await count()) === '1 completed', 'S2 search covers notes, case-insensitive');
    await p.fill('.completed-search', ''); await p.waitForTimeout(400);
    // Filters
    await p.click('.completed-filters button:has-text("Category")'); await p.waitForTimeout(300);
    await p.check('.sheet .check-row:has-text("Home") input'); await p.waitForTimeout(300);
    await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(300);
    assert((await count()) === '3 completed' && (await p.textContent('.completed-active')).includes('1 filter on'), 'F1 category filter (+ active count)');
    await p.click('.completed-filters button:has-text("Category")'); await p.waitForTimeout(300);
    await p.check('.sheet .check-row:has-text("No category") input'); await p.uncheck('.sheet .check-row:has-text("Home") input'); await p.waitForTimeout(300);
    await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(300);
    assert((await count()) === '3 completed', 'F2 “No category”');
    await p.click('.completed-active button:has-text("Clear filters")'); await p.waitForTimeout(300);
    assert((await count()) === '7 completed', 'F3 Clear filters');
    const range = async (label) => { await p.click('.completed-filters button >> nth=1'); await p.waitForTimeout(300); await p.check(`.sheet .range-list .check-row:has-text("${label}") input`); await p.waitForTimeout(300); await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(300); return count(); };
    assert((await range('This week')) === '4 completed', 'F4 date: this week (Mon 16 – today)');
    assert((await range('This month')) === '5 completed', 'F5 date: this month');
    assert((await range('Last 30 days')) === '5 completed', 'F6 date: last 30 days');
    assert((await range('This year')) === '6 completed', 'F7 date: this year');
    await p.click('.completed-filters button >> nth=1'); await p.waitForTimeout(300);
    await p.fill('.sheet input[aria-label="From"]', '2026-10-01'); await p.dispatchEvent('.sheet input[aria-label="From"]', 'change');
    await p.fill('.sheet input[aria-label="To"]', '2026-10-31'); await p.dispatchEvent('.sheet input[aria-label="To"]', 'change'); await p.waitForTimeout(300);
    await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(300);
    assert((await count()) === '1 completed' && (await titles())[0] === 'Old done, no timestamp', 'F8 custom range; no timestamp falls back to the due date');
    await p.click('.completed-active button:has-text("Clear filters")'); await p.waitForTimeout(300);
    await p.click('.completed-filters button:has-text("Priority")'); await p.waitForTimeout(300);
    await p.check('.sheet .check-row >> nth=3'); await p.waitForTimeout(300); await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(300);
    assert((await count()) === '1 completed', 'F9 priority filter');
    await p.click('.completed-active button:has-text("Clear filters")'); await p.waitForTimeout(300);
    await p.click('.completed-filters button:has-text("Type")'); await p.waitForTimeout(300);
    await p.click('.sheet .segmented button:has-text("Repeating")'); await p.waitForTimeout(300); await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(300);
    assert((await count()) === '3 completed', 'F10 type: repeating');
    await p.click('.completed-active button:has-text("Clear filters")'); await p.waitForTimeout(300);
    await p.click('.completed-filters button:has-text("Has photos")'); await p.waitForTimeout(300);
    assert((await count()) === '1 completed' && (await p.textContent('.completed-row')).includes('📎1'), 'F11 has photos (📎 count on the row)');
    // Filters remembered for the session (navigating away and back)
    await go(p, '#today'); await go(p, '#completed');
    assert((await count()) === '1 completed', 'F12 filters kept for the session');
    await p.click('.completed-active button:has-text("Clear filters")'); await p.waitForTimeout(300);
    // Tap → View → Mark not done → row disappears live
    await p.click('.completed-row:has-text("Café crème order")'); await p.waitForTimeout(500);
    assert(await p.locator('.task-view-sheet').count() === 1, 'T1 tapping a row opens View task');
    await p.click('.tv-done'); await p.waitForTimeout(400);
    await esc(p);
    assert((await count()) === '6 completed' && !(await titles()).includes('Café crème order'), 'T2 Mark not done removes it from the list');
    // completedAt recorded from now on
    await p.evaluate(async () => { const A = await import('./js/actions.js'); A.toggleTask('a4', '2026-11-18'); A.toggleTask('a3', '2026-11-15'); });
    const st = await stored(p);
    assert(st.tasks.find((x) => x.id === 'a4').completedAt > 0 && st.tasks.find((x) => x.id === 'a3').doneAt['2026-11-15'] > 0, 'T3 completedAt / doneAt recorded');
    await go(p, '#calendar');
    await p.click('.avatar-btn'); await p.waitForTimeout(300); await p.click('.menu-item:has-text("Completed tasks")'); await p.waitForTimeout(400);
    assert(await p.evaluate(() => location.hash) === '#completed', 'H5 reachable from Calendar');
    await ctx.close();
  }
  // Performance: 5000 completions
  {
    const done = {};
    for (let i = 0; i < 5000; i++) { const d = new Date(2026, 10, 18); d.setDate(d.getDate() - i); done[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`] = true; }
    const data = base({ tasks: [task('big', 'Daily log', { date: '2013-01-01', recur: { type: 'daily', days: [], interval: 2 }, doneDates: done })] });
    const { ctx, p } = await open(browser, { data });
    const t0 = Date.now();
    await go(p, '#completed');
    const ms = Date.now() - t0;
    const rowsN = await p.locator('.completed-row').count();
    assert((await p.textContent('.completed-count')) === '5000 completed' && rowsN === 150 && ms < 2500, `PF1 5000 completions: renders the first 150 rows in ${ms} ms`);
    await p.click('.completed-more'); await p.waitForTimeout(300);
    assert(await p.locator('.completed-row').count() >= 300, 'PF2 Show more loads the next page');
    const t1 = Date.now();
    await p.fill('.completed-search', 'daily'); await p.waitForTimeout(400);
    assert((await p.textContent('.completed-count')) === '5000 completed' && Date.now() - t1 < 1500, 'PF3 search over 5000 stays quick');
    await ctx.close();
  }
  // Layout 320/390/1280 light/dark
  for (const [width, dark] of [[320, false], [320, true], [390, false], [1280, true]]) {
    const data = base({ tasks: [task('a1', 'A rather long completed task title that should truncate nicely', { done: true, completedAt: NOW.getTime(), category: 'c1', priority: 2, attachments: [{ id: 'fx', w: 1, h: 1, type: 'image/jpeg' }] })] });
    const { ctx, p } = await open(browser, { width, dark, data });
    await go(p, '#completed');
    const fits = await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    assert(fits, `Y ${width} ${dark ? 'dark' : 'light'}: Completed fits`);
    if (width === 320) await p.screenshot({ path: path.join(__dirname, `l25-completed-${dark ? 'dark' : 'light'}.png`) });
    await ctx.close();
  }

  console.log(errs.join('\n') || 'no console errors');
  await browser.close();
})();
