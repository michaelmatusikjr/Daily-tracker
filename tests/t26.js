// v1.9.1: QA fixes for photos import ids, w/h clamp, Completed category + focus, viewer races.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const URL = 'http://127.0.0.1:8080/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const NOW = new Date(2026, 10, 18, 10, 0);
const TODAY = '2026-11-18';
const task = (id, title, o = {}) => ({ id, title, notes: '', date: TODAY, recur: { type: 'none', days: [], interval: 2 }, done: false, doneDates: {}, exceptions: [], order: 1, createdAt: 1, ...o });
const base = (o = {}) => ({ version: 4, settings: { onboarded: true, theme: 'light', weekStart: 1 }, categories: [{ id: 'c1', name: 'Work', color: '#3b82f6' }], tasks: [], habits: [], logs: {}, journal: {}, exercises: [], workouts: [], ...o });
async function open(browser, { data = base(), second = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 820 }, serviceWorkers: 'block', acceptDownloads: true });
  await ctx.addInitScript(([d, q]) => {
    if (localStorage.getItem('dailyTracker:profiles')) return;
    const profiles = [{ id: 'pa', name: 'Alice', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }];
    if (q) { profiles.push({ id: 'pb', name: 'Bob', avatar: { type: 'emoji', emoji: '', color: '#10b981' } }); localStorage.setItem('dailyTracker:data:pb', q); }
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'pa', profiles }));
    localStorage.setItem('dailyTracker:data:pa', d);
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
  }, [JSON.stringify(data), second && JSON.stringify(second)]);
  const p = await ctx.newPage();
  await p.clock.install({ time: NOW });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(URL); await p.waitForTimeout(400);
  return { ctx, p };
}
const go = (p, hash) => p.evaluate((x) => { location.hash = x; }, hash).then(() => p.waitForTimeout(350));
const stored = (p, id) => p.evaluate((i) => JSON.parse(localStorage.getItem('dailyTracker:data:' + i)), id);
const files = (p) => p.evaluate(async () => (await (await import('./js/attachments.js')).allFiles()).map((f) => ({ id: f.id, profileId: f.profileId })));
const png = async (p, color = '#e11') => Buffer.from(await p.evaluate(async (c) => { const cv = document.createElement('canvas'); cv.width = 60; cv.height = 40; const x = cv.getContext('2d'); x.fillStyle = c; x.fillRect(0, 0, 60, 40); const b = await new Promise((r) => cv.toBlob(r, 'image/png')); const u = new Uint8Array(await b.arrayBuffer()); let s = ''; for (const v of u) s += String.fromCharCode(v); return btoa(s); }, color), 'base64');

