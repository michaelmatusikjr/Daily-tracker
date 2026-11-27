// v1.11.0 #11: per-profile default task reminders + reminders for Anytime tasks (reminderAt).
const { chromium } = require('playwright');
const URL = 'http://127.0.0.1:8080/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const NOW = new Date(2026, 10, 18, 10, 0); // Wed Nov 18 2026
const TODAY = '2026-11-18';
const task = (id, title, o = {}) => ({ id, title, notes: '', date: TODAY, time: null, duration: null, priority: 0, category: null, reminder: null, recur: { type: 'none', days: [], interval: 2 }, done: false, doneDates: {}, exceptions: [], order: Number(id.replace(/\D/g, '')) || 1, createdAt: 1, ...o });
const base = (o = {}, s = {}) => ({ version: 5, settings: { onboarded: true, theme: 'light', weekStart: 1, notifications: true, ...s }, categories: [], tasks: [], habits: [], logs: {}, journal: {}, exercises: [], workouts: [], ...o });

async function open(browser, data) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' });
  await ctx.addInitScript((d) => {
    if (localStorage.getItem('dailyTracker:profiles')) return;
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles: [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }] }));
    localStorage.setItem('dailyTracker:data:p', d);
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
    localStorage.setItem('dailyTracker:householdConfig', '{"serverUrl":""}'); // no household (Google) sign-in: this suite runs without network
  }, JSON.stringify(data));
  const p = await ctx.newPage();
  await p.clock.install({ time: NOW });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(URL); await p.waitForTimeout(400);
  return { ctx, p };
}
const go = (p, hash) => p.evaluate((x) => { location.hash = x; }, hash).then(() => p.waitForTimeout(350));
const stored = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('dailyTracker:data:p')));
const byTitle = async (p, t) => (await stored(p)).tasks.find((x) => x.title === t);
const quickAdd = async (p, text) => {
  await p.click('button.fab'); await p.waitForTimeout(400);
  await p.fill('.qa-input', text); await p.keyboard.press('Enter'); await p.waitForTimeout(500);
};
const rules = (p) => p.evaluate(async (today) => (await import('./js/push.js')).buildRules({ hideText: false, today }).rules, TODAY);
const S = '.sheet-root:last-child';

