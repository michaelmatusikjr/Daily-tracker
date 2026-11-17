const __ROOT = require('path').resolve(__dirname, '..');
// Unit tests for the service worker's push / notificationclick handlers (sw.js run in a vm
// with a fake ServiceWorkerGlobalScope).
const vm = require('vm');
const fs = require('fs');
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const SCOPE = 'https://me.github.io/Daily-tracker-/';

function load({ windows = [] } = {}) {
  const listeners = {};
  const log = { shown: [], opened: [], focused: [], posted: [] };
  const self = {
    location: new URL(SCOPE + 'sw.js'),
    registration: { scope: SCOPE, showNotification: async (title, opts) => { log.shown.push({ title, opts }); } },
    clients: {
      matchAll: async () => windows.map((w) => ({ url: w, focus: async () => { log.focused.push(w); }, postMessage: (m) => log.posted.push({ w, m }) })),
      openWindow: async (u) => { log.opened.push(u); },
      claim: async () => {},
    },
    addEventListener: (t, fn) => { listeners[t] = fn; },
    skipWaiting: () => {},
  };
  vm.runInNewContext(fs.readFileSync((__ROOT + '/sw.js'), 'utf8'), { self, caches: {}, fetch: () => {}, URL, Request: class {}, Response: class {}, console });
  const fire = async (type, ev) => { let p; ev.waitUntil = (x) => { p = x; }; listeners[type](ev); await p; };
  return { fire, log };
}
const pushEvent = (obj) => ({ data: { json: () => obj, text: () => JSON.stringify(obj) } });
const clickEvent = (url) => { const n = { closed: false, data: { url }, close() { n.closed = true; } }; return { notification: n }; };

(async () => {
  {
    const { fire, log } = load();
    await fire('push', pushEvent({ title: 'Dentist', body: 'Starts at 09:00', url: './#open/task/p/t1/2026-11-20', tag: 'p:t:t1:2026-11-20' }));
    const s = log.shown[0];
    assert(s.title === 'Dentist' && s.opts.body === 'Starts at 09:00' && s.opts.tag === 'p:t:t1:2026-11-20' && s.opts.data.url === SCOPE + '#open/task/p/t1/2026-11-20' && s.opts.icon && s.opts.badge, 'push → showNotification(title, {body, tag, data:{url}, icon, badge})');
    await fire('push', pushEvent({ title: 'X', url: 'https://evil.example/#x' }));
    assert(log.shown[1].opts.data.url === SCOPE, 'foreign URLs are replaced by the app scope');
    await fire('push', { data: null });
    assert(log.shown[2].title === 'Daily Tracker', 'empty push still shows a notification (userVisibleOnly)');
  }
  {
    const { fire, log } = load({ windows: [SCOPE + '#today'] });
    const ev = clickEvent(SCOPE + '#open/habit/sam/h1/2026-11-20');
    await fire('notificationclick', ev);
    assert(ev.notification.closed && log.focused.length === 1 && log.posted[0].m.type === 'OPEN_URL' && log.posted[0].m.url === SCOPE + '#open/habit/sam/h1/2026-11-20' && !log.opened.length, 'existing window: focused and told to open the deep link');
  }
  {
    const { fire, log } = load();
    const ev = clickEvent(SCOPE + '#open/task/p/t1/2026-11-20');
    await fire('notificationclick', ev);
    assert(ev.notification.closed && log.opened[0] === SCOPE + '#open/task/p/t1/2026-11-20', 'no window: openWindow(deep link)');
  }
  {
    const { fire, log } = load();
    await fire('notificationclick', clickEvent(undefined));
    assert(log.opened[0] === SCOPE, 'local notification without url opens the app');
  }
})();
