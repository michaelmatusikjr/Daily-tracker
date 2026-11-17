const pw = require('./testprep');
(async () => {
  const b = await pw.chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })).newPage();
  await p.goto('http://127.0.0.1:8080/'); await p.waitForTimeout(400);
  await p.click('.ob-skip').catch(() => {});
  const found = [];
  const check = async (where) => { const t = await p.evaluate(() => document.body.innerText); if (/\bnull\b|undefined|NaN/.test(t)) found.push(where); };
  await p.click('.fab'); await p.fill('.qa-input', 'x'); await p.click('text=More options'); await p.waitForTimeout(300); await check('task form'); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await p.goto('http://127.0.0.1:8080/#habits'); await p.click('.fab'); await p.waitForTimeout(300); await check('habit form'); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await p.goto('http://127.0.0.1:8080/#workouts'); await p.click('.fab'); await p.fill('.ex-search', 'Row'); await p.click('.ex-chip.add'); await p.waitForTimeout(200); await check('workout form new'); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  for (const r of ['today', 'workouts', 'calendar', 'stats', 'settings']) { await p.goto('http://127.0.0.1:8080/#' + r); await p.waitForTimeout(250); await check(r); }
  await p.goto('http://127.0.0.1:8080/#today'); await p.click('.avatar-btn'); await p.waitForTimeout(200); await check('profile menu');
  await p.click('.menu-item:has-text("Add profile")'); await p.waitForTimeout(200); await check('profile editor');
  console.log(found.length ? 'FOUND null/undefined/NaN in: ' + found.join(', ') : 'no null/undefined/NaN text anywhere');
  await b.close();
})();
