// Daily Tracker push server (Cloudflare Worker + D1).
// The app sends each device's reminder RULES (recurrence + local time + time zone). The server
// works out each rule's next fire time, and a cron trigger sends due reminders as Web Push
// messages, so reminders keep coming even if the app isn't opened for weeks.
import { b64urlDecode } from './b64.js';
import { HttpError, json, err, readJson, sha256Hex, timingSafeEqual, randomId, isStr, rateLimit } from './util.js';
import { accountRoute, authSession, purgeAccounts } from './account.js';
import { syncRoute } from './sync.js';
import { invitesRoute } from './invites.js';
import { filesRoute, purgeFiles } from './files.js';
import { importVapidKeys, sendPush } from './webpush.js';
import { nextFire, isDateKey, isValidTimeZone, localToUTC, addDays } from './recur.js';

export const LIMITS = {
  maxRules: 500,
  maxDates: 400,              // exceptions / skipDates per rule
  newRuleGraceMs: 60000,      // a brand-new rule may fire for a time up to 1 min ago
  lateWindowMs: 15 * 60000,   // the cron sends reminders up to 15 min late (missed runs), never later
  scheduleBody: 256 * 1024,
  smallBody: 8 * 1024,
  sendBatch: 200,             // pushes per cron run (free-tier CPU friendly)
  perDevice: 10,              // due rules per device per cron run (round-robin, so no device starves another)
  concurrency: 6,
  maxDevicesPerAccount: 5,    // device sign-ups through an account session (the register-key path is not capped per account)
  maxDevicesDefault: 20,      // override with the MAX_DEVICES var
  cronStaleMs: 5 * 60000,     // health: the timer counts as stopped after 5 min without a run
  rate: { register: 10, schedule: 120, subscription: 30 }, // per hour (register: per IP; others: per device)
};

// ---------- HTTP helpers ----------
function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device, X-Register-Key, X-Invite-Code',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

// ---------- Validation ----------
// Only real browser push services: the server must never be usable to call arbitrary hosts.
const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com'];
const PUSH_SUFFIXES = ['.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com'];
export function isPushServiceUrl(u) {
  if (typeof u === 'string') { try { u = new URL(u); } catch { return false; } }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  if (/^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return false; // no IP literals
  return PUSH_HOSTS.includes(host) || PUSH_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
}

export function validateSubscription(sub) {
  if (!sub || typeof sub !== 'object') throw new HttpError(400, 'subscription is required');
  const { endpoint, keys } = sub;
  if (!isStr(endpoint, 1024, 10)) throw new HttpError(400, 'Invalid endpoint');
  let u;
  try { u = new URL(endpoint); } catch { throw new HttpError(400, 'Invalid endpoint'); }
  if (!isPushServiceUrl(u)) throw new HttpError(400, 'Endpoint is not a known push service');
  if (!keys || !isStr(keys.p256dh, 200, 80) || !isStr(keys.auth, 50, 16)) throw new HttpError(400, 'Invalid subscription keys');
  try {
    const p = b64urlDecode(keys.p256dh), a = b64urlDecode(keys.auth);
    if (p.length !== 65 || p[0] !== 4 || a.length !== 16) throw new Error();
  } catch { throw new HttpError(400, 'Invalid subscription keys'); }
  return { endpoint, p256dh: keys.p256dh, auth: keys.auth };
}

const RECUR_TYPES = ['none', 'daily', 'weekdays', 'weekly', 'monthly', 'interval'];
const dateList = (v, bad, name) => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > LIMITS.maxDates || !v.every(isDateKey)) throw bad(`${name} must be a list of up to ${LIMITS.maxDates} YYYY-MM-DD dates`);
  return [...new Set(v)].sort();
};

