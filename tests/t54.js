// v1.18.0 #43: the focused text box always sits above the on-screen keyboard. The keyboard is emulated the way iOS does it:
// the layout viewport keeps its height and only window.visualViewport shrinks. For many fields across the app the focused
// field must end up fully inside the visible area, sheets must end above the keyboard, and the page must not jump afterwards.
const { chromium, assert, task, habit, base, open, finish } = require('./h118.js');
const KB = 400; // px of keyboard on a 667 px tall phone (iPhone SE size): 267 px stay visible
const data = base({
  tasks: Array.from({ length: 10 }, (_, i) => task('t' + (i + 1), 'Task ' + (i + 1))),
  habits: [habit('h1', 'Stretch')],
});
const setKb = (p, kb) => p.evaluate((kb) => {
  const vv = window.visualViewport;
  Object.defineProperty(vv, 'height', { configurable: true, get: () => window.innerHeight - kb });
  vv.dispatchEvent(new Event('resize'));
}, kb);
const measure = (p, sel) => p.evaluate((sel) => {
  const el = document.querySelector(sel); const r = el.getBoundingClientRect();
  const vvh = window.visualViewport.height, sheet = el.closest('.sheet');
  const sb = sheet ? sheet.getBoundingClientRect().bottom : null;
  const foot = sheet?.querySelector('.sheet-foot')?.getBoundingClientRect().bottom ?? null;
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), vvh, sheetBottom: sb && Math.round(sb), footBottom: foot && Math.round(foot), kb: document.documentElement.classList.contains('kb-open'), active: document.activeElement === el };
}, sel);

