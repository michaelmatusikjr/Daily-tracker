// Weather data layer for the Today weather line: Open-Meteo forecast + geocoding, BigDataCloud reverse
// geocoding, browser geolocation, and a per-device forecast cache (localStorage, NOT in profile data).
// Nothing here blocks rendering: callers read the cache synchronously (weatherFor) and ask for a refresh
// (ensureFresh), which calls the listener when new data arrives. Every failure is swallowed.
import { isValidKey, addDays, todayKey } from './dates.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const SEARCH_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const REVERSE_URL = 'https://api.bigdatacloud.net/data/reverse-geocode-client';
const CACHE_KEY = 'dailyTracker:weatherCache';
const POS_KEY = 'dailyTracker:weatherPos';
export const FRESH_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 8000;
const RETRY_MS = 5 * 60 * 1000; // after a failure, don't try the same thing again for a while
const MAX_ENTRIES = 12;
export const FORECAST_DAYS = 8; // today + 7

/** ~1 km precision: this is all that is ever sent to a weather service. */
export const round2 = (n) => Math.round(n * 100) / 100;
const keyOf = (lat, lon) => `${round2(lat).toFixed(2)},${round2(lon).toFixed(2)}`;

// ---------- storage (per device) ----------
function lsRead(key) { try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v && typeof v === 'object' ? v : null; } catch { return null; } }
function lsWrite(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage unavailable: weather just isn't cached */ } }

function readCache() { return lsRead(CACHE_KEY) || {}; }
function writeCache(cache) {
  const keys = Object.keys(cache).sort((a, b) => (cache[b].fetchedAt || 0) - (cache[a].fetchedAt || 0));
  const out = {};
  for (const k of keys.slice(0, MAX_ENTRIES)) out[k] = cache[k];
  lsWrite(CACHE_KEY, out);
}
const readPos = () => {
  const p = lsRead(POS_KEY);
  return p && Number.isFinite(p.lat) && Number.isFinite(p.lon) ? p : null;
};

// ---------- weather codes ----------
/** WMO weather code → [emoji, label]. */
export function describeCode(code) {
  const c = Number(code);
  if (c === 0) return ['☀️', 'Clear'];
  if (c === 1) return ['🌤️', 'Mostly clear'];
  if (c === 2) return ['⛅', 'Partly cloudy'];
  if (c === 3) return ['☁️', 'Cloudy'];
  if (c === 45 || c === 48) return ['🌫️', 'Fog'];
  if (c >= 51 && c <= 57) return ['🌦️', 'Drizzle'];
  if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return ['🌧️', 'Rain'];
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return ['❄️', 'Snow'];
  if (c >= 95 && c <= 99) return ['⛈️', 'Thunderstorm'];
  return ['🌡️', 'Weather'];
}
export const toUnits = (c, units) => Math.round(units === 'C' ? c : (c * 9) / 5 + 32);

// ---------- network ----------
async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

/** Validate an Open-Meteo response into { tz, days: { 'YYYY-MM-DD': { hi, lo, pop, code } } } (°C), or null. */
export function parseForecast(j) {
  const d = j && j.daily;
  if (!d || !Array.isArray(d.time)) return null;
  const days = {};
  d.time.slice(0, 16).forEach((k, i) => {
    const hi = d.temperature_2m_max?.[i], lo = d.temperature_2m_min?.[i];
    if (typeof k !== 'string' || !isValidKey(k) || !Number.isFinite(hi) || !Number.isFinite(lo)) return;
    const pop = d.precipitation_probability_max?.[i];
    const code = d.weather_code?.[i];
    days[k] = { hi, lo, pop: Number.isFinite(pop) ? Math.max(0, Math.min(100, Math.round(pop))) : null, code: Number.isFinite(code) ? code : null };
  });
  return Object.keys(days).length ? { tz: typeof j.timezone === 'string' ? j.timezone.slice(0, 64) : '', days } : null;
}

export async function fetchForecast(lat, lon) {
  const q = new URLSearchParams({
    latitude: String(round2(lat)), longitude: String(round2(lon)),
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code',
    timezone: 'auto', forecast_days: String(FORECAST_DAYS), temperature_unit: 'celsius',
  });
  const out = parseForecast(await getJson(`${FORECAST_URL}?${q}`));
  if (!out) throw new Error('Unexpected forecast response');
  return out;
}

/** City search (Open-Meteo geocoding). Returns [{ name, detail, lat, lon }]; throws on a network problem. */
export async function searchPlaces(text) {
  const name = String(text || '').trim().slice(0, 80);
  if (!name) return [];
  const q = new URLSearchParams({ name, count: '5', language: 'en', format: 'json' });
  const j = await getJson(`${SEARCH_URL}?${q}`);
  const list = Array.isArray(j?.results) ? j.results : [];
  return list.filter((r) => r && typeof r.name === 'string' && Number.isFinite(r.latitude) && Number.isFinite(r.longitude) && Math.abs(r.latitude) <= 90 && Math.abs(r.longitude) <= 180)
    .slice(0, 5).map((r) => ({
      name: r.name.slice(0, 80),
      detail: [r.admin1, r.country_code || r.country].filter((x) => typeof x === 'string' && x).join(', ').slice(0, 80),
      lat: round2(r.latitude), lon: round2(r.longitude),
    }));
}

async function reverseName(lat, lon) {
  const q = new URLSearchParams({ latitude: String(round2(lat)), longitude: String(round2(lon)), localityLanguage: 'en' });
  const j = await getJson(`${REVERSE_URL}?${q}`);
  const n = [j?.city, j?.locality].find((x) => typeof x === 'string' && x.trim());
  return n ? n.trim().slice(0, 80) : '';
}

// ---------- current location ----------
const failedAt = new Map(); // key → time of the last failed attempt (memory only)
let geoDenied = false;

function geolocate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(Object.assign(new Error('unsupported'), { code: 0 })); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) => reject(e),
      { enableHighAccuracy: false, timeout: TIMEOUT_MS, maximumAge: 15 * 60 * 1000 });
  });
}