/** Strictly validate a schedule { tz, rules }. Returns { tz, rules } cleaned. */
export function validateSchedule(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Body must be an object');
  if (!isValidTimeZone(body.tz)) throw new HttpError(400, 'tz must be an IANA time zone');
  if (!Array.isArray(body.rules)) throw new HttpError(400, 'rules must be an array');
  if (body.rules.length > LIMITS.maxRules) throw new HttpError(400, `At most ${LIMITS.maxRules} rules`);
  const seen = new Set();
  const rules = body.rules.map((it, i) => {
    const bad = (m) => new HttpError(400, `rules[${i}]: ${m}`);
    if (!it || typeof it !== 'object') throw bad('must be an object');
    if (!isStr(it.id, 128, 1) || !/^[\w:.-]+$/.test(it.id)) throw bad('invalid id');
    if (seen.has(it.id)) throw bad('duplicate id');
    seen.add(it.id);
    if (!['task', 'habit'].includes(it.kind)) throw bad('kind must be task or habit');
    if (!isStr(it.title, 120, 1)) throw bad('title must be 1–120 characters');
    if (!isStr(it.body ?? '', 240)) throw bad('body must be at most 240 characters');
    const url = it.url ?? './';
    // Only same-app relative URLs (no other origins, no javascript:).
    if (!isStr(url, 300) || !/^(\.\/|\/(?!\/)|#)[^\s\\]*$/.test(url)) throw bad('url must be a relative app URL');
    if (!isStr(it.tag ?? '', 128)) throw bad('tag too long');
    if (typeof it.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(it.time)) throw bad('time must be HH:MM');
    const offsetDays = it.offsetDays ?? 0;
    if (!Number.isInteger(offsetDays) || offsetDays < -7 || offsetDays > 0) throw bad('offsetDays must be an integer from -7 to 0');
    const r = it.recur || { type: 'none' };
    if (!r || typeof r !== 'object' || !RECUR_TYPES.includes(r.type)) throw bad('invalid recur.type');
    const recur = { type: r.type };
    if (r.type === 'none') {
      if (!isDateKey(it.date)) throw bad('date (YYYY-MM-DD) is required for one-off rules');
    } else {
      if (!isDateKey(r.start)) throw bad('recur.start must be YYYY-MM-DD');
      recur.start = r.start;
      if (r.type === 'weekly') {
        const days = r.days ?? [];
        if (!Array.isArray(days) || days.length > 7 || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) throw bad('recur.days must be weekday numbers 0–6');
        recur.days = [...new Set(days)].sort();
      }
      if (r.type === 'interval') {
        if (!Number.isInteger(r.interval) || r.interval < 1 || r.interval > 366) throw bad('recur.interval must be 1–366');
        recur.interval = r.interval;
      }
    }
    if (it.until !== undefined && it.until !== null && !isDateKey(it.until)) throw bad('until must be YYYY-MM-DD');
    return {
      id: it.id, kind: it.kind, title: it.title, body: it.body ?? '', url, tag: it.tag || it.id, time: it.time, offsetDays,
      recur, date: r.type === 'none' ? it.date : null, exceptions: dateList(it.exceptions, bad, 'exceptions'),
      skipDates: dateList(it.skipDates, bad, 'skipDates'), until: it.until || null,
    };
  });
  return { tz: body.tz, rules };
}

const fill = (tpl, date) => String(tpl).split('{date}').join(date);

/** Rule object as stored (definition JSON) → the shape nextFire() expects. */
const ruleFromRow = (row) => JSON.parse(row.def);

// ---------- Auth ----------
async function authDevice(request, env) {
  const id = request.headers.get('X-Device') || '';
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(request.headers.get('Authorization') || '');
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(id) || !m) throw new HttpError(401, 'Missing credentials');
  const row = await env.DB.prepare('SELECT id, token_hash FROM devices WHERE id = ?1').bind(id).first();
  if (!row || !timingSafeEqual(row.token_hash, await sha256Hex(m[1]))) throw new HttpError(401, 'Unknown device or bad token');
  return id;
}

// ---------- Routes ----------
/** Paths of the account/sync API, whose responses (errors too) include the server time `now`. */
const isAccountPath = (path) => path === '/api/account' || path === '/api/invites' || /^\/api\/(account|passkey|sync|files|invites)\//.test(path);

async function route(request, env, now) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const ip = request.headers.get('CF-Connecting-IP') || 'local';

  if (path === '/api/health' && request.method === 'GET') return json(await health(env, now));

  // Accounts, passkeys and sync (see SYNC.md). These answer with `now` in every response.
  if (isAccountPath(path)) {
    const res = path.startsWith('/api/sync/') ? await syncRoute(request, env, now, path, url)
      : path.startsWith('/api/files/') ? await filesRoute(request, env, now, path, url)
      : path.startsWith('/api/invites') ? await invitesRoute(request, env, now, path, ip)
      : await accountRoute(request, env, now, path, ip);
    if (res) return res;
    throw new HttpError(404, 'Not found');
  }

  if (path === '/api/register' && request.method === 'POST') {
    // Only the server owner's register key, or a signed-in account session (Authorization: Bearer, no
    // register key sent), can add devices.
    if (!env.REGISTER_KEY) throw new HttpError(503, 'Server not set up: REGISTER_KEY is missing');
    await rateLimit(env, 'reg:' + ip, LIMITS.rate.register, now);
    const given = request.headers.get('X-Register-Key') || '';
    let sessionAccount = null; // set when the sign-up goes through an account session (capped per account)
    if (!given && request.headers.get('Authorization')) sessionAccount = (await authSession(request, env, now)).account.id;
    else if (!timingSafeEqual(await sha256Hex(given), await sha256Hex(env.REGISTER_KEY))) throw new HttpError(403, 'Wrong register key');
    const max = Number(env.MAX_DEVICES) > 0 ? Number(env.MAX_DEVICES) : LIMITS.maxDevicesDefault;
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM devices').first();
    if (n >= max) throw new HttpError(503, 'Device limit reached');
    if (sessionAccount) {
      const mine = await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE account_id = ?1').bind(sessionAccount).first();
      if (mine.n >= LIMITS.maxDevicesPerAccount) throw new HttpError(409, `This account already has ${LIMITS.maxDevicesPerAccount} devices with notifications; remove one first`);
    }
    const body = await readJson(request, LIMITS.smallBody);
    const sub = validateSubscription(body.subscription);
    const deviceId = randomId(16); // 128-bit
    const token = randomId(32);
    await env.DB.prepare(
      'INSERT INTO devices (id, token_hash, endpoint, p256dh, auth, tz, created_at, updated_at, last_seen, account_id) VALUES (?1, ?2, ?3, ?4, ?5, \'UTC\', ?6, ?6, ?6, ?7)',
    ).bind(deviceId, await sha256Hex(token), sub.endpoint, sub.p256dh, sub.auth, now, sessionAccount).run();
    return json({ deviceId, token }, 201);
  }

  if (path === '/api/schedule' && request.method === 'PUT') {
    const id = await authDevice(request, env);
    await rateLimit(env, 'sch:' + id, LIMITS.rate.schedule, now);
    const { tz, rules } = validateSchedule(await readJson(request, LIMITS.scheduleBody));
    // Rules the device already had keep firing for occurrences missed in the last 15 minutes;
    // brand-new rules only fire from (about) now on. Occurrences already sent never repeat.
    const known = new Set((await env.DB.prepare('SELECT rule_id FROM rules WHERE device_id = ?1').bind(id).all()).results.map((r) => r.rule_id));
    const firedRows = (await env.DB.prepare('SELECT rule_id, date, at FROM fired WHERE device_id = ?1').bind(id).all()).results;
    const firedByRule = new Map();
    for (const f of firedRows) (firedByRule.get(f.rule_id) || firedByRule.set(f.rule_id, []).get(f.rule_id)).push(f);
    // A sent-marker only counts while the rule still fires at the time it was sent for: moving the
    // task's time (or date) later re-arms it. fired.at holds the scheduled fire time (older rows hold
    // the send time, up to 15 min after it), so "sent for this fire time" = sent at/after it, within the late window.
    const firedFor = (r) => {
      const set = new Set();
      for (const f of firedByRule.get(r.id) || []) {
        const fireAt = localToUTC(addDays(f.date, r.offsetDays || 0), r.time, tz);
        if (f.at >= fireAt && f.at - fireAt < LIMITS.lateWindowMs) set.add(f.date);
      }
      return set;
    };
    const stmts = [env.DB.prepare('DELETE FROM rules WHERE device_id = ?1').bind(id)];
    for (const r of rules) {
      const from = known.has(r.id) ? now - LIMITS.lateWindowMs : now - LIMITS.newRuleGraceMs;
      const next = nextFire(r, tz, from, { fired: firedFor(r) });
      stmts.push(env.DB.prepare('INSERT INTO rules (device_id, rule_id, def, next_at, next_date) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind(id, r.id, JSON.stringify(r), next ? next.at : null, next ? next.date : null));
    }
    stmts.push(env.DB.prepare('UPDATE devices SET tz = ?2, last_seen = ?3 WHERE id = ?1').bind(id, tz, now));
    await env.DB.batch(stmts);
    return json({ ok: true, count: rules.length });
  }

  if (path === '/api/subscription' && request.method === 'POST') {
    const id = await authDevice(request, env);
    await rateLimit(env, 'sub:' + id, LIMITS.rate.subscription, now);
    const sub = validateSubscription((await readJson(request, LIMITS.smallBody)).subscription);
    await env.DB.prepare('UPDATE devices SET endpoint = ?2, p256dh = ?3, auth = ?4, updated_at = ?5, last_seen = ?5 WHERE id = ?1')
      .bind(id, sub.endpoint, sub.p256dh, sub.auth, now).run();
    return json({ ok: true });
  }

  if (path === '/api/device' && request.method === 'DELETE') {
    const id = await authDevice(request, env);
    await deleteDevice(env, id);
    return json({ ok: true });
  }

  return err(404, 'Not found');
}

const deviceDeletes = (env, id) => ['rules', 'fired'].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE device_id = ?1`).bind(id))
  .concat(env.DB.prepare('DELETE FROM devices WHERE id = ?1').bind(id));
async function deleteDevice(env, id) { await env.DB.batch(deviceDeletes(env, id)); }

export async function handleFetch(request, env, now = Date.now()) {
  const origin = (request.headers.get('Origin') || '').replace(/\/+$/, '');
  const allowed = allowedOrigins(env);
  const okOrigin = origin && allowed.includes(origin);
  const cors = okOrigin ? corsHeaders(origin) : {};
  const path = new URL(request.url).pathname.replace(/\/+$/, '');
  const isHealth = path === '/api/health';
  const extra = isAccountPath(path) ? { now } : undefined;
  if (request.method === 'OPTIONS') return okOrigin ? new Response(null, { status: 204, headers: cors }) : err(403, 'Origin not allowed');
  // Browsers always send Origin on these cross-origin calls; anything else is refused (health is open).
  if (!okOrigin && !isHealth) return err(403, 'Origin not allowed', {}, extra);
  try {
    const res = await route(request, env, now);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  } catch (e) {
    if (e instanceof HttpError) return err(e.status, e.message, cors, (e.extra || extra) && { ...extra, ...e.extra });
    console.error(e?.message || 'error'); // never log request data (tokens, keys, blobs)
    return err(500, 'Server error', cors, extra);
  }
}

// ---------- Health ----------
async function readMeta(env) {
  const out = {};
  for (const r of (await env.DB.prepare('SELECT key, value FROM meta').all()).results) out[r.key] = r.value;
  return out;
}
/** Configuration and timer status, so the app can explain problems in plain words. */
export async function health(env, now = Date.now()) {
  const vapidPublic = typeof env.VAPID_PUBLIC_KEY === 'string' && /^[A-Za-z0-9_-]{86,88}$/.test(env.VAPID_PUBLIC_KEY);
  let vapidPrivate = false;
  if (vapidPublic && env.VAPID_PRIVATE_KEY) {
    try { await importVapidKeys(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY); vapidPrivate = true; } catch { /* invalid */ }
  }
  let db = true, meta = {};
  try { meta = await readMeta(env); } catch { db = false; }
  const lastCronAt = meta.lastCronAt ? Number(meta.lastCronAt) : null;
  const cronOk = !!lastCronAt && now - lastCronAt < LIMITS.cronStaleMs && !meta.lastCronError;
  return {
    ok: vapidPublic && vapidPrivate && !!env.REGISTER_KEY && db && cronOk,
    time: now, vapidPublic, vapidPublicKey: vapidPublic ? env.VAPID_PUBLIC_KEY : null, vapidPrivate,
    registerKey: !!env.REGISTER_KEY, db, lastCronAt, lastCronError: meta.lastCronError || null,
  };
}

// ---------- Cron ----------
/**
 * Send every rule occurrence due in (now − 15 min, now] that hasn't been sent, then move each
 * rule's next_at forward. Occurrences missed by more than 15 minutes are skipped, never sent late.
 */
export async function runCron(env, now = Date.now(), opts = {}) {
  // Heartbeat for /api/health: when the timer last ran, and whether it failed.
  const beat = (error) => env.DB.batch([
    env.DB.prepare("INSERT INTO meta (key, value) VALUES ('lastCronAt', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(String(now)),
    error ? env.DB.prepare("INSERT INTO meta (key, value) VALUES ('lastCronError', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(String(error).slice(0, 200))
      : env.DB.prepare("DELETE FROM meta WHERE key = 'lastCronError'"),
  ]);
  try {
    const stats = await cronRun(env, now, opts);
    await beat(null);
    return stats;
  } catch (e) {
    await beat(e?.message || 'error').catch(() => {});
    throw e;
  }
}

async function cronRun(env, now, { fetchImpl = fetch } = {}) {
  const stats = { sent: 0, failed: 0, gone: 0, skippedLate: 0, purged: false };
  // Fair selection: each device's earliest due rules first, round-robin across devices
  // (every device's 1st, then every device's 2nd, …), at most perDevice each, sendBatch in all.
  const { results } = await env.DB.prepare(
    `SELECT * FROM (
       SELECT r.device_id, r.rule_id, r.def, r.next_at, r.next_date, d.tz, d.endpoint, d.p256dh, d.auth,
              ROW_NUMBER() OVER (PARTITION BY r.device_id ORDER BY r.next_at, r.rule_id) AS rn
         FROM rules r JOIN devices d ON d.id = r.device_id
        WHERE r.next_at IS NOT NULL AND r.next_at <= ?1)
      WHERE rn <= ?3
      ORDER BY rn, next_at LIMIT ?2`,
  ).bind(now, LIMITS.sendBatch, LIMITS.perDevice).all();
  if (results.length) {
    const toSend = results.filter((r) => r.next_at > now - LIMITS.lateWindowMs);
    stats.skippedLate = results.length - toSend.length;
    const deadDevices = new Set();
    if (toSend.length) {
      if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) throw new Error('VAPID keys are not configured');
      const vapid = await importVapidKeys(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
      const subject = env.VAPID_SUBJECT || 'mailto:admin@example.invalid';
      const authCache = new Map();
      let next = 0;
      const worker = async () => {
        while (next < toSend.length) {
          const r = toSend[next++];
          if (deadDevices.has(r.device_id)) continue;
          const rule = ruleFromRow(r);
          try {
            const res = await sendPush({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth },
              // url/tag are templates: "{date}" becomes the occurrence's local date (deep link to that day's item).
              { title: rule.title, body: rule.body, url: fill(rule.url, r.next_date), tag: fill(rule.tag, r.next_date) }, { vapid, subject, authCache, fetchImpl });
            if (res.gone) { deadDevices.add(r.device_id); stats.gone++; } else if (res.ok) stats.sent++; else stats.failed++;
          } catch (e) { stats.failed++; console.error('push failed', e?.message); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(LIMITS.concurrency, toSend.length) }, worker));
    }
    // Every selected occurrence is done (sent, failed or too late): record it and move the rule on.
    // (A failed send isn't retried every minute: a reminder is time-bound.)
    const stmts = [];
    for (const r of results) {
      if (deadDevices.has(r.device_id)) continue;
      const rule = ruleFromRow(r);
      const nx = nextFire(rule, r.tz, Math.max(r.next_at, now - LIMITS.lateWindowMs), { fired: new Set([r.next_date]) });
      stmts.push(
        // at = the scheduled fire time (not the send time), so a later change of the rule's time can tell it apart.
        env.DB.prepare('INSERT OR REPLACE INTO fired (device_id, rule_id, date, at) VALUES (?1, ?2, ?3, ?4)').bind(r.device_id, r.rule_id, r.next_date, r.next_at),
        env.DB.prepare('UPDATE rules SET next_at = ?3, next_date = ?4 WHERE device_id = ?1 AND rule_id = ?2').bind(r.device_id, r.rule_id, nx ? nx.at : null, nx ? nx.date : null),
      );
    }
    for (const id of deadDevices) stmts.push(...deviceDeletes(env, id));
    if (stmts.length) await env.DB.batch(stmts);
  }
  // Daily purge (once a day at 03:00 UTC).
  const d = new Date(now);
  if (d.getUTCHours() === 3 && d.getUTCMinutes() === 0) { await purge(env, now); stats.purged = true; }
  return stats;
}

/** Old send records, devices not seen for 180 days (and their rules), old rate-limit rows, expired challenges and sessions, abandoned photo uploads. */
export async function purge(env, now = Date.now()) {
  const stale = now - 180 * 86400000;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM fired WHERE at < ?1').bind(now - 3 * 86400000),
    env.DB.prepare('DELETE FROM rules WHERE device_id IN (SELECT id FROM devices WHERE last_seen < ?1)').bind(stale),
    env.DB.prepare('DELETE FROM fired WHERE device_id IN (SELECT id FROM devices WHERE last_seen < ?1)').bind(stale),
    env.DB.prepare('DELETE FROM devices WHERE last_seen < ?1').bind(stale),
    env.DB.prepare('DELETE FROM rate WHERE win < ?1').bind(Math.floor(now / 3600000) - 2),
  ]);
  // Its own try/catch: an older database without the invites table must not fail the whole purge.
  try { await env.DB.prepare('DELETE FROM invites WHERE used_at IS NULL AND (revoked = 1 OR expires_at < ?1)').bind(now - 90 * 86400000).run(); } catch (e) { console.error('invites purge failed', e?.message); }
  await purgeAccounts(env, now); // expired challenges, sessions unused for 400 days
  await purgeFiles(env, now); // photo uploads abandoned for a day
}

export default {
  fetch: (request, env) => handleFetch(request, env),
  scheduled: (event, env, ctx) => { ctx.waitUntil(runCron(env, event.scheduledTime || Date.now()).catch((e) => console.error('cron failed', e?.message))); },
};