(async () => {
  const browser = await chromium.launch();
  const checked = [];
  /** open(): JS run in the page; sel: the field to focus; before(): optional page setup. */
  async function place(name, openJs, sel, o = {}) {
    try { await place1(name, openJs, sel, o); } catch (e) { assert(false, `${name}: ${String(e.message).split('\n')[0]}`); }
  }
  async function place1(name, openJs, sel, { setup = null, after = null, hash = '', d = data } = {}) {
    const { ctx, p } = await open(browser, { data: d, height: 667, hash });
    if (setup) await setup(p);
    await p.evaluate(openJs); await p.waitForTimeout(700);
    if (after) await after(p);
    await p.evaluate((sel) => { const e = document.querySelector(sel); e.scrollIntoView({ block: 'center' }); }, sel).catch(() => {});
    await p.evaluate((sel) => document.querySelector(sel).focus(), sel);
    await p.waitForTimeout(100);
    await setKb(p, KB); await p.waitForTimeout(900);
    const m = await measure(p, sel);
    const ok = m.active && m.kb && m.top >= 0 && m.bottom <= m.vvh && (m.sheetBottom === null || m.sheetBottom <= m.vvh + 1) && (m.footBottom === null || m.footBottom <= m.vvh + 1);
    assert(ok, `${name}: field ${m.top}..${m.bottom} inside 0..${m.vvh}${m.sheetBottom !== null ? `, sheet bottom ${m.sheetBottom}` : ''}${m.footBottom ? `, footer ${m.footBottom}` : ''}, kb class ${m.kb}`);
    checked.push(name);
    await ctx.close();
  }
  const imp = (mod, call) => `(async () => { const m = await import('./js/${mod}'); ${call} })()`;
  await place('Quick add', imp('forms.js', 'm.openQuickAdd();'), '.sheet input, .sheet textarea');
  await place('New habit: name', imp('forms.js', 'm.openHabitForm(null);'), '.sheet input[placeholder^="e.g. Drink"]');
  await place('New habit: unit (below the fold)', imp('forms.js', 'm.openHabitForm(null);'), '.sheet input[aria-label="Unit"]', {
    after: (p) => p.locator('.sheet [role="radio"], .sheet .seg-btn', { hasText: 'Count' }).first().click() });
  await place('New task: notes', imp('forms.js', 'm.openTaskForm(null);'), '.sheet textarea');
  await place('New task: title', imp('forms.js', 'm.openTaskForm(null);'), '.sheet input[type=text]');
  await place('Journal entry', imp('journalForm.js', 'm.openJournalForm("2026-11-18");'), '.sheet textarea');
  await place('Log workout', imp('workoutForm.js', 'm.openWorkoutForm(null);'), '.sheet input');
  await place('Invite someone: name', imp('invites.js', 'm.openInviteSheet();'), '.sheet input[aria-label="Friend’s name"]');
  await place('Add profile: name', imp('profiles.js', 'm.openProfileEditor(null);'), '.sheet input[type=text]');
  await place('Create account (invite): username', imp('account.js', 'm.openCreateWithInvite({ code: "ABCD-EFGH", onDone() {}, onCancel() {} });'), '.sheet input[autocomplete="username"], .sheet input[type=text]');
  await place('Create account (invite): password', imp('account.js', 'm.openCreateWithInvite({ code: "ABCD-EFGH", onDone() {}, onCancel() {} });'), '.sheet input[type=password]');
  await place('Add weather location', imp('weatherUi.js', 'm.openAddLocation();'), '.sheet input');
  await place('Settings: new category (page)', '0', 'input[aria-label="New category name"]', { hash: '#settings' });
  await place('Settings: push server URL (page)', 'document.querySelector("details.push-advanced").open = true', 'details.push-advanced input', { hash: '#settings' });
  await place('Journal tab: search (header)', '0', '.journal-search', { hash: '#journal', d: { ...data, journal: { '2026-11-17': { mood: 3, note: 'hello', updatedAt: 1 } } } });
  await place('Completed: search (header)', '0', '.completed-search input, .view input[type=search], .view input', { hash: '#completed' });
  await place('First-run welcome screen', '0', '.onboarding input', { d: base({ settings: { onboarded: false, theme: 'light', accent: 'indigo', weekStart: 1, timeFormat: '12', notifications: false } }) });
  await place('Setup wizard (invite): code', imp('onboarding.js', 'm.startInviteFlow({});'), '.onboarding input', { d: base({ settings: { onboarded: true, theme: 'light', accent: 'indigo', weekStart: 1, timeFormat: '12', notifications: false } }) });

  // page must not jump when the keyboard closes
  {
    const { ctx, p } = await open(browser, { data, height: 667, hash: '#settings' });
    await p.evaluate(() => { const e = document.querySelector('input[aria-label="New category name"]'); e.scrollIntoView({ block: 'end' }); e.focus(); });
    await p.waitForTimeout(200);
    const y1 = await p.evaluate(() => window.scrollY);
    await setKb(p, KB); await p.waitForTimeout(900);
    const y2 = await p.evaluate(() => window.scrollY);
    await p.evaluate(() => document.activeElement.blur()); await setKb(p, 0); await p.waitForTimeout(800);
    const y3 = await p.evaluate(() => window.scrollY);
    assert(y2 > y1 && Math.abs(y3 - y1) <= 2, `J1 page scrolled to reveal the field (${y1} → ${y2}) and returned when the keyboard closed (${y3})`);
    assert(!(await p.evaluate(() => document.documentElement.classList.contains('kb-open'))), 'J2 kb-open class removed');
    await ctx.close();
  }
  // no keyboard (desktop / hardware): nothing changes
  {
    const { ctx, p } = await open(browser, { data, height: 667, hash: '#settings', touch: false });
    await p.evaluate(() => document.querySelector('input[aria-label="New category name"]').focus()); await p.waitForTimeout(700);
    assert(!(await p.evaluate(() => document.documentElement.classList.contains('kb-open'))), 'K1 no keyboard: no kb-open, no layout change');
    await ctx.close();
  }
  console.log('places checked: ' + checked.join('; '));
  await browser.close(); finish('t54');
})();
