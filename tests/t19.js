// v1.6.4: QA low findings.
const { chromium } = require('playwright');
const path = require('path');
const URL = 'http://127.0.0.1:8080/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const habit = (id, name, o = {}) => ({ id, name, emoji: '💧', color: '#0ea5e9', goal: { type: 'check', target: 1, unit: '' }, schedule: { type: 'daily', days: [] }, timeOfDay: 'anytime', reminder: null, archived: false, order: 1, createdAt: '2026-01-01', ...o });
const seed = (o = {}) => ({ version: 4, settings: { onboarded: true, theme: 'light', weekStart: 1, notifications: true, workoutHabit: { habitId: null, filter: 'any' } }, tasks: [], habits: [habit('h1', 'Water'), habit('h2', 'Stretch', { emoji: '🧘' })], logs: {}, journal: {}, exercises: [], workouts: [], ...o });

async function open(browser, { width = 390, dark = false, data = seed(), raw = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 820 }, serviceWorkers: 'block', colorScheme: dark ? 'dark' : 'light' });
  data.settings.theme = dark ? 'dark' : 'light';
  await ctx.addInitScript(([d]) => {
    if (localStorage.getItem('dailyTracker:profiles')) return;
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles: [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }] }));
    localStorage.setItem('dailyTracker:data:p', d);
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
  }, [raw || JSON.stringify(data)]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  await p.goto(URL); await p.waitForTimeout(400);
  return { ctx, p };
}
const go = (p, hash) => p.evaluate((x) => { location.hash = x; }, hash).then(() => p.waitForTimeout(300));
const stored = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('dailyTracker:data:p')));
const openForm = async (p, id) => {
  await p.evaluate(async (hid) => { const S = await import('./js/store.js'); const F = await import('./js/forms.js'); F.openHabitForm(S.getState().habits.find((x) => x.id === hid)); }, id);
  await p.waitForTimeout(300);
  if (await p.locator('.icon-image-panel').isHidden()) await p.click('button:has-text("Use image / Genmoji")');
};
const discPng = (p) => p.evaluate(() => { const c = document.createElement('canvas'); c.width = 120; c.height = 80; const x = c.getContext('2d'); x.fillStyle = '#e11'; x.beginPath(); x.arc(60, 40, 30, 0, 7); x.fill(); return c.toDataURL('image/png'); });

