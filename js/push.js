// Reminders while the app is closed: Web Push via the optional server in server/.
// One subscription per device covers every profile. The app sends the server one RULE per task or
// habit reminder (local time + recurrence + time zone) and replaces the set after every change;
// the server works out each occurrence, so reminders keep coming even if the app isn't opened.
// Device credentials live in their own localStorage key, so exports never include them.
import { PUSH_SERVER_URL, VAPID_PUBLIC_KEY } from './pushConfig.js';
import { getProfiles, readProfileState, getState, update } from './store.js';
import { reschedule } from './notify.js';
import { todayKey, addDays, timeToMin, minToTime, startOfWeek, fmtTime } from './dates.js';
import { activeHabits, habitDone, weekCount } from './logic.js';
import { isIOS, isStandalone } from './pwa.js';

const STATE_KEY = 'dailyTracker:push';
const CONFIG_KEY = 'dailyTracker:pushConfig';
const MAX_RULES = 500;
const NEAR_DAYS = 60; // completions/exceptions sent for the near term only
const DEBOUNCE_MS = 2000;
const BACKOFF = [5000, 30000, 120000, 600000, 1800000];
const RESYNC_AFTER = 12 * 3600000; // re-send at least twice a day (near-term skip dates roll forward)

// ---------- persisted state ----------
function readJSON(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }
function writeJSON(key, v) { try { if (v === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage full: next sync retries */ } }
const loadState = () => readJSON(STATE_KEY) || {};
function saveState(patch) { const s = { ...loadState(), ...patch }; writeJSON(STATE_KEY, s); return s; }

const listeners = new Set();
export function onPushChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const changed = () => listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });

// ---------- configuration ----------
/** { serverUrl, publicKey, overridden } — Settings overrides win over js/pushConfig.js. */
export function pushConfig() {
  const o = readJSON(CONFIG_KEY) || {};
  const serverUrl = String(o.serverUrl || PUSH_SERVER_URL || '').trim().replace(/\/+$/, '');
  const publicKey = String(o.publicKey || VAPID_PUBLIC_KEY || '').trim();
  return { serverUrl, publicKey, overridden: !!(o.serverUrl || o.publicKey) };
}
export const pushConfigured = () => { const c = pushConfig(); return !!(c.serverUrl && c.publicKey); };
export function setPushConfig({ serverUrl = '', publicKey = '' }) {
  serverUrl = serverUrl.trim().replace(/\/+$/, '');
  publicKey = publicKey.trim();
  if (serverUrl && !/^https:\/\/[^\s/]+/i.test(serverUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(serverUrl)) throw new Error('The server URL must start with https://');
  if (publicKey && !/^[A-Za-z0-9_-]{80,100}$/.test(publicKey)) throw new Error('That doesn’t look like a VAPID public key');
  writeJSON(CONFIG_KEY, serverUrl || publicKey ? { serverUrl, publicKey } : null);
  changed();
}

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const pushEnabled = () => !!loadState().on && pushConfigured();

/** True while the server holds an up-to-date schedule: local timers then stay off (no duplicates). */
export function pushCoversReminders() {
  const s = loadState();
  return !!(s.on && pushConfigured() && s.lastOk && !s.pending && !s.error);
}

/** Human status for Settings. { kind: 'on'|'pending'|'offline'|'error'|'off'|'ios', text } */
export function pushStatus() {
  const s = loadState();
  if (isIOS() && !isStandalone()) return { kind: 'ios', text: 'On iPhone and iPad this needs Daily Tracker added to your Home Screen (Share › Add to Home Screen) and iOS 16.4 or later.' };
  if (!pushSupported()) return { kind: 'unsupported', text: 'This browser can’t receive push notifications.' };
  if (!s.on) return { kind: 'off', text: 'Your server sends the reminders, so they arrive even when the app is closed. Things you complete on another device can’t reach the server until you open the app here.' };
  if (s.pending && !navigator.onLine) return { kind: 'offline', text: 'Waiting to sync (offline). Your latest changes will be sent when you’re back online.' };
  if (s.error) return { kind: 'error', text: `Couldn’t reach your server: ${s.error}. Retrying automatically.` };
  if (s.pending || !s.lastOk) return { kind: 'pending', text: 'Syncing reminders with your server…' };
  return { kind: 'on', text: `On – reminders are sent from your server (last synced ${new Date(s.lastOk).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}).` };
}
export const hideTextOn = () => !!loadState().hideText;
export function setHideText(on) { saveState({ hideText: !!on, hash: null }); changed(); scheduleSync(0); }

// ---------- rules ----------
export const HIDDEN_TITLE = 'Daily Tracker';
export const HIDDEN_BODY = 'You have a reminder – tap to open';
const safeId = (x) => String(x).replace(/[^\w:.-]/g, '_');
const RECUR = new Set(['daily', 'weekdays', 'weekly', 'monthly', 'interval']);
const nearDates = (keys, from, to) => [...new Set(keys)].filter((k) => k >= from && k <= to).sort().slice(-400);

/** Deep link to one occurrence; "{date}" is filled in per occurrence (server and local timers). */
export const deepLink = (kind, profileId, id, date = '{date}') => `./#open/${kind}/${encodeURIComponent(profileId)}/${encodeURIComponent(id)}/${date}`;

/**
 * The full replacement schedule: { tz, rules }. One rule per task/habit reminder across every
 * profile with notifications on. Times are local and already minus the reminder lead; a lead that
 * crosses midnight sets offsetDays (fire on an earlier day than the occurrence).
 */
export function buildRules({ hideText = hideTextOn(), today = todayKey() } = {}) {
  const profiles = getProfiles();
  const multi = profiles.length > 1;
  const from = addDays(today, -1), to = addDays(today, NEAR_DAYS);
  const rules = [];
  for (const profile of profiles) {
    const st = readProfileState(profile.id);
    if (!st || !st.settings.notifications) continue;
    const fmt = st.settings.timeFormat;
    const prefix = multi ? `${profile.name}: ` : '';
    const text = (title, body) => (hideText ? { title: HIDDEN_TITLE, body: HIDDEN_BODY } : { title: (prefix + title).slice(0, 120), body: body.slice(0, 240) });
    for (const t of st.tasks) {
      if (!t.time || t.reminder === null || t.reminder === undefined) continue;
      const recur = RECUR.has(t.recur?.type) ? t.recur.type : 'none';
      if (recur === 'none' && (t.done || t.date < from)) continue;
      const mins = timeToMin(t.time) - (t.reminder || 0);
      const r = {
        id: safeId(`${profile.id}:t:${t.id}`).slice(0, 128), kind: 'task',
        ...text(t.title, t.reminder ? `Starts at ${fmtTime(t.time, fmt)}` : 'Starting now'),
        url: deepLink('task', profile.id, t.id), tag: `${profile.id}:t:${t.id}:{date}`.slice(0, 128),
        time: minToTime(((mins % 1440) + 1440) % 1440), offsetDays: Math.floor(mins / 1440),
        recur: recur === 'none' ? { type: 'none' } : { type: recur, start: t.date, ...(recur === 'weekly' ? { days: t.recur.days || [] } : {}), ...(recur === 'interval' ? { interval: Math.max(1, t.recur.interval || 1) } : {}) },
        exceptions: nearDates(t.exceptions || [], from, '9999-12-31'),
        skipDates: nearDates(Object.keys(t.doneDates || {}).filter((k) => t.doneDates[k]), from, to),
      };
      if (recur === 'none') r.date = t.date;
      rules.push(r);
    }
    for (const hb of activeHabits(st)) {
      if (!hb.reminder) continue;
      const type = hb.schedule?.type;
      const start = /^\d{4}-\d{2}-\d{2}$/.test(hb.createdAt || '') && hb.createdAt < today ? hb.createdAt : today;
      const recur = type === 'days' ? { type: 'weekly', start, days: [...(hb.schedule.days || [])] } : { type: 'daily', start };
      if (type === 'days' && !recur.days.length) continue;
      const skip = [];
      for (let k = from; k <= addDays(today, 1); k = addDays(k, 1)) if (habitDone(st, hb, k)) skip.push(k);
      // X-per-week: once this week's target is met, skip the rest of the week (later weeks remind daily).
      if (type === 'perWeek' && weekCount(st, hb, today) >= (hb.schedule.times || 1)) {
        const ws = startOfWeek(today, st.settings.weekStart ?? 1);
        for (let i = 0; i < 7; i++) { const k = addDays(ws, i); if (k >= today) skip.push(k); }
      }
      rules.push({
        id: safeId(`${profile.id}:h:${hb.id}`).slice(0, 128), kind: 'habit',
        ...text(`${hb.emoji} ${hb.name}`, 'Time for your habit'),
        url: deepLink('habit', profile.id, hb.id), tag: `${profile.id}:h:${hb.id}:{date}`.slice(0, 128),
        time: hb.reminder, offsetDays: 0, recur, exceptions: [], skipDates: nearDates(skip, from, to),
      });
    }
  }
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
  return { tz, rules: rules.slice(0, MAX_RULES) };
}

// ---------- server calls ----------
class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
async function api(method, path, body, { auth = true, keepalive = false, state = loadState(), cfg = pushConfig() } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) { headers.Authorization = 'Bearer ' + state.token; headers['X-Device'] = state.deviceId; }
  const text = body === undefined ? undefined : JSON.stringify(body);
  let res;
  try {
    res = await fetch((state.serverUrl || cfg.serverUrl) + path, { method, headers, body: text, keepalive: keepalive && (text?.length || 0) < 60000, mode: 'cors', credentials: 'omit' });
  } catch {
    throw new ApiError(0, navigator.onLine ? 'network error' : 'offline');
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(res.status, data?.error || `HTTP ${res.status}`);
  return data;
}

function b64urlToBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
function sameKey(sub, key) {
  try {
    const k = sub.options?.applicationServerKey;
    if (!k) return true;
    const a = new Uint8Array(k), b = b64urlToBytes(key);
    return a.length === b.length && a.every((x, i) => x === b[i]);
  } catch { return true; }
}
async function registration() {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, rej) => setTimeout(() => rej(new Error('The app’s service worker isn’t ready yet – reload and try again')), 10000)),
  ]);
}
async function currentSubscription(cfg, { create = true } = {}) {
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, cfg.publicKey)) { await sub.unsubscribe().catch(() => {}); sub = null; }
  if (!sub && create) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(cfg.publicKey) });
  return sub;
}

