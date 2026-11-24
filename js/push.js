// Reminders while the app is closed: Web Push via the optional server in server/.
// One subscription per device covers every profile. The app sends the server one RULE per task or
// habit reminder (local time + recurrence + time zone) and replaces the set after every change;
// the server works out each occurrence, so reminders keep coming even if the app isn't opened.
// Device credentials live in their own localStorage key, so exports never include them.
import { PUSH_SERVER_URL, VAPID_PUBLIC_KEY } from './pushConfig.js';
import { getProfiles, readProfileState, getState, update } from './store.js';
import { reschedule } from './notify.js';
import { todayKey, addDays, timeToMin, minToTime, startOfWeek, fmtTime } from './dates.js';
import { activeHabits, habitDone, weekCount, habitWarnAt, reminderText } from './logic.js';
import { isIOS, isStandalone } from './pwa.js';
import { blockedHelp } from './reminders.js';
import { habitText } from './habitIcon.js';

const STATE_KEY = 'dailyTracker:push';
const CONFIG_KEY = 'dailyTracker:pushConfig';
const MAX_RULES = 500;
const NEAR_DAYS = 60; // completions/exceptions sent for the near term only
const DEBOUNCE_MS = 2000;
const BACKOFF = [5000, 30000, 120000, 600000, 1800000];
const RESYNC_AFTER = 12 * 3600000; // re-send at least twice a day (near-term skip dates roll forward)
const HEALTH_EVERY = 3600000;       // check the server's timer hourly (and on open / when shown)
const HEALTH_MAX_AGE = 2 * 3600000; // a health result older than this no longer counts

// ---------- persisted state ----------
function readJSON(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }
function writeJSON(key, v) { try { if (v === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage full: next sync retries */ } }
const loadState = () => readJSON(STATE_KEY) || {};
function saveState(patch) { const s = { ...loadState(), ...patch }; writeJSON(STATE_KEY, s); return s; }

const listeners = new Set();
export function onPushChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const changed = () => listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });

// ---------- configuration ----------
/**
 * { serverUrl, publicKey, registerKey, overridden } — Settings overrides win over js/pushConfig.js.
 * The register key is only ever entered in Settings (stored on this device), never in code,
 * because js/pushConfig.js is published with the app.
 */
export function pushConfig() {
  const o = readJSON(CONFIG_KEY) || {};
  const serverUrl = String(o.serverUrl || PUSH_SERVER_URL || '').trim().replace(/\/+$/, '');
  const publicKey = String(o.publicKey || VAPID_PUBLIC_KEY || '').trim();
  return { serverUrl, publicKey, registerKey: String(o.registerKey || '').trim(), overridden: !!(o.serverUrl || o.publicKey || o.registerKey) };
}
export const pushConfigured = () => { const c = pushConfig(); return !!(c.serverUrl && c.publicKey); };

// ---------- the register key travels with the account (SYNC.md › Register key) ----------
// The key's edit time and device (registerKeyT / registerKeyDev) are kept next to it, so syncing
// compares real edit times (latest wins) and a key that wasn't just typed never gets a new time.
// A key stored before this existed has t = 0 (any key typed anywhere wins over it).
let stamper = (prevT) => ({ t: Math.max(Date.now(), (prevT || 0) + 1), dev: '' });
/** sync.js stamps edits with its clock (server-corrected) and device id. */
export function setRegisterKeyStamper(fn) { stamper = fn; }
/** { key, t, dev } of this device's register key ('' when none). */
export function registerKeyMeta() {
  const o = readJSON(CONFIG_KEY) || {};
  return { key: String(o.registerKey || '').trim(), t: Number.isSafeInteger(o.registerKeyT) && o.registerKeyT >= 0 ? o.registerKeyT : 0, dev: typeof o.registerKeyDev === 'string' ? o.registerKeyDev : '' };
}
export const validRegisterKey = (k) => typeof k === 'string' && /^[\x21-\x7e]{8,200}$/.test(k);
function writeKeyMeta(o, key, t, dev) {
  if (key) o.registerKey = key; else delete o.registerKey;
  o.registerKeyT = t; o.registerKeyDev = dev;
}
/** The account's copy is newer: take it (keeping its edit time). */
export function applyRegisterKey(key, t, dev) {
  if (!validRegisterKey(key)) return false;
  const o = readJSON(CONFIG_KEY) || {};
  const same = String(o.registerKey || '').trim() === key;
  writeKeyMeta(o, key, t, dev);
  writeJSON(CONFIG_KEY, o);
  if (!same) changed();
  return true;
}
/** Give the key (unchanged) a new edit time / device – only when the server refused its time, or to name the device. */
export function restampRegisterKey(t, dev) {
  const o = readJSON(CONFIG_KEY) || {};
  if (!o.registerKey) return;
  o.registerKeyT = t; o.registerKeyDev = dev;
  writeJSON(CONFIG_KEY, o);
}
/** Set only the register key (e.g. the one typed when creating an account). */
export function setRegisterKey(key) {
  key = String(key || '').trim();
  if (!validRegisterKey(key)) return false;
  const o = readJSON(CONFIG_KEY) || {};
  if (String(o.registerKey || '').trim() === key) return true;
  const st = stamper(registerKeyMeta().t);
  writeKeyMeta(o, key, st.t, st.dev);
  writeJSON(CONFIG_KEY, o);
  changed();
  return true;
}

