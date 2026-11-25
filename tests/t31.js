// v1.12.0 #14: Journal tab + entries added from "+", read-only entry on Today, Habits/Workouts sub-tabs, Stats tab removed.
const { chromium } = require('playwright');
const URL = 'http://127.0.0.1:8080/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [];
const NOW = new Date(2026, 10, 18, 10, 0); // Wed Nov 18 2026
const TODAY = '2026-11-18', YEST = '2026-11-17';
const habit = (id, name, o = {}) => ({ id, name, emoji: '✅', color: '#6366f1', schedule: { type: 'daily', days: [] }, goal: { type: 'check', target: 1, unit: '' }, reminder: null, target: null, archived: false, order: Number(id.replace(/\D/g, '')) || 1, createdAt: '2026-11-01', ...o });
const base = (o = {}) => ({ version: 6, settings: { onboarded: true, theme: 'light', weekStart: 1 }, categories: [], tasks: [], habits: [], logs: {}, journal: {}, exercises: [], workouts: [], ...o });
const seed = () => base({
  habits: [habit('h1', 'Floss'), habit('h2', 'Read')],
  logs: { h1: { [TODAY]: 1, [YEST]: 1 }, h2: { [YEST]: 1 } },
  journal: {
    [YEST]: { mood: 4, note: 'Quiet day with <b>bold</b> plans', updatedAt: 5 },
    '2026-11-14': { mood: 5, note: 'Great hike with Sam', updatedAt: 4 },
    '2026-10-02': { mood: null, note: 'Rainy morning', updatedAt: 3 },
    '2025-12-25': { mood: 3, note: '', updatedAt: 2 },
  },
  exercises: [{ id: 'sq', name: 'Squat', type: 'strength' }],
  workouts: [{ id: 'w1', date: '2026-11-10', exerciseId: 'sq', lines: [{ weight: 185, sets: 3, reps: 5 }], weightUnit: 'lb', time: null, distance: null, distanceUnit: 'mi', note: '', createdAt: 1 }],
});

