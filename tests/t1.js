const { chromium } = require('./testprep');
const SP = __dirname;
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text()); });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await p.goto('http://127.0.0.1:8080/');
  await p.waitForTimeout(700);
  await p.screenshot({ path: SP + '/m-onboard.png' });
  await p.click('.ob-next'); await p.waitForTimeout(500);
  await p.click('.ob-next'); await p.waitForTimeout(500);
  await p.screenshot({ path: SP + '/m-onboard3.png' });
  await p.click('.ob-next'); await p.waitForTimeout(500);
  // quick add
  for (const t of ['Gym 6pm for 1h', 'Call mom tomorrow 14:30', 'Buy groceries #errands', 'Standup at 9 for 15m !!', 'Read a chapter', 'Lunch at noon']) {
    await p.click('.fab'); await p.waitForTimeout(350);
    await p.fill('.qa-input', t);
    if (t.startsWith('Standup')) await p.screenshot({ path: SP + '/m-quickadd.png' });
    await p.keyboard.press('Enter'); await p.waitForTimeout(350);
  }
  await p.click('.task .check'); await p.waitForTimeout(300);
  await p.click('.habit-row .habit-check'); await p.waitForTimeout(300);
  await p.click('.habit-count'); await p.click('.habit-count'); await p.waitForTimeout(300);
  console.log('active:', await p.evaluate(() => document.activeElement.outerHTML.slice(0,80)));
  await p.screenshot({ path: SP + '/m-today.png', fullPage: true });
  await p.click('a[href="#habits"].nav-item'); await p.waitForTimeout(400);
  await p.screenshot({ path: SP + '/m-habits.png', fullPage: true });
  await p.click('.habit-open'); await p.waitForTimeout(400);
  await p.screenshot({ path: SP + '/m-detail.png', fullPage: true });
  await p.click('a[href="#calendar"]'); await p.waitForTimeout(400);
  await p.screenshot({ path: SP + '/m-calendar.png', fullPage: true });
  await p.click('a[href="#journal"]'); await p.waitForTimeout(400);
  await p.screenshot({ path: SP + '/m-journal.png', fullPage: true });
  await p.evaluate(() => { location.hash = '#settings'; }); await p.waitForTimeout(400);
  await p.screenshot({ path: SP + '/m-settings.png', fullPage: true });
  await p.click('.segmented button:has-text("Dark")'); await p.waitForTimeout(400);
  await p.click('a[href="#today"]'); await p.waitForTimeout(400);
  await p.screenshot({ path: SP + '/m-today-dark.png', fullPage: true });
  await p.reload(); await p.waitForTimeout(800);
  const info = await p.evaluate(async () => ({
    tasks: document.querySelectorAll('.task').length,
    theme: document.documentElement.dataset.theme,
    sw: !!(await navigator.serviceWorker.getRegistration()),
    ctrl: !!navigator.serviceWorker.controller,
  }));
  console.log(JSON.stringify(info));
  // open edit form
  await p.click('.task-main'); await p.waitForTimeout(400);
  await p.screenshot({ path: SP + '/m-edit-dark.png' });
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await p.click('a[href="#habits"].nav-item'); await p.waitForTimeout(300);
  await p.click('.fab'); await p.waitForTimeout(400);
  await p.screenshot({ path: SP + '/m-habitform-dark.png' });
  console.log(errs.join('\n') || 'no console errors');
  await b.close();
})();
