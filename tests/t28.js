// v1.11.0 #17: habit target time ("complete by") + "time running out" warning + v4→v5 migration.
const { chromium } = require('playwright');
const URL = 'http://127.0.0.1:8080/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const NOW = new Date(2026, 10, 18, 10, 0); // Wed Nov 18 2026
const TODAY = '2026-11-18';
const habit = (id, name, o = {}) => ({ id, name, emoji: '✅', color: '#6366f1', schedule: { type: 'daily', days: [], times: 3 }, goal: { type: 'check', target: 1, unit: '' }, reminder: null, archived: false, order: Number(id.replace(/\D/g, '')) || 1, createdAt: '2026-11-01', ...o });
const base = (o = {}) => ({ version: 5, settings: { onboarded: true, theme: 'light', weekStart: 1, notifications: true }, categories: [], tasks: [], habits: [], logs: {}, journal: {}, exercises: [], workouts: [], ...o });

async function open(browser, { data = base(), clock = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 820 }, serviceWorkers: 'block' });
  await ctx.addInitScript((d) => {
    if (localStorage.getItem('dailyTracker:profiles')) return;
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles: [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }] }));
    localStorage.setItem('dailyTracker:data:p', d);
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
  }, JSON.stringify(data));
  const p = await ctx.newPage();
  if (clock) await p.clock.install({ time: NOW });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(URL); await p.waitForTimeout(400);
  return { ctx, p };
}
const go = (p, hash) => p.evaluate((x) => { location.hash = x; }, hash).then(() => p.waitForTimeout(350));
const stored = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('dailyTracker:data:p')));
const rules = (p) => p.evaluate(async (today) => (await import('./js/push.js')).buildRules({ hideText: false, today }).rules, TODAY);

