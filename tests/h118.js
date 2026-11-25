// Shared helpers for the v1.18 suites (t50–t54).
const { chromium } = require('playwright');
const URL = 'http://127.0.0.1:8080/';
const NOW = new Date(2026, 10, 18, 10, 0); // Wed Nov 18 2026, 10:00 local
const TODAY = '2026-11-18';
const errs = [];
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const task = (id, title, o = {}) => ({ id, title, notes: '', date: TODAY, time: null, duration: null, priority: 0, category: null, reminder: null, reminderAt: null, recur: { type: 'none', days: [], interval: 2 }, done: false, doneDates: {}, exceptions: [], order: Number(id.replace(/\D/g, '')) || 1, createdAt: NOW.getTime(), ...o });
const habit = (id, name, o = {}) => ({ id, name, emoji: '💧', color: '#0ea5e9', goal: { type: 'check', target: 1, unit: '' }, schedule: { type: 'daily', days: [] }, reminder: null, target: null, archived: false, order: 1, createdAt: '2026-01-01', ...o });
const base = (o = {}) => ({ version: 7, settings: { onboarded: true, theme: 'light', accent: 'indigo', weekStart: 1, timeFormat: '12', notifications: false }, categories: [], tasks: [], habits: [], logs: {}, journal: {}, exercises: [], workouts: [], ...o });

async function open(browser, { data = base(), hash = '', width = 390, height = 844, touch = true, clock = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', colorScheme: 'light', deviceScaleFactor: 1, hasTouch: touch, isMobile: touch });
  await ctx.addInitScript((d) => {
    window.__n = [];
    window.Notification = class { constructor(t, o) { window.__n.push({ title: t, body: o?.body }); } static get permission() { return 'granted'; } static requestPermission() { return Promise.resolve('granted'); } };
    if (localStorage.getItem('dailyTracker:profiles')) return;
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles: [{ id: 'p', name: 'Mick', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }] }));
    localStorage.setItem('dailyTracker:data:p', d);
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
  }, JSON.stringify(data));
  const p = await ctx.newPage();
  if (clock) await p.clock.install({ time: NOW });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push(m.text()); });
  await p.goto(URL + hash); await p.waitForTimeout(600);
  return { ctx, p };
}
const stored = (p, id = 'p') => p.evaluate((i) => JSON.parse(localStorage.getItem('dailyTracker:data:' + i)), id);
const go = (p, hash) => p.evaluate((x) => { location.hash = x; }, hash).then(() => p.waitForTimeout(700));

/** Synthetic touch swipe: touchstart at the element's centre (+ offsets), moves in `steps`, touchend. `hold`: skip touchend. */
async function swipe(p, sel, dx, { dy = 0, steps = 5, end = true, startX = 0.5 } = {}) {
  await p.evaluate(({ sel, dx, dy, steps, end, startX }) => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    const x0 = r.left + r.width * startX, y0 = r.top + r.height / 2;
    const mk = (x, y) => new Touch({ identifier: 7, target: el, clientX: x, clientY: y });
    const fire = (type, x, y, list = true) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: list ? [mk(x, y)] : [], targetTouches: list ? [mk(x, y)] : [], changedTouches: [mk(x, y)] }));
    fire('touchstart', x0, y0);
    for (let i = 1; i <= steps; i++) fire('touchmove', x0 + (dx * i) / steps, y0 + (dy * i) / steps);
    if (end) fire('touchend', x0 + dx, y0 + dy, false);
  }, { sel, dx, dy, steps, end, startX });
  await p.waitForTimeout(450);
}
/** Long-press: pointerdown (touch) on the element, wait, pointerup. */
async function hold(p, sel, ms = 650) {
  await p.evaluate((sel) => {
    const el = document.querySelector(sel); const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, pointerId: 3, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  }, sel);
  await p.waitForTimeout(ms);
  await p.evaluate((sel) => {
    const el = document.querySelector(sel); const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, pointerId: 3, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  }, sel);
  await p.waitForTimeout(150);
}
const finish = (label) => { if (errs.length) { console.log('FAIL: console errors: ' + errs.slice(0, 5).join(' | ')); process.exitCode = 1; } else console.log('ok: no console errors'); console.log(label + ' done'); };

module.exports = { chromium, URL, NOW, TODAY, errs, assert, task, habit, base, open, stored, go, swipe, hold, finish };
