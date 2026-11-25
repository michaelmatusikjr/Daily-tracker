// The device's reminder key. Closed-app reminder text (task/habit names, times) is encrypted on this device before it is
// sent to the push server, so the server only ever holds ciphertext; only this device can read the notification.
//  - One random AES-256-GCM key per device, made with WebCrypto as NON-extractable (its bytes can't be read out, even by the app).
//  - Stored in IndexedDB "dailyTracker-push" (store "kv", key "reminder"), where the page AND the service worker can read it
//    (sw.js has its own small copy of the read/decrypt code). It is never exported, synced or backed up.
//  - Each rule's { title, body } is encrypted with a fresh 12-byte IV, AAD = the rule id; sent as base64url(iv ‖ ciphertext).
//  - If the service worker can't decrypt a push (key missing or wrong) it shows a generic notification and leaves a flag here;
//    the next time the app opens it makes a new key (rotateKey) and re-sends every rule under it.
const DB = 'dailyTracker-push', STORE = 'kv', KEY_ID = 'reminder', FLAG_ID = 'decryptFailed';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idb(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const out = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(out.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function makeKey() {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const rec = { key, kid: b64url(crypto.getRandomValues(new Uint8Array(8))), created: Date.now() };
  await idb('readwrite', (s) => s.put(rec, KEY_ID));
  return rec;
}

/** { key, kid }: this device's key (made on first use). kid is a random label, handy to notice a key change. */
export async function ensureKey() {
  const rec = await idb('readonly', (s) => s.get(KEY_ID));
  if (rec?.key) return rec;
  return makeKey();
}
/** A brand-new key (the old one is gone). The caller must then send every rule again. */
export async function rotateKey() { await idb('readwrite', (s) => s.delete(FLAG_ID)); return makeKey(); }
/** True when the service worker reported a push it couldn't decrypt. */
export const decryptFailed = async () => !!(await idb('readonly', (s) => s.get(FLAG_ID)));

/** base64url(iv ‖ AES-GCM(JSON of `obj`)) with AAD = the rule id. */
export async function encryptJson(key, ruleId, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(ruleId) }, key, new TextEncoder().encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return b64url(out);
}