// ---------- turning it on / off ----------
/** Call from the toggle's click (needs the user gesture for the permission prompt). */
export async function enablePush() {
  const cfg = pushConfig();
  if (!cfg.serverUrl || !cfg.publicKey) return { ok: false, message: 'Set your push server in Advanced first.' };
  if (isIOS() && !isStandalone()) return { ok: false, message: 'Add Daily Tracker to your Home Screen first (iOS 16.4 or later).' };
  if (!pushSupported()) return { ok: false, message: 'This browser can’t receive push notifications.' };
  let perm = Notification.permission;
  if (perm === 'default') { try { perm = await Notification.requestPermission(); } catch { perm = Notification.permission; } }
  if (perm !== 'granted') return { ok: false, message: perm === 'denied' ? 'Notifications are blocked for this app.' : 'Notification permission was not granted.' };
  try {
    const sub = await currentSubscription(cfg);
    const { deviceId, token } = await api('POST', '/api/register', { subscription: sub.toJSON() }, { auth: false, cfg });
    saveState({ on: true, deviceId, token, endpoint: sub.endpoint, serverUrl: cfg.serverUrl, lastOk: null, pending: true, error: null, hash: null, pendingDelete: null });
  } catch (e) {
    return { ok: false, message: `Couldn’t turn it on: ${e.message || e}` };
  }
  // Reminders only exist for profiles with notifications on: switch them on for this profile.
  if (!getState().settings.notifications) update((s) => { s.settings.notifications = true; });
  changed();
  await syncNow();
  return { ok: true };
}

/** Turn off: forget the device on the server (retried later if offline) and unsubscribe. */
export async function disablePush() {
  const s = loadState();
  clearTimeout(debounceTimer); clearTimeout(retryTimer);
  writeJSON(STATE_KEY, { hideText: s.hideText || false, pendingDelete: s.deviceId ? { serverUrl: s.serverUrl, deviceId: s.deviceId, token: s.token } : null });
  changed();
  reschedule(); // local timers take over again
  await flushPendingDelete();
  try {
    const reg = await Promise.race([navigator.serviceWorker?.getRegistration(), new Promise((r) => setTimeout(r, 3000))]);
    const sub = await reg?.pushManager?.getSubscription();
    await sub?.unsubscribe();
  } catch { /* ignore */ }
}
async function flushPendingDelete() {
  const pd = loadState().pendingDelete;
  if (!pd) return;
  try {
    await api('DELETE', '/api/device', undefined, { state: pd });
    saveState({ pendingDelete: null });
  } catch (e) {
    if (e.status === 401 || e.status === 404) saveState({ pendingDelete: null }); // already gone
  }
}

