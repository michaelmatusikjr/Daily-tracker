const { chromium } = require('./testprep');
const SP = __dirname;
const URL = 'http://127.0.0.1:8080/';
const KEY = 'dailyTracker:data';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };

(async () => {
  const b = await chromium.launch();
  const errs = [];
  for (const width of [320, 375]) {
    const ctx = await b.newContext({ viewport: { width, height: 700 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const p = await ctx.newPage(); await p.clock.install({ time: new Date(2026, 10, 10, 15, 0) }); // tests assume "today" is Tue 2026-11-10
    p.on('pageerror', (e) => errs.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await p.goto(URL);
    await p.evaluate((k) => localStorage.setItem((localStorage.getItem('dailyTracker:profiles') ? 'dailyTracker:data:' + JSON.parse(localStorage.getItem('dailyTracker:profiles')).activeId : 'dailyTracker:data'), JSON.stringify({ version: 1, settings: { onboarded: true }, tasks: [], habits: [
      { id: 'p', name: 'Gym sessions with a long name', emoji: '🏃', color: '#ef4444', goal: { type: 'check' }, schedule: { type: 'perWeek', times: 3 }, timeOfDay: 'morning', createdAt: '2026-11-01' },
    ], logs: {}, journal: {} })), KEY);
    await p.reload(); await p.waitForTimeout(400);
    await p.click('[aria-label="Next day"]'); await p.waitForTimeout(200);
    const t = await p.locator('.page-title .title-short').isVisible() ? await p.locator('.title-short').textContent() : await p.locator('.title-long').textContent();
    const lines = await p.locator('.page-title').evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
    assert(t === 'Wed, Nov 11' && lines === 1, `N4 ${width}px non-today title short, one line ("${t}", ${lines} line)`);
    await p.screenshot({ path: `${SP}/n4-${width}.png` });
    await p.evaluate(async () => (await import('./js/ctx.js')).ctx.setDate('2026-12-11'));
    const eb = await p.locator('.eyebrow').textContent();
    assert(eb === 'In 31 days' && (await p.locator('.title-short').textContent()) === 'Fri, Dec 11', `3a ${width}px eyebrow differs from title (${eb})`);
    await p.evaluate(async () => (await import('./js/ctx.js')).ctx.setDate('2027-01-20'));
    assert((await p.locator('.eyebrow').textContent()) === 'In 71 days · 2027', '3a year shown when it differs');
    await p.setViewportSize({ width: 800, height: 700 }); await p.waitForTimeout(100);
    assert(await p.locator('.title-long').isVisible() && !(await p.locator('.title-short').isVisible()), '3c title swaps on resize (CSS)');
    await p.setViewportSize({ width, height: 700 });
    await p.evaluate(async () => (await import('./js/ctx.js')).ctx.setDate('2026-11-11'));
    await p.click('.chip-btn:has-text("Today")'); await p.waitForTimeout(200);
    const sub = await p.locator('.habit-row .sub-text').textContent();
    assert(sub.startsWith('3 left this week'), 'N7 weekly progress first (1.8.0: “N left this week”): ' + sub);
    await ctx.close();
  }

  const ctx = await b.newContext({ viewport: { width: 390, height: 700 }, hasTouch: true, isMobile: true, acceptDownloads: true });
  const p = await ctx.newPage(); await p.clock.install({ time: new Date(2026, 10, 10, 15, 0) }); // tests assume "today" is Tue 2026-11-10
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(URL);
  const backups = () => p.evaluate(() => Object.keys(localStorage).filter((k) => k.includes(':backup-')).length);
  // N6: three older distinct backups exist, then a new bad value; repeated reloads add only one
  await p.evaluate((k) => {
    for (let i = 1; i <= 3; i++) localStorage.setItem(`${(localStorage.getItem('dailyTracker:profiles') ? 'dailyTracker:data:' + JSON.parse(localStorage.getItem('dailyTracker:profiles')).activeId : 'dailyTracker:data')}:backup-${1000 + i}`, 'old' + i);
    localStorage.setItem((localStorage.getItem('dailyTracker:profiles') ? 'dailyTracker:data:' + JSON.parse(localStorage.getItem('dailyTracker:profiles')).activeId : 'dailyTracker:data'), '{broken');
  }, KEY);
  for (let i = 0; i < 3; i++) { await p.reload(); await p.waitForTimeout(300); }
  assert(await backups() === 3, 'N6 no duplicate backups, newest 3 kept');
  assert(await p.evaluate(() => Object.keys(localStorage).some((k) => k.endsWith(':backup-1001'))) === false, 'N6 oldest pruned');
  // N5: scroll down, reload → back at top with the card visible and a toast
  await p.evaluate(() => { document.body.style.minHeight = '3000px'; window.scrollTo(0, 800); });
  await p.reload(); await p.waitForTimeout(700);
  assert(await p.evaluate(() => window.scrollY) === 0, 'N5 starts at the top');
  assert(await p.locator('.load-fail').isVisible(), 'N5 card visible');
  assert((await p.locator('.takeover').textContent()).includes('couldn’t be read'), 'N5 takeover shown');
  await p.keyboard.press('Escape'); await p.waitForTimeout(350);
  await p.click('.load-fail .danger-ghost'); await p.waitForTimeout(300);
  await p.click('.sheet .btn.danger'); await p.waitForTimeout(400);
  assert(await backups() === 1, 'N6 backups cleaned to the latest after reset');

  // N8 preview: tap the date guess to keep the words in the title
  await p.click('.fab'); await p.waitForTimeout(300);
  await p.fill('.qa-input', 'Call mom tomorrow 3pm');
  await p.screenshot({ path: `${SP}/n8-preview.png` });
  await p.click('.pchip.guess >> nth=0'); await p.waitForTimeout(150);
  assert((await p.locator('.qa-title').textContent()).includes('Call mom tomorrow'), 'N8 date guess dropped → title keeps words');
  assert(await p.locator('.pchip.restore').count() === 1, 'N8 restore chip offered');
  await p.screenshot({ path: `${SP}/n8-dropped.png` });
  await p.keyboard.press('Enter'); await p.waitForTimeout(300);
  const task = await p.evaluate((k) => JSON.parse(localStorage.getItem(localStorage.getItem('dailyTracker:profiles') ? 'dailyTracker:data:' + JSON.parse(localStorage.getItem('dailyTracker:profiles')).activeId : k)).tasks[0], KEY);
  assert(task.title === 'Call mom tomorrow' && task.time === '15:00' && task.date === '2026-11-10', 'N8 saved without the date guess');
  // 1: dropping the time on "Monday gym 6pm" keeps the Monday date and offers restore
  await p.click('.fab'); await p.waitForTimeout(300);
  await p.fill('.qa-input', 'Monday gym 6pm');
  await p.click('.pchip.guess:has-text("6 PM")'); await p.waitForTimeout(150);
  const chipsTxt = await p.locator('.qa-preview').textContent();
  assert(chipsTxt.includes('Monday') && chipsTxt.includes('“6pm” as time'), '1 date kept + time restore chip: ' + chipsTxt);
  assert((await p.locator('.qa-title').textContent()).includes('gym 6pm'), '1 title keeps "6pm"');
  await p.click('.pchip.restore'); await p.waitForTimeout(150);
  assert((await p.locator('.qa-preview').textContent()).includes('6 PM'), '1 restore brings the time back');
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  console.log(errs.join('\n') || 'no console errors');
  await b.close();
})();
