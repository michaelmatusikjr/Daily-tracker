// v1.2.0: alarm removal — reminders flow, v2→v3 migration, imports, no 404s, 320px header.
const { chromium } = require('./testprep');
const fs = require('fs');
const SP = __dirname;
const URL = 'http://127.0.0.1:8080/';
const KEY = 'dailyTracker:data', RT = 'dailyTracker:alarmRuntime';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [], notFound = [];
const base = (extra = {}) => ({ version: 3, settings: { onboarded: true, notifications: false, timeFormat: '12' }, tasks: [], habits: [], logs: {}, journal: {}, ...extra });
const notifStub = (perm, result) => `(() => { let p = ${JSON.stringify(perm)};
  class N { constructor() {} static get permission() { return p; } static requestPermission() { window.__asked = (window.__asked || 0) + 1; p = ${JSON.stringify(result)}; return Promise.resolve(p); } }
  window.Notification = N; })();`;

async function open(browser, { data = null, raw = null, init = null, width = 390, ua = null, rt = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, ...(ua ? { userAgent: ua } : {}) });
  if (init) await ctx.addInitScript(init);
  const seed = raw || (data && JSON.stringify(data));
  if (seed) await ctx.addInitScript(([k, d, r, rk]) => {
    if (!sessionStorage.getItem('seeded')) { localStorage.setItem(k, d); if (r) localStorage.setItem(rk, r); sessionStorage.setItem('seeded', '1'); }
  }, [KEY, seed, rt, RT]);
  const p = await ctx.newPage();
  await p.clock.install({ time: new Date(2026, 10, 10, 15, 0) });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('response', (r) => { if (r.status() >= 400) notFound.push(r.status() + ' ' + r.url()); });
  await p.goto(URL); await p.waitForTimeout(400);
  return { ctx, p };
}
const stored = (p) => p.evaluate((k) => JSON.parse(localStorage.getItem(localStorage.getItem('dailyTracker:profiles') ? 'dailyTracker:data:' + JSON.parse(localStorage.getItem('dailyTracker:profiles')).activeId : k)), KEY);
async function openTaskFormWithTime(p) {
  await p.click('.fab'); await p.waitForTimeout(250);
  await p.fill('.qa-input', 'Dentist 3pm');
  await p.click('text=More options'); await p.waitForTimeout(300);
}

