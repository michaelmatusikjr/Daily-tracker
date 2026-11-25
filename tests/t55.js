// v1.18.0 layout checks (phone size): the pulled-down month calendar and a row mid-swipe fit the screen, the page never scrolls
// sideways. With SHOTS=<dir> it also saves screenshots.
const { chromium, assert, task, habit, base, open, swipe, finish } = require('./h118.js');
const SHOTS = process.env.SHOTS || '';
const data = base({
  tasks: [task('t1', 'Call the dentist', { time: '09:00' }), task('t2', 'Water the plants'), task('t3', 'Pay rent', { priority: 3 })],
  habits: [habit('h1', 'Stretch'), habit('h2', 'Water', { goal: { type: 'count', target: 3, unit: 'glasses' }, order: 2 })],
  logs: { h1: { '2026-11-17': 1, '2026-11-16': 1 }, h2: { '2026-11-17': 3, '2026-11-18': 4 } },
  journal: { '2026-11-12': { mood: 4, note: 'ok', updatedAt: 1 } },
});
(async () => {
  const browser = await chromium.launch();
  const { ctx, p } = await open(browser, { data });
  const overflow = () => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await swipe(p, '.week-strip', 0, { dy: 70 });
  await p.waitForTimeout(400);
  const r = await p.evaluate(() => { const h = document.querySelector('.app-head').getBoundingClientRect(); const g = document.querySelector('.cal-grid').getBoundingClientRect(); return { headB: Math.round(h.bottom), gridL: Math.round(g.left), gridR: Math.round(g.right), w: innerWidth, h: innerHeight }; });
  assert(r.gridL >= 0 && r.gridR <= r.w && r.headB < r.h, `A1 calendar fits the phone: grid ${r.gridL}..${r.gridR} of ${r.w}, header bottom ${r.headB} of ${r.h}`);
  assert((await overflow()) <= 0, 'A2 no sideways scrolling with the calendar open');
  if (SHOTS) await p.screenshot({ path: SHOTS + '/today-calendar-open.png' });
  await p.locator('.cal-grab').click(); await p.waitForTimeout(300);
  await swipe(p, '.task[data-id="t2"] .task-main', 110, { end: false });
  const b = await p.evaluate(() => { const l = document.querySelector('.swipe-under').getBoundingClientRect(); const li = document.querySelector('.task[data-id="t2"]').getBoundingClientRect(); return { l: Math.round(l.left), r: Math.round(l.right), liL: Math.round(li.left), w: innerWidth }; });
  assert(b.l >= 0 && b.r <= b.liL + 1 && (await overflow()) <= 0, `B1 mid-swipe the buttons fill the space the row left (${b.l}..${b.r}, row starts at ${b.liL})`);
  if (SHOTS) await p.screenshot({ path: SHOTS + '/today-row-mid-swipe.png' });
  await p.evaluate(() => { const el = document.querySelector('.task[data-id="t2"] .task-main'); el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, changedTouches: [new Touch({ identifier: 7, target: el, clientX: 200, clientY: 300 })] })); });
  await p.waitForTimeout(400);
  await swipe(p, '.task[data-id="t3"] .task-main', -110, { end: false });
  assert((await overflow()) <= 0, 'B2 no sideways scrolling mid-swipe (left)');
  if (SHOTS) await p.screenshot({ path: SHOTS + '/today-row-mid-swipe-left.png' });
  await ctx.close();
  await browser.close(); finish('t55');
})();
