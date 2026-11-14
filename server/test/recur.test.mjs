// Recurrence parity with the app (js/logic.js) and time-zone / DST handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { occursOn, nextFire, localToUTC, wallTime, addDays } from '../src/recur.js';

// Load the app's own recurrence code (browser ES modules) unchanged.
const appJs = new URL('../../js/', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'dt-logic-'));
writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
for (const f of ['logic.js', 'dates.js']) copyFileSync(join(appJs, f), join(dir, f));
const app = await import(join(dir, 'logic.js'));

/** Deterministic PRNG so failures are reproducible. */
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }

test('occursOn matches the app for thousands of random rules and dates', () => {
  const rand = rng(42);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const types = ['none', 'daily', 'weekdays', 'weekly', 'monthly', 'interval'];
  let checked = 0;
  for (let i = 0; i < 400; i++) {
    const start = addDays('2024-01-01', Math.floor(rand() * 1200));
    const type = pick(types);
    const days = type === 'weekly' ? [...new Set(Array.from({ length: Math.floor(rand() * 4) }, () => Math.floor(rand() * 7)))] : [];
    const interval = 1 + Math.floor(rand() * 10);
    const exceptions = Array.from({ length: Math.floor(rand() * 4) }, () => addDays(start, Math.floor(rand() * 90)));
    const task = { date: start, recur: { type, days, interval }, exceptions };
    const rule = { recur: type === 'none' ? { type } : { type, days, interval, start }, date: type === 'none' ? start : null, exceptions };
    for (let j = -5; j < 120; j++) {
      const k = addDays(start, j);
      assert.equal(occursOn(rule, k), app.occursOn(task, k), JSON.stringify({ task, k }));
      checked++;
    }
  }
  assert.ok(checked > 40000);
});

test('monthly on the 31st clamps to the month end, like the app', () => {
  const rule = { recur: { type: 'monthly', start: '2027-01-31' }, exceptions: [] };
  const fires = [];
  let t = Date.UTC(2027, 0, 30);
  for (let i = 0; i < 6; i++) { const n = nextFire({ ...rule, time: '08:00' }, 'UTC', t); fires.push(n.date); t = n.at; }
  assert.deepEqual(fires, ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31', '2027-06-30']);
});

test('interval rules are anchored on start; exceptions and skipDates are skipped', () => {
  const rule = { time: '07:30', recur: { type: 'interval', start: '2027-05-01', interval: 3 }, exceptions: ['2027-05-07'], skipDates: ['2027-05-10'] };
  const fires = [];
  let t = Date.UTC(2027, 3, 1);
  for (let i = 0; i < 4; i++) { const n = nextFire(rule, 'UTC', t); fires.push(n.date); t = n.at; }
  assert.deepEqual(fires, ['2027-05-01', '2027-05-04', '2027-05-13', '2027-05-16']);
});

test('weekly with days, weekdays, until, one-off', () => {
  const at = (rule, from) => nextFire({ time: '09:00', ...rule }, 'UTC', Date.UTC(...from))?.date ?? null;
  assert.equal(at({ recur: { type: 'weekly', start: '2027-05-03', days: [5] } }, [2027, 4, 3]), '2027-05-07'); // Friday
  assert.equal(at({ recur: { type: 'weekdays', start: '2027-05-01' } }, [2027, 4, 1]), '2027-05-03'); // skips the weekend
  assert.equal(at({ recur: { type: 'daily', start: '2027-05-01' }, until: '2027-05-02' }, [2027, 4, 3]), null);
  assert.equal(at({ recur: { type: 'none' }, date: '2027-05-09' }, [2027, 4, 1]), '2027-05-09');
  assert.equal(at({ recur: { type: 'none' }, date: '2027-05-09' }, [2027, 4, 10]), null);
});

test('a reminder lead crossing midnight fires the evening before (offsetDays)', () => {
  // Task at 00:10 daily with a 30 min lead → 23:40 the day before.
  const rule = { time: '23:40', offsetDays: -1, recur: { type: 'daily', start: '2027-06-10' } };
  const n = nextFire(rule, 'Europe/London', Date.UTC(2027, 5, 1));
  assert.equal(n.date, '2027-06-10');
  assert.deepEqual(wallTime(n.at, 'Europe/London'), { key: '2027-06-09', hm: '23:40', sec: 0 });
});

for (const [tz, spring, fall] of [['America/New_York', '2027-03-14', '2027-11-07'], ['Europe/London', '2027-03-28', '2027-10-31']]) {
  test(`DST in ${tz}: local time kept, gap → next valid minute, repeat → once`, () => {
    // 09:00 every day across the spring change stays 09:00 local; that day is 23 h long.
    const rule = { time: '09:00', recur: { type: 'daily', start: '2027-01-01' } };
    const before = nextFire(rule, tz, localToUTC(addDays(spring, -1), '08:00', tz));
    const on = nextFire(rule, tz, before.at);
    assert.equal(wallTime(before.at, tz).hm, '09:00');
    assert.equal(wallTime(on.at, tz).hm, '09:00');
    assert.equal(on.at - before.at, 23 * 3600000);
    // Nonexistent local time (clocks jump forward): fires at the jump, the next valid minute.
    const gapHm = tz === 'Europe/London' ? '01:30' : '02:30';
    const jumpTo = tz === 'Europe/London' ? '02:00' : '03:00';
    const g = localToUTC(spring, gapHm, tz);
    assert.deepEqual([wallTime(g, tz).key, wallTime(g, tz).hm], [spring, jumpTo]);
    assert.equal(wallTime(g - 60000, tz).hm < gapHm || wallTime(g - 60000, tz).key < spring, true);
    // Repeated local time (clocks go back): the first one, and only once per day.
    const repHm = '01:30';
    const r1 = localToUTC(fall, repHm, tz);
    assert.equal(wallTime(r1, tz).hm, repHm);
    assert.equal(wallTime(r1 + 3600000, tz).hm, repHm, 'the time really repeats an hour later');
    const daily = { time: repHm, recur: { type: 'daily', start: '2027-01-01' } };
    const first = nextFire(daily, tz, r1 - 60000);
    const second = nextFire(daily, tz, first.at, { fired: new Set([first.date]) });
    assert.equal(first.at, r1);
    assert.equal(second.date, addDays(fall, 1), 'fires once on the repeated day');
  });
}

test('weekly rule fires on the same local weekday in every time zone', () => {
  for (const tz of ['Pacific/Auckland', 'Asia/Kolkata', 'America/Los_Angeles', 'UTC']) {
    const n = nextFire({ time: '07:00', recur: { type: 'weekly', start: '2027-01-04', days: [1] } }, tz, Date.UTC(2027, 0, 6));
    assert.equal(new Date(n.date + 'T00:00:00Z').getUTCDay(), 1);
    assert.deepEqual(wallTime(n.at, tz), { key: n.date, hm: '07:00', sec: 0 });
  }
});