/** After a reset or profile delete: stop push entirely when no profile wants reminders any more. */
export async function afterDataRemoved() {
  if (!loadState().on) return;
  const anyOn = getProfiles().some((p) => readProfileState(p.id)?.settings.notifications);
  if (!anyOn || getProfiles().length <= 1) await disablePush();
  else scheduleSync(0);
}

// ---------- sync ----------
let debounceTimer = null, retryTimer = null, attempt = 0, inflight = null;

/** Debounced full-schedule sync (call after any data change). */
export function scheduleSync(delay = DEBOUNCE_MS) {
  if (!pushEnabled()) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => syncNow(), delay);
}

const hashOf = (items) => {
  let h = 0;
  const s = JSON.stringify(items);
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return String(h);
};

/** Send the whole schedule now. Queues and retries with backoff when offline or failing. */
export async function syncNow({ keepalive = false, force = false } = {}) {
  if (!pushEnabled()) return false;
  clearTimeout(debounceTimer);
  if (inflight) { await inflight.catch(() => {}); }
  inflight = (async () => {
    const schedule = buildRules();
    const hash = hashOf(schedule);
    let s = loadState();
    // Nothing changed and the server copy is fresh: skip the network.
    if (!force && s.hash === hash && s.lastOk && !s.pending && !s.error && Date.now() - s.lastOk < RESYNC_AFTER) return true;
    saveState({ pending: true });
    if (!navigator.onLine) { saveState({ error: null }); changed(); reschedule(); return false; }
    try {
      try {
        await api('PUT', '/api/schedule', schedule, { keepalive });
      } catch (e) {
        if (e.status !== 401) throw e;
        await reRegister(); // the server forgot this device (e.g. it was purged): register again
        await api('PUT', '/api/schedule', schedule, { keepalive });
      }
      attempt = 0;
      clearTimeout(retryTimer);
      s = saveState({ lastOk: Date.now(), pending: false, error: null, hash });
      changed(); reschedule();
      return true;
    } catch (e) {
      const offline = e.status === 0 && !navigator.onLine;
      saveState({ pending: true, error: offline ? null : e.message || 'error' });
      changed(); reschedule(); // fall back to local timers meanwhile
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => syncNow(), BACKOFF[Math.min(attempt++, BACKOFF.length - 1)]);
      return false;
    }
  })();
  try { return await inflight; } finally { inflight = null; }
}

async function reRegister() {
  const cfg = pushConfig();
  const sub = await currentSubscription(cfg);
  const { deviceId, token } = await api('POST', '/api/register', { subscription: sub.toJSON() }, { auth: false, cfg });
  saveState({ deviceId, token, endpoint: sub.endpoint, serverUrl: cfg.serverUrl });
}

/** On app open: retry a queued delete, follow a rotated subscription, and sync. */
export async function pushOnOpen() {
  await flushPendingDelete();
  if (!pushEnabled()) return;
  const s = loadState();
  try {
    if (Notification.permission === 'granted') {
      const sub = await currentSubscription(pushConfig());
      if (sub && sub.endpoint !== s.endpoint) {
        await api('POST', '/api/subscription', { subscription: sub.toJSON() });
        saveState({ endpoint: sub.endpoint });
      }
    }
  } catch { /* the sync below reports problems */ }
  await syncNow({ force: true });
}

/** Wire the triggers: online, page hidden, and a periodic roll-forward of the 14-day window. */
export function initPush() {
  window.addEventListener('online', () => { if (loadState().pending) syncNow(); flushPendingDelete(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && pushEnabled()) syncNow({ keepalive: true });
  });
  setInterval(() => {
    const s = loadState();
    // Daily: refresh near-term completions/skips (the rules themselves don't expire).
    if (pushEnabled() && (!s.lastOk || Date.now() - s.lastOk > RESYNC_AFTER)) syncNow({ force: true });
  }, 3600000);
  pushOnOpen();
}
