// In-app reminders. Without a push server, reminders are scheduled with setTimeout while the
// app is open (or recently backgrounded) and shown via the service worker. With the optional
// push server (js/push.js) the same occurrences are sent from the server instead.
import { getProfiles, readProfileState } from './store.js';
import { todayKey, addDays, dateAt, fmtTime, timeToMin, minToTime } from './dates.js';
import { tasksOn, isTaskDone, activeHabits, isDueOn, habitVal, habitWarns, reminderText } from './logic.js';
import { habitText } from './habitIcon.js';
import { pushCoversReminders, deepLink, hideTextOn, HIDDEN_TITLE, HIDDEN_BODY } from './push.js';

const FIRED_KEY = 'dailyTracker:fired';
let timers = [];

export const notifySupported = () => 'Notification' in window;
export const permission = () => (notifySupported() ? Notification.permission : 'unsupported');

export async function requestPermission() {
  if (!notifySupported()) return 'unsupported';
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

function loadFired() {
  try { return JSON.parse(localStorage.getItem(FIRED_KEY) || '{}'); } catch { return {}; }
}
function markFired(key) {
  const f = loadFired();
  f[key] = Date.now();
  const cutoff = Date.now() - 3 * 86400000;
  for (const k in f) if (f[k] < cutoff) delete f[k];
  try { localStorage.setItem(FIRED_KEY, JSON.stringify(f)); } catch { /* ignore */ }
}

export async function showNotification(title, body, tag, url = './') {
  const opts = { body, tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url } };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) { await reg.showNotification(title, opts); return true; }
  } catch { /* fall through */ }
  try { new Notification(title, opts); return true; } catch { return false; }
}

/**
 * Upcoming reminder occurrences for EVERY profile with notifications on, between `from` and `until`
 * (ms). Used by the in-app timers (next 36 h) and by the push schedule (next 14 days).
 * Each: { key, at, title, body, url, profileId, stillDue(state) }. Keys double as notification tags,
 * so a local notification and a pushed one for the same occurrence replace each other.
 */
export function reminderOccurrences(from, until, { profiles = getProfiles() } = {}) {
  const out = [];
  const multi = profiles.length > 1;
  const today = todayKey();
  const days = [];
  for (let k = addDays(today, -1); dateAt(k, '00:00').getTime() <= until; k = addDays(k, 1)) days.push(k);
  for (const profile of profiles) {
    const st = readProfileState(profile.id);
    if (!st || !st.settings.notifications) continue;
    const fmt = st.settings.timeFormat;
    const pname = multi ? profile.name : '';
    const add = (key, at, text, k, stillDue) => {
      if (at < from || at > until) return;
      out.push({ key: `${profile.id}:${key}`, at, title: text.title, body: text.body, url: deepLink(key[0] === 't' ? 'task' : 'habit', profile.id, key.split(':')[1], k), profileId: profile.id, stillDue });
    };
    for (const k of days) {
      for (const t of tasksOn(st, k)) {
        const timedRem = !!t.time && t.reminder !== null;
        if ((!timedRem && !(!t.time && t.reminderAt)) || isTaskDone(t, k) || t.missedDates?.[k]) continue;
        // Local fire time = task time minus the lead, as wall-clock time (same as the push server).
        // An Anytime task reminds at its own time of day (reminderAt) on its day.
        const mins = timedRem ? timeToMin(t.time) - t.reminder : timeToMin(t.reminderAt);
        const at = dateAt(addDays(k, Math.floor(mins / 1440)), minToTime(((mins % 1440) + 1440) % 1440)).getTime();
        add(`t:${t.id}:${k}`, at, reminderText({ kind: timedRem ? 'task' : 'anytime', name: t.title, profile: pname, lead: t.reminder || 0, time: t.time, fmt }), k,
          (s2) => { const x = s2.tasks.find((y) => y.id === t.id); return x && !isTaskDone(x, k) && !x.missedDates?.[k]; });
      }
      for (const hb of activeHabits(st)) {
        if (!isDueOn(st, hb, k) || hb.missed?.[k]) continue;
        // "N minutes left": at each time minus the warning, only while that instance isn't done
        // (one time for the whole habit: until the goal is met; per-instance times: instance i is done at count ≥ i).
        for (const w of habitWarns(st, hb)) {
          if (habitVal(st, hb, k) >= w.need) continue;
          const stillDue = (s2) => { const x = s2.habits.find((y) => y.id === hb.id); return x && !x.archived && habitVal(s2, x, k) < w.need && !x.missed?.[k]; };
          add(`hw:${hb.id}:${k}${w.idx ? ':' + w.idx : ''}`, dateAt(k, minToTime(w.at)).getTime(), reminderText({ kind: 'habit', name: hb.name, profile: pname, left: w.left, time: w.time, fmt }), k, stillDue);
        }
      }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Schedule reminders for EVERY profile (each with its own notifications setting). */
export function reschedule() {
  timers.forEach(clearTimeout);
  timers = [];
  if (permission() !== 'granted') return;
  // While the push server has an up-to-date schedule, it sends these; no duplicate local timers.
  if (pushCoversReminders()) return;
  const now = Date.now();
  const fired = loadFired();
  for (const r of reminderOccurrences(now - 60000, now + 36 * 3600000)) {
    // Keyed to the scheduled fire time too: moving the task later (or earlier) re-arms its reminder.
    const fk = `${r.key}@${r.at}`;
    if (fired[fk]) continue;
    // Re-read the profile's data when the timer fires, so completed items don't notify.
    timers.push(setTimeout(() => {
      const s2 = readProfileState(r.profileId);
      if (!s2 || !s2.settings.notifications || !r.stillDue(s2) || loadFired()[fk]) return;
      markFired(fk);
      // Same tag and deep link as the pushed copy of this occurrence.
      if (hideTextOn()) showNotification(HIDDEN_TITLE, HIDDEN_BODY, r.key, r.url);
      else showNotification(r.title, r.body, r.key, r.url);
    }, Math.max(0, r.at - now)));
  }
}
