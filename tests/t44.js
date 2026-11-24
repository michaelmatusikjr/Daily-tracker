// v1.16 (#32): changing a setting re-renders Settings without moving the scroll position or losing focus.
const { chromium, devices } = require('playwright');
const APP = process.env.APP_URL || 'http://127.0.0.1:8080/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  for (const re of [/open-meteo\.com/, /nominatim/, /bigdatacloud/, /zippopotam/]) await ctx.route(re, (r) => r.abort());
  await ctx.addInitScript(() => {
    if (localStorage.getItem('dailyTracker:profiles')) return;
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles: [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }] }));
    localStorage.setItem('dailyTracker:data:p', JSON.stringify({ version: 6, settings: { onboarded: true, theme: 'light', weekStart: 1, accent: 'indigo' }, tasks: [], habits: [], logs: {}, journal: {}, exercises: [], workouts: [] }));
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await p.goto(APP + '#settings'); await p.waitForTimeout(800);

  const steps = [
    ['accent swatch', '.swatches[aria-label="Accent color"] .swatch[aria-label="Teal"]', () => p.evaluate(() => document.documentElement.dataset.accent || getComputedStyle(document.documentElement).getPropertyValue('--accent'))],
    ['theme', '[role="radiogroup"][aria-label="Theme"] [role="radio"]:not([aria-checked="true"]), .segmented[aria-label="Theme"] button:not([aria-pressed="true"]):not([aria-checked="true"])', null],
    ['week start', '[aria-label="Week starts on"] button:not([aria-pressed="true"]):not([aria-checked="true"]), [aria-label="Week starts on"] [role="radio"]:not([aria-checked="true"])', null],
    ['time format', '[aria-label="Time format"] button:not([aria-pressed="true"]):not([aria-checked="true"]), [aria-label="Time format"] [role="radio"]:not([aria-checked="true"])', null],
  ];
  for (const [name, sel] of steps) {
    const el = p.locator(sel).first();
    if (!(await el.count())) { assert(false, `${name}: control found`); continue; }
    // Put the control in the middle of the screen, then remember where we are.
    await el.evaluate((n) => { const r = n.getBoundingClientRect(); window.scrollBy(0, r.top - window.innerHeight / 2); });
    await p.waitForTimeout(200);
    const before = await p.evaluate(() => window.scrollY);
    const label = await el.getAttribute('aria-label') || await el.textContent();
    await el.tap();
    await p.waitForTimeout(500);
    const after = await p.evaluate(() => window.scrollY);
    assert(before > 50, `${name}: the page was scrolled down first (${before})`);
    assert(Math.abs(after - before) <= 1, `${name}: scroll position kept (${before} → ${after})`);
    const focused = await p.evaluate(() => { const a = document.activeElement; return a && a !== document.body ? (a.getAttribute('aria-label') || a.textContent) : null; });
    assert(focused === label, `${name}: focus stays on the tapped control (${focused})`);
  }
  // Switching tabs still starts the new screen at the top.
  await p.evaluate(() => { location.hash = '#today'; }); await p.waitForTimeout(500);
  assert(await p.evaluate(() => window.scrollY) === 0, 'changing route still scrolls to the top');

  // ===== 1.15.1 QA fixes: scroll restore only for the user's own re-render; focus by identity =====
  {
    const c2 = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    for (const re of [/open-meteo\.com/, /nominatim/, /bigdatacloud/, /zippopotam/]) await c2.route(re, (r) => r.abort());
    await c2.addInitScript(() => {
      window.__scrolls = 0;
      const orig = window.scrollTo.bind(window);
      window.scrollTo = (...a) => { window.__scrolls++; return orig(...a); };
      if (localStorage.getItem('dailyTracker:profiles')) return;
      const d = new Date(); const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const tasks = Array.from({ length: 40 }, (_, i) => ({ id: 't' + i, title: 'Task ' + i, date: k, order: i }));
      localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles: [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }] }));
      localStorage.setItem('dailyTracker:data:p', JSON.stringify({ version: 6, settings: { onboarded: true, theme: 'light', weekStart: 1, accent: 'indigo' }, tasks, habits: [], logs: {}, journal: {}, exercises: [], workouts: [] }));
      localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
      window.__k = k;
    });
    const a = await c2.newPage();
    a.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    await a.goto(APP + '#today'); await a.waitForTimeout(800);
    const k = await a.evaluate(() => window.__k);
    // Deep link while Today is already showing: the row ends up in view and stays there.
    await a.evaluate(() => window.scrollTo(0, 0));
    await a.evaluate((k) => { location.hash = '#open/task/p/t38/' + k; }, k);
    await a.waitForTimeout(600);
    const r = await a.evaluate(() => { const b = document.querySelector('.task[data-id="t38"]').getBoundingClientRect(); return { top: b.top, h: innerHeight }; });
    assert(r.top >= 0 && r.top < r.h, `deep link on Today (scrolled to top) shows the row (top ${Math.round(r.top)})`);
    await a.keyboard.press('Escape'); await a.waitForTimeout(500);
    // Background render (another tab changed the data): no scrollTo calls, and the page isn't moved.
    await a.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 400); });
    await a.waitForTimeout(300);
    await a.evaluate(() => { window.__scrolls = 0; });
    const b = await c2.newPage();
    await b.goto(APP + '#today'); await b.waitForTimeout(400);
    await b.evaluate(() => { const o = JSON.parse(localStorage.getItem('dailyTracker:data:p')); o.tasks = o.tasks.filter((t) => t.id !== 't3'); localStorage.setItem('dailyTracker:data:p', JSON.stringify(o)); });
    await a.waitForTimeout(700);
    const y0 = await a.evaluate(() => scrollY);
    assert(await a.locator('.task[data-id="t3"]').count() === 0, 'the background render happened (t3 gone)');
    assert(await a.evaluate(() => window.__scrolls) === 0, 'a background render never calls scrollTo');
    assert(Math.abs(y0 - 400) <= 2, `…and does not move the page (${y0})`);
    // Focus is matched by identity: a control inserted/removed before it doesn't shift focus to its neighbour.
    await a.evaluate(() => { const el = document.querySelector('.task[data-id="t20"] .task-main'); el.scrollIntoView({ block: 'center' }); el.focus({ preventScroll: true }); });
    await a.waitForTimeout(200);
    await b.evaluate(() => { const o = JSON.parse(localStorage.getItem('dailyTracker:data:p')); o.tasks = o.tasks.filter((t) => t.id !== 't5'); localStorage.setItem('dailyTracker:data:p', JSON.stringify(o)); });
    await a.waitForTimeout(700);
    const f1 = await a.evaluate(() => document.activeElement?.closest('.task')?.dataset.id || null);
    assert(await a.locator('.task[data-id="t5"]').count() === 0 && f1 === 't20', `focus stays on the same task after an earlier row was removed (${f1})`);
    // The focused control itself disappears: focus isn't moved to a different one.
    await b.evaluate(() => { const o = JSON.parse(localStorage.getItem('dailyTracker:data:p')); o.tasks = o.tasks.filter((t) => t.id !== 't20'); localStorage.setItem('dailyTracker:data:p', JSON.stringify(o)); });
    await a.waitForTimeout(700);
    const f2 = await a.evaluate(() => document.activeElement?.closest('.task')?.dataset.id || null);
    assert(f2 === null, `no matching control: focus is not restored onto another one (${f2})`);
    await c2.close();
  }
  assert(!errs.length, 'no page errors ' + errs.join(' | '));
  await browser.close();
})().catch((e) => { console.log('FAIL: ' + e.stack); process.exitCode = 1; });