(async () => {
  const browser = await chromium.launch();

  // ---- Migration from v2 with alarms, codes and alarm runtime ----
  {
    const v2 = {
      version: 2, settings: { onboarded: true, theme: 'dark', accent: 'teal', weekStart: 0, timeFormat: '24', notifications: false },
      categories: [{ id: 'work', name: 'Work', color: '#3b82f6' }],
      tasks: [{ id: 't1', title: 'Keep me', date: '2026-11-10', time: '09:00', category: 'work', reminder: 10 }],
      habits: [{ id: 'h1', name: 'Water', emoji: '💧', goal: { type: 'count', target: 8, unit: 'glasses' }, createdAt: '2026-11-01' }],
      logs: { h1: { '2026-11-09': 8, '2026-11-10': 3 } }, journal: { '2026-11-09': { mood: 4, note: 'good' } },
      alarms: [{ id: 'a1', time: '07:00', days: [1, 2, 3, 4, 5], dismiss: 'scan', codeIds: ['c1'] }],
      codes: [{ id: 'c1', value: 'X', nickname: 'Toothpaste' }],
    };
    const rt = JSON.stringify({ lastSeen: 1, snoozes: { a1: { until: 2, count: 1 } }, missed: [{ id: 'a1', at: 1, time: '07:00' }], active: { id: 'a1', occ: 1, alarm: { id: 'a1' } } });
    const { ctx, p } = await open(browser, { data: v2, rt });
    const s = await stored(p);
    assert(s.version === 5 && !('alarms' in s) && !('codes' in s), 'M1 v2 → v4: alarms and codes dropped from stored state');
    assert(s.tasks[0].title === 'Keep me' && s.tasks[0].reminder === 10 && s.habits[0].name === 'Water' && s.logs.h1['2026-11-10'] === 3
      && s.journal['2026-11-09'].note === 'good' && s.settings.accent === 'teal' && s.settings.weekStart === 0 && s.settings.timeFormat === '24' && s.categories.length === 1,
    'M1 nothing else lost (tasks, reminder, habits, logs, journal, settings, categories)');
    assert(await p.evaluate((k) => localStorage.getItem(k), RT) === null, 'M2 dailyTracker:alarmRuntime removed on startup');
    assert(!(await p.locator('.ring-screen, .load-fail').count()), 'M2 no ring screen or load-failure card');
    assert(await p.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'M1 theme kept');
    await p.goto(URL + '#alarms'); await p.waitForTimeout(300);
    assert((await p.locator('.page-title').textContent()).includes('Nov'), 'R0 old #alarms link falls back to Today');
    // export has no alarms
    const exp = await p.evaluate(async () => (await import('./js/store.js')).exportPayload());
    assert(exp.profiles[0].data.version === 5 && !('alarms' in exp.profiles[0].data), 'M3 export has no alarms/codes');
    await ctx.close();
  }
  // ---- Imports v1 / v2 / v3, with and without alarms ----
  {
    const { ctx, p } = await open(browser, { data: base({ tasks: [{ id: 'x', title: 'Current', date: '2026-11-10' }] }) });
    await p.evaluate(() => { location.hash = '#settings'; }); await p.waitForTimeout(200);
    const files = {
      v1: { version: 1, settings: { onboarded: true }, tasks: [{ id: 'a', title: 'From v1', date: '2026-11-10' }], habits: [], logs: {}, journal: {} },
      v2: { app: 'daily-tracker', appVersion: '1.1.2', data: { version: 2, tasks: [{ id: 'b', title: 'From v2', date: '2026-11-10' }], habits: [{ id: 'h', name: 'Read' }], alarms: [{ id: 'q', time: '06:00' }], codes: [{ id: 'c', value: 'V' }] } },
      v3: { app: 'daily-tracker', data: { version: 3, tasks: [{ id: 'c', title: 'From v3', date: '2026-11-10' }], habits: [], alarms: [{ id: 'q', time: '06:00' }] } },
    };
    for (const [name, obj] of Object.entries(files)) {
      fs.writeFileSync(`${SP}/imp-${name}.json`, JSON.stringify(obj));
      await p.setInputFiles('input[type=file]', `${SP}/imp-${name}.json`); await p.waitForTimeout(300);
      const msg = await p.textContent('.sheet .dialog-msg');
      assert(!/alarm|scan code/i.test(msg) && /\d+ tasks, \d+ habits and \d+ workouts/.test(msg), `I ${name}: confirmation mentions tasks, habits, workouts ("${msg.slice(0, 40)}…")`);
      await p.click('.sheet .btn.danger'); await p.waitForTimeout(300);
      const s = await stored(p);
      assert(s.version === 5 && !('alarms' in s) && !('codes' in s) && s.tasks[0].title === `From ${name}`, `I ${name}: imported, alarms/codes ignored`);
    }
    await ctx.close();
  }

  // ---- Reminder permission flow (kept) ----
  {
    const { ctx, p } = await open(browser, { init: notifStub('default', 'granted'), data: base() });
    await openTaskFormWithTime(p);
    await p.selectOption('.sheet select >> nth=1', '10'); await p.waitForTimeout(300);
    assert(await p.evaluate(() => window.__asked) === 1 && (await stored(p)).settings.notifications === true, 'R1 default → asked, granted → notifications on');
    assert((await p.locator('.toast').textContent()).includes('reminders are on'), 'R1 confirmation toast');
    await ctx.close();
  }
  {
    const { ctx, p } = await open(browser, { init: notifStub('granted', 'granted'), data: base() });
    await p.click('a[data-tab="habits"]'); await p.click('.fab'); await p.waitForTimeout(300);
    await p.fill('.sheet .habit-name-row input', 'Stretch');
    await p.fill('.sheet input[type=time]:not([aria-label="Complete by"])', '07:30');
    await p.locator('.sheet input[type=time]:not([aria-label="Complete by"])').dispatchEvent('change'); await p.waitForTimeout(300);
    assert((await stored(p)).settings.notifications === true && (await p.locator('.toast').textContent()).includes('Notifications turned on'), 'R2 granted but off → switched on with toast');
    await ctx.close();
  }
  {
    const data = base({ tasks: [{ id: 't', title: 'Dentist', date: '2026-11-20', time: '15:00', reminder: 10 }], habits: [{ id: 'h', name: 'Stretch', reminder: '07:30', createdAt: '2026-11-01' }] });
    const { ctx, p } = await open(browser, { init: notifStub('denied', 'denied'), data });
    assert(await p.locator('.habit-row .warn-badge').count() === 1, 'R3 blocked: habit badge');
    await openTaskFormWithTime(p);
    await p.selectOption('.sheet select >> nth=1', '10'); await p.waitForTimeout(200);
    assert((await p.locator('.reminder-note.warn').textContent()).includes("Notifications are blocked for this app – reminders won't appear"), 'R3 blocked warning on form');
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    await p.evaluate(() => { location.hash = '#settings'; }); await p.waitForTimeout(300);
    assert((await p.locator('.reminder-banner').textContent()).includes('2 reminders won’t appear'), 'R3 Settings banner');
    assert(!(await p.locator('a[href="#alarms"]').count()) && !(await p.textContent('.view')).includes('Alarm'), 'X Settings has no Alarms row');
    await ctx.close();
  }
  {
    const { ctx, p } = await open(browser, { init: 'delete window.Notification;', data: base(), ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1' });
    await openTaskFormWithTime(p);
    await p.selectOption('.sheet select >> nth=1', '10'); await p.waitForTimeout(200);
    assert((await p.locator('.reminder-note.warn').textContent()).includes('Home Screen'), 'R4 iOS tab: Home Screen explanation');
    await p.click('.reminder-note .link-btn'); await p.waitForTimeout(700);
    assert(await p.locator('#set-install').isVisible(), 'R4 link opens install instructions');
    await ctx.close();
  }
  {
    const data = base({ settings: { onboarded: true, notifications: true }, tasks: [{ id: 't', title: 'Dentist', date: '2026-11-20', time: '15:00', reminder: 10 }] });
    const { ctx, p } = await open(browser, { init: notifStub('granted', 'granted'), data });
    await p.evaluate(() => { location.hash = '#settings'; }); await p.waitForTimeout(300);
    await p.click('button.switch[aria-label="Notifications"]'); await p.waitForTimeout(300);
    assert((await p.textContent('.sheet .dialog-msg')).includes('1 reminder won’t fire'), 'R5 turn-off warning');
    await ctx.close();
  }

  // ---- Removal checks: Quick add, Today header at 320px ----
  {
    const { ctx, p } = await open(browser, { data: base({ tasks: [{ id: 't', title: 'Thing', date: '2026-11-11' }] }), width: 320 });
    assert(!(await p.locator('.alarm-pill').count()), 'X Today header has no alarm pill');
    const ov = () => p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    assert(!(await ov()), 'L 320px Today without overflow');
    await p.screenshot({ path: SP + '/x-today-320.png' });
    await p.click('[aria-label="Next day"]'); await p.waitForTimeout(200);
    const lines = await p.locator('.page-title').evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
    assert(lines === 1 && !(await ov()), 'L 320px non-today header fits on one line');
    await p.screenshot({ path: SP + '/x-today-next-320.png' });
    await p.click('.fab'); await p.waitForTimeout(300);
    const opts = await p.$$eval('.sheet .segmented button', (b) => b.map((x) => x.textContent));
    assert(JSON.stringify(opts) === '["Task","Habit","Workout"]', 'X Quick add offers Task, Habit and Workout (no Alarm)');
    await ctx.close();
  }

  assert(!notFound.length, 'no 4xx/5xx responses' + (notFound.length ? ': ' + notFound.join(', ') : ''));
  console.log(errs.join('\n') || 'no console errors');
  await browser.close();
})();