async function open(browser, data = seed(), { width = 390 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: 'block', hasTouch: true });
  await ctx.addInitScript((d) => {
    if (localStorage.getItem('dailyTracker:profiles')) return;
    localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'p', profiles: [{ id: 'p', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }] }));
    localStorage.setItem('dailyTracker:data:p', d);
    localStorage.setItem('dailyTracker:tips', '{"settingsMoved":true,"itemMenu":true}');
  }, JSON.stringify(data));
  // The weather line isn't under test here: keep the network out of it.
  await ctx.route(/open-meteo\.com|bigdatacloud\.net|nominatim\.openstreetmap\.org/, (r) => r.abort());
  const p = await ctx.newPage();
  await p.clock.install({ time: NOW });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push(m.text()); });
  await p.goto(URL); await p.waitForTimeout(400);
  const cdp = await ctx.newCDPSession(p);
  return { ctx, p, cdp };
}
const go = (p, hash) => p.evaluate((x) => { location.hash = x; }, hash).then(() => p.waitForTimeout(350));
const stored = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('dailyTracker:data:p')));
const center = async (p, sel) => { await p.locator(sel).first().evaluate((e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(50); const b = await p.locator(sel).first().boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
async function hold(p, cdp, sel, ms = 650) {
  const { x, y } = await center(p, sel);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await p.waitForTimeout(ms);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await p.waitForTimeout(350);
}
const menuItems = (p) => p.$$eval('.sheet.action-menu .menu-item', (e) => e.map((x) => x.textContent.trim()));
const pick = async (p, label) => { await p.click(`.sheet.action-menu .menu-item:has-text("${label}")`); await p.waitForTimeout(300); };
const undo = async (p) => { await p.click('#toasts .toast-action'); await p.waitForTimeout(250); };

(async () => {
  const browser = await chromium.launch();

  // ===== Today: no collapsible journal box; add from + =====
  {
    const { ctx, p, cdp } = await open(browser, base());
    assert(await p.locator('.journal-head, .journal-body').count() === 0, 'A1 no collapsible journal box on Today');
    assert(await p.locator('.journal-entry').count() === 0, 'A2 nothing shown when the day has no entry');
    await p.click('.fab'); await p.waitForTimeout(300);
    const modes = await p.$$eval('.sheet .segmented button', (b) => b.map((x) => x.textContent.trim()));
    assert(modes.includes('Journal'), 'A3 quick add offers a Journal option: ' + modes.join(','));
    await p.click('.sheet .segmented button:has-text("Journal")'); await p.waitForTimeout(350);
    assert((await p.textContent('.sheet-title')).includes('Nov 18'), 'A4 journal sheet is for the selected date');
    assert(await p.locator('.sheet textarea[maxlength="1000"]').count() === 1 && await p.locator('.sheet .mood').count() === 5, 'A5 5-mood picker + 1000-char note');
    // Saving an empty entry creates nothing
    await p.click('.sheet .btn.primary:has-text("Save")'); await p.waitForTimeout(350);
    assert(Object.keys((await stored(p)).journal).length === 0, 'A6 empty save creates no entry');
    await p.click('.fab'); await p.waitForTimeout(300);
    await p.click('.sheet .segmented button:has-text("Journal")'); await p.waitForTimeout(350);
    await p.click('.sheet .mood[aria-label="Good"]');
    await p.fill('.sheet textarea', 'Shipped the release');
    await p.click('.sheet .btn.primary:has-text("Save")'); await p.waitForTimeout(400);
    const j = (await stored(p)).journal[TODAY];
    assert(j && j.mood === 4 && j.note === 'Shipped the release', 'A7 entry saved for today');
    assert((await p.textContent('.journal-entry')).includes('Shipped the release') && (await p.textContent('.journal-entry')).includes('🙂'), 'A8 Today shows the entry (mood + note)');
    assert(await p.locator('.journal-entry textarea, .journal-entry input').count() === 0, 'A9 entry card is read-only');
    // + again for the same date edits the existing entry
    await p.click('.fab'); await p.waitForTimeout(300);
    await p.click('.sheet .segmented button:has-text("Journal")'); await p.waitForTimeout(350);
    assert(await p.inputValue('.sheet textarea') === 'Shipped the release' && await p.locator('.sheet .mood[aria-checked="true"]').getAttribute('aria-label') === 'Good', 'A10 + on a day with an entry edits it');
    await p.fill('.sheet textarea', 'Shipped it'); await p.click('.sheet .btn.primary:has-text("Save")'); await p.waitForTimeout(350);
    assert((await stored(p)).journal[TODAY].note === 'Shipped it' && Object.keys((await stored(p)).journal).length === 1, 'A11 edit replaces (one entry per date)');
    // Tap opens edit
    await p.click('.journal-entry .journal-open'); await p.waitForTimeout(350);
    assert(await p.inputValue('.sheet textarea') === 'Shipped it', 'A12 tapping the entry opens it for editing');
    // Clearing both mood and note then saving deletes (with Undo)
    await p.click('.sheet .mood[aria-checked="true"]'); await p.fill('.sheet textarea', ''); await p.click('.sheet .btn.primary:has-text("Save")'); await p.waitForTimeout(350);
    assert(!(await stored(p)).journal[TODAY] && await p.locator('.journal-entry').count() === 0, 'A13 saving an emptied entry deletes it');
    await undo(p);
    assert((await stored(p)).journal[TODAY]?.note === 'Shipped it', 'A14 …and Undo brings it back');
    // Long-press menu
    await hold(p, cdp, '.journal-entry .journal-open');
    assert((await menuItems(p)).join('|') === 'Edit|Delete', 'A15 long-press menu: Edit, Delete: ' + (await menuItems(p)).join('|'));
    await pick(p, 'Edit');
    assert(await p.locator('.sheet textarea').count() === 1 && await p.inputValue('.sheet textarea') === 'Shipped it', 'A16 menu Edit opens the sheet');
    await p.keyboard.press('Escape'); await p.waitForTimeout(350);
    await hold(p, cdp, '.journal-entry .journal-open'); await pick(p, 'Delete');
    assert(!(await stored(p)).journal[TODAY], 'A17 menu Delete removes the entry');
    assert(/Undo/.test(await p.textContent('#toasts')), 'A18 delete shows an Undo toast');
    await undo(p);
    assert((await stored(p)).journal[TODAY]?.mood === 4, 'A19 Undo restores mood and note');
    // Delete button inside the edit sheet
    await p.click('.journal-entry .journal-open'); await p.waitForTimeout(300);
    await p.click('.sheet .btn:has-text("Delete")'); await p.waitForTimeout(350);
    assert(!(await stored(p)).journal[TODAY], 'A20 Delete button in the edit sheet');
    await ctx.close();
  }

  // ===== Past days show the entry read-only; days without one show nothing =====
  {
    const { ctx, p } = await open(browser);
    await p.click('button[aria-label="Previous day"]'); await p.waitForTimeout(350);
    const t = await p.textContent('.journal-entry');
    assert(t.includes('Quiet day with <b>bold</b> plans') && t.includes('🙂'), 'B1 yesterday’s entry shown read-only (HTML shown as text)');
    assert(await p.locator('.journal-entry b').count() === 0, 'B2 note text is never parsed as HTML');
    await p.click('button[aria-label="Previous day"]'); await p.waitForTimeout(350);
    assert(await p.locator('.journal-entry').count() === 0, 'B3 a day without an entry shows nothing');
    await ctx.close();
  }

  // ===== Journal tab =====
  {
    const { ctx, p, cdp } = await open(browser);
    const nav = await p.$$eval('#nav .nav-item', (a) => a.map((x) => x.textContent.trim() + ':' + getComputedStyle(x).display));
    assert(nav.filter((x) => !x.endsWith('none')).map((x) => x.split(':')[0]).join(',') === 'Today,Habits,Workouts,Calendar,Journal', 'C1 tab bar order: ' + nav.join(','));
    assert(await p.locator('a[href="#stats"]').count() === 0, 'C2 no Stats tab / link');
    await p.click('#nav a[href="#journal"]'); await p.waitForTimeout(350);
    assert((await p.textContent('h1.page-title')) === 'Journal', 'C3 Journal tab opens');
    const rows = await p.$$eval('.journal-item', (r) => r.map((x) => x.querySelector('.journal-date').textContent.trim()));
    assert(rows.join('|') === 'Tue, Nov 17|Sat, Nov 14|Fri, Oct 2|Thu, Dec 25, 2025', 'C4 newest first, short month names: ' + rows.join('|'));
    const first = await p.textContent('.journal-item');
    assert(first.includes('Quiet day with <b>bold</b> plans') && first.includes('🙂') && await p.locator('.journal-item b').count() === 0, 'C5 row shows mood + note as text');
    assert((await p.textContent('.journal-item:last-child')).includes('Feeling okay'), 'C6 mood-only entry still readable');
    await p.fill('.journal-search', 'HIKE'); await p.waitForTimeout(450);
    assert(await p.locator('.journal-item').count() === 1 && (await p.textContent('.journal-item')).includes('Great hike'), 'C7 search filters note text (case-insensitive)');
    await p.fill('.journal-search', 'nope-nothing'); await p.waitForTimeout(450);
    assert(await p.locator('.journal-item').count() === 0 && /No entries match/.test(await p.textContent('.view-journal')), 'C8 no-match message');
    await p.fill('.journal-search', ''); await p.waitForTimeout(450);
    // Tap → edit sheet; edit from the list
    await p.click('.journal-item[data-date="2026-11-14"] .journal-open'); await p.waitForTimeout(350);
    assert(await p.inputValue('.sheet textarea') === 'Great hike with Sam' && (await p.textContent('.sheet-title')).includes('Nov 14'), 'C9 tap opens edit sheet for that date');
    await p.fill('.sheet textarea', 'Great hike'); await p.click('.sheet .btn.primary:has-text("Save")'); await p.waitForTimeout(350);
    assert((await stored(p)).journal['2026-11-14'].note === 'Great hike', 'C10 edit from the tab saves');
    // Long-press delete + undo
    await hold(p, cdp, '.journal-item[data-date="2026-10-02"] .journal-open');
    assert((await menuItems(p)).join('|') === 'Edit|Delete', 'C11 long-press menu on a row');
    await pick(p, 'Delete');
    assert(!(await stored(p)).journal['2026-10-02'] && await p.locator('.journal-item').count() === 3, 'C12 delete removes the row');
    await undo(p);
    assert((await stored(p)).journal['2026-10-02']?.note === 'Rainy morning' && await p.locator('.journal-item').count() === 4, 'C13 Undo restores it');
    // + on the Journal tab adds an entry for today
    await p.click('.fab'); await p.waitForTimeout(350);
    assert(await p.locator('.sheet textarea').count() === 1 && (await p.textContent('.sheet-title')).includes('Nov 18'), 'C14 + on Journal opens a journal sheet for today');
    await p.fill('.sheet textarea', 'From the tab'); await p.click('.sheet .btn.primary:has-text("Save")'); await p.waitForTimeout(350);
    assert((await p.textContent('.journal-item')).includes('From the tab'), 'C15 new entry listed first');
    // Old #stats bookmarks fall back to Today
    await go(p, '#stats');
    assert((await p.textContent('h1.page-title')).includes('Nov') && await p.locator('.progress-card').count() === 1, 'C16 #stats falls back to Today');
    await ctx.close();
  }
  {
    const { ctx, p } = await open(browser, base());
    await go(p, '#journal');
    assert(/No journal entries yet/.test(await p.textContent('.view-journal')) && await p.locator('.journal-search').count() === 0, 'C17 empty state');
    await ctx.close();
  }

  // ===== Habits sub-tabs =====
  {
    const { ctx, p } = await open(browser);
    await go(p, '#habits');
    assert(await p.locator('.page-head .icon-btn[aria-label="New habit"]').count() === 0, 'D1 no "+" at the top of Habits');
    assert(await p.locator('.fab').getAttribute('aria-label') === 'New habit', 'D2 bottom + stays');
    const tabs = await p.$$eval('[role=tablist] [role=tab]', (t) => t.map((x) => x.textContent.trim() + ':' + x.getAttribute('aria-selected')));
    assert(tabs.join(',') === 'Active habits:true,Stats:false', 'D3 tabs: ' + tabs.join(','));
    assert(await p.locator('.habit-card').count() === 2, 'D4 Active habits lists habits');
    await p.click('[role=tab]:has-text("Stats")'); await p.waitForTimeout(350);
    assert(await p.locator('.habit-card').count() === 0 && /Habit check-ins/.test(await p.textContent('.view-habits')) && /Floss/.test(await p.textContent('.rate-list')), 'D5 Stats tab shows habit stats');
    assert(!/Daily completion|Best day of the week|This week|Your progress/.test(await p.textContent('.view-habits')), 'D6 general stats are gone');
    await go(p, '#calendar'); await go(p, '#habits');
    assert(await p.locator('[role=tab][aria-selected=true]').textContent() === 'Stats', 'D7 sub-tab remembered while navigating');
    await p.focus('[role=tab][aria-selected=true]'); await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(350);
    assert(await p.locator('[role=tab][aria-selected=true]').textContent() === 'Active habits' && await p.evaluate(() => document.activeElement.getAttribute('role')) === 'tab', 'D8 arrow keys switch tabs and keep focus');
    await p.keyboard.press('End'); await p.waitForTimeout(350);
    assert(await p.locator('[role=tab][aria-selected=true]').textContent() === 'Stats', 'D9 End key selects the last tab');
    assert(await p.locator('[role=tab][tabindex="0"]').count() === 1 && await p.locator('[role=tabpanel]').count() === 1, 'D10 roving tabindex + tabpanel');
    await ctx.close();
  }
  {
    const { ctx, p } = await open(browser, base());
    await go(p, '#habits'); await p.click('[role=tab]:has-text("Stats")'); await p.waitForTimeout(300);
    assert(/No habit stats yet/.test(await p.textContent('.view-habits')), 'D11 Stats empty state');
    await ctx.close();
  }

  // ===== Workouts sub-tabs =====
  {
    const { ctx, p } = await open(browser);
    await go(p, '#workouts');
    assert(await p.locator('.log-btn').count() === 0, 'E1 no "Log workout" button at the top');
    assert(await p.locator('.fab').getAttribute('aria-label') === 'Log workout', 'E2 bottom + stays');
    const tabs = await p.$$eval('[role=tablist] [role=tab]', (t) => t.map((x) => x.textContent.trim() + ':' + x.getAttribute('aria-selected')));
    assert(tabs.join(',') === 'Workouts:true,Stats:false', 'E3 tabs: ' + tabs.join(','));
    assert(await p.locator('.wo-entry').count() === 1 && await p.locator('.wo-filters').count() === 1 && await p.locator('.progress-table').count() === 0, 'E4 Workouts tab: entries + filters, no progress table');
    await p.click('.fab'); await p.waitForTimeout(300);
    assert((await p.textContent('.sheet-title')) === 'Log workout', 'E5 + opens the log form');
    await p.keyboard.press('Escape'); await p.waitForTimeout(350);
    await p.click('[role=tab]:has-text("Stats")'); await p.waitForTimeout(350);
    assert(await p.locator('.progress-table').count() === 1 && await p.locator('.stat-grid').count() === 1 && await p.locator('.wo-entry').count() === 0, 'E6 Stats tab: stats + progress table');
    assert(await p.locator('.view-workouts .strength-link, .view-workouts .link-btn').count() === 0 && !/All workouts/.test(await p.textContent('.view-workouts')), 'E7 no links back to the old Stats page');
    await p.click('[role=tab]:has-text("Workouts")'); await p.waitForTimeout(350);
    assert(await p.locator('.wo-entry').count() === 1, 'E8 back to the list');
    // an exercise page's own "Log" button is untouched
    await go(p, '#exercise/sq');
    assert(await p.locator('.log-btn').count() === 1, 'E9 exercise page keeps its Log button');
    await ctx.close();
  }
  {
    const { ctx, p } = await open(browser, base());
    await go(p, '#workouts'); await p.click('[role=tab]:has-text("Stats")'); await p.waitForTimeout(300);
    assert(/No workout stats yet/.test(await p.textContent('.view-workouts')), 'E10 Stats empty state');
    await ctx.close();
  }

  // ===== Calendar still fine, nothing points to Stats =====
  {
    const { ctx, p } = await open(browser);
    await go(p, '#calendar');
    assert(await p.locator('a[href="#stats"]').count() === 0 && await p.locator('.cal-completed-btn').count() === 0, 'F1 Calendar has no Completed link (moved to avatar menu in v1.14), none to Stats');
    await ctx.close();
  }

  await browser.close();
  assert(errs.length === 0, 'no page errors: ' + errs.slice(0, 3).join(' | '));
})();
