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
  assert(!errs.length, 'no page errors ' + errs.join(' | '));
  await browser.close();
})().catch((e) => { console.log('FAIL: ' + e.stack); process.exitCode = 1; });
