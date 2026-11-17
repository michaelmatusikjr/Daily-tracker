const __ROOT = require('path').resolve(__dirname, '..');
const { chromium } = require('./testprep');
const fs = require('fs');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://127.0.0.1:8081/Daily-tracker-/');
  await p.waitForFunction(() => navigator.serviceWorker.controller || new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r)));
  console.log('scope', await p.evaluate(async () => (await navigator.serviceWorker.getRegistration()).scope));
  await ctx.setOffline(true);
  await p.reload(); await p.waitForTimeout(800);
  console.log('offline reminders module:', await p.evaluate(async () => (await fetch('js/reminders.js')).status));
  await p.goto('http://127.0.0.1:8081/Daily-tracker-/#stats'); await p.waitForTimeout(500);
  console.log('offline stats page:', await p.locator('.page-title').first().textContent());
  console.log('offline render:', await p.locator('.page-title').first().textContent(), await p.locator('.nav-item').count());
  await ctx.setOffline(false);
  const swPath = (__ROOT + '/sw.js');
  const orig = fs.readFileSync(swPath, 'utf8');
  fs.writeFileSync(swPath, orig.replace(/const VERSION = '([^']+)'/, "const VERSION = '$1-test'"));
  try {
    await p.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await p.waitForSelector('#update-toast.show', { timeout: 10000 });
    console.log('update toast shown');
    await p.screenshot({ path: __dirname + '/m-update.png' });
    await Promise.all([p.waitForEvent('load'), p.click('#update-toast [data-action="reload"]')]);
    await p.waitForTimeout(500);
    console.log('reloaded after update; caches:', await p.evaluate(() => caches.keys()));
  } finally { fs.writeFileSync(swPath, orig); }
  console.log(errs.join('\n') || 'no errors');
  await b.close();
})();