(async () => {
  const browser = await chromium.launch();

  // ===== Quick add with defaults =====
  {
    const existing = task('t1', 'Old task');
    const { ctx, p } = await open(browser, base({ tasks: [existing] }));
    const st = await p.evaluate(async () => (await import('./js/store.js')).getState());
    assert(st.tasks[0].reminder === null && !st.tasks[0].reminderAt && st.settings.taskDefaults.on === true && st.settings.taskDefaults.anytimeReminderTime === '06:00', 'Q0 defaults on, 06:00; existing task untouched');
    await quickAdd(p, 'Dentist tomorrow');
    let t = await byTitle(p, 'Dentist');
    assert(t && t.time === null && t.reminder === null && t.reminderAt === '06:00' && t.date === '2026-11-19', 'Q1 Anytime task with a date → reminder at 06:00 on its day (' + JSON.stringify({ time: t?.time, r: t?.reminder, at: t?.reminderAt }) + ')');
    await quickAdd(p, 'Gym 6pm');
    t = await byTitle(p, 'Gym');
    assert(t && t.time === '18:00' && t.reminder === 0 && !t.reminderAt, 'Q2 timed task → reminder at the time of the event (lead 0)');
    assert((await byTitle(p, 'Old task')).reminder === null && !(await byTitle(p, 'Old task')).reminderAt, 'Q3 existing tasks not changed');
    // Settings: change the time, then turn off
    await go(p, 'settings');
    assert(await p.locator('#set-anytime-reminder').inputValue() === '06:00', 'Q4 Settings shows the Anytime reminder time');
    await p.fill('#set-anytime-reminder', '07:15'); await p.locator('#set-anytime-reminder').dispatchEvent('change'); await p.waitForTimeout(300);
    assert((await stored(p)).settings.taskDefaults.anytimeReminderTime === '07:15', 'Q5 time saved per profile');
    await go(p, 'today');
    await quickAdd(p, 'Pay rent');
    assert((await byTitle(p, 'Pay rent')).reminderAt === '07:15', 'Q6 new Anytime task uses the new time');
    assert((await byTitle(p, 'Dentist')).reminderAt === '06:00', 'Q7 earlier tasks keep theirs');
    await go(p, 'settings');
    await p.click('.set-row:has-text("Default reminders for new tasks") .switch'); await p.waitForTimeout(300);
    assert((await stored(p)).settings.taskDefaults.on === false && await p.locator('#set-anytime-reminder').count() === 0, 'Q8 toggle off hides the time picker');
    await go(p, 'today');
    await quickAdd(p, 'Water plants'); await quickAdd(p, 'Call Bo 3pm');
    const a = await byTitle(p, 'Water plants'), b = await byTitle(p, 'Call Bo');
    assert(a.reminderAt === null && a.reminder === null && b.reminder === null && b.time === '15:00', 'Q9 defaults off → no reminders added');
    await ctx.close();
  }

  // ===== Full task form =====
  {
    const { ctx, p } = await open(browser, base({ tasks: [task('t1', 'Has reminder', { reminderAt: '08:30' }), task('t2', 'Timed', { time: '13:00', reminder: 15 })] }));
    await p.click('button.fab'); await p.waitForTimeout(400);
    await p.fill('.qa-input', 'Big one'); await p.click('button:has-text("More options")'); await p.waitForTimeout(500);
    assert(await p.locator(`${S} #task-remind-at`).inputValue() === '06:00' && await p.locator(`${S} #task-remind-at`).isVisible(), 'T1 new Anytime task: Reminder at 06:00 pre-filled');
    await p.fill(`${S} #task-time`, '16:00'); await p.locator(`${S} #task-time`).dispatchEvent('input'); await p.waitForTimeout(200);
    assert(await p.locator(`${S} #task-remind-at`).isHidden() && (await p.locator(`${S} select`).evaluateAll((e) => e.map((x) => x.value))).includes('0'), 'T2 choosing a time switches the default to "At start time"');
    await p.click(`${S} button:has-text("Clear")`); await p.waitForTimeout(200);
    assert(await p.locator(`${S} #task-remind-at`).inputValue() === '06:00', 'T3 clearing the time brings the Anytime default back');
    // Explicit none stays none
    await p.click(`${S} button:has-text("None")`); await p.waitForTimeout(200);
    assert(await p.locator(`${S} #task-remind-at`).inputValue() === '', 'T4 None clears the reminder');
    await p.fill(`${S} #task-time`, '17:00'); await p.locator(`${S} #task-time`).dispatchEvent('input'); await p.waitForTimeout(200);
    assert(!(await p.locator(`${S} select`).evaluateAll((e) => e.map((x) => x.value))).includes('0'), 'T5 after an explicit choice, a time no longer swaps in the default');
    await p.click(`${S} .sheet-foot .btn.primary`); await p.waitForTimeout(500);
    let t = await byTitle(p, 'Big one');
    assert(t.time === '17:00' && t.reminder === null && t.reminderAt === null, 'T6 explicit "no reminder" stays none');
    // Edit an Anytime task's reminder
    await p.click('.task:has-text("Has reminder") .task-main'); await p.waitForTimeout(400);
    assert((await p.textContent('.tv-section[aria-label="Details"]')).includes('Reminder: at 8:30 AM'), 'T7 View task sheet shows "Reminder: at 8:30 AM"');
    await p.click('.tv-actions .tv-edit'); await p.waitForTimeout(400);
    assert(await p.locator(`${S} #task-remind-at`).inputValue() === '08:30', 'T8 edit form shows the existing time');
    await p.fill(`${S} #task-remind-at`, '09:45'); await p.locator(`${S} #task-remind-at`).dispatchEvent('change');
    await p.click(`${S} .sheet-foot .btn.primary`); await p.waitForTimeout(500);
    assert((await byTitle(p, 'Has reminder')).reminderAt === '09:45', 'T9 changed Anytime reminder saved');
    assert(await p.locator('.task:has-text("Has reminder") .meta[title^="Reminder"]').count() === 1, 'T10 bell badge on an Anytime task with a reminder');
    await p.keyboard.press('Escape'); await p.waitForTimeout(400);
    // Edit an existing task without a reminder: no default is injected
    await p.evaluate(async () => { const S = await import('./js/store.js'); S.update((s) => { s.tasks.push({ ...JSON.parse(JSON.stringify(s.tasks[0])), id: 'zz', title: 'Plain', reminderAt: null, reminder: null }); }); });
    await p.waitForTimeout(300);
    await p.locator('.task:has-text("Plain") .task-main').dispatchEvent('click'); await p.waitForTimeout(400);
    await p.click('.tv-actions .tv-edit'); await p.waitForTimeout(400);
    assert(await p.locator(`${S} #task-remind-at`).inputValue() === '', 'T11 editing a task with no reminder does not add the default');
    await p.fill(`${S} #task-time`, '11:00'); await p.locator(`${S} #task-time`).dispatchEvent('input'); await p.waitForTimeout(200);
    assert((await p.locator(`${S} select`).evaluateAll((e) => e.map((x) => x.value))).every((v) => v !== '0'), 'T12 …nor when adding a time to an existing task');
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    await ctx.close();
  }

  // ===== Push rules + local timers for Anytime reminders =====
  {
    const tasks = [
      task('t1', 'Anytime once', { reminderAt: '06:00', date: '2026-11-19' }),
      task('t2', 'Anytime daily', { reminderAt: '07:30', recur: { type: 'daily', days: [], interval: 2 }, doneDates: { [TODAY]: true } }),
      task('t3', 'Done once', { reminderAt: '06:00', done: true }),
      task('t4', 'No reminder', {}),
      task('t5', 'Timed', { time: '13:00', reminder: 0 }),
      task('t6', 'Ghost', { time: '13:00', reminderAt: '05:00' }), // reminderAt ignored when there is a time
    ];
    const { ctx, p } = await open(browser, base({ tasks }));
    const st = await p.evaluate(async () => (await import('./js/store.js')).getState());
    assert(st.tasks.find((x) => x.id === 't6').reminderAt === null, 'P0 reminderAt dropped when the task has a start time');
    const r = await rules(p);
    const R = Object.fromEntries(r.map((x) => [x.id.split(':').slice(2).join(':'), x]));
    assert(R.t1 && R.t1.time === '06:00' && R.t1.offsetDays === 0 && R.t1.recur.type === 'none' && R.t1.date === '2026-11-19' && R.t1.title === 'Today' && R.t1.body === 'Anytime once – due today', 'P1 one-off Anytime task → push rule at reminderAt');
    assert(R.t2 && R.t2.time === '07:30' && R.t2.recur.type === 'daily' && R.t2.skipDates.includes(TODAY), 'P2 recurring Anytime task → daily rule, done day skipped');
    assert(!R.t3 && !R.t4 && !R.t6, 'P3 done one-off / no reminder / timed-with-stale-reminderAt → no Anytime rule');
    assert(R.t5 && R.t5.time === '13:00' && R.t5.title === 'Now' && R.t5.body.startsWith('Timed – 1:00 PM'), 'P4 timed task rule unchanged');
    const occ = await p.evaluate(async () => {
      const N = await import('./js/notify.js');
      return N.reminderOccurrences(new Date(2026, 10, 18, 0, 0).getTime(), new Date(2026, 10, 19, 23, 0).getTime()).filter((o) => /:t:t[12]:/.test(o.key)).map((o) => [o.key.split(':').slice(1).join(':'), new Date(o.at).getHours() + ':' + String(new Date(o.at).getMinutes()).padStart(2, '0'), o.body]);
    });
    assert(occ.some((o) => o[0] === 't:t1:2026-11-19' && o[1] === '6:00') && occ.some((o) => o[0] === 't:t2:2026-11-19' && o[1] === '7:30') && !occ.some((o) => o[0] === 't:t2:2026-11-18'), 'L1 local timers: Anytime reminders at their time; done occurrence skipped (' + JSON.stringify(occ) + ')');
    // Moving later changes the fire time → timer key changes (re-arm)
    const at1 = await p.evaluate(async () => (await import('./js/notify.js')).reminderOccurrences(new Date(2026, 10, 18).getTime(), new Date(2026, 10, 22).getTime()).find((o) => o.key.includes(':t:t1:'))?.at);
    await p.evaluate(async () => { const S = await import('./js/store.js'); S.update((s) => { s.tasks.find((x) => x.id === 't1').reminderAt = '08:00'; }); });
    const at2 = await p.evaluate(async () => (await import('./js/notify.js')).reminderOccurrences(new Date(2026, 10, 18).getTime(), new Date(2026, 10, 22).getTime()).find((o) => o.key.includes(':t:t1:'))?.at);
    assert(at1 && at2 && at2 - at1 === 2 * 3600000, 'L2 changing the reminder time moves the occurrence (re-arm key differs)');
    // Marked missed → skipped
    await p.evaluate(async () => { const S = await import('./js/store.js'); S.update((s) => { s.tasks.find((x) => x.id === 't1').missedDates = { '2026-11-19': true }; }); });
    assert(!(await rules(p)).some((x) => x.id.endsWith(':t:t1')), 'L3 marked missed → no rule');
    const ar = await p.evaluate(async () => (await import('./js/reminders.js')).activeReminders());
    assert(ar.tasks.some((x) => x.id === 't2') && ar.tasks.some((x) => x.id === 't5'), 'L4 Settings count includes Anytime reminders');
    // Import validation
    const norm = await p.evaluate(async () => {
      const S = await import('./js/store.js');
      const t = (o) => ({ id: 'q' + Math.random(), title: 'X', date: '2026-11-18', ...o });
      return S.migrate({ version: 5, tasks: [t({ reminderAt: '09:00' }), t({ reminderAt: '9:00' }), t({ reminderAt: '09:00', time: '10:00' }), t({ reminderAt: 5 })], habits: [] }).tasks.map((x) => x.reminderAt);
    });
    assert(JSON.stringify(norm) === JSON.stringify(['09:00', null, null, null]), 'V1 reminderAt validated on import (' + JSON.stringify(norm) + ')');
    await ctx.close();
  }
  assert(errs.length === 0, 'no console/page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await browser.close();
})();
