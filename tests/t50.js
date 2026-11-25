// v1.18.0 #36–#38: count habits. Past-day dots add one per tap (even past the goal), "+N" badge over the goal
// (Today rows and Habits dots), long-press on a counter opens a − / + / Done pad (row long-press still opens the menu).
const { chromium, assert, habit, base, open, stored, go, hold, finish } = require('./h118.js');
(async () => {
  const browser = await chromium.launch();
  const water = habit('h1', 'Water', { goal: { type: 'count', target: 3, unit: 'glasses' }, order: 1 });
  const read = habit('h2', 'Read', { order: 2 });
  const data = base({ habits: [water, read], logs: { h1: { '2026-11-18': 4, '2026-11-17': 3, '2026-11-16': 1 }, h2: { '2026-11-16': 1 } } });
  {
    const { ctx, p } = await open(browser, { data, hash: '#habits' });
    const dots = '.habit-card[data-id="h1"] .wd';
    assert((await p.locator(dots).count()) === 7, 'A0 seven dots');
    // idx: 6 = Nov 18 (today), 5 = Nov 17, 4 = Nov 16
    assert(await p.locator(dots).nth(6).locator('.over-badge').innerText() === '+1', 'A1 today over the goal: dot shows +1');
    assert((await p.locator(dots).nth(5).locator('.over-badge').count()) === 0 && await p.locator(dots).nth(5).evaluate((e) => e.classList.contains('done')), 'A2 at the goal: filled, no badge');
    await p.locator(dots).nth(4).click(); await p.waitForTimeout(200);
    assert((await stored(p)).logs.h1['2026-11-16'] === 2, 'A3 tapping a past-day dot adds one (1 → 2), not "done"');
    await p.locator(dots).nth(4).click(); await p.locator(dots).nth(4).click(); await p.waitForTimeout(200);
    assert((await stored(p)).logs.h1['2026-11-16'] === 4, 'A4 taps keep counting past the goal (→ 4)');
    assert(await p.locator(dots).nth(4).locator('.over-badge').innerText() === '+1', 'A5 badge +1 at goal + 1');
    await p.locator(dots).nth(4).click(); await p.waitForTimeout(200);
    assert(await p.locator(dots).nth(4).locator('.over-badge').innerText() === '+2', 'A6 badge +2 at goal + 2');
    // check habit dot still toggles
    const rd = '.habit-card[data-id="h2"] .wd';
    await p.locator(rd).nth(4).click(); await p.waitForTimeout(150);
    assert(!(await stored(p)).logs.h2?.['2026-11-16'], 'A7 check habit: dot toggles the day off');
    // long-press a past-day dot: pad with − / + / Done
    await p.evaluate(() => document.querySelector('.habit-card[data-id="h1"] .wd:nth-child(5)').setAttribute('id', 'lp-dot'));
    await hold(p, '#lp-dot');
    assert((await p.locator('.counter-pad').count()) === 1, 'B1 long-press on a dot opens the pad');
    assert((await p.locator('.action-menu').count()) === 0, 'B2 not the item menu');
    assert((await stored(p)).logs.h1['2026-11-16'] === 5, 'B3 the long-press did not also add one');
    await p.locator('.counter-pad .cp-minus').click(); await p.waitForTimeout(150);
    assert((await stored(p)).logs.h1['2026-11-16'] === 4, 'B4 − removes one (past day)');
    await p.locator('.counter-pad .cp-plus').click(); await p.locator('.counter-pad .cp-plus').click(); await p.waitForTimeout(150);
    assert((await stored(p)).logs.h1['2026-11-16'] === 6 && (await p.locator('.counter-pad .cp-value').innerText()) === '6/3', 'B5 + adds; pad shows 6/3');
    await p.locator('.counter-pad .cp-done').click(); await p.waitForTimeout(150);
    assert((await p.locator('.counter-pad').count()) === 0, 'B6 Done closes the pad');
    // today's counter on the Habits tab
    await p.evaluate(() => document.querySelector('.habit-card[data-id="h1"] .habit-count').setAttribute('id', 'lp-cnt'));
    await hold(p, '#lp-cnt');
    assert((await p.locator('.counter-pad').count()) === 1, 'B7 long-press on the counter opens the pad');
    await p.locator('.counter-pad .cp-done').click();
    // long-press on the card elsewhere still opens the item menu
    await hold(p, '.habit-card[data-id="h1"] .habit-open');
    assert((await p.locator('.action-menu').count()) === 1, 'B8 long-press elsewhere on the row opens the item menu');
    await ctx.close();
  }
  {
    const { ctx, p } = await open(browser, { data });
    const row = '.habit-row[data-id="h1"]';
    assert(await p.locator(row + ' .habit-count .over-badge').innerText() === '+1', 'C1 Today row: +1 badge, ring filled with check');
    assert((await p.locator(row + ' .habit-count.done').count()) === 1, 'C2 counter stays done above the goal');
    assert((await p.locator('.habit-row[data-id="h2"] .over-badge').count()) === 0, 'C3 no badge on a check habit');
    await p.evaluate(() => document.querySelector('.habit-row[data-id="h1"] .habit-count').setAttribute('id', 'lp-cnt'));
    await hold(p, '#lp-cnt');
    assert((await p.locator('.counter-pad').count()) === 1 && (await p.locator('.action-menu').count()) === 0, 'D1 Today: long-press the counter opens the pad, not the menu');
    await p.locator('.counter-pad .cp-minus').click(); await p.waitForTimeout(200);
    assert((await stored(p)).logs.h1['2026-11-18'] === 3 && (await p.locator(row + ' .over-badge').count()) === 0, 'D2 − back to the goal: badge gone');
    await p.locator('.counter-pad .cp-done').click(); await p.waitForTimeout(150);
    await hold(p, row + ' .habit-row-main');
    assert((await p.locator('.action-menu').count()) === 1, 'D3 Today: long-press on the row opens the item menu');
    await ctx.close();
  }
  await browser.close(); finish('t50');
})();