(async () => {
  const browser = await chromium.launch();

  // ===== 1. Paste box never runs pasted handlers =====
  {
    const { ctx, p } = await open(browser);
    await openForm(p, 'h2');
    const disc = await discPng(p);
    // execCommand insertHTML with an onerror payload (bypasses paste/beforeinput)
    await p.focus('.genmoji-box');
    await p.evaluate(() => document.execCommand('insertHTML', false, '<img src="does-not-exist.png" onerror="window.__pwned=1"><svg onload="window.__pwned2=1"></svg><b onmouseover="window.__pwned3=1">x</b>'));
    await p.waitForTimeout(800);
    assert(!(await p.evaluate(() => window.__pwned || window.__pwned2 || window.__pwned3)) && (await p.innerHTML('.genmoji-box')) === '', 'S1 execCommand insertHTML onerror/onload payload: nothing runs, box emptied');
    // Paste HTML with a handler + data: image → image taken from an inert parse, nothing inserted
    await p.evaluate((src) => {
      const dt = new DataTransfer(); dt.setData('text/html', `<p>hi<img src="${src}" onerror="window.__pwned4=1" onload="window.__pwned5=1"></p>`);
      document.querySelector('.genmoji-box').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, disc);
    await p.waitForTimeout(700);
    assert(!(await p.evaluate(() => window.__pwned4 || window.__pwned5)) && (await p.textContent('.icon-status')).includes('set as the icon') && await p.locator('.emoji-preview img').count() === 1, 'S2 pasted HTML: image extracted via DOMParser, handlers never run');
    // Drop an image file
    await p.evaluate(async (src) => {
      const blob = await (await fetch(src)).blob();
      const dt = new DataTransfer(); dt.items.add(new File([blob], 'd.png', { type: 'image/png' }));
      document.querySelector('.genmoji-box').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, disc);
    await p.waitForTimeout(500);
    assert((await p.textContent('.icon-status')).includes('Dropped image set'), 'S3 dropped image file → icon');
    // Genmoji-style <img> inserted by the keyboard still works (inserted directly into the box)
    await p.evaluate((src) => { document.querySelector('.genmoji-box').innerHTML = `<img src="${src}" onerror="window.__pwned6=1">`; }, disc);
    await p.waitForTimeout(500);
    assert((await p.textContent('.icon-status')).includes('Genmoji set') && !(await p.evaluate(() => window.__pwned6)), 'S4 keyboard-inserted <img> (Genmoji) still works, handler stripped');
    // Typed emoji still works
    await p.focus('.genmoji-box'); await p.keyboard.insertText('🦊'); await p.waitForTimeout(300);
    assert((await p.textContent('.emoji-preview')).trim() === '🦊', 'S5 typing an emoji in the box picks it');
    // Plain text pasted → hint, nothing inserted
    await p.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'hello'); document.querySelector('.genmoji-box').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
    await p.waitForTimeout(200);
    assert((await p.textContent('.icon-status')).includes('Only an emoji') && (await p.innerHTML('.genmoji-box')) === '', 'S6 plain text ignored');
    // 4. blobFromSrc maps fetch failures
    const msg = await p.evaluate(async () => { const H = await import('./js/habitIcon.js'); try { await H.processIcon('blob:http://127.0.0.1:8080/00000000-0000-0000-0000-000000000000'); return 'no error'; } catch (e) { return e.message; } });
    assert(msg === 'That image couldn’t be read.', 'S7 blobFromSrc fetch failure → “That image couldn’t be read.”: ' + msg);
    await ctx.close();
  }

  // ===== 2. Advanced save stores only overrides =====
  {
    const { ctx, p } = await open(browser);
    const def = await p.evaluate(async () => { const C = await import('./js/pushConfig.js'); return { url: C.PUSH_SERVER_URL, key: C.VAPID_PUBLIC_KEY }; });
    await go(p, '#settings');
    await p.click('details.push-advanced summary');
    assert(await p.inputValue('[aria-label="Push server URL"]') === def.url, 'A0 Advanced shows the bundled URL');
    await p.fill('[aria-label="Register key"]', 'my-register-key');
    await p.click('.push-advanced .btn.secondary'); await p.waitForTimeout(300);
    let cfg = await p.evaluate(() => JSON.parse(localStorage.getItem('dailyTracker:pushConfig')));
    assert(JSON.stringify(cfg) === '{"registerKey":"my-register-key"}', 'A1 saving unchanged URL/key stores only the register key: ' + JSON.stringify(cfg));
    await p.fill('[aria-label="Push server URL"]', 'https://other.example.org');
    await p.click('.push-advanced .btn.secondary'); await p.waitForTimeout(300);
    cfg = await p.evaluate(() => JSON.parse(localStorage.getItem('dailyTracker:pushConfig')));
    assert(cfg.serverUrl === 'https://other.example.org' && !('publicKey' in cfg) && cfg.registerKey === 'my-register-key', 'A2 a changed URL is stored as an override; the key stays bundled');
    await ctx.close();
  }

  // ===== 3. Space between image icon and name; 5. Workouts segmented at 320 =====
  for (const dark of [false, true]) {
    const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
    const data = seed({ logs: { h2: { [today]: 1 } }, settings: { onboarded: true, theme: 'light', weekStart: 1, workoutHabit: { habitId: 'h1', filter: 'any' } } });
    const { ctx, p } = await open(browser, { width: 320, dark, data });
    const icon = await p.evaluate(async () => { const c = document.createElement('canvas'); c.width = 40; c.height = 40; const x = c.getContext('2d'); x.fillStyle = '#e11'; x.fillRect(5, 5, 30, 30); return (await import('./js/habitIcon.js')).processIcon(c.toDataURL('image/png')); });
    await p.evaluate(async (d) => { const A = await import('./js/actions.js'); const S = await import('./js/store.js'); A.saveHabit({ ...S.getState().habits.find((x) => x.id === 'h2'), icon: { type: 'image', data: d } }); }, icon);
    await go(p, '#habits'); await p.click('[role=tab]:has-text("Stats")'); await p.waitForTimeout(250);
    const gapStats = await p.evaluate(() => { const t = document.querySelector('.stat-sub .habit-title'); const img = t.querySelector('img').getBoundingClientRect(); const r = document.createRange(); r.selectNodeContents(t); const rects = [...r.getClientRects()]; return { gap: getComputedStyle(t).columnGap, text: t.textContent }; });
    assert(gapStats.gap !== 'normal' && parseFloat(gapStats.gap) > 3, `G1 Stats longest-streak: gap between image and name (${gapStats.gap})`);
    await go(p, '#habits'); await p.click('[role=tab]:has-text("Active habits")'); await p.waitForTimeout(250);
    await p.click('.habit-card:has-text("Stretch") .habit-open', { button: 'right' }); await p.waitForTimeout(300);
    const g2 = await p.evaluate(() => { const t = document.querySelector('.sheet.action-menu .sheet-title .habit-title'); const img = t.querySelector('img').getBoundingClientRect(); const r = document.createRange(); const txt = [...t.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim()); r.selectNodeContents(txt); return r.getBoundingClientRect().left - img.right; });
    assert(g2 >= 3, `G2 item-menu title: ${g2.toFixed(1)}px between image and name`);
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    await go(p, '#settings');
    const seg = await p.evaluate(() => { const s = document.querySelector('.segmented[aria-label="Which workouts count"]'); const card = s.closest('.set-card').getBoundingClientRect(); const r = s.getBoundingClientRect(); return { over: r.right - card.right, sw: s.scrollWidth - s.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth }; });
    assert(seg.over <= 0 && seg.sw <= 0 && seg.page <= 0, `W1 320 ${dark ? 'dark' : 'light'}: workout filter fits (${JSON.stringify(seg)})`);
    await p.locator('.segmented[aria-label="Which workouts count"]').scrollIntoViewIfNeeded();
    await p.screenshot({ path: path.join(__dirname, `l19-settings-${dark ? 'dark' : 'light'}.png`) });
    await ctx.close();
  }

  // ===== 6. Saving a daily habit unchanged keeps its schedule as stored =====
  {
    const raw = JSON.stringify(seed({ habits: [habit('h1', 'Water', { schedule: { type: 'daily', days: [] } }), habit('h3', 'Gym', { schedule: { type: 'perWeek', days: [], times: 2 } }), habit('h4', 'Piano', { schedule: { type: 'days', days: [1, 3], times: 4 } })] }));
    const { ctx, p } = await open(browser, { raw });
    const before = (await stored(p)).habits.map((x) => JSON.stringify(x.schedule));
    for (const id of ['h1', 'h3', 'h4']) {
      await p.evaluate(async (hid) => { const S = await import('./js/store.js'); const F = await import('./js/forms.js'); F.openHabitForm(S.getState().habits.find((x) => x.id === hid)); }, id);
      await p.waitForTimeout(250);
      await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(250);
    }
    const after = (await stored(p)).habits.map((x) => JSON.stringify(x.schedule));
    assert(JSON.stringify(after) === JSON.stringify(before) && after[0] === '{"type":"daily","days":[]}', 'H1 unchanged save keeps schedules exactly: ' + after.join(' '));
    // Switching to "Some days" stores days, keeps the rest
    await p.evaluate(async () => { const S = await import('./js/store.js'); const F = await import('./js/forms.js'); F.openHabitForm(S.getState().habits.find((x) => x.id === 'h3')); });
    await p.waitForTimeout(250);
    await p.click('.sheet .segmented button:has-text("Some days")'); await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(250);
    const h3 = (await stored(p)).habits.find((x) => x.id === 'h3').schedule;
    assert(h3.type === 'days' && h3.days.length === 5 && h3.times === 2, 'H2 changing type sets that type’s field, preserves others: ' + JSON.stringify(h3));
    // New daily habit: no stray days/times
    await p.evaluate(async () => { const F = await import('./js/forms.js'); F.openHabitForm(null); }); await p.waitForTimeout(250);
    await p.fill('.sheet input[placeholder^="e.g. Drink water"]', 'Brand new'); await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(250);
    const nw = (await stored(p)).habits.find((x) => x.name === 'Brand new').schedule;
    assert(nw.type === 'daily' && !nw.times, 'H3 new daily habit has no times: ' + JSON.stringify(nw));
    await ctx.close();
  }

  console.log(errs.join('\n') || 'no console errors');
  await browser.close();
})();
