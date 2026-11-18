// v1.7.2: View task sheet.
const { chromium } = require('playwright');
const path = require('path');
const URL = 'http://127.0.0.1:8080/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const NOW = new Date(2026, 10, 18, 10, 0); // Wed Nov 18 2026
const TODAY = '2026-11-18';
const task = (id, title, o = {}) => ({ id, title, notes: '', date: TODAY, time: null, duration: null, priority: 0, category: null, reminder: null, recur: { type: 'none', days: [], interval: 2 }, done: false, doneDates: {}, exceptions: [], order: Number(id.replace(/\D/g, '')) || 1, createdAt: 1, ...o });
const NOTES = 'Bring the form\nSee https://example.org/a?b=1, and http://x.test/path.\njavascript:alert(1) <b>bold</b> <img src=x onerror=window.__pwned=1>';
const seed = () => ({
  version: 4, settings: { onboarded: true, theme: 'light', weekStart: 1, notifications: true, timeFormat: '12' },
  categories: [{ id: 'c1', name: 'Errands', color: '#10b981' }],
  tasks: [
    task('t1', 'Dentist', { time: '15:00', duration: 30, reminder: 15, priority: 3, category: 'c1', notes: NOTES }),
    task('t2', 'Water plants', { date: '2026-11-01', recur: { type: 'daily', days: [], interval: 2 } }),
    task('t3', 'Old errand', { date: '2026-11-15' }),
    task('t4', 'Gave up', { missedDates: { [TODAY]: true } }),
    task('t5', 'Second anytime'),
  ],
  habits: [], logs: {}, journal: {}, exercises: [], workouts: [],
});
async function open(browser, { width = 390, dark = false, data = seed(), second = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 820 }, serviceWorkers: 'block', colorScheme: dark ? 'dark' : 'light' });
  data.settings.theme = dark ? 'dark' : 'light';
  await ctx.addInitScript(([d, q]) => {
    if (localStorage.getItem('dailyTracker:profiles')) return;
    const profiles = [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }];
    if (q) { profiles.push({ id: 'sam', name: 'Sam', avatar: { type: 'emoji', emoji: '', color: '#10b981' } }); localStorage.setItem('dailyTracker:data:sam', q); }
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles }));
    localStorage.setItem('dailyTracker:data:p', d);
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
  }, [JSON.stringify(data), second && JSON.stringify(second)]);
  const p = await ctx.newPage();
  await p.clock.install({ time: NOW });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(URL); await p.waitForTimeout(400);
  return { ctx, p };
}
const stored = (p, id = 'p') => p.evaluate((i) => JSON.parse(localStorage.getItem('dailyTracker:data:' + i)), id);
const viewOpen = (p) => p.locator('.sheet.task-view-sheet').count().then((n) => n === 1);
const viewTitle = (p) => p.textContent('.task-view-sheet .sheet-title');
const esc = async (p) => { await p.keyboard.press('Escape'); await p.waitForTimeout(350); };

