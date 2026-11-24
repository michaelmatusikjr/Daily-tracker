// v1.3.0: profiles, workouts, workout→habit link, migration from 1.2.0 data.
const { chromium } = require('playwright');
const fs = require('fs');
const SP = __dirname;
// Fixture files (the repo doesn't ship them): a non-image and a 240x160 gradient PNG.
const FX = require('fs').mkdtempSync(require('os').tmpdir() + '/dt-t10-');
require('fs').writeFileSync(FX + '/notimage.txt', 'just text');
{
  const zlib = require('zlib'); const W = 240, H = 160;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = y * (W * 3 + 1) + 1 + x * 3; raw[o - (x === 0 ? 1 : 0) * 0] = x; raw[o + 1] = y; raw[o + 2] = 128; }
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([l, td, cr]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  require('fs').writeFileSync(FX + '/photo.png', Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
const URL = 'http://127.0.0.1:8080/';
const LEGACY = 'dailyTracker:data';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const errs = [], bad = [];
const NOW = new Date(2026, 10, 12, 10, 0); // Thu Nov 12 2026, 10:00 local (UTC in this env)

const v3 = (extra = {}) => ({ version: 3, settings: { onboarded: true, theme: 'dark', accent: 'teal', timeFormat: '12', notifications: false }, tasks: [], habits: [], logs: {}, journal: {}, ...extra });

async function open(browser, { legacy = null, width = 390, init = null, perms = [], clock = NOW, dark = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 820 }, serviceWorkers: 'block', colorScheme: dark ? 'dark' : 'light', permissions: perms, acceptDownloads: true });
  if (init) await ctx.addInitScript(init);
  if (legacy) await ctx.addInitScript(([k, d]) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem(k, d); sessionStorage.setItem('seeded', '1'); } }, [LEGACY, JSON.stringify(legacy)]);
  const p = await ctx.newPage();
  if (clock) await p.clock.install({ time: clock });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('response', (r) => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url()); });
  await p.goto(URL); await p.waitForTimeout(500);
  return { ctx, p };
}
const idx = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('dailyTracker:profiles')));
const stored = (p) => p.evaluate(() => { const i = JSON.parse(localStorage.getItem('dailyTracker:profiles')); return JSON.parse(localStorage.getItem('dailyTracker:data:' + i.activeId)); });
const S = (p, fn) => p.evaluate(fn);
const go = (p, hash) => p.evaluate((x) => { location.hash = x; }, hash).then(() => p.waitForTimeout(250));
const toastText = (p) => p.textContent('#toasts');
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

async function logWorkout(p, { name, isNew = false, type = null, lines = null, time = null, dist = null, date = null }) {
  await go(p, '#workouts');
  await p.click('.fab'); await p.waitForTimeout(250);
  if (isNew) {
    await p.fill('.ex-search', name); await p.click('.ex-chip.add');
    if (type === 'cardio') await p.click('.sheet .segmented button:has-text("Cardio")');
  } else {
    await p.click(`.ex-chip:has-text("${name}")`);
  }
  await p.waitForTimeout(150);
  if (lines) {
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) { await p.click('.add-line'); }
      const row = p.locator('.wo-line').nth(i).locator('input');
      const [w, s, r] = lines[i];
      await row.nth(0).fill(w === null ? '' : String(w)); await row.nth(1).fill(s === null ? '' : String(s)); await row.nth(2).fill(r === null ? '' : String(r));
    }
  }
  if (time !== null) await p.fill('#wo-time', time);
  if (dist !== null) await p.fill('#wo-dist', String(dist));
  if (date) await p.fill('.sheet input[type=date]', date);
  await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(300);
}