(async () => {
  const browser = await chromium.launch();

  // ===== Migration v4 → v5 =====
  {
    const v4 = base({ version: 4, habits: [
      habit('h1', 'A', { timeOfDay: 'anytime' }), habit('h2', 'M', { timeOfDay: 'morning' }),
      habit('h3', 'N', { timeOfDay: 'afternoon' }), habit('h4', 'E', { timeOfDay: 'evening' }), habit('h5', 'Old', {}),
    ] });
    const { ctx, p } = await open(browser, { data: v4 });
    const st = await stored(p);
    const t = Object.fromEntries(st.habits.map((x) => [x.id, x.target]));
    assert(st.version === 6, 'M1 stored data upgraded to schema 6');
    assert(t.h1 === null && t.h2 === '12:00' && t.h3 === '17:00' && t.h4 === '21:00' && t.h5 === null, 'M2 anytime/morning/afternoon/evening → null/12:00/17:00/21:00 (' + JSON.stringify(t) + ')');
    assert(st.habits.every((x) => !('timeOfDay' in x)), 'M3 timeOfDay dropped');
    assert(st.settings.habitWarnDefault === 30 && st.settings.taskDefaults.on === true && st.settings.taskDefaults.anytimeReminderTime === '06:00', 'M4 new profile settings defaulted');
    // Import of an older backup (single and multi-profile) goes through the same migration.
    const imp = await p.evaluate(async (d) => {
      const S = await import('./js/store.js');
      const single = S.validateImport({ app: 'daily-tracker', data: d });
      const multi = S.validateImport({ app: 'daily-tracker', profiles: [{ id: 'x', name: 'X', data: d }] });
      let bad = null; try { S.validateImport({ app: 'daily-tracker', data: { ...d, version: 99 } }); } catch (e) { bad = e.message; }
      return { s: single.data.habits.map((x) => x.target), m: multi.profiles[0].data.habits.map((x) => x.target), bad };
    }, v4);
    assert(JSON.stringify(imp.s) === JSON.stringify([null, '12:00', '17:00', '21:00', null]) && JSON.stringify(imp.m) === JSON.stringify(imp.s), 'M5 v4 single + multi-profile backups import with converted targets');
    assert(imp.bad && /newer/.test(imp.bad), 'M6 a newer-version backup is still refused');
    // Validation of bad values
    const norm = await p.evaluate(async () => {
      const S = await import('./js/store.js');
      const hb = (o) => ({ id: 'z' + Math.random(), name: 'Z', ...o });
      const d = S.migrate({ version: 5, settings: { habitWarnDefault: -5, taskDefaults: { on: 'yes', anytimeReminderTime: '25:99' } }, tasks: [], habits: [hb({ target: '9:00', warn: 10 }), hb({ target: '09:00', warn: 15 }), hb({ target: '09:00', warn: 0 }), hb({ target: '09:00', warn: -1 }), hb({ target: '09:00', warn: 1.5 }), hb({ target: '09:00' }), hb({ warn: 20 })] });
      return { w: d.habits.map((x) => [x.target, x.warn]), s: d.settings };
    });
    assert(norm.w[0][0] === null && norm.w[1][1] === 15 && norm.w[2][1] === 0 && norm.w[3][1] == null && norm.w[4][1] == null && norm.w[5][1] == null && norm.w[6][1] == null && norm.w[6][0] === null, 'N1 target must be HH:MM; warn keeps only non-negative integers and only with a target');
    assert(norm.s.habitWarnDefault === 30 && norm.s.taskDefaults.on === true && norm.s.taskDefaults.anytimeReminderTime === '06:00', 'N2 invalid settings fall back to defaults');
    await ctx.close();
  }

  // ===== Habit form: Complete by + warning =====
  {
    const { ctx, p } = await open(browser, { data: base() });
    await go(p, 'habits');
    await p.click('button[aria-label="New habit"]'); await p.waitForTimeout(400);
    const sheet = '.sheet-root:last-child';
    assert(await p.locator(`${sheet} :text("Time of day")`).count() === 0 && await p.locator(`${sheet} :text("Morning")`).count() === 0, 'F1 Morning/Afternoon/Evening chips are gone');
    assert(await p.locator(`${sheet} input[aria-label="Complete by"]`).isHidden() && await p.locator(`${sheet} :text("Warn me before")`).count() > 0 && await p.locator(`${sheet} select`).first().isHidden(), 'F2 Anytime by default: no time picker, no warning control');
    await p.fill(`${sheet} input[type=text]`, 'Floss');
    await p.click(`${sheet} button:has-text("By a time")`);
    await p.fill(`${sheet} input[aria-label="Complete by"]`, '08:00');
    const opts = await p.locator(`${sheet} select option`).allTextContents();
    assert(opts[0] === 'Default (30 min)' && opts.includes('5 min before') && opts.includes('2 hours before') && opts[opts.length - 1] === 'None', 'F3 warn choices: Default (30 min) / 5..2 hours / None (' + opts.join('|') + ')');
    await p.click(`${sheet} .sheet-foot .btn.primary`); await p.waitForTimeout(500);
    let st = await stored(p);
    let f = st.habits.find((x) => x.name === 'Floss');
    assert(f.target === '08:00' && f.warn === undefined, 'F4 saved target 08:00 and follows the default warning');
    // Edit: explicit 15 min, then None
    await go(p, 'habit/' + f.id);
    await p.click('button[aria-label="Edit habit"]'); await p.waitForTimeout(400);
    await p.selectOption(`${sheet} select`, '15');
    await p.click(`${sheet} .sheet-foot .btn.primary`); await p.waitForTimeout(400);
    f = (await stored(p)).habits.find((x) => x.name === 'Floss');
    assert(f.warn === 15, 'F5 explicit 15 minutes stored');
    await p.click('button[aria-label="Edit habit"]'); await p.waitForTimeout(400);
    await p.selectOption(`${sheet} select`, 'none');
    await p.click(`${sheet} .sheet-foot .btn.primary`); await p.waitForTimeout(400);
    f = (await stored(p)).habits.find((x) => x.name === 'Floss');
    assert(f.warn === 0 && f.target === '08:00', 'F6 "None" stored as warn 0');
    assert((await p.textContent('.detail-hero')).includes('Complete by 8 AM'), 'F7 detail view shows Complete by');
    // Switching back to Anytime clears target and warn
    await p.click('button[aria-label="Edit habit"]'); await p.waitForTimeout(400);
    await p.click(`${sheet} button:has-text("Anytime")`);
    await p.click(`${sheet} .sheet-foot .btn.primary`); await p.waitForTimeout(400);
    f = (await stored(p)).habits.find((x) => x.name === 'Floss');
    assert(f.target === null && !('warn' in f), 'F8 back to Anytime: target null, warn removed');
    await ctx.close();
  }

  // ===== Habits tab ordering =====
  {
    const hs = [habit('h1', 'Any one', { order: 1 }), habit('h2', 'Late', { order: 2, target: '21:00' }), habit('h3', 'Early', { order: 3, target: '07:30' })];
    const { ctx, p } = await open(browser, { data: base({ habits: hs }) });
    await go(p, 'habits');
    const names = await p.locator('.habit-card .habit-name').allTextContents();
    assert(JSON.stringify(names) === JSON.stringify(['Early', 'Late', 'Any one']), 'H1 Habits tab: timed habits by target time, Anytime last (' + names.join(',') + ')');
    assert((await p.textContent('.habit-card:has-text("Early")')).includes('by 7:30 AM'), 'H2 target shown on the card');
    await ctx.close();
  }

  // ===== Warning rules (push) and local occurrences =====
  {
    const hs = [
      habit('h1', 'Floss', { target: '08:00' }),                       // default warn 30 → 07:30
      habit('h2', 'Stretch', { target: '09:00', warn: 60, reminder: '07:00' }), // own 60 + a normal reminder
      habit('h3', 'Quiet', { target: '10:00', warn: 0 }),             // explicit none
      habit('h4', 'Early', { target: '00:10' }),                      // would be before 00:00 → skipped
      habit('h5', 'Anytime', { reminder: '06:00' }),                  // anytime keeps reminder
      habit('h6', 'Weekly', { target: '20:00', schedule: { type: 'perWeek', days: [], times: 1 } }),
    ];
    const { ctx, p } = await open(browser, { data: base({ habits: hs, logs: { h1: { [TODAY]: 1 }, h6: { [TODAY]: 1 } } }) });
    const r = await rules(p);
    const byId = Object.fromEntries(r.map((x) => [x.id.split(':').slice(1).join(':'), x]));
    assert(byId['hw:h1']?.time === '07:30' && byId['hw:h1'].title === '30 min left' && byId['hw:h1'].body === 'Floss – complete by 8:00 AM', 'R1 default 30 min → 07:30 "30 minutes left to floss"');
    assert(byId['hw:h2']?.time === '08:00' && byId['hw:h2'].title === '1 hr left' && byId['hw:h2'].body === 'Stretch – complete by 9:00 AM' && !byId['h:h2'], 'R2 own 60 min → "1 hour left"; a legacy time-of-day reminder is ignored');
    assert(!byId['hw:h3'] && !byId['hw:h4'], 'R3 warn none / before midnight → no rule');
    assert(!byId['hw:h5'] && !byId['h:h5'], 'R4 Anytime habit with a legacy reminder: no rules');
    assert(byId['hw:h1'].skipDates.includes(TODAY), 'R5 done today → warning skipped for today (skipDates)');
    assert(byId['hw:h1'].kind === 'habit' && byId['hw:h1'].offsetDays === 0 && byId['hw:h1'].recur.type === 'daily' && /^\.\/#open\/habit\//.test(byId['hw:h1'].url) && byId['hw:h1'].tag.includes('hw:h1'), 'R6 rule shape reuses the habit rule');
    assert(byId['hw:h6']?.skipDates.includes('2026-11-19') && byId['hw:h6'].skipDates.includes('2026-11-22'), 'R7 weekly habit with target met: rest of the week skipped');
    // A missed habit is skipped too
    await p.evaluate(async () => { const S = await import('./js/store.js'); S.update((s) => { s.habits.find((x) => x.id === 'h2').missed = { '2026-11-18': true }; }); });
    const r2 = await rules(p);
    assert(r2.find((x) => x.id.endsWith(':hw:h2')).skipDates.includes(TODAY), 'R8 marked missed → warning skipped');
    // Profile default
    await p.evaluate(async () => { const S = await import('./js/store.js'); S.update((s) => { s.settings.habitWarnDefault = 15; }); });
    assert((await rules(p)).find((x) => x.id.endsWith(':hw:h1')).time === '07:45', 'R9 changing the profile default moves the warning (15 min → 07:45)');
    await p.evaluate(async () => { const S = await import('./js/store.js'); S.update((s) => { s.settings.habitWarnDefault = 0; }); });
    const r3 = await rules(p);
    assert(!r3.some((x) => x.id.endsWith(':hw:h1')) && r3.some((x) => x.id.endsWith(':hw:h2')), 'R10 default off → only habits with their own warning keep one');
    await p.evaluate(async () => { const S = await import('./js/store.js'); S.update((s) => { s.settings.habitWarnDefault = 30; }); });
    // Local timers path
    const occ = await p.evaluate(async () => {
      const N = await import('./js/notify.js');
      return N.reminderOccurrences(new Date(2026, 10, 18, 0, 0).getTime(), new Date(2026, 10, 19, 23, 0).getTime()).filter((o) => /:hw:/.test(o.key)).map((o) => [o.key, new Date(o.at).getHours() + ':' + new Date(o.at).getMinutes(), o.title, o.body]);
    });
    const tomorrowFloss = occ.find((o) => o[0].endsWith('hw:h1:2026-11-19'));
    assert(tomorrowFloss && tomorrowFloss[1] === '7:30' && tomorrowFloss[2] === '30 min left' && tomorrowFloss[3] === 'Floss – complete by 8:00 AM', 'L1 local occurrence: 7:30 "30 minutes left to floss"');
    assert(!occ.some((o) => o[0].endsWith('hw:h1:2026-11-18')), 'L2 done today → no local warning today');
    assert(occ.some((o) => o[0].endsWith('hw:h2:2026-11-19')) && !occ.some((o) => o[0].endsWith('hw:h2:2026-11-18')), 'L3 missed today skipped, tomorrow kept');
    // Text helpers
    const fmts = await p.evaluate(async () => { const D = await import('./js/dates.js'); return [1, 5, 30, 60, 90, 120].map(D.fmtSpan); });
    assert(JSON.stringify(fmts) === JSON.stringify(['1 minute', '5 minutes', '30 minutes', '1 hour', '1 hour 30 minutes', '2 hours']), 'L4 time-left wording (' + fmts.join('|') + ')');
    await ctx.close();
  }

  // ===== Settings: default warning =====
  {
    const { ctx, p } = await open(browser, { data: base({ habits: [habit('h1', 'Floss', { target: '08:00' })] }) });
    await go(p, 'settings');
    assert(await p.inputValue('#set-habit-warn') === '30', 'S1 Settings shows the default warning (30 min)');
    await p.selectOption('#set-habit-warn', '0');
    assert((await stored(p)).settings.habitWarnDefault === 0, 'S2 Off stored as 0');
    await p.selectOption('#set-habit-warn', '60');
    assert((await stored(p)).settings.habitWarnDefault === 60, 'S3 1 hour stored');
    await ctx.close();
  }

  assert(errs.length === 0, 'no console/page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await browser.close();
})();