(async () => {
  const browser = await chromium.launch();
  // ===== 1. "Replace this profile" import never shares photo files between profiles (QA p35 repro) =====
  {
    const { ctx, p } = await open(browser, { data: base({ tasks: [task('t1', 'Alice task')] }), second: base({ tasks: [task('b1', 'Bob task')] }) });
    // Alice adds a photo
    await p.evaluate(async () => { const F = await import('./js/forms.js'); const S = await import('./js/store.js'); F.openTaskForm(S.getState().tasks[0]); }); await p.waitForTimeout(300);
    await p.setInputFiles('.photo-field input[type=file]', { name: 'a.png', mimeType: 'image/png', buffer: await png(p) }); await p.waitForTimeout(1200);
    await p.click('.sheet-root:last-child .sheet-foot .btn.primary'); await p.waitForTimeout(500);
    const aliceId = (await stored(p, 'pa')).tasks[0].attachments[0].id;
    await go(p, '#settings');
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('button:has-text("Export JSON")')]);
    const full = path.join(__dirname, 'b191-full.json'); await dl.saveAs(full);
    const bk = JSON.parse(fs.readFileSync(full, 'utf8'));
    // Single-profile style backup of Alice, imported into Bob with "Replace"
    const single = path.join(__dirname, 'b191-single.json');
    fs.writeFileSync(single, JSON.stringify({ app: 'daily-tracker', data: bk.profiles.find((x) => x.id === 'pa').data, attachments: bk.attachments }));
    await p.evaluate(async () => { const S = await import('./js/store.js'); S.switchProfile('pb'); }); await p.waitForTimeout(300);
    await go(p, '#settings');
    await p.setInputFiles('input[type=file][accept^="application/json"]', single); await p.waitForTimeout(400);
    await p.click('.sheet.dialog button:has-text("Replace Bob")'); await p.waitForTimeout(1500);
    const bobId = (await stored(p, 'pb')).tasks[0].attachments[0].id;
    let f = await files(p);
    assert(bobId !== aliceId && f.find((x) => x.id === aliceId)?.profileId === 'pa' && f.find((x) => x.id === bobId)?.profileId === 'pb', 'I1 Replace: the imported photo gets its own id; Alice’s file stays Alice’s');
    // Deleting Alice's task (after the Undo window) leaves Bob's photo
    await p.evaluate(async () => { const S = await import('./js/store.js'); S.switchProfile('pa'); }); await p.waitForTimeout(300);
    await p.evaluate(async () => { const A = await import('./js/actions.js'); await A.deleteTask('t1', '2026-11-18'); });
    await p.waitForTimeout(9000);
    f = await files(p);
    assert(!f.some((x) => x.id === aliceId) && f.some((x) => x.id === bobId), 'I2 deleting Alice’s task removes only her file; Bob’s photo is intact');
    // importFiles: an id owned by another profile is re-id'd, not adopted; task refs rewritten
    const r = await p.evaluate(async (bid) => {
      const A = await import('./js/attachments.js');
      const fr = await A.getFile(bid); const reader = new FileReader();
      const dataUrl = await new Promise((res) => { reader.onload = () => res(reader.result); reader.readAsDataURL(fr.blob); });
      const out = await A.importFiles([{ id: bid, profileId: 'pa', data: dataUrl, w: 1e9, h: -5 }], () => 'pa');
      return { stored: [...out.stored], renamed: [...out.renamed], bobOwner: (await A.getFile(bid)).profileId, newRec: out.renamed.size ? (await A.getFile([...out.renamed.values()][0].id)) : null };
    }, bobId);
    assert(r.renamed.length === 1 && r.bobOwner === 'pb' && r.newRec.profileId === 'pa' && r.newRec.w === 10000 && r.newRec.h === 0, 'I3 importFiles never adopts another profile’s file id (re-id’d; w/h clamped)');
    // Full "Replace all" round trip still keeps ids and photos
    await go(p, '#settings');
    await p.setInputFiles('input[type=file][accept^="application/json"]', full); await p.waitForTimeout(400);
    await p.click('.sheet.dialog .btn.danger'); await p.waitForTimeout(1500);
    const a2 = (await stored(p, 'pa')).tasks[0].attachments[0].id;
    f = await files(p);
    assert(f.some((x) => x.id === a2 && x.profileId === 'pa'), 'I4 Replace-all round trip restores Alice’s photo');
    await ctx.close();
  }
  // ===== 2. Imported w/h clamped =====
  {
    const { ctx, p } = await open(browser);
    const a = await p.evaluate(async () => { const S = await import('./js/store.js'); return S.validateImport({ version: 4, tasks: [{ id: 'x', title: 'X', date: '2026-11-18', attachments: [{ id: 'a1', type: 'image/png', w: 1e9, h: -5 }, { id: 'a2', type: 'image/jpeg', w: 12.6, h: 'NaN' }] }], habits: [] }).data.tasks[0].attachments; });
    assert(JSON.stringify(a.map((x) => [x.w, x.h])) === '[[10000,0],[13,0]]', 'W1 attachment w/h clamped to integers 0–10000: ' + JSON.stringify(a));
    await ctx.close();
  }
  // ===== 3 + 4. Completed: deleted category = No category; focus back to the row =====
  {
    const data = base({ tasks: [task('a', 'Work done', { done: true, category: 'c1' }), task('b', 'Orphan category', { done: true, category: 'gone' }), task('c', 'Plain', { done: true })] });
    const { ctx, p } = await open(browser, { data });
    await go(p, '#completed');
    await p.click('.completed-filters button:has-text("Category")'); await p.waitForTimeout(300);
    await p.check('.sheet .check-row:has-text("No category") input'); await p.waitForTimeout(300);
    await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(300);
    const t = await p.$$eval('.completed-title', (e) => e.map((x) => x.textContent).sort());
    assert(JSON.stringify(t) === '["Orphan category","Plain"]', 'C1 a deleted category counts as “No category”: ' + t);
    await p.click('.completed-row:has-text("Plain")'); await p.waitForTimeout(500);
    await p.keyboard.press('Escape'); await p.waitForTimeout(600);
    assert(await p.evaluate(() => document.activeElement?.classList.contains('completed-row') && document.activeElement.textContent.includes('Plain')), 'C2 closing View returns focus to its Completed row');
    // Mark not done from the view: focus moves to a neighbouring Completed row (not the title)
    await p.click('.completed-row:has-text("Orphan category")'); await p.waitForTimeout(500);
    await p.click('.tv-done'); await p.waitForTimeout(400);
    await p.keyboard.press('Escape'); await p.waitForTimeout(600);
    assert(await p.evaluate(() => document.activeElement?.classList.contains('completed-row')), 'C3 when the row is gone, focus goes to a neighbouring Completed row');
    await ctx.close();
  }
  // ===== 5. Viewer: fast navigation + close don't mismatch or leak =====
  {
    const { ctx, p } = await open(browser, { data: base({ tasks: [task('t1', 'Gallery')] }) });
    await p.evaluate(async () => { const F = await import('./js/forms.js'); const S = await import('./js/store.js'); F.openTaskForm(S.getState().tasks[0]); }); await p.waitForTimeout(300);
    const imgs = [];
    for (const c of ['#e11', '#1e1', '#11e', '#ee1']) imgs.push({ name: c.slice(1) + '.png', mimeType: 'image/png', buffer: await png(p, c) });
    await p.setInputFiles('.photo-field input[type=file]', imgs); await p.waitForTimeout(2500);
    await p.click('.sheet-root:last-child .sheet-foot .btn.primary'); await p.waitForTimeout(500);
    // Count object URLs created/revoked
    await p.evaluate(async () => {
      const live = window.__live = new Set();
      const c = URL.createObjectURL.bind(URL), r = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (b) => { const u = c(b); live.add(u); return u; };
      URL.revokeObjectURL = (u) => { live.delete(u); r(u); };
    });
    await p.evaluate(async () => (await import('./js/taskView.js')).openTaskView('t1')); await p.waitForTimeout(800);
    await p.locator('.tv-photos .photo-open').first().focus(); await p.keyboard.press('Enter'); await p.waitForTimeout(600);
    for (let i = 0; i < 3; i++) await p.keyboard.press('ArrowRight');
    await p.waitForTimeout(800);
    const shown = await p.evaluate(() => ({ count: document.querySelector('.pv-count').textContent, alt: document.querySelector('.pv-img').alt, src: document.querySelector('.pv-img').src }));
    const expectedSrcOk = await p.evaluate(async () => { const img = document.querySelector('.pv-img'); await img.decode().catch(() => {}); const c = document.createElement('canvas'); c.width = 1; c.height = 1; const x = c.getContext('2d'); x.drawImage(img, 0, 0, 1, 1); return [...x.getImageData(0, 0, 1, 1).data].slice(0, 3).join(); });
    assert(shown.count === '4 / 4' && shown.alt.endsWith('photo 4 of 4') && expectedSrcOk.split(',').map(Number).every((v, i) => Math.abs(v - [238, 238, 17][i]) <= 4), 'V1 fast navigation shows the right (last) photo: ' + JSON.stringify(shown) + ' rgb ' + expectedSrcOk);
    await p.keyboard.press('ArrowLeft'); await p.keyboard.press('Escape'); // close while a load is in flight
    await p.waitForTimeout(800);
    const leaks = await p.evaluate(() => [...window.__live].length);
    await p.keyboard.press('Escape'); await p.waitForTimeout(800);
    const leaks2 = await p.evaluate(() => [...window.__live].length);
    assert(leaks2 === 0, `V2 no object URLs left after closing (late results revoked): ${leaks} → ${leaks2}`);
    await ctx.close();
  }
  console.log(errs.join('\n') || 'no console errors');
  await browser.close();
})();