(async () => {
  const browser = await chromium.launch();

  // ===== Migration from real 1.2.0 data + intro sheet =====
  {
    const legacy = v3({ tasks: [{ id: 't1', title: 'Old task', date: '2026-11-12', time: '09:00', reminder: 10 }], habits: [{ id: 'h1', name: 'Read', createdAt: '2026-11-01' }], logs: { h1: { '2026-11-11': 1 } }, journal: { '2026-11-11': { mood: 4, note: 'ok' } } });
    const { ctx, p } = await open(browser, { legacy, init: `localStorage.setItem('dailyTracker:alarmRuntime', '{}')` });
    const i = await idx(p);
    assert(i && i.profiles.length === 1 && i.profiles[0].introPending === true, 'P1 legacy data became the first profile');
    assert(await S(p, () => localStorage.getItem('dailyTracker:data')) === null, 'P1 legacy key moved (removed)');
    const st = await stored(p);
    assert(st.version === 7 && Array.isArray(st.workouts) && st.tasks[0].title === 'Old task' && st.logs.h1['2026-11-11'] === 1 && st.journal['2026-11-11'].note === 'ok', 'P1 v3→v4 migration keeps everything');
    assert(await S(p, () => document.documentElement.dataset.theme) === 'dark', 'P1 theme kept');
    assert((await p.textContent('.sheet-title')) === 'Who’s this?', 'P1 friendly intro sheet on first open');
    await p.screenshot({ path: SP + '/p-intro.png' });
    await p.fill('.sheet input[aria-label="Name"]', 'Sam'); await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(300);
    const i2 = await idx(p);
    assert(i2.profiles[0].name === 'Sam' && !i2.profiles[0].introPending, 'P1 intro saved name');
    await p.reload(); await p.waitForTimeout(500);
    assert(!(await p.locator('.sheet-title').count()), 'P1 intro not shown again');
    await ctx.close();
  }
  {
    const { ctx, p } = await open(browser, { legacy: v3() });
    await p.click('.sheet-foot .btn.ghost'); await p.waitForTimeout(300);
    const i = await idx(p);
    assert(i.profiles[0].name === 'Me' && !i.profiles[0].introPending, 'P1 skip → "Me"');
    await ctx.close();
  }
  {
    const { ctx, p } = await open(browser);
    await p.click('.ob-first button:has-text("Get started on this device")'); await p.waitForTimeout(300); // first screen (1.15.1)
    assert(await p.locator('.onboarding input.ob-name').count() === 1, 'P1 new user: name step in onboarding');
    await p.click('.ob-next'); await p.waitForTimeout(600); await p.click('.ob-next'); await p.waitForTimeout(600);
    await p.fill('.ob-name', 'Jo'); await p.click('.ob-next'); await p.waitForTimeout(400);
    assert((await idx(p)).profiles[0].name === 'Jo', 'P1 onboarding name saved');
    await ctx.close();
  }

  // ===== Profiles: nav, add, switch, themes, separate data, photo, delete =====
  {
    const notif = `(() => { window.__n = []; class N { constructor(t) { window.__n.push(t); } static get permission() { return 'granted'; } static requestPermission() { return Promise.resolve('granted'); } } window.Notification = N; })();`;
    const legacy = v3({ settings: { onboarded: true, theme: 'dark', accent: 'teal', notifications: true }, tasks: [{ id: 't1', title: 'Dentist', date: '2026-11-12', time: '10:15', reminder: 10 }] });
    const { ctx, p } = await open(browser, { legacy, init: notif });
    await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(200); // intro → "Me" (empty name)
    await p.evaluate(async () => (await import('./js/store.js')).updateProfile((await import('./js/store.js')).getActiveProfile().id, { name: 'Sam' }));
    const tabs = await p.$$eval('.nav-item', (e) => e.filter((x) => x.offsetParent !== null).map((x) => x.querySelector('.nav-label').textContent));
    assert(JSON.stringify(tabs) === '["Today","Habits","Workouts","Calendar","Journal"]', 'N tabs: Today, Habits, Workouts, Calendar, Journal');
    assert(await p.locator('.avatar-btn').count() === 1, 'N avatar on Today');
    await go(p, '#habits');
    assert(await p.locator('.avatar-btn').count() === 1, 'N avatar on every tab (v1.14 fixed header)');
    await go(p, '#settings');
    assert((await p.textContent('.page-title')) === 'Settings', 'N #settings route still works');
    await go(p, '#today');
    await p.click('.avatar-btn'); await p.waitForTimeout(250);
    const items = await p.$$eval('.menu-item span', (e) => e.map((x) => x.textContent));
    assert(items.includes('Add profile') && items.includes('Settings') && !items.some((t) => t.startsWith('Delete')), 'P2 menu: add/edit/settings; no delete with one profile');
    await p.click('.menu-item:has-text("Add profile")'); await p.waitForTimeout(250);
    await p.fill('.sheet input[aria-label="Name"]', 'Alex');
    await p.click('.avatar-emojis .emoji-btn[aria-label="🦊"]');
    await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(400);
    assert((await toastText(p)).includes('Switched to Alex'), 'P2 adding switches to the new profile');
    assert(await p.locator('.task').count() === 0 && await S(p, () => document.documentElement.dataset.theme) === undefined, 'P2 Alex has separate data and default theme');
    await go(p, '#settings');
    await p.click('.segmented button:has-text("Light")'); await p.click('.swatch[aria-label="Rose"]'); await p.waitForTimeout(200);
    await go(p, '#today');
    await p.click('.avatar-btn'); await p.waitForTimeout(250);
    await p.click('.profile-item:has-text("Sam")'); await p.waitForTimeout(400);
    assert(!(await toastText(p)).includes('Switched to Sam'), 'P2 no "Switched to Sam" toast when the user picks a profile');
    assert(await S(p, () => [document.documentElement.dataset.theme, document.documentElement.dataset.accent].join()) === 'dark,teal', 'P2 Sam’s theme/accent applied');
    assert(await p.locator('.task').count() === 1, 'P2 Sam’s data shown');
    // Reminder fires for Sam even when Alex is active, prefixed with the name
    await p.click('.avatar-btn'); await p.click('.profile-item:has-text("Alex")'); await p.waitForTimeout(300);
    assert(await S(p, () => document.documentElement.dataset.accent) === 'rose', 'P2 Alex’s accent applied');
    await p.clock.runFor(6 * 60 * 1000); await p.waitForTimeout(200);
    assert(JSON.stringify(await S(p, () => window.__n)) === '["Sam · in 10 min"]', 'P6 reminders fire for all profiles, titled with the profile name + timing');
    // Photo avatar
    await p.click('.avatar-btn'); await p.click('.menu-item:has-text("Edit Alex")'); await p.waitForTimeout(250);
    await p.setInputFiles('.sheet input[type=file]', FX + '/notimage.txt'); await p.waitForTimeout(300);
    assert((await p.textContent('.sheet .form-error')).includes('isn’t an image'), 'P3 non-image rejected gracefully');
    await p.setInputFiles('.sheet input[type=file]', FX + '/photo.png'); await p.waitForTimeout(600);
    await p.click('.cropper-sheet .cropper-save'); await p.waitForTimeout(400); // crop step (details in t27)
    await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(300);
    const av = (await idx(p)).profiles.find((x) => x.name === 'Alex').avatar;
    assert(av.type === 'photo' && av.data.startsWith('data:image/jpeg;base64,') && av.data.length < 150000, 'P3 photo stored as small JPEG data URL');
    assert(await p.$eval('.avatar-btn img', (img) => img.naturalWidth === 192 && img.naturalHeight === 192), 'P3 photo resized/cropped to 192×192');
    await p.screenshot({ path: SP + '/p-today-photo.png' });
    // Delete profile (double confirm)
    await p.click('.avatar-btn'); await p.waitForTimeout(250);
    await p.screenshot({ path: SP + '/p-menu.png' });
    await p.click('.menu-item:has-text("Delete Alex")'); await p.waitForTimeout(250);
    await p.click('.sheet .btn.danger'); await p.waitForTimeout(300);
    await p.click('.sheet .btn.danger'); await p.waitForTimeout(400);
    const i3 = await idx(p);
    assert(i3.profiles.length === 1 && i3.profiles[0].name === 'Sam' && (await toastText(p)).includes('Switched to Sam'), 'P4 delete with double confirm switches to remaining profile');
    assert(await S(p, () => Object.keys(localStorage).filter((k) => k.startsWith('dailyTracker:data:')).length) === 1, 'P4 deleted profile’s data removed');
    await ctx.close();
  }

  // ===== Export / import =====
  {
    const { ctx, p } = await open(browser, { legacy: v3({ tasks: [{ id: 'a', title: 'Sam task', date: '2026-11-12' }] }) });
    await p.click('.sheet-foot .btn.ghost'); await p.waitForTimeout(200);
    await p.evaluate(async () => { const S2 = await import('./js/store.js'); S2.addProfile({ name: 'Kim', avatar: { type: 'emoji', emoji: '🐼', color: '#10b981' } }); });
    await go(p, '#settings');
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('text=Export JSON')]);
    await dl.saveAs(SP + '/multi.json');
    const backup = JSON.parse(fs.readFileSync(SP + '/multi.json', 'utf8'));
    assert(backup.format === 'profiles' && backup.profiles.length === 2 && backup.profiles[0].data.tasks[0].title === 'Sam task', 'E1 export contains all profiles');
    // Old single-profile backup → Add as new profile
    fs.writeFileSync(SP + '/single.json', JSON.stringify({ app: 'daily-tracker', data: v3({ tasks: [{ id: 'z', title: 'From v3', date: '2026-11-12' }] }) }));
    await p.setInputFiles('input[type=file]', SP + '/single.json'); await p.waitForTimeout(300);
    assert((await p.textContent('.sheet .dialog-msg')).includes('1 tasks'), 'E2 single backup asks what to do');
    await p.click('.sheet .btn:has-text("Add as new profile")'); await p.waitForTimeout(400);
    let i = await idx(p);
    assert(i.profiles.length === 3 && i.profiles.find((x) => x.id === i.activeId).name === 'Imported' && (await stored(p)).tasks[0].title === 'From v3', 'E2 added as new profile');
    await go(p, '#settings');
    await p.setInputFiles('input[type=file]', SP + '/single.json'); await p.waitForTimeout(300);
    await p.click('.sheet .btn:has-text("Replace")'); await p.waitForTimeout(300);
    assert((await idx(p)).profiles.length === 3, 'E2 replace current keeps profile count');
    // Multi backup replaces everything (with a bad avatar sanitised)
    backup.profiles[1].avatar = { type: 'photo', data: 'data:image/svg+xml;base64,PHN2Zz4=' };
    fs.writeFileSync(SP + '/multi2.json', JSON.stringify(backup));
    await go(p, '#settings');
    await p.setInputFiles('input[type=file]', SP + '/multi2.json'); await p.waitForTimeout(300);
    assert((await p.textContent('.sheet .dialog-msg')).includes('2 profiles'), 'E3 multi backup: replace-all confirmation');
    await p.click('.sheet .btn.danger'); await p.waitForTimeout(400);
    i = await idx(p);
    assert(i.profiles.length === 2 && i.profiles[1].avatar.type === 'emoji', 'E3 replaced all profiles; non-JPEG/PNG avatar rejected');
    assert(await S(p, () => Object.keys(localStorage).filter((k) => /^dailyTracker:data:[^:]+$/.test(k)).length) === 2, 'E3 old profile data removed');
    await ctx.close();
  }

  // ===== Workouts =====
  {
    const habit = { id: 'hx', name: 'Exercise', emoji: '💪', createdAt: '2026-11-01' };
    const { ctx, p } = await open(browser, { legacy: v3({ settings: { onboarded: true, theme: 'light' }, habits: [habit] }) });
    await p.click('.sheet-foot .btn.ghost'); await p.waitForTimeout(200);
    // Quick add has Workout
    await p.click('.fab'); await p.waitForTimeout(200);
    assert(JSON.stringify(await p.$$eval('.sheet .segmented button', (b) => b.map((x) => x.textContent))) === '["Task","Habit","Workout","Journal"]', 'W0 Quick add offers Workout');
    await p.click('.sheet .segmented button:has-text("Workout")'); await p.waitForTimeout(300);
    assert((await p.textContent('.sheet-title')) === 'Log workout', 'W0 opens the log form');
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    // Validation
    await go(p, '#workouts'); await p.click('.fab'); await p.fill('.ex-search', 'Squats'); await p.click('.ex-chip.add');
    await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(150);
    assert((await p.textContent('.sheet .form-error')).includes('Enter a weight'), 'W5 empty entry rejected');
    await p.locator('.wo-line input').nth(0).fill('225');
    await p.fill('.sheet input[type=date]', '2026-11-13'); await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(150);
    assert((await p.textContent('.sheet .form-error')).includes('future'), 'W5 future date rejected');
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    await logWorkout(p, { name: 'Squats', isNew: true, lines: [[225, 3, 5]], date: '2026-11-10' });
    assert(!(await toastText(p)).includes('Logged'), 'W1 log new exercise; no toast');
    // Repeat: pick → prefilled → Save
    await go(p, '#workouts'); await p.click('.fab'); await p.waitForTimeout(200);
    const chips = await p.$$eval('.ex-chip', (e) => e.map((x) => x.textContent));
    assert(chips[0] === 'Squats', 'W1 recent exercise offered as a chip');
    await p.click('.ex-chip:has-text("Squats")'); await p.waitForTimeout(150);
    assert((await p.textContent('.last-time')) === 'Last time: 225 lbs · 3 × 5 · Nov 10', 'W1 "Last time" shown');
    assert(await p.locator('.wo-line input').nth(0).inputValue() === '225', 'W1 values prefilled');
    await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(300);
    assert((await stored(p)).workouts.length === 2, 'W1 pick → Save logs a repeat');
    // PR
    await logWorkout(p, { name: 'Squats', lines: [[245, 1, 3]] });
    assert(((await p.textContent('.takeover-emoji')) + ' ' + (await p.textContent('.takeover-msg'))).includes('🏆 New 1-rep max: Squats 245 lbs'), 'W2 PR takeover (new 1-rep max)');
    await p.keyboard.press('Escape'); await p.waitForTimeout(350);
    assert(await p.locator('.wo-entry .pr-badge').count() === 1, 'W2 🏆 badge on the record entry');
    await p.click('.wo-entry:has(.pr-badge) .wo-del'); await p.waitForTimeout(200);
    assert(await p.locator('.pr-badge').count() === 0, 'W2 records recompute after delete');
    await p.click('#toasts .toast-action'); await p.waitForTimeout(200);
    assert(await p.locator('.pr-badge').count() === 1, 'W2 Undo restores the record');
    // Multi-line
    await logWorkout(p, { name: 'Squats', lines: [[225, 3, 5], [245, 1, 3]], date: '2026-11-11' });
    const allText = await p.textContent('.view'); assert(allText.includes('225 × 3×5, 245 × 1×3'), 'W3 multi-line summary' + (allText.includes('245') ? '' : ' :: ' + allText.slice(0, 300)));
    // Cardio + time-only strength
    await logWorkout(p, { name: 'Walk', isNew: true, type: 'cardio', time: '30', dist: '2.5' });
    assert((await toastText(p)) === '', 'W4 cardio save: no toast');
    await logWorkout(p, { name: 'Plank', isNew: true, time: '1:30' });
    assert((await toastText(p)) === '', 'W4 m:ss hold: no toast');
    await logWorkout(p, { name: 'Walk', time: '0:45', dist: '3.5' });
    assert(!(await toastText(p)).includes('🏆'), 'W4 a longer walk is not a record (records are standard distances only)');
    // Filters
    await go(p, '#workouts'); await p.click('.filter-chip:has-text("Cardio")'); await p.waitForTimeout(150);
    const names = await p.$$eval('.wo-title', (e) => e.map((x) => x.textContent.replace('🏆', '')));
    assert(names.every((n) => n === 'Walk'), 'W7 Cardio filter');
    assert((await p.textContent('.wo-day-head')).includes('Today, Nov 12'), 'W7 day header');
    await p.click('.filter-chip:has-text("All")');
    await p.screenshot({ path: SP + '/w-history.png', fullPage: true });
    // Units
    await go(p, '#settings'); await p.click('.segmented button:has-text("kg")'); await p.waitForTimeout(150);
    await go(p, '#workouts');
    assert((await p.textContent('.wo-list')).includes('102 kg'), 'W6 converted to kg for display');
    assert((await stored(p)).workouts.every((w) => w.weightUnit === 'lb'), 'W6 stored units unchanged');
    await go(p, '#settings'); await p.click('.segmented button:has-text("lbs")'); await p.waitForTimeout(150);
    // Exercise detail
    const sq = (await stored(p)).exercises.find((e) => e.name === 'Squats');
    await go(p, '#exercise/' + sq.id);
    assert((await p.textContent('.view')).includes('1-rep max') && (await p.textContent('.view')).includes('3×5 max') && await p.locator('.line-chart .dot, .line-chart .mark').count() === 3 && await p.locator('.line-chart .mark').count() === 3, 'W8 detail: 1RM/3×5 records + chart with 3×5 markers');
    await p.screenshot({ path: SP + '/w-detail.png', fullPage: true });
    const walk = (await stored(p)).exercises.find((e) => e.name === 'Walk');
    await go(p, '#exercise/' + walk.id);
    await p.click('.segmented button:has-text("Pace")'); await p.waitForTimeout(150);
    assert((await p.textContent('.chart-card .section-title')).startsWith('Pace'), 'W8 cardio pace toggle');
    // Rename + delete-with-history offers archive
    await go(p, '#exercise/' + sq.id);
    await p.click('[aria-label="Edit Squats"]'); await p.fill('.sheet input[aria-label="Exercise name"]', 'Back squat');
    await p.click('.sheet-foot .btn.primary'); await p.waitForTimeout(200);
    assert((await p.textContent('.page-title')) === 'Back squat' && (await stored(p)).workouts.filter((w) => w.exerciseId === sq.id).length === 4, 'W9 rename keeps history');
    await p.click('[aria-label="Edit Back squat"]'); await p.click('.sheet-foot .btn.danger-ghost'); await p.waitForTimeout(200);
    assert((await p.textContent('.sheet .dialog-msg')).includes('Archive it instead'), 'W9 delete with history offers archive');
    await p.click('.sheet .btn:has-text("Archive instead")'); await p.waitForTimeout(300);
    assert((await stored(p)).exercises.find((e) => e.id === sq.id).archived, 'W9 archived');
    // Calendar + stats
    await go(p, '#calendar');
    assert(await p.locator('.cal-workout').count() >= 3, 'W10 💪 calendar markers');
    await go(p, '#workouts'); await p.click('[role=tab]:has-text("Stats")'); await p.waitForTimeout(300);
    assert((await p.textContent('.view-workouts')).includes('Workout days') && (await p.textContent('.view-workouts')).includes('Recent records'), 'W10 Workouts › Stats section');
    await p.screenshot({ path: SP + '/w-stats.png', fullPage: true });
    await p.click('[role=tab]:has-text("Workouts")'); await p.waitForTimeout(250);

    // ===== Workout → habit link =====
    const hv = async (d) => { const s = await stored(p); return [s.logs.hx?.[d] || 0, !!s.autoHabit.hx?.[d]]; };
    await go(p, '#settings');
    await p.selectOption('select[aria-label="Habit to check off when you log a workout"]', 'hx'); await p.waitForTimeout(200);
    assert((await stored(p)).settings.workoutHabit.habitId === 'hx', 'L0 link set in Settings');
    await logWorkout(p, { name: 'Walk', time: '20' });
    assert(JSON.stringify(await hv('2026-11-12')) === '[1,true]', 'L1 logging checks the habit (auto)');
    await p.click('.wo-entry .wo-del >> nth=0'); await p.waitForTimeout(200);
    // other workouts still exist today (Walk 45, Plank) → still checked
    assert(JSON.stringify(await hv('2026-11-12')) === '[1,true]', 'L2 still checked while another workout remains that day');
    await p.click('#toasts .toast-action'); await p.waitForTimeout(200);
    // Past date log
    await logWorkout(p, { name: 'Plank', time: '45', date: '2026-11-05' });
    assert(JSON.stringify(await hv('2026-11-05')) === '[1,true]', 'L3 past date checked');
    await go(p, '#workouts');
    const del = async (d) => { const ids = (await stored(p)).workouts.filter((w) => w.date === d).map((w) => w.id); for (const id of ids) { await p.evaluate(async (x) => (await import('./js/actions.js')).deleteWorkout(x), id); } };
    await del('2026-11-05');
    assert(JSON.stringify(await hv('2026-11-05')) === '[0,false]', 'L4 deleting the last workout un-checks the auto-checked habit');
    await p.click('#toasts .toast-action'); await p.waitForTimeout(200); // undo last delete
    assert(JSON.stringify(await hv('2026-11-05')) === '[1,true]', 'L5 Undo of delete restores habit state');
    // Undo of a save
    await logWorkout(p, { name: 'Plank', time: '50', date: '2026-11-04' });
    assert(JSON.stringify(await hv('2026-11-04')) === '[1,true]', 'L6 saved → checked');
    await del('2026-11-04'); await p.waitForTimeout(200); // (saving no longer shows an Undo toast; delete instead)
    assert(JSON.stringify(await hv('2026-11-04')) === '[0,false]' && !(await stored(p)).workouts.some((w) => w.date === '2026-11-04'), 'L6 Undo of save removes workout and un-checks');
    // Manual check is never undone by the link
    await p.evaluate(async () => (await import('./js/actions.js')).setHabitValue('hx', '2026-11-03', 1));
    await logWorkout(p, { name: 'Plank', time: '40', date: '2026-11-03' });
    await del('2026-11-03');
    assert(JSON.stringify(await hv('2026-11-03')) === '[1,false]', 'L7 manual check stays after deleting the workout');
    // Manually unchecking an auto day hands it to the user
    await p.evaluate(async () => (await import('./js/actions.js')).setHabitValue('hx', '2026-11-05', 0));
    assert(JSON.stringify(await hv('2026-11-05')) === '[0,false]', 'L8 manual uncheck clears the auto marker');
    // Filter: cardio only → strength doesn't check
    await go(p, '#settings'); await p.click('.segmented button:has-text("Cardio")'); await p.waitForTimeout(200);
    await logWorkout(p, { name: 'Plank', time: '30', date: '2026-11-02' });
    assert(JSON.stringify(await hv('2026-11-02')) === '[0,false]', 'L9 Cardio-only filter ignores strength');
    // Archive habit → setting falls back to None
    await p.evaluate(async () => (await import('./js/actions.js')).setArchived('hx', true));
    assert((await stored(p)).settings.workoutHabit.habitId === null, 'L10 archived habit → link None');
    await ctx.close();
  }

  // ===== Import validation of workouts =====
  {
    const { ctx, p } = await open(browser, { legacy: v3() });
    const r = await p.evaluate(async () => {
      const S2 = await import('./js/store.js');
      const out = S2.validateImport({ version: 4, tasks: [], habits: [], exercises: [{ id: 'e1', name: 'Row', type: 'cardio' }, { id: 'e1', name: 'Dup' }],
        workouts: [{ id: 'w', date: '2026-11-01', exerciseId: 'gone', lines: [{ weight: 100, sets: 3, reps: 5 }] }, { id: 'w', date: '2026-11-01', exerciseId: 'e1', time: 600 },
          { id: 'x', date: '2026-11-01', exerciseId: 'e1', time: -5, distance: NaN }, { id: 'y', date: 'bad', exerciseId: 'e1', time: 60 }] });
      return { ex: out.data.exercises.map((e) => [e.id === 'e1', e.name]), wo: out.data.workouts.map((w) => w.id), ids: new Set(out.data.exercises.map((e) => e.id)).size };
    });
    assert(r.wo.length === 2 && new Set(r.wo).size === 2, 'V1 invalid workouts dropped, ids deduplicated');
    assert(r.ex.some(([, n]) => n === 'Unknown exercise') && r.ids === r.ex.length, 'V1 dangling exercise → placeholder; exercise ids unique');
    await ctx.close();
  }

  // ===== 320px / dark / overflow =====
  for (const [width, dark] of [[320, false], [320, true], [390, true], [1280, false]]) {
    const legacy = v3({ settings: { onboarded: true, theme: dark ? 'dark' : 'light' }, exercises: [{ id: 'e', name: 'Bulgarian split squat with a long name', type: 'strength' }],
      workouts: [{ id: 'w1', date: '2026-11-12', exerciseId: 'e', lines: [{ weight: 135, sets: 3, reps: 8 }, { weight: 155, sets: 2, reps: 6 }], weightUnit: 'lb' }] });
    const { ctx, p } = await open(browser, { legacy, width });
    await p.click('.sheet-foot .btn.ghost').catch(() => {}); await p.waitForTimeout(200);
    const tag = `${width}${dark ? '-dark' : ''}`;
    const okToday = await noOverflow(p); await p.screenshot({ path: `${SP}/l13-today-${tag}.png` });
    await go(p, '#workouts'); const okW = await noOverflow(p); await p.screenshot({ path: `${SP}/l13-workouts-${tag}.png` });
    await p.click('.fab'); await p.waitForTimeout(250); await p.click('.ex-chip >> nth=0'); await p.waitForTimeout(150);
    await p.click('.add-line'); const okF = await noOverflow(p); await p.screenshot({ path: `${SP}/l13-form-${tag}.png` });
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    await go(p, '#exercise/e'); const okE = await noOverflow(p); await p.screenshot({ path: `${SP}/l13-ex-${tag}.png`, fullPage: true });
    await go(p, '#today'); await p.click('.avatar-btn'); await p.waitForTimeout(250); const okM = await noOverflow(p);
    assert(okToday && okW && okF && okE && okM, `L ${tag}: no horizontal overflow (today/workouts/form/detail/menu) ${[okToday, okW, okF, okE, okM]}`);
    await ctx.close();
  }

  assert(!bad.length, 'no 4xx/5xx' + (bad.length ? ': ' + bad.slice(0, 5).join(', ') : ''));
  console.log(errs.join('\n') || 'no console errors');
  await browser.close();
})();
