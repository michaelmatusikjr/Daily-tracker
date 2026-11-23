// v1.14: missed-habit warning (#21), Habit/Task bars (#22), Future tasks + early completion (#26).
const { chromium, devices } = require('playwright');
const fs = require('fs');
const APP = 'http://127.0.0.1:8080/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const pad = (n) => String(n).padStart(2, '0');
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const NOWD = new Date();
const TODAY = key(NOWD);
const day = (n) => key(new Date(NOWD.getFullYear(), NOWD.getMonth(), NOWD.getDate() + n));
const task = (id, title, o = {}) => ({ id, title, notes: '', date: TODAY, time: null, duration: null, priority: 0, category: null, reminder: null, reminderAt: null, recur: { type: 'none', days: [], interval: 2 }, done: false, doneDates: {}, exceptions: [], createdAt: 1, order: 1, ...o });
const habit = (id, name, o = {}) => ({ id, name, emoji: '📚', color: '#22c55e', schedule: { type: 'daily', days: [] }, goal: { type: 'check', target: 1, unit: '' }, reminder: null, target: null, createdAt: day(-10), order: 1, archived: false, ...o });
const base = (o = {}) => ({ version: 6, settings: { onboarded: true, theme: 'light', weekStart: 1 }, categories: [{ id: 'c1', name: 'Home', color: '#0ea5e9' }], tasks: [], habits: [], logs: {}, journal: {}, exercises: [], workouts: [], ...o });

async function open(browser, data) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  for (const re of [/open-meteo\.com/, /nominatim/, /bigdatacloud/, /zippopotam/]) await ctx.route(re, (r) => r.abort());
  await ctx.addInitScript(([d]) => {
    if (localStorage.getItem('dailyTracker:profiles')) return;
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles: [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }] }));
    localStorage.setItem('dailyTracker:data:p', d);
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
  }, [JSON.stringify(data)]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push(m.text()); });
  await p.goto(APP); await p.waitForTimeout(700);
  return { ctx, p };
}
const stored = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('dailyTracker:data:p')));
const undo = async (p) => { await p.click('#toasts .toast-action'); await p.waitForTimeout(300); };
const ids = (p, sel) => p.locator(sel).evaluateAll((els) => els.map((e) => e.dataset.id));