/** Resolve the device position (rounded) and its city name; remembered per device. */
async function refreshPosition() {
  try {
    const p = await geolocate();
    geoDenied = false;
    const lat = round2(p.lat), lon = round2(p.lon);
    const old = readPos();
    let name = old && keyOf(old.lat, old.lon) === keyOf(lat, lon) ? old.name || '' : '';
    if (!name) { try { name = await reverseName(lat, lon); } catch { name = ''; } }
    lsWrite(POS_KEY, { lat, lon, name, at: Date.now() });
    return true;
  } catch (e) {
    // Denied (code 1) forgets the remembered position; any other failure (unsupported, unavailable, timeout)
    // keeps an older position if there is one, otherwise it's time to ask for a city.
    if (e && e.code === 1) { try { localStorage.removeItem(POS_KEY); } catch { /* ignore */ } }
    geoDenied = !readPos();
    return false;
  }
}

// ---------- public API ----------
let listener = () => {};
/** Called (with no arguments) whenever new weather data or a position arrived. */
export function onWeatherChange(fn) { listener = typeof fn === 'function' ? fn : () => {}; }

const inFlight = new Map();

/** Where to look: { kind:'current'|'saved', lat, lon, name } or { kind:'need-city' } / { kind:'locating' }. */
export function resolveTarget(w) {
  const sel = w.locations.find((l) => l.id === w.selected);
  if (w.selected !== 'current' && sel) return { kind: 'saved', lat: sel.lat, lon: sel.lon, name: sel.name };
  const pos = readPos();
  if (pos) return { kind: 'current', lat: pos.lat, lon: pos.lon, name: pos.name || '' };
  return geoDenied ? { kind: 'need-city' } : { kind: 'locating' };
}

/**
 * What the weather line should show for `dateKey`, from the cache only (never waits for the network).
 * → null when nothing should show (a past day, or beyond 7 days ahead); otherwise
 * { pill, needCity, forecast: { emoji, label, hi, lo, pop } | null, stale, updatedAt }.
 */
export function weatherFor(w, dateKey, today = todayKey()) {
  if (dateKey < today || dateKey > addDays(today, FORECAST_DAYS - 1)) return null;
  const t = resolveTarget(w);
  if (t.kind === 'need-city') return { pill: 'Add a city', needCity: true, forecast: null, stale: false, updatedAt: null };
  const pill = t.name || 'Current location';
  if (t.kind === 'locating') return { pill, needCity: false, forecast: null, stale: false, updatedAt: null };
  const entry = readCache()[keyOf(t.lat, t.lon)];
  const day = entry && entry.days && entry.days[dateKey];
  if (!day) return { pill, needCity: false, forecast: null, stale: false, updatedAt: null };
  const [emoji, label] = describeCode(day.code);
  const age = Date.now() - (entry.fetchedAt || 0);
  // Stale = older than the refresh interval and the refresh isn't working (offline / failed).
  const failed = failedAt.has(keyOf(t.lat, t.lon)) || (typeof navigator !== 'undefined' && navigator.onLine === false);
  return {
    pill, needCity: false, stale: age > FRESH_MS && failed, updatedAt: entry.fetchedAt || null,
    forecast: { emoji, label, hi: toUnits(day.hi, w.units), lo: toUnits(day.lo, w.units), pop: day.pop },
  };
}

/** Make sure the selected location has a forecast younger than ~30 min; fires the listener when something changed. */
export function ensureFresh(w) {
  try {
    const t = resolveTarget(w);
    if (t.kind === 'need-city') return;
    if (t.kind === 'locating' || (t.kind === 'current' && positionDue())) {
      if (inFlight.has('pos') || recentlyFailed('pos')) return;
      const p = refreshPosition().then((ok) => {
        if (!ok) failedAt.set('pos', Date.now()); else failedAt.delete('pos');
        listener();
      }).finally(() => inFlight.delete('pos'));
      inFlight.set('pos', p);
      // A known position can still be used for the forecast while the new one is looked up.
      if (t.kind === 'locating') return;
    }
    const key = keyOf(t.lat, t.lon);
    const entry = readCache()[key];
    if (entry && Date.now() - (entry.fetchedAt || 0) < FRESH_MS) return;
    if (inFlight.has(key) || recentlyFailed(key)) return;
    const p = fetchForecast(t.lat, t.lon).then((f) => {
      const cache = readCache();
      cache[key] = { fetchedAt: Date.now(), tz: f.tz, days: f.days };
      writeCache(cache);
      failedAt.delete(key);
      listener();
    }).catch(() => {
      failedAt.set(key, Date.now());
      listener(); // lets the line switch to its "stale" look
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
  } catch { /* weather must never break the app */ }
}

function recentlyFailed(key) { const t = failedAt.get(key); return !!t && Date.now() - t < RETRY_MS; }
function positionDue() { const p = readPos(); return !p || Date.now() - (p.at || 0) > FRESH_MS; }

/** Forget the "recently failed" marks (e.g. after the user picked another location or came back online). */
export function resetRetries() { failedAt.clear(); geoDenied = false; }
if (typeof window !== 'undefined') window.addEventListener('online', () => { failedAt.clear(); listener(); });