export function setPushConfig({ serverUrl = '', publicKey = '', registerKey = '' }) {
  serverUrl = serverUrl.trim().replace(/\/+$/, '');
  publicKey = publicKey.trim();
  registerKey = registerKey.trim();
  if (serverUrl && !/^https:\/\/[^\s/]+/i.test(serverUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(serverUrl)) throw new Error('The server URL must start with https://');
  if (publicKey && !/^[A-Za-z0-9_-]{80,100}$/.test(publicKey)) throw new Error('That doesn’t look like a VAPID public key');
  if (registerKey && !/^[\x21-\x7e]{8,200}$/.test(registerKey)) throw new Error('That doesn’t look like a register key');
  // Only keep what differs from the bundled js/pushConfig.js, so a later app update can change
  // those defaults; the register key is never bundled, so it's always stored here.
  const o = {};
  if (serverUrl && serverUrl !== String(PUSH_SERVER_URL || '').trim().replace(/\/+$/, '')) o.serverUrl = serverUrl;
  if (publicKey && publicKey !== String(VAPID_PUBLIC_KEY || '').trim()) o.publicKey = publicKey;
  // A changed key is a new edit (it syncs to the account); an unchanged one keeps its edit time.
  const prev = registerKeyMeta();
  if (registerKey !== prev.key) { const st = stamper(prev.t); writeKeyMeta(o, registerKey, st.t, st.dev); }
  else if (registerKey || prev.t) writeKeyMeta(o, registerKey, prev.t, prev.dev);
  writeJSON(CONFIG_KEY, Object.keys(o).length ? o : null);
  changed();
}

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const pushEnabled = () => !!loadState().on && pushConfigured();

/** What's wrong with the server, in plain words (null when it's fine). h = last /api/health result. */
export function healthProblem(h, cfg = pushConfig()) {
  if (!h) return null;
  if (!h.reachable) return 'Can’t reach your server right now.';
  if (h.db === false) return 'Your server’s database isn’t set up – run “npm run db:init” (server/README.md, step 6).';
  if (!h.vapidPublic) return 'Your server has no public key – set VAPID_PUBLIC_KEY in wrangler.toml and deploy again (step 7).';
  if (!h.vapidPrivate) return 'Your server is missing its private key (or it isn’t valid) – run “npx wrangler secret put VAPID_PRIVATE_KEY” (step 9).';
  if (!h.registerKey) return 'Your server has no register key – run “npx wrangler secret put REGISTER_KEY” (step 9).';
  if (h.vapidPublicKey && cfg.publicKey && h.vapidPublicKey !== cfg.publicKey) return 'The public key in Advanced doesn’t match your server’s – paste the one from your server setup.';
  if (h.lastCronError) return `Your server’s timer reported an error: ${h.lastCronError}`;
  if (!h.lastCronAt) return 'Your server’s timer hasn’t run yet. It runs every minute once deployed – check “Triggers” for the Worker in the Cloudflare dashboard.';
  if (h.time - h.lastCronAt > 5 * 60000) return 'Your server’s timer isn’t running – check “Triggers” for the Worker in the Cloudflare dashboard.';
  return null;
}

/** Server error messages → plain wording. */
function plainError(e) {
  const m = String(e?.message || e || '');
  if (e?.status === 0) return m === 'offline' ? 'You’re offline' : 'Can’t reach your server';
  if (/Origin not allowed/.test(m)) return `Your server doesn’t allow this app’s address – add ${location.origin} to ALLOWED_ORIGINS (server/README.md, step 7)`;
  if (/Wrong register key/.test(m)) return 'The register key doesn’t match your server’s – check it in Advanced';
  if (/REGISTER_KEY is missing|not set up/i.test(m)) return 'Your server has no register key yet – run “npx wrangler secret put REGISTER_KEY” (step 9)';
  if (/Device limit/.test(m)) return 'Your server already has its maximum number of devices (MAX_DEVICES)';
  if (/Too many requests/.test(m)) return 'Your server is busy – trying again shortly';
  if (/known push service/.test(m)) return 'This browser’s push service isn’t supported by your server';
  if (e?.status >= 500) return 'Your server had a problem – trying again shortly';
  return m || 'Something went wrong';
}

/** True while the server holds an up-to-date schedule AND its timer is running: local timers then stay off. */
export function pushCoversReminders() {
  // No permission, no notifications at all – so nothing is "covered".
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  const s = loadState();
  const h = s.health;
  return !!(s.on && pushConfigured() && s.lastOk && !s.pending && !s.error && !s.overLimit
    && h && Date.now() - h.at < HEALTH_MAX_AGE && !healthProblem(h));
}

/** The caveat shown when reminders will NOT arrive while the app is closed (null when they will). */
export const OPEN_APP_ONLY = 'Reminders fire while the app is open or was recently used.';
export const reminderReach = () => (pushCoversReminders() ? null : OPEN_APP_ONLY);

/** Human status for Settings. { kind: 'on'|'pending'|'offline'|'error'|'off'|'ios'|'blocked'|'server', text, help? } */
export function pushStatus() {
  const s = loadState();
  if (isIOS() && !isStandalone()) return { kind: 'ios', text: 'On iPhone and iPad this needs Daily Tracker added to your Home Screen (Share › Add to Home Screen) and iOS 16.4 or later.' };
  if (!pushSupported()) return { kind: 'unsupported', text: 'This browser can’t receive push notifications.' };
  if (!s.on) return { kind: 'off', text: 'When on, your server sends the reminders, so they arrive even when the app is closed. Things you complete on another device can’t reach the server until you open the app here.' };
  if (Notification.permission === 'denied') return { kind: 'blocked', text: `Notifications are blocked – closed-app reminders can’t appear. ${blockedHelp()}` };
  if (s.pending && !navigator.onLine) return { kind: 'offline', text: 'Waiting to sync (offline). Your latest changes will be sent when you’re back online. Reminders come from this device meanwhile.' };
  if (s.error) return { kind: 'error', text: `Couldn’t sync: ${s.error}. Retrying automatically; reminders come from this device meanwhile.` };
  const hp = healthProblem(s.health);
  if (hp) return { kind: 'server', text: `${hp} Reminders come from this device meanwhile (only while it’s open or recently used).` };
  if (s.pending || !s.lastOk) return { kind: 'pending', text: 'Syncing reminders with your server…' };
  if (s.overLimit) return { kind: 'server', text: `You have ${s.overLimit} reminders; your server takes 500. The first 500 are sent from the server; the rest only appear while the app is open.` };
  return { kind: 'on', text: `On – reminders are sent from your server (last synced ${new Date(s.lastOk).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}).` };
}

/** Ask the server how it is (config + timer heartbeat). Local timers come back when it's unhealthy. */
export async function checkHealth() {
  if (!pushEnabled()) return null;
  let h;
  try {
    const data = await api('GET', '/api/health', undefined, { auth: false });
    h = { ...data, reachable: true, at: Date.now() };
  } catch {
    h = { reachable: false, at: Date.now() };
  }
  const before = pushCoversReminders();
  saveState({ health: h });
  if (before !== pushCoversReminders()) reschedule();
  changed();
  return h;
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
    const pname = multi ? profile.name : '';
    const text = (o) => { if (hideText) return { title: HIDDEN_TITLE, body: HIDDEN_BODY }; const r = reminderText({ ...o, profile: pname, fmt }); return { title: r.title.slice(0, 120), body: r.body.slice(0, 240) }; };
    for (const t of st.tasks) {
      // A timed task reminds `reminder` minutes before its start; an Anytime one at its reminderAt time of day.
      const timedRem = !!t.time && t.reminder !== null && t.reminder !== undefined;
      if (!timedRem && !(!t.time && t.reminderAt)) continue;
      const recur = RECUR.has(t.recur?.type) ? t.recur.type : 'none';
      if (recur === 'none' && (t.done || t.date < from || t.missedDates?.[t.date])) continue;
      const mins = timedRem ? timeToMin(t.time) - (t.reminder || 0) : timeToMin(t.reminderAt);
      const r = {
        id: safeId(`${profile.id}:t:${t.id}`).slice(0, 128), kind: 'task',
        ...text({ kind: timedRem ? 'task' : 'anytime', name: t.title, lead: t.reminder || 0, time: t.time }),
        url: deepLink('task', profile.id, t.id), tag: `${profile.id}:t:${t.id}:{date}`.slice(0, 128),
        time: minToTime(((mins % 1440) + 1440) % 1440), offsetDays: Math.floor(mins / 1440),
        recur: recur === 'none' ? { type: 'none' } : { type: recur, start: t.date, ...(recur === 'weekly' ? { days: t.recur.days || [] } : {}), ...(recur === 'interval' ? { interval: Math.max(1, t.recur.interval || 1) } : {}) },
        exceptions: nearDates(t.exceptions || [], from, '9999-12-31'),
        // Done or marked missed: no reminder that day.
        skipDates: nearDates([...Object.keys(t.doneDates || {}).filter((k) => t.doneDates[k]), ...Object.keys(t.missedDates || {})], from, to),
      };
      if (recur === 'none') r.date = t.date;
      rules.push(r);
    }
    for (const hb of activeHabits(st)) {
      const warnAt = habitWarnAt(st, hb);
      if (warnAt === null) continue;
      const type = hb.schedule?.type;
      const start = /^\d{4}-\d{2}-\d{2}$/.test(hb.createdAt || '') && hb.createdAt < today ? hb.createdAt : today;
      const recur = type === 'days' ? { type: 'weekly', start, days: [...(hb.schedule.days || [])] } : { type: 'daily', start };
      if (type === 'days' && !recur.days.length) continue;
      const skip = [];
      for (let k = from; k <= addDays(today, 1); k = addDays(k, 1)) if (habitDone(st, hb, k)) skip.push(k);
      skip.push(...Object.keys(hb.missed || {})); // marked missed: no reminder that day
      // X-per-week: once this week's target is met, skip the rest of the week (later weeks remind daily).
      if (type === 'perWeek' && weekCount(st, hb, today) >= (hb.schedule.times || 1)) {
        const ws = startOfWeek(today, st.settings.weekStart ?? 1);
        for (let i = 0; i < 7; i++) { const k = addDays(ws, i); if (k >= today) skip.push(k); }
      }
      // "N minutes left" warning: one more habit rule at target − warn, with the same done/missed skips.
      if (warnAt !== null) {
        rules.push({
          id: safeId(`${profile.id}:hw:${hb.id}`).slice(0, 128), kind: 'habit',
          ...text({ kind: 'habit', name: hb.name, left: timeToMin(hb.target) - warnAt, time: hb.target }),
          url: deepLink('habit', profile.id, hb.id), tag: `${profile.id}:hw:${hb.id}:{date}`.slice(0, 128),
          time: minToTime(warnAt), offsetDays: 0, recur, exceptions: [], skipDates: nearDates(skip, from, to),
        });
      }
    }
  }
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
  return { tz, rules: rules.slice(0, MAX_RULES), total: rules.length };
}