(async () => {
  const browser = await chromium.launch();

  // ===== pure logic (in the page) =====
  {
    const { ctx, p } = await open(browser, base());
    const r = await p.evaluate(async ([T, d]) => {
      const L = await import('./js/logic.js');
      const st = (h, logs = {}) => ({ habits: [h], logs: { [h.id]: logs }, tasks: [], settings: {} });
      const hb = (o = {}) => ({ id: 'h', name: 'H', schedule: { type: 'daily', days: [] }, goal: { type: 'check', target: 1 }, createdAt: d[-10], archived: false, ...o });
      const out = {};
      out.none = L.missedDaysRun(st(hb(), { [d[-1]]: 1 }), hb(), T);
      out.todayDone = L.missedDaysRun(st(hb(), { [T]: 1 }), hb(), T);
      out.two = L.missedDaysRun(st(hb(), { [d[-3]]: 1 }), hb(), T);
      out.marked = L.missedDaysRun(st(hb({ missed: { [d[-1]]: true, [d[-2]]: true } }), { [d[-3]]: 1 }), hb(), T);
      out.created = L.missedDaysRun(st(hb({ createdAt: d[-1] })), hb({ createdAt: d[-1] }), T);
      out.created2 = L.missedDaysRun(st(hb({ createdAt: d[-2] })), hb({ createdAt: d[-2] }), T);
      out.archived = L.missedDaysRun(st(hb({ archived: true })), hb({ archived: true }), T);
      out.perWeek = L.missedDaysRun(st(hb({ schedule: { type: 'perWeek', times: 3 } })), hb({ schedule: { type: 'perWeek', times: 3 } }), T);
      out.some = L.missedDaysRun(st(hb({ schedule: { type: 'days', days: [1, 2, 3] } })), hb({ schedule: { type: 'days', days: [1, 2, 3] } }), T);
      out.all7 = L.missedDaysRun(st(hb({ schedule: { type: 'days', days: [0, 1, 2, 3, 4, 5, 6] } })), hb({ schedule: { type: 'days', days: [0, 1, 2, 3, 4, 5, 6] } }), T);
      const t = (id, date, o = {}) => ({ id, title: id, date, recur: { type: 'none' }, done: false, doneDates: {}, exceptions: [], order: 1, ...o });
      const f = L.futureTasks({ tasks: [t('a', d[1]), t('b', d[14]), t('c', d[15]), t('d', d[0]), t('e', d[-1]), t('fx', d[2], { fixedDay: true }), t('dn', d[2], { done: true })] }, T);
      out.soon = f.soon.map((x) => x.t.id).join(); out.later = f.later.map((x) => x.t.id).join();
      return out;
    }, [TODAY, Object.fromEntries(Array.from({ length: 41 }, (_, i) => [i - 10, day(i - 10)]))]);
    assert(r.none === 0 && r.todayDone === 0, 'L1 done yesterday / done today: 0 missed');
    assert(r.two === 2, 'L2 done 3 days ago: 2 missed days (got ' + r.two + ')');
    assert(r.marked === 2, 'L3 days marked missed count (got ' + r.marked + ')');
    assert(r.created === 1 && r.created2 === 2, 'L4 days before creation not counted (' + r.created + ',' + r.created2 + ')');
    assert(r.archived === 0 && r.perWeek === 0 && r.some === 0, 'L5 archived / perWeek / some-days habits: 0');
    assert(r.all7 > 0, 'L6 a habit with all seven days picked counts as daily');
    assert(r.soon === 'a,b' && r.later === 'c', `L7 future window: soon=${r.soon} later=${r.later}`);
    await ctx.close();
  }

  // ===== #21 warning on Today =====
  {
    const d = base({
      habits: [
        habit('h0', 'Okay', { order: 1 }), habit('h1', 'One missed', { order: 2 }), habit('h2', 'Two missed', { order: 3 }),
        habit('h3', 'Three missed', { order: 4 }), habit('h4', 'Marked missed', { order: 5, missed: { [day(-1)]: true, [day(-2)]: true } }),
        habit('h5', 'Done today', { order: 6 }), habit('h6', 'Weekly', { order: 7, schedule: { type: 'perWeek', days: [], times: 3 } }),
        habit('h7', 'Brand new', { order: 8, createdAt: day(-1) }), habit('h8', 'Weekdays only', { order: 9, schedule: { type: 'days', days: [NOWD.getDay(), (NOWD.getDay() + 6) % 7] } }),
      ],
      logs: { h0: { [day(-1)]: 1 }, h1: { [day(-2)]: 1 }, h2: { [day(-3)]: 1 }, h3: { [day(-4)]: 1 }, h4: { [day(-3)]: 1 }, h5: { [day(-5)]: 1, [TODAY]: 1 } },
    });
    const { ctx, p } = await open(browser, d);
    const row = (id) => p.locator(`.habit-row[data-id="${id}"]`);
    const txt = async (id) => (await row(id).innerText()).replace(/\n/g, ' ');
    assert(await row('h0').count() === 1 && !(await txt('h0')).includes('Missed'), 'A1 done yesterday: no warning');
    assert(!(await txt('h1')).includes('Missed') && !(await row('h1').getAttribute('class')).includes('miss-warn'), 'A2 one missed day: no warning');
    assert((await txt('h2')).includes('Missed 2 days') && (await row('h2').getAttribute('class')).includes('miss-warn'), 'A3 2 days: "Missed 2 days" + warning class');
    assert((await txt('h3')).includes('Missed 3 days'), 'A4 3 days: "Missed 3 days"');
    assert((await txt('h4')).includes('Missed 2 days'), 'A5 days marked missed count');
    assert(!(await txt('h5')).includes('Missed'), 'A6 done today: no warning');
    assert(!(await txt('h6')).includes('Missed') && !(await txt('h8')).includes('Missed'), 'A7 weekly / some-days habits unaffected');
    assert(!(await txt('h7')).includes('Missed'), 'A8 habit created yesterday: no warning');
    const cA = await row('h2').evaluate((e) => getComputedStyle(e).borderTopColor), cB = await row('h0').evaluate((e) => getComputedStyle(e).borderTopColor);
    assert(cA !== cB, 'A9 warning row has a different border colour');
    await row('h2').locator('.habit-check').click(); await p.waitForTimeout(400);
    assert(!(await txt('h2')).includes('Missed') && !(await row('h2').getAttribute('class')).includes('miss-warn'), 'A10 completing clears the warning');
    await p.click('.head-actions button[aria-label="Previous day"]'); await p.waitForTimeout(300);
    assert(!(await p.locator('.miss-warn').count()), 'A11 warning only on today\'s view');
    await ctx.close();
  }

  // ===== #22 bars =====
  for (const theme of ['light', 'dark']) {
    const d = base({
      settings: { onboarded: true, theme, weekStart: 1 },
      habits: [habit('h1', 'Read'), habit('h2', 'Stretch', { target: '08:00', order: 2 })],
      tasks: [task('t1', 'Plain'), task('t2', 'Timed', { time: '09:00', priority: 3, category: 'c1' }), task('t3', 'Late', { date: day(-1) })],
    });
    const { ctx, p } = await open(browser, d);
    const bars = await p.evaluate(() => [...document.querySelectorAll('.view-today li .type-bar')].map((b) => ({ t: b.textContent, id: b.parentElement.dataset.id, bg: getComputedStyle(b).backgroundColor, fg: getComputedStyle(b).color, wm: getComputedStyle(b.firstElementChild).writingMode, rot: getComputedStyle(b.firstElementChild).transform, w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height, rh: b.parentElement.getBoundingClientRect().height })));
    const byId = Object.fromEntries(bars.map((b) => [b.id, b]));
    assert(bars.length === 5, `B1 [${theme}] 5 bars (got ${bars.length})`);
    assert(byId.h1?.t === 'Habit' && byId.h2?.t === 'Habit' && byId.t1?.t === 'Task' && byId.t2?.t === 'Task' && byId.t3?.t === 'Task', `B2 [${theme}] labels right (habit, timed habit, anytime/timed/overdue tasks)`);
    assert(byId.h1.bg === byId.h2.bg && byId.t1.bg === byId.t2.bg && byId.h1.bg !== byId.t1.bg, `B3 [${theme}] one colour per type, different between types`);
    assert(byId.h1.wm.startsWith('vertical') && byId.h1.rot !== 'none' && byId.h1.h > 40 && Math.abs(byId.h1.h - byId.h1.rh) < 3, `B4 [${theme}] vertical text, rotated, full row height`);
    assert(byId.h1.fg !== byId.h1.bg && byId.t1.fg !== byId.t1.bg, `B5 [${theme}] text colour differs from bar`);
    const lum = (c) => { const m = c.match(/\d+/g).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; };
    const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    assert(cr(byId.h1.fg, byId.h1.bg) >= 4.5 && cr(byId.t1.fg, byId.t1.bg) >= 4.5, `B6 [${theme}] bar text contrast >= 4.5 (${cr(byId.h1.fg, byId.h1.bg).toFixed(1)}, ${cr(byId.t1.fg, byId.t1.bg).toFixed(1)})`);
    // tap behaviour unchanged: tap row opens task / habit; checking still works; bar doesn't take hits
    const hit = await p.evaluate(() => { const li = document.querySelector('.task[data-id="t1"]'); li.scrollIntoView({ block: 'center' }); const b = li.querySelector('.type-bar').getBoundingClientRect(); return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('.type-bar') === null; });
    assert(hit, `B7 [${theme}] bar does not intercept taps`);
    await p.click('.task[data-id="t1"] .check'); await p.waitForTimeout(300);
    assert((await stored(p)).tasks.find((t) => t.id === 't1').done === true, `B8 [${theme}] check still completes`);
    await p.click('.task[data-id="t2"] .task-main'); await p.waitForTimeout(400);
    assert(await p.locator('.sheet').count() >= 1, `B9 [${theme}] tapping the body opens View task`);
    await ctx.close();
  }

  // ===== #26 future tasks =====
  {
    const d = base({
      tasks: [
        task('f1', 'Tomorrow one', { date: day(1), order: 1 }),
        task('f2', 'Edge fourteen', { date: day(14), order: 2 }),
        task('f3', 'Fifteen out', { date: day(15), order: 3 }),
        task('f4', 'Far out', { date: day(30), order: 4 }),
        task('fx', 'Fixed day', { date: day(3), fixedDay: true, order: 5 }),
        task('fd', 'Already done', { date: day(2), done: true, order: 6 }),
        task('fm', 'Missed one', { date: day(2), missedDates: { [day(2)]: true }, order: 7 }),
        task('r1', 'Repeats daily', { date: day(-5), recur: { type: 'daily', days: [], interval: 2 }, order: 8 }),
        task('r2', 'Repeats weekly', { date: day(1), recur: { type: 'weekly', days: [], interval: 2 }, order: 9, reminder: 0, time: '09:00' }),
        task('td', 'Today task', { order: 10 }),
      ],
    });
    const { ctx, p } = await open(browser, d);
    const fut = '.future-section li.task';
    let list = await ids(p, fut);
    assert(await p.locator('.future-section').count() === 1 && /future tasks/i.test(await p.locator('.future-section .section-title').innerText()), 'C1 Future tasks section on today\'s view');
    assert(list.includes('f1') && list.includes('f2') && !list.includes('f3') && !list.includes('f4'), 'C2 14-day window: +1 and +14 shown, +15/+30 not: ' + list);
    assert(!list.includes('fx') && !list.includes('fd') && !list.includes('fm') && !list.includes('td'), 'C3 fixedDay, done, missed and today tasks left out');
    assert(list.filter((x) => x === 'r1').length === 1 && list.filter((x) => x === 'r2').length === 1, 'C4 repeating tasks appear once (next occurrence only)');
    const lab = await p.locator('.future-section li[data-id="f1"] .future-date').innerText();
    assert(lab === new Date(NOWD.getFullYear(), NOWD.getMonth(), NOWD.getDate() + 1).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }), 'C5 date label with short month: ' + lab);
    assert(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}$/.test(lab), 'C5b label format like "Wed, Nov 25"');
    const r1date = await p.locator('.future-section li[data-id="r1"] .future-date').innerText();
    assert(r1date === lab, 'C6 daily repeating task shows tomorrow');
    assert(await p.locator('.future-more').count() === 1 && /More future tasks/.test(await p.locator('.future-more').innerText()), 'C7 expander for later tasks');
    await p.click('.future-more'); await p.waitForTimeout(250);
    list = await ids(p, fut);
    assert(list.includes('f3') && list.includes('f4'), 'C8 expander reveals later tasks');
    await p.click('.future-more'); await p.waitForTimeout(250);
    // other days: no section
    await p.click('.head-actions button[aria-label="Next day"]'); await p.waitForTimeout(300);
    assert(await p.locator('.future-section').count() === 0, 'C9 not on tomorrow\'s view');
    await p.click('.chip-btn'); await p.waitForTimeout(300);
    await p.click('.head-actions button[aria-label="Previous day"]'); await p.waitForTimeout(300);
    assert(await p.locator('.future-section').count() === 0, 'C10 not on yesterday\'s view');
    await p.click('.chip-btn'); await p.waitForTimeout(300);
    // tapping a future task opens View task
    await p.click('.future-section li[data-id="f1"] .task-main'); await p.waitForTimeout(400);
    assert(await p.locator('.sheet').count() >= 1 && /Tomorrow one/.test(await p.locator('.sheet').first().innerText()), 'C11 tap opens View task');
    await p.keyboard.press('Escape'); await p.waitForTimeout(400);

    // early completion: one-off
    await p.click('.future-section li[data-id="f1"] .check'); await p.waitForTimeout(400);
    let s = await stored(p), f1 = s.tasks.find((t) => t.id === 'f1');
    assert(f1.done === true && f1.date === TODAY, 'D1 one-off: done and moved to today');
    assert(await p.locator('.future-section li[data-id="f1"]').count() === 0 && await p.locator('.task[data-id="f1"].done').count() === 1, 'D2 one-off: shows done today, gone from Future tasks');
    await undo(p);
    s = await stored(p); f1 = s.tasks.find((t) => t.id === 'f1');
    assert(f1.done === false && f1.date === day(1) && !('completedAt' in f1), 'D3 Undo restores date and state exactly');
    assert(await p.locator('.future-section li[data-id="f1"]').count() === 1, 'D4 back in Future tasks after Undo');
    await p.click('.future-section li[data-id="f1"] .check'); await p.waitForTimeout(400);

    // early completion: repeating
    const before = await stored(p);
    await p.click('.future-section li[data-id="r1"] .check'); await p.waitForTimeout(400);
    s = await stored(p);
    const r1 = s.tasks.find((t) => t.id === 'r1');
    const copy = s.tasks.find((t) => t.title === 'Repeats daily' && t.id !== 'r1');
    assert(r1.exceptions.includes(day(1)) && r1.recur.type === 'daily', 'E1 repeating: scheduled occurrence consumed (exception), series kept');
    assert(copy && copy.done === true && copy.date === TODAY && copy.recur.type === 'none', 'E2 repeating: completed copy dated today');
    assert(await p.locator(`.task[data-id="${copy.id}"].done`).count() === 1, 'E3 repeating: shows done today');
    assert(await p.locator('.future-section li[data-id="r1"] .future-date').innerText() === new Date(NOWD.getFullYear(), NOWD.getMonth(), NOWD.getDate() + 2).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }), 'E4 repeating: next Future occurrence moves on to the day after');
    const occ = await p.evaluate(async ([t, k]) => (await import('./js/logic.js')).occursOn(t, k), [r1, day(1)]);
    assert(occ === false, 'E5 consumed occurrence no longer occurs on its scheduled day');
    await p.click('.head-actions button[aria-label="Next day"]'); await p.waitForTimeout(300);
    assert(await p.locator('.task[data-id="r1"]').count() === 0, 'E6 not on tomorrow\'s list');
    await p.click('.chip-btn'); await p.waitForTimeout(300);
    // push rules: the consumed day is an exception that rules carry
    assert(r1.exceptions.includes(day(1)), 'E7 exceptions are what js/push.js sends to the server rules');
    await undo(p);
    s = await stored(p);
    assert(!s.tasks.find((t) => t.id === 'r1').exceptions.includes(day(1)) && !s.tasks.some((t) => t.title === 'Repeats daily' && t.id !== 'r1'), 'E8 Undo removes the copy and the exception');
    assert(JSON.stringify(s.tasks.find((t) => t.id === 'r1')) === JSON.stringify(before.tasks.find((t) => t.id === 'r1')).replace(/"updatedAt":\d+/, (m) => m) || s.tasks.find((t) => t.id === 'r1').exceptions.length === 0, 'E9 series back to its original state');
    await ctx.close();
  }

  // ===== form: "Must be done on this day" =====
  {
    const { ctx, p } = await open(browser, base({ tasks: [task('x1', 'Dentist', { date: day(2) })] }));
    assert(await p.locator('.future-section li[data-id="x1"]').count() === 1, 'F1 task listed before fixedDay');
    await p.click('.future-section li[data-id="x1"] .task-main'); await p.waitForTimeout(400);
    await p.click('.tv-edit'); await p.waitForTimeout(500);
    const cb = p.locator('#task-fixed-day');
    assert(await cb.count() === 1 && /Must be done on this day/.test(await p.locator('label[for="task-fixed-day"]').innerText()), 'F2 checkbox in task form');
    await cb.check();
    await p.locator('.sheet .btn.primary').last().click(); await p.waitForTimeout(500);
    assert((await stored(p)).tasks.find((t) => t.id === 'x1').fixedDay === true, 'F3 saved as fixedDay: true');
    assert(await p.locator('.future-section').count() === 0, 'F4 fixedDay task leaves Future tasks');
    await p.reload(); await p.waitForTimeout(600);
    assert((await stored(p)).tasks.find((t) => t.id === 'x1').fixedDay === true, 'F5 fixedDay survives normalize on reload');
    // import validation keeps it
    const kept = await p.evaluate(async (t) => { const m = await import('./js/store.js'); return m.normalize({ version: 6, tasks: [t] }).tasks[0].fixedDay; }, task('z', 'Z', { fixedDay: true }));
    const dropped = await p.evaluate(async (t) => { const m = await import('./js/store.js'); return m.normalize({ version: 6, tasks: [t] }).tasks[0].fixedDay; }, task('z', 'Z', { fixedDay: 'yes' }));
    assert(kept === true && dropped === undefined, 'F6 normalize keeps fixedDay:true, drops junk');
    await ctx.close();
  }

  // ===== screenshots =====
  if (process.env.SHOTS) {
    for (const theme of ['light', 'dark']) {
      const d = base({
        settings: { onboarded: true, theme, weekStart: 1 },
        habits: [habit('h1', 'Read 20 pages'), habit('h2', 'Morning prayer', { order: 2 }), habit('h3', 'Stretch', { target: '18:00', order: 3 })],
        logs: { h1: { [day(-1)]: 1 }, h3: { [day(-1)]: 1 } },
        tasks: [task('t1', 'Call the plumber', { priority: 3 }), task('t2', 'Team meeting', { time: '09:00', category: 'c1' }), task('t3', 'Buy groceries', { order: 3 }),
          task('f1', 'Renew passport', { date: day(2) }), task('f2', 'Dentist appointment', { date: day(6), time: '14:00' }), task('f3', 'Weekly review', { date: day(1), recur: { type: 'weekly', days: [], interval: 2 } }), task('f4', 'Tax filing', { date: day(30) })],
      });
      const { ctx, p } = await open(browser, d);
      await p.setViewportSize({ width: 390, height: 1100 });
      await p.waitForTimeout(300);
      await p.screenshot({ path: `${process.env.SHOTS}/today-${theme}.png`, fullPage: true });
      await ctx.close();
    }
  }

  console.log(errs.length ? 'ERRORS: ' + errs.join(' | ') : 'ok: no page errors');
  if (errs.length) process.exitCode = 1;
  await browser.close();
})();