(async () => {
  const browser = await chromium.launch();
  const { ctx, p } = await open(browser);

  // ===== Tap opens the view (timeline, Anytime, overdue, Missed) =====
  await p.click('.task:has-text("Dentist") .task-main'); await p.waitForTimeout(400);
  assert(await viewOpen(p) && (await viewTitle(p)) === 'Dentist' && await p.locator('.sheet-title:has-text("Edit task")').count() === 0, 'V1 timeline tap opens View task (not the edit form)');
  const txt = await p.textContent('.task-view');
  assert(txt.includes('Not done') && txt.includes('Today · Wednesday, Nov 18') && txt.includes('3 PM – 3:30 PM') && !txt.includes('null'), 'V2 when: date + time range (app time format), no stray text');
  assert(txt.includes('Urgent priority') || txt.includes('High priority') || /priority/.test(txt), 'V3 priority shown');
  assert(txt.includes('Errands') && txt.includes('Reminder: 15 min before'), 'V3 category chip and reminder');
  const links = await p.$$eval('.tv-notes a', (a) => a.map((x) => [x.getAttribute('href'), x.target, x.rel, x.textContent]));
  assert(JSON.stringify(links) === JSON.stringify([['https://example.org/a?b=1', '_blank', 'noopener noreferrer', 'https://example.org/a?b=1'], ['http://x.test/path', '_blank', 'noopener noreferrer', 'http://x.test/path']]), 'V4 notes: http(s) links only, safe rel/target, trailing punctuation kept out: ' + JSON.stringify(links));
  const notesTxt = await p.textContent('.tv-notes');
  assert(notesTxt.includes('javascript:alert(1) <b>bold</b> <img src=x onerror=window.__pwned=1>') && await p.locator('.tv-notes b, .tv-notes img').count() === 0 && await p.locator('.tv-notes br').count() === 2 && !(await p.evaluate(() => window.__pwned)), 'V5 notes: HTML stays text, javascript: not linked, line breaks kept');
  assert(await p.evaluate(() => document.activeElement?.classList.contains('sheet-title')) && (await p.getAttribute('.task-view-sheet', 'aria-labelledby')) !== null, 'V6 dialog labelled by the title; focus on the title');
  await esc(p);
  assert(await p.evaluate(() => document.activeElement?.closest('.task')?.textContent.includes('Dentist')), 'V6 focus returns to the row');
  await p.click('.task:has-text("Second anytime") .task-main'); await p.waitForTimeout(400);
  assert(await viewOpen(p) && (await viewTitle(p)) === 'Second anytime', 'V7 Anytime tap opens the view'); await esc(p);
  await p.click('.overdue-card .task-main'); await p.waitForTimeout(400);
  assert(await viewOpen(p) && (await viewTitle(p)) === 'Old errand' && (await p.textContent('.task-view')).includes('Overdue'), 'V8 overdue row opens the view (with an Overdue line)'); await esc(p);
  await p.click('.missed-section .collapse-btn'); await p.waitForTimeout(250);
  await p.click('.missed-item:has-text("Gave up")'); await p.waitForTimeout(400);
  assert(await viewOpen(p) && (await p.textContent('.task-view')).includes('Marked as missed'), 'V9 Missed list opens the view (Missed line)'); await esc(p);
  // Keyboard
  await p.locator('.task:has-text("Second anytime") .task-main').focus(); await p.keyboard.press('Enter'); await p.waitForTimeout(400);
  assert(await viewOpen(p), 'V10 Enter on a focused row opens the view'); await esc(p);
  await p.locator('.task:has-text("Second anytime") .task-main').focus(); await p.keyboard.press(' '); await p.waitForTimeout(400);
  assert(await viewOpen(p), 'V10 Space too'); await esc(p);

  // ===== Checkbox and long-press unchanged =====
  await p.click('.task:has-text("Second anytime") .check'); await p.waitForTimeout(300);
  assert((await stored(p)).tasks.find((x) => x.id === 't5').done && !(await viewOpen(p)), 'K1 checkbox still toggles directly');
  await p.click('.task:has-text("Second anytime") .check'); await p.waitForTimeout(300);
  await p.click('.task:has-text("Dentist") .task-main', { button: 'right' }); await p.waitForTimeout(300);
  assert(await p.locator('.sheet.action-menu').count() === 1 && !(await viewOpen(p)), 'K2 long-press/right-click still opens the menu'); await esc(p);

  // ===== Mark done in place; recurring: only that occurrence =====
  await p.click('.task:has-text("Water plants") .task-main'); await p.waitForTimeout(400);
  await p.click('.tv-done'); await p.waitForTimeout(300);
  let st = await stored(p);
  const wp = st.tasks.find((x) => x.id === 't2');
  assert(JSON.stringify(wp.doneDates) === JSON.stringify({ [TODAY]: true }) && (await p.textContent('.tv-state')).startsWith('Done') && (await p.textContent('.tv-done')).includes('Mark not done'), 'D1 recurring: Mark done affects only this occurrence; view updates in place');
  assert(!(await p.textContent('#toasts')).includes('Undo'), 'D1 completing shows no toast (the view updates in place)');
  await p.click('.tv-done'); await p.waitForTimeout(300);
  assert(!(await stored(p)).tasks.find((x) => x.id === 't2').doneDates[TODAY] && (await p.textContent('.tv-state')).startsWith('Not done'), 'D2 Mark not done');
  await esc(p);

  // ===== Edit → save returns to the view =====
  await p.click('.task:has-text("Dentist") .task-main'); await p.waitForTimeout(400);
  await p.click('.tv-actions button:has-text("Edit")'); await p.waitForTimeout(400);
  assert((await p.textContent('.sheet-root:last-child .sheet-title')) === 'Edit task', 'E1 Edit opens the edit form');
  await p.fill('.sheet-root:last-child input[placeholder="What do you need to do?"]', 'Dentist (moved)');
  await p.click('.sheet-root:last-child .sheet-foot .btn.primary'); await p.waitForTimeout(500);
  assert(await viewOpen(p) && (await viewTitle(p)) === 'Dentist (moved)' && await p.locator('.sheet-root').count() === 1, 'E2 after saving, back on the view with the new title');

  // ===== More → actions =====
  const more = async (label) => { await p.click('.tv-actions button:has-text("More")'); await p.waitForTimeout(300); await p.click(`.sheet.action-menu .menu-item:has-text("${label}")`); await p.waitForTimeout(400); };
  await more('Mark as missed');
  assert(await viewOpen(p) && (await p.textContent('.task-view')).includes('Marked as missed'), 'M1 More › Mark as missed (view stays, updates)');
  await more('Unmark missed');
  assert(!(await p.textContent('.task-view')).includes('Marked as missed'), 'M2 More › Unmark missed');
  await more('Duplicate');
  assert((await stored(p)).tasks.filter((x) => x.title === 'Dentist (moved)').length === 2 && await viewOpen(p), 'M3 More › Duplicate');
  await more('Move to tomorrow');
  assert((await p.textContent('.task-view')).includes('Tomorrow · Thursday, Nov 19') && (await stored(p)).tasks.find((x) => x.id === 't1').date === '2026-11-19', 'M4 More › Move to tomorrow (view follows the date)');
  await more('Delete');
  assert(!(await viewOpen(p)) && (await p.textContent('#toasts')).includes('Deleted') && !(await stored(p)).tasks.some((x) => x.id === 't1'), 'M5 More › Delete closes the view with the usual Undo toast');
  await p.click('#toasts .toast-action'); await p.waitForTimeout(300);
  // Skip this day for recurring
  await p.click('.task:has-text("Water plants") .task-main'); await p.waitForTimeout(400);
  await more('Skip this day');
  assert((await stored(p)).tasks.find((x) => x.id === 't2').exceptions.includes(TODAY), 'M6 More › Skip this day (recurring)');
  await esc(p);

  // ===== Delete from the edit form opened from the view: view closes, Undo toast kept =====
  await p.click('.task:has-text("Old errand") .task-main'); await p.waitForTimeout(400);
  await p.click('.tv-actions button:has-text("Edit")'); await p.waitForTimeout(400);
  await p.click('.sheet-root:last-child .sheet-foot .danger-ghost'); await p.waitForTimeout(500);
  assert(!(await viewOpen(p)) && await p.locator('.sheet-root').count() === 0 && (await p.textContent('#toasts')).includes('Deleted “Old errand”') && await p.locator('#toasts .toast-action').count() === 1, 'X0 deleting from the edit form closes both sheets and keeps the Undo toast');
  await p.click('#toasts .toast-action'); await p.waitForTimeout(300);

  // ===== Deleted in another tab closes the sheet =====
  await p.click('.task:has-text("Second anytime") .task-main'); await p.waitForTimeout(400);
  const p2 = await ctx.newPage(); await p2.goto(URL + 'icons/icon.svg');
  await p2.evaluate(() => { const d = JSON.parse(localStorage.getItem('dailyTracker:data:p')); d.tasks = d.tasks.filter((x) => x.id !== 't5'); localStorage.setItem('dailyTracker:data:p', JSON.stringify(d)); });
  await p.waitForTimeout(800);
  assert(!(await viewOpen(p)) && (await p.textContent('#toasts')).includes('That task was deleted.'), 'X1 deleted in another tab → sheet closes with a toast');
  await p2.close();

  // ===== New tasks still open the edit form =====
  await p.click('.fab'); await p.waitForTimeout(300);
  assert(!(await viewOpen(p)), 'N1 FAB opens quick add, not the view'); await esc(p);
  await ctx.close();

  // ===== Deep links (push / local notifications) =====
  {
    const sam = seed(); sam.tasks = [task('s1', 'Sam’s dentist', { date: '2026-12-03', time: '09:00', reminder: 0 }), task('s2', 'Sam daily', { date: '2026-11-01', recur: { type: 'daily', days: [], interval: 2 } })];
    const { ctx: c2, p: q } = await open(browser, { second: sam });
    await q.evaluate(() => { location.hash = '#open/task/sam/s1/2026-12-03'; }); await q.waitForTimeout(900);
    assert(await q.evaluate(() => JSON.parse(localStorage.getItem('dailyTracker:profiles')).activeId) === 'sam' && (await q.textContent('#toasts')).includes('Switched to Sam'), 'L1 deep link switches to the right profile');
    assert(await viewOpen(q) && (await viewTitle(q)) === 'Sam’s dentist' && (await q.textContent('.page-title')).includes('Dec 3') && await q.locator('.task[data-id="s1"].pulse').count() === 1 && await q.evaluate(() => location.hash) === '#today', 'L2 opens the View sheet on that date, row highlighted behind it, hash cleaned');
    await esc(q);
    // Local-notification style deep link for a recurring occurrence
    await q.evaluate(() => navigator.serviceWorker?.dispatchEvent?.(new MessageEvent('message', { data: { type: 'OPEN_URL', url: location.origin + '/#open/task/sam/s2/2026-11-20' } })) || (location.hash = '#open/task/sam/s2/2026-11-20'));
    await q.waitForTimeout(900);
    assert(await viewOpen(q) && (await q.textContent('.task-view')).includes('showing Nov 20'), 'L3 recurring occurrence opens for that date');
    await esc(q);
    await q.evaluate(() => { location.hash = '#open/task/sam/gone/2026-12-03'; }); await q.waitForTimeout(700);
    assert(!(await viewOpen(q)) && (await q.textContent('#toasts')).includes('That reminder’s item was deleted.'), 'L4 deleted item behaviour unchanged');
    await c2.close();
  }

  // ===== 320 light/dark =====
  for (const dark of [false, true]) {
    const { ctx: c3, p: q } = await open(browser, { width: 320, dark });
    await q.click('.task:has-text("Dentist") .task-main'); await q.waitForTimeout(500);
    const fits = await q.evaluate(() => { const s = document.querySelector('.task-view-sheet'); return s.scrollWidth <= s.clientWidth + 1 && document.documentElement.scrollWidth <= document.documentElement.clientWidth; });
    assert(fits, `Y 320 ${dark ? 'dark' : 'light'}: view sheet fits`);
    await q.screenshot({ path: path.join(__dirname, `l21-view-${dark ? 'dark' : 'light'}.png`) });
    await c3.close();
  }

  console.log(errs.join('\n') || 'no console errors');
  await browser.close();
})();
