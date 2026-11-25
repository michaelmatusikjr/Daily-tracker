// v1.18.0 #39: swipe actions on task/habit rows (Today and Habits): partial reveals two buttons, tap either, a full swipe
// runs the outer action, cancel animates back, vertical scroll untouched, day swipe elsewhere still works; Settings choose actions.
const { chromium, assert, task, habit, base, open, stored, go, swipe, finish } = require('./h118.js');
const mk = (swipeCfg) => base({
  settings: { onboarded: true, theme: 'light', accent: 'indigo', weekStart: 1, timeFormat: '12', notifications: false, ...(swipeCfg ? { swipe: swipeCfg } : {}) },
  tasks: [task('t1', 'Alpha'), task('t2', 'Beta'), task('t3', 'Gamma'), task('t4', 'Delta')],
  habits: [habit('h1', 'Stretch')],
});
const dateOf = (p) => p.evaluate(() => document.querySelector('.title-long')?.textContent);
(async () => {
  const browser = await chromium.launch();
  {
    const { ctx, p } = await open(browser, { data: mk() });
    const t1 = '.task[data-id="t1"]';
    // partial right swipe: two buttons (outer View details at the far edge, inner Complete next to the row)
    await swipe(p, t1 + ' .task-main', 100);
    const labels = await p.locator(t1 + ' .swipe-under.side-right .sw-btn').allInnerTexts();
    assert(labels.length === 2 && labels[0] === 'Details' && labels[1] === 'Complete', 'A1 right partial reveals [Details (outer), Complete (inner)]: ' + labels);
    assert(await p.locator(t1).evaluate((e) => e.style.transform) === 'translateX(152px)', 'A2 row settles open');
    assert((await dateOf(p)) === 'Wednesday, Nov 18' || /Nov 18/.test(await dateOf(p)), 'A3 the day did not change');
    await p.locator(t1 + ' .sw-complete').click(); await p.waitForTimeout(300);
    assert((await stored(p)).tasks.find((t) => t.id === 't1').done === true, 'A4 tapping the inner button completes');
    assert((await p.locator('.swipe-under').count()) === 0, 'A5 row closed afterwards');
    // partial left: Edit (inner), Missed (outer)
    const t2 = '.task[data-id="t2"]';
    await swipe(p, t2 + ' .task-main', -100);
    const l2 = await p.locator(t2 + ' .swipe-under.side-left .sw-btn').allInnerTexts();
    assert(l2.length === 2 && l2[0] === 'Edit' && l2[1] === 'Missed', 'B1 left partial reveals [Edit (inner), Missed (outer)]: ' + l2);
    await p.locator(t2 + ' .sw-edit').click(); await p.waitForTimeout(500);
    assert((await p.locator('.sheet-title').first().innerText()) === 'Edit task', 'B2 inner button runs Edit');
    await p.keyboard.press('Escape'); await p.waitForTimeout(400);
    await swipe(p, t2 + ' .task-main', -100);
    await p.locator(t2 + ' .sw-missed').click(); await p.waitForTimeout(300);
    assert((await stored(p)).tasks.find((t) => t.id === 't2').missedDates?.['2026-11-18'] === true, 'B3 outer button marks missed');
    // full swipes
    const t3 = '.task[data-id="t3"]';
    await swipe(p, t3 + ' .task-main', 260);
    assert((await p.locator('.task-view-sheet').count()) === 1, 'C1 full right swipe runs the outer action: View details');
    await p.keyboard.press('Escape'); await p.waitForTimeout(400);
    assert((await p.locator('.swipe-under').count()) === 0 && !(await p.locator(t3).evaluate((e) => e.style.transform)), 'C2 row back in place after a full swipe');
    await swipe(p, t3 + ' .task-main', -260);
    assert((await stored(p)).tasks.find((t) => t.id === 't3').missedDates?.['2026-11-18'] === true, 'C3 full left swipe marks missed (outer)');
    // cancel
    const t4 = '.task[data-id="t4"]';
    await swipe(p, t4 + ' .task-main', 20);
    assert(!(await p.locator(t4).evaluate((e) => e.style.transform)) && (await p.locator('.swipe-under').count()) === 0, 'D1 a short swipe animates back (nothing runs)');
    assert(!(await stored(p)).tasks.find((t) => t.id === 't4').done, 'D2 nothing changed');
    // open row closes on a tap elsewhere
    await swipe(p, t4 + ' .task-main', 100);
    assert((await p.locator('.swipe-under').count()) === 1, 'D3 open');
    await p.evaluate(() => document.querySelector('.task[data-id="t1"] .task-main').dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [new Touch({ identifier: 1, target: document.body, clientX: 10, clientY: 10 })] })));
    await p.waitForTimeout(450);
    assert(!(await p.locator(t4).evaluate((e) => e.style.transform)), 'D4 touching elsewhere closes the open row');
    // vertical gesture: no swipe
    await swipe(p, t4 + ' .task-main', 6, { dy: 60 });
    assert((await p.locator('.swipe-under').count()) === 0 && !(await p.locator(t4).evaluate((e) => e.style.transform)), 'E1 vertical movement does not swipe the row');
    // a swipe starting elsewhere still changes the day
    await swipe(p, '.section-title', -120, { startX: 0.1 });
    assert(/Nov 19/.test(await dateOf(p)), 'F1 swiping elsewhere still changes the day: ' + await dateOf(p));
    await ctx.close();
  }
  {
    // Habits on Today + the Habits tab (acts on today), a row swipe doesn't change the day
    const { ctx, p } = await open(browser, { data: mk() });
    await swipe(p, '.habit-row[data-id="h1"] .habit-row-main', 100);
    await p.locator('.habit-row[data-id="h1"] .sw-complete').click(); await p.waitForTimeout(300);
    assert((await stored(p)).logs.h1?.['2026-11-18'] === 1, 'G1 habit row: Complete');
    assert(/Nov 18/.test(await dateOf(p)), 'G2 day unchanged');
    await go(p, '#habits');
    await swipe(p, '.habit-card[data-id="h1"] .habit-open', 100);
    const lab = await p.locator('.habit-card[data-id="h1"] .sw-btn').allInnerTexts();
    assert(lab[1] === 'Not done', 'G3 Habits tab: done habit offers "Not done" for the inner action: ' + lab);
    await p.locator('.habit-card[data-id="h1"] .sw-complete').click(); await p.waitForTimeout(300);
    assert(!(await stored(p)).logs.h1?.['2026-11-18'], 'G4 Habits tab swipe acts on today');
    await swipe(p, '.habit-card[data-id="h1"] .habit-open', 260);
    assert(/#habit\/h1/.test(await p.evaluate(() => location.hash)), 'G5 full right swipe on a habit card: View details');
    await ctx.close();
  }
  {
    // Settings: custom actions, delete with Undo, "Off"
    const cfg = { right: { inner: 'off', outer: 'delete' }, left: { inner: 'off', outer: 'off' } };
    const { ctx, p } = await open(browser, { data: mk(cfg) });
    await swipe(p, '.task[data-id="t1"] .task-main', 100);
    assert((await p.locator('.task[data-id="t1"] .sw-btn').count()) === 1, 'H1 only the enabled action shows');
    await p.locator('.task[data-id="t1"] .task-main').evaluate((e) => e); // keep focus
    await swipe(p, '.task[data-id="t1"] .task-main', 100); // closes? (already open) then reopen
    await p.waitForTimeout(300);
    await p.mouse.click(5, 5).catch(() => {});
    await swipe(p, '.task[data-id="t2"] .task-main', 260);
    assert(!(await stored(p)).tasks.some((t) => t.id === 't2'), 'H2 full swipe runs Delete');
    assert((await p.locator('#toasts .toast', { hasText: 'Deleted' }).count()) === 1, 'H3 with an Undo toast');
    await p.locator('#toasts .toast-action').click(); await p.waitForTimeout(300);
    assert((await stored(p)).tasks.some((t) => t.id === 't2'), 'H4 Undo restores it');
    await swipe(p, '.task[data-id="t3"] .task-main', -120, { startX: 0.5 });
    assert(/Nov 19/.test(await dateOf(p)), 'H5 a side set to Off: the swipe changes the day instead');
    await go(p, '#settings');
    const sel = p.locator('select[data-side="left"][data-pos="outer"]');
    assert((await sel.inputValue()) === 'off' && (await p.locator('select.swipe-select').count()) === 4, 'I1 Settings shows four swipe selects');
    await sel.selectOption('details'); await p.waitForTimeout(300);
    assert((await stored(p)).settings.swipe.left.outer === 'details' && (await stored(p)).settings.swipe.right.outer === 'delete', 'I2 choice saved per side/position');
    await ctx.close();
  }
  await browser.close(); finish('t51');
})();
