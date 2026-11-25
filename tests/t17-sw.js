const __ROOT = require('path').resolve(__dirname, '..');
// Unit tests for the service worker's push / notificationclick handlers (sw.js run in a vm
// with a fake ServiceWorkerGlobalScope).
const vm = require('vm');
const fs = require('fs');
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const SCOPE = 'https://me.github.io/Daily-tracker-/';

/** A tiny fake of the IndexedDB calls sw.js makes (open + one store get/put). */
function fakeIdb(kv) {
  return { open: () => {
    const req = {};
    setTimeout(() => {
      req.result = { objectStoreNames: { contains: () => true }, close() {}, transaction: () => {
        const tx = {};
        tx.objectStore = () => ({
          get: (k) => { const r = { result: kv.get(k) }; setTimeout(() => tx.oncomplete?.(), 0); return r; },
          put: (v, k) => { kv.set(k, v); setTimeout(() => tx.oncomplete?.(), 0); return { result: undefined }; },
        });
        return tx;
      } };
      req.onsuccess?.();
    }, 0);
    return req;
  } };
}
const { webcrypto } = require('crypto');
const b64u = (u8) => Buffer.from(u8).toString('base64url');
const KID = 'AAAAAAAAAAA'; // 11-character key label, the first part of `enc`
async function seal(key, id, obj, kid = KID) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(id) }, key, new TextEncoder().encode(JSON.stringify(obj))));
  return kid + b64u(Buffer.concat([iv, ct]));
}

function load({ windows = [], kv = new Map() } = {}) {
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
  vm.runInNewContext(fs.readFileSync((__ROOT + '/sw.js'), 'utf8'), { self, caches: {}, fetch: () => {}, URL, Request: class {}, Response: class {}, console, indexedDB: fakeIdb(kv), crypto: webcrypto, atob, TextEncoder, TextDecoder, Uint8Array, JSON, Date, String, Promise });
  const fire = async (type, ev) => { let p; ev.waitUntil = (x) => { p = x; }; listeners[type](ev); await p; };
  return { fire, log, kv };
}
const pushEvent = (obj) => ({ data: { json: () => obj, text: () => JSON.stringify(obj) } });
const clickEvent = (url) => { const n = { closed: false, data: { url }, close() { n.closed = true; } }; return { notification: n }; };

(async () => {
  {
    // v1.18: the push carries { enc, id, url, tag }; the SW decrypts with the device key from IndexedDB.
    const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const kv = new Map([['reminder', { key, kid: KID }]]);
    const { fire, log } = load({ kv });
    const enc = await seal(key, 'p:t:t1', { title: 'Now', body: 'Dentist – 9:00 AM' });
    await fire('push', pushEvent({ enc, id: 'p:t:t1', url: './#open/task/p/t1/2026-11-20', tag: 'p:t:t1:2026-11-20' }));
    const s = log.shown[0];
    assert(s.title === 'Now' && s.opts.body === 'Dentist – 9:00 AM' && s.opts.tag === 'p:t:t1:2026-11-20' && s.opts.data.url === SCOPE + '#open/task/p/t1/2026-11-20' && s.opts.icon && s.opts.badge, 'push → decrypted showNotification(title, {body, tag, data:{url}, icon, badge})');
    assert(!kv.has('decryptFailed'), 'no failure flag after a good decrypt');
    await fire('push', pushEvent({ enc, id: 'p:t:OTHER', url: './#today' }));
    assert(log.shown[1].title === 'Reminder' && log.shown[1].opts.body === 'Open Daily Tracker to see it' && kv.has('decryptFailed'), 'wrong rule id (AAD) → generic notification + failure flag');
    kv.delete('decryptFailed');
    await fire('push', pushEvent({ enc: await seal(key, 'p:t:t1', { title: 'Old', body: 'x' }, 'BBBBBBBBBBB'), id: 'p:t:t1', url: './#today' }));
    assert(log.shown[log.shown.length - 1].title === 'Reminder' && !kv.has('decryptFailed'), 'a push made under an older key label: generic notification, no flag (the app already re-sent its rules)');
    await fire('push', pushEvent({ enc, id: 'p:t:t1', url: 'https://evil.example/#x' }));
    assert(log.shown[log.shown.length - 1].opts.data.url === SCOPE, 'foreign URLs are replaced by the app scope');
    await fire('push', { data: null });
    assert(log.shown[log.shown.length - 1].title === 'Reminder', 'empty push still shows a notification (userVisibleOnly)');
    // plaintext from an old server is never shown as text
    await fire('push', pushEvent({ title: 'Secret name', body: 'x' }));
    assert(log.shown[log.shown.length - 1].title === 'Reminder' && !JSON.stringify(log.shown[log.shown.length - 1]).includes('Secret'), 'a plaintext push is not shown');
  }
  {
    // no key at all (storage cleared): generic notification, flag left for the app
    const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const { fire, log, kv } = load();
    await fire('push', pushEvent({ enc: await seal(key, 'a', { title: 'T', body: 'B' }), id: 'a', url: './' }));
    assert(log.shown[0].title === 'Reminder' && log.shown[0].opts.body === 'Open Daily Tracker to see it' && kv.has('decryptFailed'), 'missing key → generic notification, the app is told to make a new key');
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
