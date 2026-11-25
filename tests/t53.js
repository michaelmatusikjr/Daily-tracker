// v1.18.0 #40: count habits with a "complete by" time per instance: schema 7 → 8 (data kept), import validation,
// the form (Complete all by / Complete each by a time, shrink and grow), Today's row (earliest active instance time),
// per-instance warnings: local reminders and closed-app push rules.
const { chromium, assert, habit, base, open, stored, go, finish } = require('./h118.js');
const each = (o = {}) => habit('h1', 'Water', { goal: { type: 'count', target: 3, unit: 'glasses' }, target: '09:00', targets: ['09:00', '12:00', '15:00'], warn: 30, ...o });
const one = (o = {}) => habit('h2', 'Pills', { goal: { type: 'count', target: 3, unit: '' }, target: '20:00', warn: 30, order: 2, ...o });
const occ = (p) => p.evaluate(async () => (await import('./js/notify.js')).reminderOccurrences(new Date(2026, 10, 18, 0, 0).getTime(), new Date(2026, 10, 18, 23, 59).getTime()).map((o) => o.key.split(':').slice(1).join(':')));
const rules = (p) => p.evaluate(async () => (await import('./js/push.js')).buildRules({ hideText: false, today: '2026-11-18' }).rules.filter((r) => r.kind === 'habit').map((r) => ({ id: r.id.split(':').slice(1).join(':'), time: r.time, skip: r.skipDates, tag: r.tag.split(':').slice(1).join(':'), title: r.title, body: r.body })));
const rowTime = (p, id = 'h1') => p.locator(`.habit-row[data-id="${id}"] .task-time span`).last().innerText();
(async () => {
  const browser = await chromium.launch();
  // ===== schema + import =====
  {
    const { ctx, p } = await open(browser, { data: base({ habits: [one()], logs: { h2: { '2026-11-17': 2 } } }) }); // schema 7, no targets
    const st = await stored(p);
    assert(st.version === 8 && st.habits[0].target === '20:00' && !('targets' in st.habits[0]) && st.logs.h2['2026-11-17'] === 2, 'A1 schema 7 data upgrades to 8 and keeps the habit (one time for all)');
    assert(st.settings.swipe.right.outer === 'details' && st.settings.swipe.left.outer === 'missed', 'A2 swipe settings default in');
    const r = await p.evaluate(async () => {
      const S = await import('./js/store.js');
      const hb = (id, goal, extra) => ({ id, name: id, goal, schedule: { type: 'daily' }, ...extra });
      const out = S.validateImport({ version: 7, tasks: [], habits: [
        hb('a', { type: 'count', target: 3 }, { target: '12:00', targets: ['15:00', '09:00', '12:00'] }),
        hb('b', { type: 'count', target: 2 }, { target: '09:00', targets: ['09:00', '12:00', '15:00'] }),
        hb('c', { type: 'count', target: 3 }, { target: '09:00', targets: ['10:00'] }),
        hb('d', { type: 'count', target: 3 }, { target: '09:00', targets: ['xx', '25:99', 5] }),
        hb('e', { type: 'check' }, { target: '09:00', targets: ['09:00', '10:00'] }),
        hb('f', { type: 'count', target: 3 }, { targets: ['11:00', '13:00', '14:00'], warn: 15 }),
        hb('g', { type: 'count', target: 1 }, { target: '09:00', targets: ['09:00'] }),
      ], logs: {}, settings: { swipe: { right: { inner: 'nope', outer: 'delete' }, left: 5 } } });
      const m = Object.fromEntries(out.data.habits.map((x) => [x.id, [x.target, x.targets]]));
      return { m, version: out.data.version, swipe: out.data.settings.swipe, warn: out.data.habits.find((x) => x.id === 'f').warn, sv: S.SCHEMA_VERSION };
    });
    assert(JSON.stringify(r.m.a) === '["09:00",["09:00","12:00","15:00"]]', 'B1 times sorted, target = earliest: ' + JSON.stringify(r.m.a));
    assert(JSON.stringify(r.m.b) === '["09:00",["09:00","12:00"]]', 'B2 target went down: extra times dropped');
    assert(JSON.stringify(r.m.c) === '["10:00",["10:00","10:00","10:00"]]', 'B3 fewer times than the target: padded with the last');
    assert(JSON.stringify(r.m.d) === '["09:00",null]' || (r.m.d[0] === '09:00' && !r.m.d[1]), 'B4 invalid times ignored: ' + JSON.stringify(r.m.d));
    assert(!r.m.e[1] && !r.m.g[1], 'B5 check habits / goal 1 carry no per-instance times');
    assert(JSON.stringify(r.m.f) === '["11:00",["11:00","13:00","14:00"]]' && r.warn === 15, 'B6 times without a single time: first becomes the target, warn kept');
    assert(r.version === 8 && r.sv === 8 && r.swipe.right.inner === 'complete' && r.swipe.right.outer === 'delete' && r.swipe.left.outer === 'missed', 'B7 imports at schema 8; bad swipe settings fall back per field: ' + JSON.stringify(r.swipe));
    await ctx.close();
  }
  // ===== form =====
  {
    const { ctx, p } = await open(browser, { data: base() });
    await go(p, '#habits');
    await p.locator('.fab').click(); await p.waitForTimeout(500);
    await p.locator('input[placeholder^="e.g. Drink"]').fill('Water');
    await p.locator('.seg-btn, [role="radio"]', { hasText: 'Count' }).first().click();
    await p.locator('input[aria-label="Daily target"]').fill('3');
    await p.locator('button', { hasText: 'By a time' }).click();
    const lab = await p.locator('.sheet .recur-extra.inline span').allInnerTexts();
    assert(lab.includes('Complete all by'), 'C1 label reads "Complete all by": ' + lab.join('|'));
    assert(await p.locator('.sheet label', { hasText: 'Complete each by a time' }).isVisible(), 'C2 checkbox shown for a count goal above 1');
    assert((await p.locator('.sheet .each-times input[type=time]').count()) === 0, 'C3 no per-instance fields yet');
    await p.locator('.sheet label', { hasText: 'Complete each by a time' }).click();
    assert((await p.locator('.sheet .each-times input[type=time]').count()) === 3, 'C4 three "Complete by" fields for a target of 3');
    assert(await p.locator('input[aria-label="Complete by"]').isHidden(), 'C5 the single time is replaced');
    const f = p.locator('.sheet .each-times input[type=time]');
    await f.nth(0).fill('09:00'); await f.nth(1).fill('12:00'); await f.nth(2).fill('15:00');
    await p.locator('input[aria-label="Daily target"]').fill('2'); await p.waitForTimeout(100);
    assert((await p.locator('.sheet .each-times input[type=time]').count()) === 2 && (await p.locator('.sheet .each-times input[type=time]').nth(1).inputValue()) === '12:00', 'C6 target 3 → 2 drops the extra time');
    await p.locator('input[aria-label="Daily target"]').fill('4'); await p.waitForTimeout(100);
    const vals = await p.locator('.sheet .each-times input[type=time]').evaluateAll((l) => l.map((x) => x.value));
    assert(vals.join() === '09:00,12:00,15:00,15:00', 'C7 target 2 → 4: the times are kept while ticked, new fields copy the last: ' + vals);
    await p.locator('input[aria-label="Daily target"]').fill(''); await p.waitForTimeout(100);
    await p.locator('input[aria-label="Daily target"]').fill('4'); await p.waitForTimeout(100);
    assert((await p.locator('.sheet .each-times input[type=time]').evaluateAll((l) => l.map((x) => x.value))).join() === '09:00,12:00,15:00,15:00', 'C7b blanking and retyping the count keeps the times');
    await p.locator('.sheet .each-times input[type=time]').nth(3).fill('18:00');
    await p.locator('.sheet-foot .btn.primary').click(); await p.waitForTimeout(400);
    let hb = (await stored(p)).habits[0];
    assert(hb.goal.target === 4 && hb.target === '09:00' && JSON.stringify(hb.targets) === '["09:00","12:00","15:00","18:00"]', 'C8 saved: target = earliest, targets per instance: ' + JSON.stringify([hb.target, hb.targets]));
    // edit: reopen, untick → single time; check habit has no checkbox
    await p.locator('.habit-card[data-id] .habit-open').click(); await p.waitForTimeout(400);
    await go(p, '#habits');
    await p.locator('.habit-card .habit-open').click({ button: 'right' }); await p.waitForTimeout(400);
    await p.locator('.menu-item', { hasText: 'Edit' }).first().click(); await p.waitForTimeout(500);
    assert((await p.locator('.sheet .each-times input[type=time]').count()) === 4 && await p.locator('.sheet input[type=checkbox][aria-label="Complete each by a time"]').isChecked(), 'D1 editing shows the saved times');
    await p.locator('.sheet label', { hasText: 'Complete each by a time' }).click();
    await p.locator('.sheet-foot .btn.primary').click(); await p.waitForTimeout(400);
    hb = (await stored(p)).habits[0];
    assert(!('targets' in hb) && hb.target, 'D2 unticking goes back to one time for the whole habit: ' + JSON.stringify([hb.target, hb.targets]));
    await ctx.close();
  }
  // ===== Today row + warnings =====
  {
    const logs = (n) => ({ h1: { '2026-11-18': n }, h2: { '2026-11-18': n } });
    const { ctx, p } = await open(browser, { data: base({ habits: [each(), one()], logs: logs(0) }) });
    assert((await rowTime(p)) === '12 PM', 'E1 10:00, no completions: 1st time (9:00) passed → row shows the 2nd (12:00 PM): ' + await rowTime(p));
    assert((await p.locator('.habit-row[data-id="h2"] .task-time span').last().innerText()) === '8 PM', 'E2 single time habit unchanged');
    await p.locator('.habit-row[data-id="h1"] .habit-count').click(); await p.waitForTimeout(250);
    assert((await rowTime(p)) === '12 PM', 'E3 one tap counts as the 1st instance: still the 2nd time');
    await p.locator('.habit-row[data-id="h1"] .habit-count').click(); await p.waitForTimeout(250);
    assert((await rowTime(p)) === '3 PM', 'E4 2nd done: the 3rd time');
    await p.locator('.habit-row[data-id="h1"] .habit-count').click(); await p.waitForTimeout(250);
    assert((await rowTime(p)) === '3 PM' && (await p.locator('.habit-row[data-id="h1"] .habit-count.done').count()) === 1, 'E5 all done: last time stays');
    await p.clock.setSystemTime(new Date(2026, 10, 18, 16, 0));
    await go(p, '#habits'); await go(p, '#today');
    assert((await p.locator('.habit-row').count()) >= 2, 'E6 still one row per habit');
    await ctx.close();
  }
  {
    const mkSt = (n) => base({ habits: [each(), one()], logs: { h1: { '2026-11-18': n }, h2: { '2026-11-18': n } } });
    for (const [n, want] of [[0, ['hw:h1:2026-11-18:1', 'hw:h1:2026-11-18:2', 'hw:h1:2026-11-18:3']], [1, ['hw:h1:2026-11-18:2', 'hw:h1:2026-11-18:3']], [2, ['hw:h1:2026-11-18:3']], [3, []]]) {
      const { ctx, p } = await open(browser, { data: { ...mkSt(n), settings: { ...mkSt(n).settings, notifications: true } } });
      const o = (await occ(p)).filter((k) => k.startsWith('hw:h1'));
      assert(JSON.stringify(o) === JSON.stringify(want), `F${n} count ${n}: local warnings for the instances not done yet: ${o}`);
      const h2 = (await occ(p)).filter((k) => k.startsWith('hw:h2'));
      assert(h2.length === (n >= 3 ? 0 : 1) && (n >= 3 || h2[0] === 'hw:h2:2026-11-18'), `F${n}b single-time habit: one warning until the goal is met (${h2})`);
      const rl = await rules(p);
      const mine = rl.filter((r) => r.id.startsWith('hw:h1'));
      assert(JSON.stringify(mine.map((r) => [r.id, r.time])) === JSON.stringify([['hw:h1:1', '08:30'], ['hw:h1:2', '11:30'], ['hw:h1:3', '14:30']]), `G${n} push rules: one per instance at its time minus the warning: ` + JSON.stringify(mine.map((r) => [r.id, r.time])));
      assert(mine.every((r, i) => r.skip.includes('2026-11-18') === (n >= i + 1)), `G${n}b skip today exactly for the instances already done`);
      assert(mine[0].tag === 'hw:h1:{date}:1' && mine[0].body === 'Water – complete by 9:00 AM' && mine[0].title === '30 min left', `G${n}c per-instance tag and wording: ${mine[0].tag} / ${mine[0].body}`);
      const r2 = rl.filter((r) => r.id.startsWith('hw:h2'));
      assert(r2.length === 1 && r2[0].id === 'hw:h2' && r2[0].tag === 'hw:h2:{date}' && r2[0].skip.includes('2026-11-18') === (n >= 3), `G${n}d single-time rule unchanged (id, tag, skipped only once the goal is met)`);
      if (n === 1) {
        const still = await p.evaluate(async () => {
          const s = await import('./js/store.js'); const nt = await import('./js/notify.js');
          const list = nt.reminderOccurrences(new Date(2026, 10, 18, 0, 0).getTime(), new Date(2026, 10, 18, 23, 59).getTime()).filter((o) => o.key.includes(':hw:h1'));
          const state = s.readProfileState('p');
          const a = list.map((o) => o.stillDue(state));
          state.logs.h1['2026-11-18'] = 2;
          return [a, list.map((o) => o.stillDue(state))];
        });
        assert(JSON.stringify(still) === '[[true,true],[false,true]]', 'H1 a pending timer re-checks the count when it fires: ' + JSON.stringify(still));
      }
      await ctx.close();
    }
    // two instances sharing a time: one warning (for the larger count)
    const { ctx, p } = await open(browser, { data: { ...mkSt(0), habits: [each({ targets: ['09:00', '09:00', '15:00'] })], settings: { ...mkSt(0).settings, notifications: true } } });
    const rl = (await rules(p)).map((r) => r.id);
    assert(JSON.stringify(rl) === '["hw:h1:2","hw:h1:3"]', 'I1 instances sharing a time give one warning: ' + rl);
    await ctx.close();
  }
  await browser.close(); finish('t53');
})();
