const { chromium } = require('./testprep');
const SP = __dirname;
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text()); });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('dialog', (d) => { errs.push('DIALOG: ' + d.message()); d.dismiss(); });
  // Seed a past overdue task
  await p.goto('http://127.0.0.1:8080/');
  await p.evaluate(() => localStorage.setItem((localStorage.getItem('dailyTracker:profiles') ? 'dailyTracker:data:' + JSON.parse(localStorage.getItem('dailyTracker:profiles')).activeId : 'dailyTracker:data'), JSON.stringify({ version: 1, settings: { onboarded: true }, tasks: [
    { id: 'old1', title: 'Old unfinished thing', date: '2026-11-05', done: false },
    { id: 'old2', title: 'Another old one', date: '2026-11-08', done: false },
  ], habits: [], logs: {}, journal: {} })));
  await p.reload(); await p.waitForTimeout(500);
  assert(await p.locator('.overdue-card .task').count() === 2, 'overdue shown');
  await p.click('.overdue-card .move-btn'); await p.waitForTimeout(300);
  assert(await p.locator('.overdue-card .task').count() === 1, 'moved one to today');
  // XSS title via quick add
  await p.keyboard.press('n'); await p.waitForTimeout(300);
  await p.fill('.qa-input', '<img src=x onerror=alert(1)> test');
  await p.keyboard.press('Enter'); await p.waitForTimeout(300);
  assert(await p.locator('img[src=x]').count() === 0, 'no XSS injection');
  // Recurring task via full form
  await p.click('.fab'); await p.waitForTimeout(300);
  await p.click('text=More options'); await p.waitForTimeout(300);
  await p.fill('.sheet input[type=text]', 'Daily review');
  await p.fill('.sheet input[type=time]', '17:00');
  await p.selectOption('.sheet select >> nth=2', 'daily');
  await p.screenshot({ path: SP + '/d-form.png' });
  await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(400);
  const row = p.locator('section:not(.future-section) .task', { hasText: 'Daily review' });
  await row.locator('.check').click(); await p.waitForTimeout(300);
  assert(await row.evaluate((e) => e.classList.contains('done')), 'recurring done today');
  await p.click('[aria-label="Next day"]'); await p.waitForTimeout(300);
  const row2 = p.locator('.task', { hasText: 'Daily review' });
  assert(await row2.count() === 1 && !(await row2.evaluate((e) => e.classList.contains('done'))), 'next occurrence not done');
  // delete this day only
  await row2.locator('.task-main').click(); await p.waitForTimeout(300); await p.click('.tv-actions button:has-text("Edit")'); await p.waitForTimeout(300); // 1.7.2: tap opens View task; Edit from there
  await p.click('.sheet-foot .danger-ghost'); await p.waitForTimeout(300);
  await p.click('text=This day only'); await p.waitForTimeout(500);
  assert(await p.locator('.task', { hasText: 'Daily review' }).count() === 0, 'occurrence removed');
  await p.click('[aria-label="Next day"]'); await p.waitForTimeout(300);
  assert(await p.locator('.task', { hasText: 'Daily review' }).count() === 1, 'series continues day after');
  await p.click('.chip-btn:has-text("Today")'); await p.waitForTimeout(300);
  // Habits: create count habit
  await p.click('a[href="#habits"].nav-item'); await p.waitForTimeout(300);
  await p.click('text=Create a habit'); await p.waitForTimeout(300);
  await p.fill('.sheet .habit-name-row input', 'Water');
  await p.click('.sheet .segmented button:has-text("Count")');
  await p.fill('.sheet input[aria-label="Daily target"]', '3');
  await p.fill('.sheet input[aria-label="Unit"]', 'glasses');
  await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(400);
  const cnt = p.locator('.habit-count').first();
  await cnt.click(); await cnt.click(); await cnt.click(); await p.waitForTimeout(300);
  assert(await p.locator('.habit-count.done').count() === 1, 'count habit reached target');
  await p.locator('.habit-open').first().click({ button: 'right' }); await p.waitForTimeout(300); // v1.18: right-click on the counter itself opens the − / + pad
  await p.click('.sheet.action-menu .menu-item:has-text("Remove one")'); await p.waitForTimeout(300);
  assert(await p.locator('.habit-count.done').count() === 0, 'right-click menu › Remove one decrements (1.5.0)');
  // toggle past day dot
  await p.locator('.wd').nth(4).click(); await p.waitForTimeout(300);
  assert(await p.locator('.wd.done').count() >= 1, 'past dot toggled');
  await p.screenshot({ path: SP + '/d-habits.png' });
  await p.click('.habit-open'); await p.waitForTimeout(400);
  await p.screenshot({ path: SP + '/d-detail.png', fullPage: true });
  // Today desktop
  await p.click('a[href="#today"]'); await p.waitForTimeout(400);
  // keyboard reorder anytime
  const before = await p.locator('.tasks:not(.compact) .task-title').allTextContents();
  await p.locator('.tasks:not(.compact) .drag-handle').first().focus();
  await p.keyboard.press('ArrowDown'); await p.waitForTimeout(300);
  const after = await p.locator('.tasks:not(.compact) .task-title').allTextContents();
  assert(before[0] === after[1], 'keyboard reorder');
  await p.click('.fab'); await p.waitForTimeout(300);
  await p.click('.sheet .segmented button:has-text("Journal")'); await p.waitForTimeout(300);
  await p.click('.sheet .mood >> nth=3'); await p.waitForTimeout(200);
  await p.fill('.sheet .journal-note', 'Productive day'); await p.click('.sheet .btn.primary:has-text("Save")'); await p.waitForTimeout(500);
  await p.screenshot({ path: SP + '/d-today.png', fullPage: true });
  await p.evaluate(() => { location.hash = '#calendar'; }); await p.waitForTimeout(300);
  await p.screenshot({ path: SP + '/d-calendar.png' });
  await p.click('a[href="#journal"]'); await p.waitForTimeout(300);
  await p.screenshot({ path: SP + '/d-journal.png', fullPage: true });
  // export
  await p.evaluate(() => { location.hash = '#settings'; }); await p.waitForTimeout(300);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('text=Export JSON')]);
  const path = SP + '/backup.json'; await dl.saveAs(path);
  const data = require(path);
  assert(data.app === 'daily-tracker' && data.profiles[0].data.tasks.length >= 3, 'export ok');
  // reset then import
  await p.click('button:has-text("Reset"):has-text("data")'); await p.waitForTimeout(300);
  await p.click('.sheet .btn.danger'); await p.waitForTimeout(400);
  await p.click('.sheet .btn.danger'); await p.waitForTimeout(400);
  assert((await p.evaluate(() => JSON.parse(localStorage.getItem((localStorage.getItem('dailyTracker:profiles') ? 'dailyTracker:data:' + JSON.parse(localStorage.getItem('dailyTracker:profiles')).activeId : 'dailyTracker:data'))).tasks.length)) === 0, 'reset ok');
  await p.setInputFiles('input[type=file]', path); await p.waitForTimeout(400);
  await p.click('.sheet .btn.danger'); await p.waitForTimeout(400);
  assert((await p.evaluate(() => JSON.parse(localStorage.getItem((localStorage.getItem('dailyTracker:profiles') ? 'dailyTracker:data:' + JSON.parse(localStorage.getItem('dailyTracker:profiles')).activeId : 'dailyTracker:data'))).tasks.length)) >= 3, 'import ok');
  // bad import
  require('fs').writeFileSync(SP + '/bad.json', '{"foo":1}');
  await p.setInputFiles('input[type=file]', SP + '/bad.json'); await p.waitForTimeout(400);
  console.log('toast:', await p.locator('.toast-msg').textContent());
  await p.click('.segmented button:has-text("Dark")'); await p.waitForTimeout(300);
  await p.click('.swatch[aria-label="Teal"]'); await p.waitForTimeout(300);
  await p.screenshot({ path: SP + '/d-settings-dark.png', fullPage: true });
  await p.click('a[href="#today"]'); await p.waitForTimeout(300);
  await p.screenshot({ path: SP + '/d-today-dark.png', fullPage: true });
  console.log('theme-color:', await p.evaluate(() => [...document.querySelectorAll('meta[name=theme-color]')].map((m) => m.content)));
  console.log(errs.join('\n') || 'no console errors');
  await b.close();
})();
