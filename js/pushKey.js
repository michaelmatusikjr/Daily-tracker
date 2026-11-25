// The device's reminder key. Closed-app reminder text (task/habit names, times) is encrypted on this device before it is
// sent to the push server, so the server only ever holds ciphertext; only this device can read the notification.
//  - One random AES-256-GCM key per device, made with WebCrypto as NON-extractable (its bytes can't be read out, even by the app).
//  - Stored in IndexedDB "dailyTracker-push" (store "kv", key "reminder"), where the page AND the service worker can read it
//    (sw.js has its own small copy of the read/decrypt code). It is never exported, synced or backed up.
//  - Each rule's { title, body } is encrypted with a fresh 12-byte IV, AAD = the rule id; sent as base64url(iv ‖ ciphertext).
//  - Each rule's { title, body } is encrypted with a fresh 12-byte IV, AAD = the rule id (url / tag / fire times are NOT covered:
//    they stay plaintext); sent as kid (11 chars, the key's label) + base64url(iv ‖ ciphertext).
//  - If the service worker can't decrypt a push made with this device's CURRENT key (kid matches), or has no key at all, it shows a
//    generic notification and leaves a flag here; the next time the app syncs it re-sends every rule with the existing key (a missing
//    key is simply made again by ensureKey, which changes the kid and so re-sends too). Pushes under an older kid are not flagged.

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
  const rec = { key, kid: b64url(crypto.getRandomValues(new Uint8Array(8))), created: Date.now() }; // kid: 11 base64url characters
  await idb('readwrite', (s) => s.put(rec, KEY_ID));
  return rec;
}

let mem = null; // the key record once read: the page-hide sync must not wait for IndexedDB
export const cachedKey = () => mem;

/**
 * { key, kid }: this device's key (made on first use, guarded by a Web Lock so two tabs can't each make one).
 * `fresh` re-reads IndexedDB (notices a key that was cleared); without it the in-memory copy is used.
 */
export async function ensureKey({ fresh = false } = {}) {
  if (mem && !fresh) return mem;
  const rec = await idb('readonly', (s) => s.get(KEY_ID));
  if (rec?.key) { mem = rec; return rec; }
  const make = async () => {
    const again = await idb('readonly', (s) => s.get(KEY_ID));
    return again?.key ? again : makeKey();
  };
  mem = navigator.locks?.request ? await navigator.locks.request('dailyTracker-push-key', make) : await make();
  return mem;
}
/** True (once) when the service worker reported a push it couldn't read; the flag is cleared by this call. */
export async function takeDecryptFailure() {
  const flagged = !!(await idb('readonly', (s) => s.get(FLAG_ID)));
  if (flagged) await idb('readwrite', (s) => s.delete(FLAG_ID));
  return flagged;
}
/** Read-only look at the flag (tests). */
export const decryptFailed = async () => !!(await idb('readonly', (s) => s.get(FLAG_ID)));

/** kid + base64url(iv ‖ AES-GCM(JSON of `obj`)) with AAD = the rule id. `rec` = { key, kid }. */
export async function encryptJson(rec, ruleId, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(ruleId) }, rec.key, new TextEncoder().encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return rec.kid + b64url(out);
}