// ---------- server calls ----------
class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
async function api(method, path, body, { auth = true, keepalive = false, state = loadState(), cfg = pushConfig() } = {}) {
  const headers = body === undefined ? {} : { 'Content-Type': 'application/json' };
  if (auth) { headers.Authorization = 'Bearer ' + state.token; headers['X-Device'] = state.deviceId; }
  if (path === '/api/register') headers['X-Register-Key'] = cfg.registerKey;
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
  if (!cfg.registerKey) return { ok: false, message: 'Enter your server’s register key in Advanced first.' };
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
    return { ok: false, message: `Couldn’t turn it on: ${plainError(e)}.` };
  }
  // Reminders only exist for profiles with notifications on: switch them on for this profile.
  if (!getState().settings.notifications) update((s) => { s.settings.notifications = true; });
  changed();
  await Promise.all([syncNow(), checkHealth()]);
  const problem = healthProblem(loadState().health);
  return problem ? { ok: true, warning: `Turned on, but: ${problem}` } : { ok: true };
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
    const { tz, rules, total } = buildRules();
    const schedule = { tz, rules };
    const hash = hashOf(schedule);
    if ((loadState().overLimit || 0) !== (total > MAX_RULES ? total : 0)) saveState({ overLimit: total > MAX_RULES ? total : 0 });
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
      saveState({ pending: true, error: offline ? null : plainError(e) });
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
  await Promise.all([syncNow({ force: true }), checkHealth()]);
}

/** Wire the triggers: online, page hidden/shown, hourly health + twice-daily refresh. */
export function initPush() {
  window.addEventListener('online', () => { if (loadState().pending) syncNow(); flushPendingDelete(); checkHealth(); });
  document.addEventListener('visibilitychange', () => {
    if (!pushEnabled()) return;
    if (document.visibilityState === 'hidden') syncNow({ keepalive: true });
    else checkHealth();
  });
  setInterval(() => {
    if (!pushEnabled()) return;
    checkHealth();
    // Refresh near-term completions/skips (the rules themselves don't expire).
    const s = loadState();
    if (!s.lastOk || Date.now() - s.lastOk > RESYNC_AFTER) syncNow({ force: true });
  }, HEALTH_EVERY);
  pushOnOpen();
}
